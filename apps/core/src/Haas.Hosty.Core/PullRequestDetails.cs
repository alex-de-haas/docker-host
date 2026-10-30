using System.Text.Json;

namespace Haas.Hosty.Core;

internal sealed partial class PullRequestService
{
    private void EvictDetails(string userId, string repositoryId)
    {
        foreach (var key in details.Where(p => p.Value.Owner == userId && p.Key.Contains(":" + repositoryId + ":", StringComparison.Ordinal)).Select(p => p.Key).ToArray()) details.Remove(key);
        foreach (var key in detailCursors.Where(p => p.Value.Repo == repositoryId).Select(p => p.Key).ToArray()) detailCursors.Remove(key);
    }
    private sealed record DetailEntry(object Value, DateTimeOffset At, DateTimeOffset Used, int Bytes, string Owner);
    private readonly Dictionary<string, DetailEntry> details = new(StringComparer.Ordinal);
    private readonly Dictionary<string, Task<object>> detailFlights = new(StringComparer.Ordinal);
    private sealed record DetailCursor(string Actor, string Repo, int Number, string Kind, string Head,
        string ProviderCursor, int Seen, DateTimeOffset Expires);
    private readonly Dictionary<string, DetailCursor> detailCursors = new(StringComparer.Ordinal);

    private async Task RequireDetailAccessAsync(PullRequestActor actor, InstalledPullRequestRepositories.Binding binding, CancellationToken ct)
    {
        var current = await inventory.DiscoverAsync(actor, ct);
        if (!current.Bindings.Any(b => b.Key == binding.Key && b.Authority == binding.Authority))
            throw new PullRequestException("pr_access_denied", "Repository access changed during the detail read.", 403);
    }
    private async Task<T> CachedAsync<T>(PullRequestActor actor, Repository repo, string key, Func<Task<T>> read, CancellationToken ct) where T : class
    {
        var binding = repo.Binding;
        var value = await CachedValueAsync(actor, repo, key, read, ct);
        // Shared work validates its initiator. Every recipient still owns its current authority.
        await RequireDetailAccessAsync(actor, binding, ct);
        return value;
    }
    private async Task<T> CachedValueAsync<T>(PullRequestActor actor, Repository repo, string key, Func<Task<T>> read, CancellationToken ct) where T : class
    {
        key = actor.UserId + ":" + repo.Binding.Authority + ":" + repo.Id + ":" + key;
        Task<object>? flight;
        TaskCompletionSource<object>? completion = null;
        lock (sync)
        {
            foreach (var old in details.Where(p => clock.UtcNow - p.Value.Used >= TimeSpan.FromMinutes(30)).Select(p => p.Key).ToArray()) details.Remove(old);
            if (details.TryGetValue(key, out var cached) && clock.UtcNow - cached.At < TimeSpan.FromSeconds(60))
            { details[key] = cached with { Used = clock.UtcNow }; return (T)cached.Value; }
            if (!detailFlights.TryGetValue(key, out flight))
            {
                completion = new(TaskCreationOptions.RunContinuationsAsynchronously);
                detailFlights[key] = flight = completion.Task;
            }
        }
        if (completion is null) return (T)await flight.WaitAsync(ct);
        try
        {
            var result = await read();
            var size = JsonSerializer.SerializeToUtf8Bytes(result, CoreJson.TypeInfo<T>()).Length;
            lock (sync)
            {
                while (details.Count > 0 && (details.Values.Sum(e => (long)e.Bytes) + size > 256 * 1024 * 1024 ||
                    details.Values.Where(e => e.Owner == actor.UserId).Sum(e => (long)e.Bytes) + size > 64 * 1024 * 1024))
                {
                    var victim = details.Where(p => p.Value.Owner == actor.UserId).MinBy(p => p.Value.Used);
                    if (victim.Key is null) victim = details.MinBy(p => p.Value.Used);
                    details.Remove(victim.Key);
                }
                if (size <= 64 * 1024 * 1024) details[key] = new(result, clock.UtcNow, clock.UtcNow, size, actor.UserId);
            }
            completion.SetResult(result); return result;
        }
        catch (Exception ex) { completion.SetException(ex); _ = completion.Task.Exception; throw; }
        finally { lock (sync) detailFlights.Remove(key); }
    }

    public async Task<PullRequestDetail> DetailAsync(PullRequestActor actor, string id, int number, CancellationToken ct)
    {
        if (number <= 0) throw new PullRequestException("pr_request_invalid", "Invalid PR number.", 400);
        var (owner, repo) = await RequireRepositoryAsync(actor, id, ct);
        var binding = repo.Binding;
        var data = await CachedAsync(actor, repo, "description:" + number, async () =>
        {
            var remote = await ReadAsync(actor, repo, (c, p) => p.ReadPullRequestAsync(c, repo.Name, id, number, ct), ct);
            lock (sync)
            {
                var summary = remote.Summary;
                if (repo.Items.TryGetValue(number, out var previous) && previous.Head == summary.Head)
                    summary = summary with { Checks = previous.Checks, ReviewDecision = previous.ReviewDecision, MergeState = previous.MergeState };
                else repo.HeadSeen[number] = clock.UtcNow;
                repo.Items[number] = summary; Changed(owner);
                return new PullRequestDetail(summary, remote.Description, remote.Truncated, [], summary.Receipt);
            }
        }, ct);
        var links = await inspection.PullRequestLinksAsync(actor.UserId, data.PullRequest.Url, ct);
        await RequireDetailAccessAsync(actor, binding, ct);
        // A cached description is independent of the current CI observation and head.
        lock (sync) return data with { Links = links, PullRequest = repo.Items.TryGetValue(number, out var current) ? Display(owner, repo, current) : data.PullRequest };
    }
    private (string? Cursor, int Seen) ResolveCursor(PullRequestActor actor, string id, int number, string kind, string head, string? cursor)
    {
        lock (sync)
        {
            foreach (var old in detailCursors.Where(p => p.Value.Expires <= clock.UtcNow).Select(p => p.Key).ToArray()) detailCursors.Remove(old);
            if (cursor is null) return (null, 0);
            if (!detailCursors.TryGetValue(cursor, out var value) || value.Actor != actor.Key || value.Repo != id || value.Number != number || value.Kind != kind || value.Head != head)
                throw new PullRequestException("pr_cursor_expired", "Reload this detail from its first page.");
            return (value.ProviderCursor, value.Seen);
        }
    }
    private string? NextCursor(PullRequestActor actor, string id, int number, string kind, string head, string? cursor, int seen)
    {
        if (cursor is null || seen >= 500) return null;
        lock (sync)
        {
            while (detailCursors.Count >= 2048) detailCursors.Remove(detailCursors.Keys.First());
            var key = Guid.NewGuid().ToString("N");
            detailCursors[key] = new(actor.Key, id, number, kind, head, cursor, seen, clock.UtcNow.AddMinutes(2));
            return key;
        }
    }
    public async Task<PullRequestChecks> ChecksAsync(PullRequestActor actor, string id, int number, string? cursor, CancellationToken ct)
    {
        var (_, repo) = await RequireRepositoryAsync(actor, id, ct);
        string head;
        lock (sync) head = repo.Items.GetValueOrDefault(number)?.Head ?? throw new PullRequestException("pr_not_found", "Load the PR before its checks.", 404);
        var page = ResolveCursor(actor, id, number, "checks", head, cursor);
        var result = await CachedAsync(actor, repo, $"checks:{number}:{head}:{page.Cursor}",
            async () =>
            {
                try { return await ReadAsync(actor, repo, (c, p) => p.ReadChecksAsync(c, repo.Name, number, head, page.Cursor, ct), ct, detailCapability: true); }
                catch (PullRequestException e) when (e.Code == "pr_access_denied") { return new PullRequestChecks([], null, "unknown"); }
            }, ct);
        lock (sync) if (repo.Items.GetValueOrDefault(number)?.Head != head) throw new PullRequestException("pr_changed", "The PR head changed. Reload its checks.");
        return result with { Cursor = NextCursor(actor, id, number, "checks", head, result.Cursor, page.Seen + result.Items.Length) };
    }
    public async Task<PullRequestReview> ReviewAsync(PullRequestActor actor, string id, int number, string? cursor, CancellationToken ct)
    {
        var (_, repo) = await RequireRepositoryAsync(actor, id, ct);
        string head;
        lock (sync) head = repo.Items.GetValueOrDefault(number)?.Head ?? throw new PullRequestException("pr_not_found", "Load the PR before its review.", 404);
        var page = ResolveCursor(actor, id, number, "review", head, cursor);
        var result = await CachedAsync(actor, repo, $"review:{number}:{head}:{page.Cursor}",
            async () =>
            {
                try { return await ReadAsync(actor, repo, (c, p) => p.ReadDiscussionAsync(c, repo.Name, number, head, page.Cursor, ct), ct, detailCapability: true); }
                catch (PullRequestException e) when (e.Code == "pr_access_denied") { return new PullRequestReview([], null, null,
                    new(Guid.NewGuid().ToString("N"), Freshness: "unavailable", Completeness: "unknown", Reason: "Review details are not accessible with this connection.")); }
            }, ct);
        lock (sync) if (repo.Items.GetValueOrDefault(number)?.Head != head) throw new PullRequestException("pr_changed", "The PR head changed. Reload its review.");
        return result with { Cursor = NextCursor(actor, id, number, "review", head, result.Cursor, page.Seen + result.Items.Length) };
    }
    public async Task<PullRequestDiff> DiffAsync(PullRequestActor actor, string id, int number, string head, string basis, CancellationToken ct)
    {
        var (_, repo) = await RequireRepositoryAsync(actor, id, ct);
        lock (sync)
            if (!repo.Items.TryGetValue(number, out var current) || current.Head != head || current.Base != basis)
                throw new PullRequestException("pr_changed", "Reload the PR before opening its diff.");
        return await CachedAsync(actor, repo, $"diff:{number}:{head}:{basis}",
            () => ReadAsync(actor, repo, (c, p) => p.ReadDiffAsync(c, repo.Name, id, number, head, basis, ct), ct), ct);
    }
}
