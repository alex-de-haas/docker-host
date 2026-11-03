using HostySdk.App;
using System.Globalization;

namespace Haas.Hosty.Core;

internal sealed class CoreDecisionService(CoreDecisionStore store, UserDirectoryStore users, AppRegistryStore registry,
    IClock clock, CoreEventHub events, NotificationService notifications, ILogger<CoreDecisionService> logger, CorePublicOriginResolver? origins = null)
{
    private static void Require(CoreCapabilityCaller caller, string permission)
        => caller.Require(AccessTokenScopes.McpDecisions, permission);
    private static string Source(CoreCapabilityCaller caller) => caller.App is null ? "user:" + caller.User.Id : CoreCapabilityAuthorization.AppPrincipal(caller.App);
    private static bool Own(HostyDecisionRecord row, CoreCapabilityCaller caller) => row.UserId == caller.User.Id
        && row.SourceAppId == caller.App?.Id && row.SourceInstallation == caller.App?.InstalledAt;

    // A current user cannot inherit another user's questions by becoming an administrator. A source
    // removal/reinstallation or assignment revocation also removes metadata and counts from queries.
    private async Task<Func<HostyDecisionRecord, bool>> Visibility(CoreCapabilityCaller caller, CancellationToken ct)
    {
        var state = await users.ReadAsync(ct);
        var user = state.Users.SingleOrDefault(u => u.Id == caller.User.Id && !u.Disabled)
            ?? throw CoreDecisionValidation.Missing();
        var apps = (await registry.ListAppRecordsAsync(ct)).ToDictionary(a => a.Id, StringComparer.Ordinal);
        return row => row.UserId == user.Id && (row.SourceAppId is null ||
            (apps.TryGetValue(row.SourceAppId, out var app) && app.InstalledAt == row.SourceInstallation
             && AppAccessPolicy.CanAccessApp(state, user, app.Id, app.System)));
    }
    private Task<int> Expire(CancellationToken ct) => store.MaintainAsync(clock.UtcNow, ct);

    internal async Task<HostyDecisionRecord> CreateAsync(CoreCapabilityCaller caller, HostyDecisionCreate input, CancellationToken ct = default)
    {
        Require(caller, CoreAppPermissions.DecisionsRequest);
        var visible = await Visibility(caller, ct); await Expire(ct);
        var fingerprint = CoreDecisionValidation.Fingerprint(input);
        var key = ReplayKey(caller, input.RequestId);
        // The deadline is validated only for a new create, so a late identical replay still works.
        var row = await store.UpdateAsync(state =>
        {
            if (Replay(state, key, fingerprint, visible) is { } replay) return (state, replay);
            CoreDecisionValidation.Input(input.Input, clock.UtcNow);
            var correlation = CoreDecisionValidation.Hash(input.Input.CorrelationKey);
            if (state.Records.Any(r => Own(r, caller) && r.CorrelationHash == correlation))
                throw CoreDecisionValidation.Conflict("This source correlation already has a decision; recover the original request.");
            if (input.Input.PredecessorId is { } predecessor && !state.Records.Any(r => r.Id == predecessor && Own(r, caller) && visible(r) && r.State != "pending"))
                throw CoreDecisionValidation.Invalid("The predecessor must be your terminal decision.");
            if (state.Records.Count(r => r.UserId == caller.User.Id && r.State == "pending") >= 1000)
                throw CoreDecisionValidation.Conflict("Resolve or withdraw existing decisions before creating more.");
            var result = new HostyDecisionRecord(Guid.NewGuid().ToString("D"), state.Sequence + 1, 1, caller.User.Id, correlation,
                caller.App?.Id, caller.App?.InstalledAt, caller.PrincipalId, input.Input, "pending", clock.UtcNow, clock.UtcNow);
            return Save(state with { Sequence = result.Sequence }, result, key, fingerprint);
        }, ct);
        events.PublishDecision(row.UserId);
        // Notifications are only hints; all recovery is driven by the durable record and outbox.
        try
        {
            var origin = origins?.Effective.TrimEnd('/');
            var link = origin is null ? null : caller.App is { Ui.EndpointKey: { } endpoint } app && row.Input?.OriginPath is { } route
                ? UiPanelService.BuildOpenUrl(origin, app.Id, PanelIdentity.Installation(app), endpoint, route)
                : $"{origin}/api/decisions/v1/requests/{row.Id}";
            await notifications.PublishAsync(new CoreScope(), row.UserId, NotificationService.AudienceUser, "info",
                "A decision needs your response", null, link, "decision:" + row.Id, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        { logger.LogWarning(ex, "Decision {DecisionId} is saved; its notification could not be published.", row.Id); }
        return row;
    }

    internal async Task<HostyDecisionRecord> GetAsync(CoreCapabilityCaller caller, string id, CancellationToken ct = default)
    {
        Require(caller, CoreAppPermissions.DecisionsRead);
        var visible = await Visibility(caller, ct); await Expire(ct);
        return await store.UpdateAsync(state => (state, state.Records.SingleOrDefault(r => r.Id == id && visible(r)) ?? throw CoreDecisionValidation.Missing()), ct);
    }
    internal async Task<HostyDecisionPage> QueryAsync(CoreCapabilityCaller caller, HostyDecisionQuery query, bool responses = false, CancellationToken ct = default)
    {
        Require(caller, responses ? CoreAppPermissions.DecisionsRequest : CoreAppPermissions.DecisionsRead);
        if (query.Limit is < 1 or > 100) throw CoreDecisionValidation.Invalid("Page size must be between 1 and 100.");
        if (query.State is not (null or "pending" or "answered" or "withdrawn" or "expired" or "stale" or "history"))
            throw CoreDecisionValidation.Invalid("Unknown decision state.");
        CoreDecisionValidation.Text(query.Subject, 2000, "Subject"); CoreDecisionValidation.Text(query.Task, 2000, "Task");
        var visible = await Visibility(caller, ct); await Expire(ct);
        var binding = CoreDecisionValidation.Hash($"{caller.User.Id}|{Source(caller)}|{responses}|" + CoreJson.Text(query with { Cursor = null, Limit = 0 }));
        long after = 0;
        if (query.Cursor is { } cursor)
        {
            var parts = cursor.Split('.');
            if (parts.Length != 2 || parts[1] != binding || !long.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out after) || after < 0)
                throw CoreDecisionValidation.Invalid("The cursor belongs to a different query.");
        }
        return await store.UpdateAsync(state =>
        {
            var allowed = state.Records.Where(visible).ToArray();
            var items = allowed.Where(r => (!responses || (Own(r, caller) && r.Delivery is { ReceivedAt: null }))
                && (query.State is null || (query.State == "history" ? r.State != "pending" : r.State == query.State))
                && (query.Subject is null || r.Input?.Subject?.Id == query.Subject)
                && (query.Task is null || r.Input?.Task?.Id == query.Task) && r.Sequence > after)
                .OrderBy(r => r.Sequence).Take(query.Limit + 1).ToArray();
            var page = items.Take(query.Limit).ToArray();
            return (state, new HostyDecisionPage(page, allowed.Count(r => r.State == "pending" && (!responses || Own(r, caller))),
                items.Length > query.Limit ? page[^1].Sequence.ToString(CultureInfo.InvariantCulture) + "." + binding : null));
        }, ct);
    }
    internal Task<HostyDecisionRecord> ResolveAsync(CoreCapabilityCaller caller, string id, HostyDecisionResolve input, CancellationToken ct = default)
        => Mutate(caller, id, input.RequestId, "resolve:" + CoreDecisionValidation.Fingerprint(input), CoreAppPermissions.DecisionsRespond, false, row =>
        {
            Revision(row, input.ExpectedRevision);
            if (row.State != "pending" || row.Input is null) throw CoreDecisionValidation.Conflict("This question no longer accepts answers.");
            CoreDecisionValidation.Answers(row.Input, input.Answers);
            return row with { State = "answered", Revision = row.Revision + 1, UpdatedAt = clock.UtcNow,
                Resolution = new(row.Revision + 1, caller.User.Id, caller.PrincipalId, input.Answers, clock.UtcNow),
                Delivery = new(row.Revision + 1), Continuation = new(1, null, "pending", clock.UtcNow) };
        }, ct);
    internal Task<HostyDecisionRecord> WithdrawAsync(CoreCapabilityCaller caller, string id, HostyDecisionWithdraw input, bool stale = false, CancellationToken ct = default)
        => Mutate(caller, id, input.RequestId, (stale ? "stale:" : "withdraw:") + CoreDecisionValidation.Fingerprint(input), CoreAppPermissions.DecisionsRequest, true, row =>
        {
            Revision(row, input.ExpectedRevision); CoreDecisionValidation.Text(input.Reason, 1000, "Reason", true);
            CoreDecisionValidation.Text(input.CurrentSubjectRevision, 200, "Current subject revision");
            if (row.State is not ("pending" or "answered") && !input.RemoveContent) throw CoreDecisionValidation.Conflict("This decision is already terminal.");
            var next = row with { State = stale ? "stale" : "withdrawn", Revision = row.Revision + 1, UpdatedAt = clock.UtcNow, Reason = input.Reason,
                Continuation = row.Continuation is null ? null : row.Continuation with { Revision = row.Continuation.Revision + 1,
                    State = "cancelled", Reason = stale ? "stale_input" : "cancelled", UpdatedAt = clock.UtcNow } };
            return input.RemoveContent ? next with { Input = null, Reason = null, ContentRemovedAt = clock.UtcNow,
                Resolution = next.Resolution is null ? null : next.Resolution with { Answers = new Dictionary<string, HostyDecisionAnswer>() },
                Delivery = null, Continuation = next.Continuation is null ? null : next.Continuation with { Outcome = null } } : next;
        }, ct);
    internal Task<HostyDecisionRecord> AckAsync(CoreCapabilityCaller caller, string id, HostyDecisionAck input, CancellationToken ct = default)
        => Mutate(caller, id, input.RequestId, "ack:" + CoreDecisionValidation.Fingerprint(input), CoreAppPermissions.DecisionsRequest, true, row =>
        {
            if (row.Delivery is null || row.Resolution?.Revision != input.ResolutionRevision)
                throw CoreDecisionValidation.Conflict("The response revision changed.");
            if (row.Delivery.ReceivedAt is not null) return row;
            return row with { Revision = row.Revision + 1, UpdatedAt = clock.UtcNow, Delivery = row.Delivery with { ReceivedAt = clock.UtcNow },
                Continuation = row.Continuation?.State != "pending" ? row.Continuation : row.Continuation with {
                    State = "received", Revision = row.Continuation.Revision + 1, UpdatedAt = clock.UtcNow } };
        }, ct);
    internal Task<HostyDecisionRecord> ContinueAsync(CoreCapabilityCaller caller, string id, HostyDecisionContinue input, CancellationToken ct = default)
        => Mutate(caller, id, input.RequestId, "continue:" + CoreDecisionValidation.Fingerprint(input), CoreAppPermissions.DecisionsRequest, true, row =>
        {
            CoreDecisionValidation.Uuid(input.CommandId); CoreDecisionValidation.Text(input.Outcome, 2000, "Outcome");
            if (input.Reason is not (null or "missing_authority" or "missing_provider" or "unknown_stop" or "unknown_admission"
                or "stale_input" or "unsupported_resume" or "paused" or "cancelled" or "provider_failed")) throw CoreDecisionValidation.Invalid("Unknown continuation reason.");
            var current = row.Continuation ?? throw CoreDecisionValidation.Conflict("There is no response to continue.");
            if (current.Revision != input.ExpectedRevision || (current.CommandId is not null && current.CommandId != input.CommandId))
                throw CoreDecisionValidation.Conflict("The continuation changed; reconcile the original command.");
            if (row.State != "answered" || row.Delivery?.ReceivedAt is null) throw CoreDecisionValidation.Conflict("Receive an actionable response before continuing.");
            var allowed = current.State switch {
                "received" => new[] { "blocked", "admitted", "cancelled", "failed" },
                "blocked" => ["blocked", "admitted", "cancelled", "failed"],
                "admitted" => ["running", "blocked", "failed", "cancelled"],
                "running" => ["completed", "blocked", "failed", "cancelled"],
                _ => Array.Empty<string>() };
            if (!allowed.Contains(input.State, StringComparer.Ordinal) || (input.State == "blocked" && input.Reason is null))
                throw CoreDecisionValidation.Conflict("Invalid continuation transition.");
            return row with { Revision = row.Revision + 1, UpdatedAt = clock.UtcNow,
                Continuation = new(current.Revision + 1, input.CommandId, input.State, clock.UtcNow, input.Reason, input.Outcome) };
        }, ct);

    private async Task<HostyDecisionRecord> Mutate(CoreCapabilityCaller caller, string id, string requestId, string fingerprint,
        string permission, bool own, Func<HostyDecisionRecord, HostyDecisionRecord> change, CancellationToken ct)
    {
        Require(caller, permission); var visible = await Visibility(caller, ct); await Expire(ct);
        var key = ReplayKey(caller, requestId); fingerprint = id + ":" + fingerprint;
        var result = await store.UpdateAsync(state =>
        {
            var row = state.Records.SingleOrDefault(r => r.Id == id && visible(r) && (!own || Own(r, caller)))
                ?? throw CoreDecisionValidation.Missing();
            if (Replay(state, key, fingerprint, visible) is { } replay) return (state, replay);
            return Save(state, change(row), key, fingerprint);
        }, ct);
        events.PublishDecision(result.UserId); return result;
    }
    private static void Revision(HostyDecisionRecord row, long expected)
    { if (row.Revision != expected) throw CoreDecisionValidation.Conflict("The decision changed; refresh it before answering."); }
    private static string ReplayKey(CoreCapabilityCaller caller, string requestId)
        => caller.User.Id + ":" + Source(caller) + ":" + CoreDecisionValidation.Uuid(requestId);
    private static HostyDecisionRecord? Replay(CoreDecisionState state, string key, string fingerprint, Func<HostyDecisionRecord, bool> visible)
    {
        var receipt = state.Replays.SingleOrDefault(r => r.Key == key);
        if (receipt is null) return null;
        var current = state.Records.Single(r => r.Id == receipt.DecisionId);
        if (!visible(current)) throw CoreDecisionValidation.Missing();
        if (receipt.Fingerprint != fingerprint) throw CoreDecisionValidation.Conflict("This request ID was already used with different input.");
        return receipt.Result ?? current;
    }
    private static (CoreDecisionState, HostyDecisionRecord) Save(CoreDecisionState state, HostyDecisionRecord row, string key, string fingerprint)
        => (state with { Records = [.. state.Records.Where(r => r.Id != row.Id), row],
            Replays = [.. state.Replays.Select(receipt => row.ContentRemovedAt is not null && receipt.DecisionId == row.Id ? receipt with { Result = null } : receipt),
                new(key, fingerprint, row.Id, row.ContentRemovedAt is null ? row : null)] }, row);
}
