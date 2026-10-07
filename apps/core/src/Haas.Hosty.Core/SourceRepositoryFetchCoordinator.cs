using System.Collections.Concurrent;

namespace Haas.Hosty.Core;

// Shared by workspace mutations and document reads. Waiting/cancelling a caller never cancels
// another caller's fetch, and no repository holds a process-wide workspace lock during transport.
internal sealed class SourceRepositoryFetchCoordinator(IClock clock)
{
    internal static readonly TimeSpan Interval = TimeSpan.FromSeconds(30);
    internal static readonly TimeSpan Timeout = TimeSpan.FromSeconds(30);
    internal const long TransferLimit = 128 * 1024 * 1024;
    private sealed class Entry
    {
        internal readonly object Gate = new();
        internal Task<string>? Running;
        internal string? Head;
        internal DateTimeOffset? FetchedAt;
        internal bool RunningAnonymous;
        internal string? PublicHead;
        internal DateTimeOffset? PublicFetchedAt;
    }
    private readonly ConcurrentDictionary<string, Entry> entries = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, string> defaults = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, SemaphoreSlim> initializations = new(StringComparer.Ordinal);
    private static string Key(string repository, string branch) => repository + "\n" + branch;
    internal string? DefaultBranch(string repository) => defaults.GetValueOrDefault(repository);
    internal void SetDefaultBranch(string repository, string branch) => defaults[repository] = branch;

    internal DateTimeOffset? LastFetched(string repository, string branch)
    {
        if (!entries.TryGetValue(Key(repository, branch), out var entry)) return null;
        lock (entry.Gate) return entry.FetchedAt;
    }
    internal bool HasPublicProof(string repository, string branch, string? head)
    {
        if (head is null || !entries.TryGetValue(Key(repository, branch), out var entry)) return false;
        lock (entry.Gate) return entry.PublicHead == head && entry.PublicFetchedAt is { } at && clock.UtcNow - at < Interval;
    }

    internal async Task EnsureRepositoryAsync(string path, Func<Task> initialize, CancellationToken ct)
    {
        var gate = initializations.GetOrAdd(path, _ => new(1, 1));
        await gate.WaitAsync(ct);
        try { if (!Directory.Exists(path)) await initialize(); }
        finally { gate.Release(); }
    }

    internal Task<string> FetchAsync(string path, string repository, string branch, bool refresh,
        Func<CancellationToken, Task<string>> fetch, CancellationToken ct, bool anonymous = false)
    {
        var entry = entries.GetOrAdd(Key(repository, branch), _ => new());
        Task<string> pending;
        lock (entry.Gate)
        {
            if (entry.Running is { IsCompleted: false } active)
                pending = anonymous && !entry.RunningAnonymous
                    ? AfterPrivateAsync(active, path, repository, branch, refresh, fetch, ct) : active;
            else if (!refresh && entry.Head is { } head && entry.FetchedAt is { } at && clock.UtcNow - at < Interval
                && (!anonymous || entry.PublicHead == head && entry.PublicFetchedAt is { } publicAt && clock.UtcNow - publicAt < Interval))
                pending = Task.FromResult(head);
            else
            {
                entry.RunningAnonymous = anonymous;
                if (!anonymous) { entry.PublicHead = null; entry.PublicFetchedAt = null; }
                pending = entry.Running = RunAsync(entry, path, fetch, anonymous);
            }
        }
        return pending.WaitAsync(ct);
    }

    private async Task<string> AfterPrivateAsync(Task<string> active, string path, string repository,
        string branch, bool refresh, Func<CancellationToken, Task<string>> fetch, CancellationToken ct)
    {
        try { await active.WaitAsync(ct); }
        catch (AppLifecycleException) { } // A failed credentialed transport is not a public verdict.
        return await FetchAsync(path, repository, branch, refresh, fetch, ct, anonymous: true);
    }

    private async Task<string> RunAsync(Entry entry, string path, Func<CancellationToken, Task<string>> fetch, bool anonymous)
    {
        await Task.Yield();
        using var deadline = new CancellationTokenSource(Timeout);
        var initialSize = DirectorySize(path);
        var transfer = fetch(deadline.Token);
        while (!transfer.IsCompleted)
        {
            var tick = Task.Delay(200, deadline.Token);
            if (await Task.WhenAny(transfer, tick) == transfer) break;
            if (DirectorySize(path) - initialSize <= TransferLimit) continue;
            deadline.Cancel();
            try { await transfer; } catch (OperationCanceledException) { }
            throw DevelopmentWorkspaceService.Error("fetch_limit", "Repository fetch exceeded its transfer size limit.");
        }
        try
        {
            var head = await transfer;
            if (DirectorySize(path) - initialSize > TransferLimit)
                throw DevelopmentWorkspaceService.Error("fetch_limit", "Repository fetch exceeded its transfer size limit.");
            lock (entry.Gate)
            {
                entry.Head = head; entry.FetchedAt = clock.UtcNow;
                if (anonymous) { entry.PublicHead = head; entry.PublicFetchedAt = clock.UtcNow; }
            }
            return head;
        }
        catch (OperationCanceledException)
        {
            throw DevelopmentWorkspaceService.Error("git_timeout", "Repository fetch exceeded its time limit.");
        }
    }

    private static long DirectorySize(string path)
    {
        if (!Directory.Exists(path)) return 0;
        long size = 0;
        foreach (var file in Directory.EnumerateFiles(path, "*", SearchOption.AllDirectories))
        {
            try { size += new FileInfo(file).Length; }
            catch (IOException) { } // Git may replace a temporary pack while it is inspected.
        }
        return size;
    }
}
