namespace Haas.Hosty.Core;

internal sealed partial class DevelopmentWorkspaceService
{
    // Read each owned receipt independently so a damaged workspace cannot stop another's cleanup.
    internal async IAsyncEnumerable<WorkspaceDiscardJournal> ConfirmedDeletionsAsync(
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        var directory = Path.Combine(DiscardRoot, "pending");
        if (!Directory.Exists(directory)) yield break;
        RequireDiscardStorage(directory);
        foreach (var marker in Directory.EnumerateFiles(directory, "*.json"))
        {
            ct.ThrowIfCancellationRequested();
            var path = Path.Combine(DiscardRoot, "operations", Path.GetFileName(marker));
            WorkspaceDiscardJournal? validated;
            try
            {
                RequireDiscardStorage(path);
                var candidate = await JsonStorage.ReadAsync<WorkspaceDiscardJournal>(path, ct);
                if (candidate?.DeleteOwner is null || candidate.Command is null || candidate.State != "pending" &&
                    (candidate.SessionsAccepted || candidate.SelectedSessions is not { Length: > 0 })) continue;
                if (path != DiscardJournalPath(candidate.WorkspaceId, candidate.Command.RequestId)) continue;
                validated = await ReadDiscardAsync(candidate.WorkspaceId, candidate.Command.RequestId, candidate.Actor, ct);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Text.Json.JsonException or AppLifecycleException)
            { continue; }
            if (validated is not null) yield return validated;
        }
    }
}

internal sealed partial class WorkspaceCleanupService
{
    internal async Task<WorkspaceWriterStop[]> WriterStopsAsync(string app, DateTimeOffset installation, CancellationToken ct)
    {
        var result = new List<WorkspaceWriterStop>();
        await foreach (var journal in workspaces.ConfirmedDeletionsAsync(ct))
            if (journal.State == "pending")
                result.AddRange((journal.Writers ?? []).Where(w => w.Consumer == app && w.Installation == installation));
        return result.DistinctBy(w => w.AdmissionRef).ToArray();
    }

    internal async Task<WorkspaceChatRemoval[]> ChatRemovalsAsync(string app, DateTimeOffset installation, CancellationToken ct)
    {
        var result = new List<WorkspaceChatRemoval>();
        await foreach (var journal in workspaces.ConfirmedDeletionsAsync(ct))
        {
            if (journal.DeleteOwner is not { RemoveAttachedSessions: true } owner || owner.AppId != app ||
                owner.Installation != installation || journal.SessionsAccepted || journal.SelectedSessions is not { Length: > 0 } sessions) continue;
            result.Add(new(journal.WorkspaceId, journal.Command.RequestId, journal.Actor, sessions));
            if (result.Count == 64) break;
        }
        return result.ToArray();
    }

    internal async Task<bool> AcceptChatRemovalsAsync(string app, DateTimeOffset installation, string workspaceId, string requestId, CancellationToken ct)
    {
        var gate = gates.GetOrAdd(workspaceId, _ => new(1, 1));
        await gate.WaitAsync(ct);
        try
        {
            var journal = await workspaces.ReadDiscardAsync(workspaceId, requestId, "", ct);
            if (journal?.DeleteOwner is not { RemoveAttachedSessions: true } owner || owner.AppId != app || owner.Installation != installation)
                throw DevelopmentWorkspaceService.Error("not_found", "The installation has no matching removal delivery.");
            if (!journal.SessionsAccepted) await workspaces.SaveDiscardAsync(journal with { SessionsAccepted = true, SelectedSessions = null });
            return true;
        }
        finally { gate.Release(); }
    }

    internal async Task RecoverDeletesAsync(CancellationToken ct)
    {
        await foreach (var journal in workspaces.ConfirmedDeletionsAsync(ct))
        {
            if (journal.State != "pending" || journal.DeleteOwner is not { } owner) continue;
            try
            {
                if (owner.AppId is not null && (await apps.GetAppAsync(owner.AppId, ct))?.InstalledAt != owner.Installation) continue;
                await ApplyDeleteAsync(journal.WorkspaceId, journal.Actor, owner.AppId, new(journal.Command.RequestId, owner.RemoveAttachedSessions, owner.Returns?.Select(t => t.Key).ToArray()), ct);
            }
            catch (Exception ex) when (ex is IOException or HttpRequestException or AppLifecycleException or AppIdentityException or UnauthorizedAccessException or SandboxException)
            { /* The original receipt and allocation stay available for the next pass. */ }
        }
    }
}

internal sealed partial class CoreAgentAuthorizationStore
{
    // A workspace administrator can retire an activity marker. The admitted writer still
    // owns its separate cleanup obligation against this immutable worktree allocation.
    internal static bool HasWriterClaim(CoreAgentAuthorization admission, DevelopmentWorkspace[] trees, string? leaseId = null)
    {
        return admission.Leases?.Any(lease => !lease.Released && lease.SessionId == admission.Request.SessionId
            && (leaseId is null || lease.LeaseId == leaseId) && trees.Any(tree => lease.WorktreeId.Length > 0
                ? lease.WorkspaceId == tree.WorkspaceId && lease.WorktreeId == tree.Id
                : tree.LeaseClaims?.Any(claim => claim.Id == lease.LeaseId && claim.Session.UserId == admission.UserId
                    && claim.Session.AppId == admission.Request.Provider.AppId && claim.Session.SessionId == lease.SessionId
                    && claim.Session.Installation.ToString("O") == admission.Request.Provider.InstallationId) == true)) == true;
    }

    internal async Task<WorkspaceWriterStop[]> WorkspaceWritersAsync(DevelopmentWorkspace[] trees, CancellationToken ct, WorkspaceLeaseClaim? selectedClaim = null)
    {
        var directory = Path.Combine(paths.CoreRoot, "agent-authorizations");
        if (!Directory.Exists(directory)) return [];
        var writers = new List<WorkspaceWriterStop>();
        foreach (var path in Directory.EnumerateFiles(directory, "*.json"))
        {
            ct.ThrowIfCancellationRequested();
            var a = await JsonStorage.ReadAsync<CoreAgentAuthorization>(path, ct);
            if (a?.Request is not { Operation: "runs.start", RunId: { } run, SessionId: not null } request) continue;
            if (selectedClaim is not null && (selectedClaim.Session.UserId != a.UserId || selectedClaim.Session.SessionId != request.SessionId
                || selectedClaim.Session.AppId != request.Provider.AppId || selectedClaim.Session.Installation.ToString("O") != request.Provider.InstallationId)) continue;
            if (HasWriterClaim(a, trees, selectedClaim?.Id))
                writers.Add(new(a.CallerAppId, a.CallerInstallation, request.Provider, a.Id, run));
        }
        return writers.ToArray();
    }
}
