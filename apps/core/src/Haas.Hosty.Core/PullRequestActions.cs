using System.Text.RegularExpressions;

namespace Haas.Hosty.Core;

internal sealed record PullRequestActionAvailability(bool Enabled, string? Reason = null);
internal sealed record PullRequestActions(string Head, string Base, string State, bool Draft, string MergeState,
    PullRequestActionAvailability Merge, PullRequestActionAvailability UpdateBranch, string AutoMerge,
    string? AutoMergeMethod, DateTimeOffset ObservedAt, PullRequestCommand? PendingCommand = null, PullRequestCommandResult? PendingResult = null);
internal sealed record PullRequestCommand(string RequestId, string Action, string Head, string Base);
internal sealed record PullRequestCommandResult(string RequestId, string Action, string State, string Message);
internal sealed record PullRequestActionOutcome(string State, string Message, string? ProviderRequestId = null);
internal sealed record PullRequestCommandRecord(string Actor, string Repository, string Authority, int Number,
    PullRequestCommand Command, PullRequestActionOutcome Outcome, DateTimeOffset At);
internal sealed record PullRequestCommandJournal(PullRequestCommandRecord[] Records);
internal interface IPullRequestActionsProvider
{
    Task<PullRequestActions> ActionsAsync(UserProviderConnection connection, string repository, int number, CancellationToken ct);
    Task<PullRequestActionOutcome> ExecuteActionAsync(UserProviderConnection connection, string repository, int number,
        PullRequestCommand command, Func<Task> beforeSend, CancellationToken ct);
    Task<PullRequestActionOutcome> RecoverActionAsync(UserProviderConnection connection, string repository, int number,
        PullRequestCommand command, PullRequestActionOutcome previous, CancellationToken ct);
}

internal sealed partial class PullRequestService
{
    // Bounded stripes serialize the durable owner journal, including concurrent retries across UI surfaces.
    private readonly SemaphoreSlim[] actionGates = Enumerable.Range(0, 64).Select(_ => new SemaphoreSlim(1)).ToArray();
    private async Task RequireActionBinding(PullRequestActor actor, InstalledPullRequestRepositories.Binding binding, CancellationToken ct)
    {
        var current = await inventory.DiscoverAsync(actor, ct);
        if (!current.Bindings.Any(b => b.Key == binding.Key && b.Authority == binding.Authority && b.ConnectionId == binding.ConnectionId))
            throw new PullRequestException("pr_access_denied", "The installed source or selected connection changed. Reload this PR.", 403);
    }
    public async Task<PullRequestActions> ActionsAsync(PullRequestActor actor, string id, int number, CancellationToken ct)
    {
        if (number <= 0) throw new PullRequestException("pr_request_invalid", "Invalid PR number.", 400);
        var (_, repo) = await RequireRepositoryAsync(actor, id, ct);
        var available = await ReadAsync(actor, repo, (c, provider) => provider is IPullRequestActionsProvider actions
            ? actions.ActionsAsync(c, repo.Name, number, ct)
            : throw new PullRequestException("pr_actions_unsupported", "This provider does not support PR actions.", 409), ct, detailCapability: true);
        var journal = await JsonStorage.ReadAsync<PullRequestCommandJournal>(Path.Combine(CacheRoot, "actions", DevelopmentWorkspaceService.Hash(actor.UserId) + ".json"), ct);
        var pending = journal?.Records.LastOrDefault(r => r.Actor == actor.Key && r.Repository == id && r.Number == number &&
            r.Authority == repo.Binding.Authority && r.Outcome.State is "pending" or "unknown");
        return pending is null ? available : available with { PendingCommand = pending.Command,
            PendingResult = new(pending.Command.RequestId, pending.Command.Action, pending.Outcome.State, pending.Outcome.Message) };
    }
    internal static void ValidateCommand(PullRequestCommand command)
    {
        if (!Guid.TryParseExact(command.RequestId, "D", out _) || command.Action is not ("merge" or "update-branch") ||
            !Regex.IsMatch(command.Head ?? "", "^[a-f0-9]{40}$", RegexOptions.CultureInvariant) ||
            !Regex.IsMatch(command.Base ?? "", "^[a-f0-9]{40}$", RegexOptions.CultureInvariant))
            throw new PullRequestException("pr_request_invalid", "Provide a UUID, supported action and exact head/base commits.", 400);
    }
    public async Task<PullRequestCommandResult> ExecuteActionAsync(PullRequestActor actor, string id, int number, PullRequestCommand command, CancellationToken ct, bool recoverOnly = false)
    {
        ValidateCommand(command);
        if (number <= 0) throw new PullRequestException("pr_request_invalid", "Invalid PR number.", 400);
        var gate = actionGates[(uint)StringComparer.Ordinal.GetHashCode(actor.UserId) % actionGates.Length];
        await gate.WaitAsync(ct);
        try
        {
            var (owner, repo) = await RequireRepositoryAsync(actor, id, ct);
            var binding = repo.Binding;
            if (binding.Provider is not IPullRequestActionsProvider provider)
                throw new PullRequestException("pr_actions_unsupported", "This provider does not support PR actions.", 409);
            var path = Path.Combine(CacheRoot, "actions", DevelopmentWorkspaceService.Hash(actor.UserId) + ".json");
            var journal = await JsonStorage.ReadAsync<PullRequestCommandJournal>(path, ct) ?? new([]);
            var records = journal.Records.ToList();
            var previous = records.FirstOrDefault(r => r.Command.RequestId == command.RequestId);
            if (previous is not null && (previous.Actor != actor.Key || previous.Repository != id || previous.Number != number || previous.Command != command))
                throw new PullRequestException("pr_request_conflict", "This request ID belongs to a different command.", 409);
            if (previous is not null && previous.Authority != binding.Authority)
                throw new PullRequestException("pr_access_denied", "The action's source or account binding has changed.", 403);
            if (previous is null && recoverOnly)
                return new(command.RequestId, command.Action, "failed", "No dispatched request was recorded. Refresh status before confirming a new action.");
            // A lost browser response must not allow a second write under a new request ID.
            if (previous is null && records.Any(r => r.Repository == id && r.Number == number && r.Authority == binding.Authority &&
                (r.Outcome.State is "pending" or "unknown" || r.Command.Head == command.Head && r.Command.Action == command.Action && r.Outcome.State != "failed")))
                throw new PullRequestException("pr_action_exists", "An action was already sent for this PR. Recover its original request or inspect the result on GitHub.", 409);
            if (previous is null && records.Count >= 4096)
                throw new PullRequestException("pr_action_capacity", "The retained action receipt limit has been reached. Use GitHub for this action.", 409);
            async Task Save(PullRequestCommandRecord value)
            {
                var index = records.FindIndex(r => r.Command.RequestId == value.Command.RequestId);
                if (index < 0) records.Add(value); else records[index] = value;
                await JsonStorage.WriteAsync(path, new PullRequestCommandJournal(records.ToArray()), restrictToOwner: true, CancellationToken.None);
            }
            var record = previous ?? new(actor.Key, id, binding.Authority, number, command,
                new("unknown", "Delivery is uncertain. Check the result; this request will not be sent again."), clock.UtcNow);
            var dispatched = previous is not null;
            try
            {
                var outcome = await connections.UseForSourceAsync(actor.UserId, binding.ConnectionId, async connection =>
                {
                    await RequireActionBinding(actor, binding, ct);
                    if (previous is not null)
                        return previous.Outcome.State is "pending" or "unknown"
                            ? await provider.RecoverActionAsync(connection, repo.Name, number, command, previous.Outcome, ct)
                            : previous.Outcome;
                    var available = await provider.ActionsAsync(connection, repo.Name, number, ct);
                    if (available.Head != command.Head || available.Base != command.Base)
                        throw new PullRequestException("pr_changed", "This PR changed. Refresh and review its current head and base before confirming again.", 409);
                    var selected = command.Action == "merge" ? available.Merge : available.UpdateBranch;
                    if (!selected.Enabled) throw new PullRequestException("pr_action_blocked", selected.Reason ?? "GitHub does not currently allow this action.", 409);
                    return await provider.ExecuteActionAsync(connection, repo.Name, number, command, async () =>
                    {
                        // Runs after provider pacing and immediately before dispatch, under the credential gate.
                        await RequireActionBinding(actor, binding, ct);
                        await Save(record); dispatched = true;
                    }, ct);
                }, ct);
                record = record with { Outcome = outcome }; await Save(record);
            }
            catch (Exception ex) when (dispatched && ex is HttpRequestException or OperationCanceledException or System.Text.Json.JsonException or PublicationException or PullRequestException or IOException)
            {
                // A provider read/recovery failure preserves the last receipt, never schedules a retrying write.
                await Save(record);
            }
            finally
            {
                if (dispatched) lock (sync)
                {
                    EvictDetails(actor.UserId, id); repo.Requested.Add(number); repo.ScanRequested = true;
                    repo.StatusAt.Remove(number); Changed(owner, repo);
                }
            }
            await RequireActionBinding(actor, binding, ct);
            return new(command.RequestId, command.Action, record.Outcome.State, record.Outcome.Message);
        }
        finally { gate.Release(); }
    }
}
