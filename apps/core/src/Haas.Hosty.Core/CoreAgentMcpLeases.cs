namespace Haas.Hosty.Core;

internal sealed partial class CoreAgentExecution
{
    internal async Task<DevelopmentWorkspace> McpLease(CoreCallerAuthority? origin, string userId, WorkspaceOwner actor,
        string requestId, string leaseId, Func<Task<DevelopmentWorkspace>> acquire, CancellationToken ct)
    {
        if (origin?.Mcp?.AgentAdmissionRef is not { } reference) return await acquire();
        return await store.WithWorkspaceLease(reference, async _ =>
        {
            await RecordMcpLease(origin, userId, actor, requestId, leaseId, null, ct);
            var tree = await acquire();
            await RecordMcpLease(origin, userId, actor, requestId, leaseId, tree, ct);
            return tree;
        }, ct);
    }
    internal async Task<DevelopmentWorkspace> McpRelease(CoreCallerAuthority? origin, string userId, WorkspaceOwner actor,
        string workspaceId, string requestId, string leaseId, Func<Task<DevelopmentWorkspace>> release, CancellationToken ct)
    {
        if (origin?.Mcp?.AgentAdmissionRef is not { } reference) return await release();
        return await store.WithWorkspaceLease(reference, async _ =>
        {
            var record = await McpLeaseRecord(origin, userId, actor, requestId, leaseId, ct);
            var lease = record.Leases?.SingleOrDefault(l => l.LeaseId == leaseId && l.SessionId == actor.SessionId);
            if (lease is null || lease.WorktreeId.Length > 0 && lease.WorktreeId != workspaceId)
                throw new AppIdentityException("permission_denied", "Use the exact workspace, session and lease of this execution.");
            var trees = (await workspaces.ListAsync(null, true, ct)).Workspaces;
            if (trees.Any(t => t.Id != workspaceId && t.LeaseClaims?.Any(c => c.Id == leaseId && c.Session.SameIdentity(actor)) == true)
                || trees.SingleOrDefault(t => t.Id == workspaceId)?.LeaseClaims?.Any(c => c.Id == leaseId && !c.Session.SameIdentity(actor)) == true)
                throw new AppIdentityException("permission_denied", "The recorded lease belongs to another workspace or consumer.");
            var tree = await release();
            if (tree.Id != workspaceId || tree.Leases.Contains(leaseId))
                throw new CoreProviderException("execution_conflict", "Workspace lease removal was not confirmed.", 409);
            await store.Change(reference, current => current with { Leases = current.Leases?.Select(l => l.LeaseId == leaseId ? l with { Released = true } : l).ToArray() }, ct);
            return tree;
        }, ct);
    }
    private async Task<CoreAgentAuthorization> McpLeaseRecord(CoreCallerAuthority? origin, string userId, WorkspaceOwner actor,
        string requestId, string leaseId, CancellationToken ct)
    {
        if (origin?.Mcp?.AgentAdmissionRef is not { } reference)
            throw new AppIdentityException("permission_denied", "An admitted execution is required.");
        if (!Guid.TryParse(requestId, out _) || !Guid.TryParse(leaseId, out _)) throw Invalid("Use stable request and lease UUIDs.");
        var record = await store.Get(reference, ct);
        var provider = await apps.GetAppAsync(actor.AppId, ct) ?? throw new AppIdentityException("permission_denied", "The provider installation changed.");
        var (_, caller) = await ValidateRecord(provider, record, ct);
        caller.Require(AccessTokenScopes.McpWorkspaces, CoreAppPermissions.Sources);
        if (userId != record.UserId || actor.UserId != record.UserId || actor.Installation != provider.InstalledAt
            || actor.SessionId != record.Request.SessionId) throw new AppIdentityException("permission_denied", "The workspace lease is outside this admitted execution.");
        return record;
    }
    private async Task RecordMcpLease(CoreCallerAuthority? origin, string userId, WorkspaceOwner actor, string requestId,
        string leaseId, DevelopmentWorkspace? tree, CancellationToken ct)
    {
        var record = await McpLeaseRecord(origin, userId, actor, requestId, leaseId, ct);
        var revision = tree is null ? (long?)null : (await workspaces.ParticipationAsync(tree.WorkspaceId, record.UserId, ct)).Revision;
        await store.RecordLease(record.Id, new(tree?.WorkspaceId ?? "", tree?.Id ?? "", actor.SessionId, leaseId, requestId, Revision: revision), ct);
    }
    private async Task<CoreAgentWorkspaceResult> ReleaseAll(AppRecord provider, CoreAgentAuthorization record, string? requestId, CancellationToken ct)
    {
        if (!Guid.TryParse(requestId, out _) || record.Request.SessionId is not { } sessionId) throw Invalid("Use a stable cleanup UUID and admitted session.");
        var actor = new WorkspaceOwner(provider.Id, provider.InstalledAt, record.UserId, sessionId);
        // Once cleanup is admitted, cancellation must not reopen acquisition after restart.
        if (!record.WorkspaceLeasesClosed)
            record = await store.Change(record.Id, current => current with { WorkspaceLeasesClosed = true }, CancellationToken.None);
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
