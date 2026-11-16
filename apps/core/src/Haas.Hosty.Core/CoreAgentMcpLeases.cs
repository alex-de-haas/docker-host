namespace Haas.Hosty.Core;

internal sealed partial class CoreAgentExecution
{
    internal async Task McpLease(CoreCallerAuthority? origin, string userId, WorkspaceOwner actor, string requestId,
        string leaseId, DevelopmentWorkspace? tree, CancellationToken ct)
    {
        if (origin?.Mcp?.AgentAdmissionRef is not { } reference) return;
        if (!Guid.TryParse(requestId, out _) || !Guid.TryParse(leaseId, out _)) throw Invalid("Use stable request and lease UUIDs.");
        var record = await store.Get(reference, ct);
        var provider = await apps.GetAppAsync(actor.AppId, ct) ?? throw new AppIdentityException("permission_denied", "The provider installation changed.");
        var (_, caller) = await ValidateRecord(provider, record, ct);
        caller.Require(AccessTokenScopes.McpWorkspaces, CoreAppPermissions.Sources);
        if (userId != record.UserId || actor.UserId != record.UserId || actor.Installation != provider.InstalledAt
            || actor.SessionId != record.Request.SessionId) throw new AppIdentityException("permission_denied", "The workspace lease is outside this admitted execution.");
        var revision = tree is null ? (long?)null : (await workspaces.ParticipationAsync(tree.WorkspaceId, record.UserId, ct)).Revision;
        await store.RecordLease(reference, new(tree?.WorkspaceId ?? "", tree?.Id ?? "", actor.SessionId, leaseId, requestId, Revision: revision), ct);
    }
    private async Task<CoreAgentWorkspaceResult> ReleaseAll(AppRecord provider, CoreAgentAuthorization record, string? requestId, CancellationToken ct)
    {
        if (!Guid.TryParse(requestId, out _) || record.Request.SessionId is not { } sessionId) throw Invalid("Use a stable cleanup UUID and admitted session.");
        var actor = new WorkspaceOwner(provider.Id, provider.InstalledAt, record.UserId, sessionId);
        foreach (var lease in record.Leases ?? [])
        {
            if (lease.Released) continue;
            // Only UUIDs durably retained before the original MCP effect are recovered. Session-wide
            // discovery could collect a later run's consumers, so never use it as cleanup authority.
            var trees = (await workspaces.ListAsync(null, true, ct)).Workspaces.Where(t =>
                (lease.WorktreeId.Length == 0 || t.Id == lease.WorktreeId)
                && t.LeaseClaims?.Any(c => c.Id == lease.LeaseId && c.Session.SameIdentity(actor)) == true).ToArray();
            foreach (var tree in trees) await workspaces.ReleaseAgentLeaseAsync(tree.Id, actor, lease.LeaseId, ct);
            await store.Change(record.Id, current => current with { Leases = current.Leases?.Select(l => l.LeaseId == lease.LeaseId ? l with { Released = true } : l).ToArray() }, ct);
        }
        return new(record.Id, 0, "", State: "released");
    }
}
