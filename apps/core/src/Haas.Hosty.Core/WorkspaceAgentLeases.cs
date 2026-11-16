namespace Haas.Hosty.Core;

internal sealed partial class DevelopmentWorkspaceService
{
    internal async Task<WorkspaceActivityReceipt> AgentLeaseActivityAsync(string id, WorkspaceOwner actor, WorkspaceActivityRequest input, CancellationToken ct)
    {
        if (input.Status is not ("idle" or "failed" or "running" or "awaiting_approval" or "awaiting_question" or "stopping" or "unknown"))
            throw Error("activity_invalid", "Supply a bounded execution state.");
        var tree = await Read(id, actor, ct);
        if (input.LeaseId is null) throw Error("lease_invalid", "An execution lease is required.");
        RequireLeaseOwner(tree, actor, input.LeaseId);
        if ((await SessionParticipationAsync(actor, ct))?.Id == tree.WorkspaceId) return await SessionActivityAsync(actor, input, ct);
        var stop = false;
        try { await RequireOpenWorkflow(tree.Owner, ct); } catch (AppLifecycleException) { stop = true; }
        return new(tree.WorkspaceId, (await ReadParticipationAsync(tree.WorkspaceId, ct))?.Revision, stop, stop ? "stopping" : input.Status);
    }
    // The bridge authenticates the exact persisted tuple. Releasing one known consumer must remain
    // possible after revocation and must preserve independently active repository consumers.
    internal Task<WorkspaceActivityReceipt> ReleaseAgentLeaseAsync(string worktreeId, WorkspaceOwner actor, string leaseId, CancellationToken ct)
        => Locked("workspace-participation", async () =>
        {
            var initial = await Read(worktreeId, null, ct);
            return await Locked(Hash(OwnerIdentity(initial.Owner)), async () =>
            {
                var tree = await Read(worktreeId, null, ct);
                if (tree.Leases.Contains(leaseId))
                {
                    RequireLeaseOwner(tree, actor, leaseId);
                    await Save(tree with { Leases = tree.Leases.Where(id => id != leaseId).ToArray(), LeaseClaims = tree.LeaseClaims?.Where(c => c.Id != leaseId).ToArray() });
                }
                var participation = await ReadParticipationAsync(tree.WorkspaceId, ct);
                var binding = participation?.Sessions.SingleOrDefault(s => s.Session.SameIdentity(actor));
                var state = "idle";
                if (binding is not null)
                {
                    var remaining = (await ListAsync(null, true, ct)).Workspaces.Where(t => t.WorkspaceId == participation!.Id)
                        .SelectMany(t => t.LeaseClaims ?? []).FirstOrDefault(c => c.Session.SameIdentity(actor));
                    binding = binding with { LeaseId = remaining?.Id, Status = remaining is null ? "idle" : binding.Status, ActivityAt = clock.UtcNow, ChangedAt = clock.UtcNow };
                    state = binding.Status;
                    await SaveParticipationAsync(participation! with { Sessions = participation.Sessions.Select(s => s.Session.SameIdentity(actor) ? binding : s).ToArray() }, ct);
                }
                var stop = false;
                try { await RequireWorkspaceUserAsync(actor.UserId, ct); await RequireOpenWorkflow(tree.Owner, ct); } catch (AppLifecycleException) { stop = true; }
                return new WorkspaceActivityReceipt(tree.WorkspaceId, participation?.Revision, stop, state);
            }, ct);
        }, ct);
}
