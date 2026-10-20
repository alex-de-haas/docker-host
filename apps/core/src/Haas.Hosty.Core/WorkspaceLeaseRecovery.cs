namespace Haas.Hosty.Core;

internal sealed record WorkspaceLeaseRecovery(string RequestId, string ExpectedHead, string LeaseId,
    bool ConsumerExitConfirmed);

internal sealed partial class DevelopmentWorkspaceService
{
    // Operator recovery is separate from the external principal's ordinary lease-release API.
    // Closing admission fences new managed work; native execution still requires human verification.
    internal async Task<DevelopmentWorkspace> RecoverExternalLeaseAsync(string id, WorkspaceOwner owner,
        string actor, WorkspaceLeaseRecovery input, CancellationToken ct)
        => await Locked(Hash(OwnerIdentity(owner)), async () =>
        {
            RequestId(input.RequestId);
            var tree = await Read(id, owner, ct);
            if (!owner.IsExternal || owner.UserId != actor)
                throw Error("forbidden", "Only the external workspace's operator can recover its activity lease.");
            var fingerprint = Hash(actor + "\n" + CoreJson.Text(input));
            var prior = tree.Operations.FirstOrDefault(o => o.Id == input.RequestId);
            if (prior is not null)
            {
                if (prior.Kind != "recover-lease" || prior.Fingerprint != fingerprint)
                    throw Error("request_conflict", "Reuse the original lease recovery request.");
                return tree;
            }
            if (!input.ConsumerExitConfirmed)
                throw Error("exit_unconfirmed", "Verify that the external agent and all native consumers have exited before recovering its lease.");
            if (!Guid.TryParse(input.LeaseId, out _) || !tree.Leases.Contains(input.LeaseId))
                throw Error("lease_invalid", "The selected activity lease is no longer present. Refresh this workspace.");
            var workflow = await WorkflowAsync(owner, ct);
            if (workflow.Closure is not ("closing" or "closed"))
                throw Error("close_required", "Close the workspace first to block new managed work.");
            if (tree.State != "active" || tree.Operations.Any(o => o.State is "pending" or "unknown"))
                throw Error("operation_pending", "Recover outstanding source operations before releasing an abandoned lease.");
            await ValidateTree(tree, ct);
            tree = await Observe(tree, ct);
            if (tree.Observation?.State != "ok" || string.IsNullOrWhiteSpace(input.ExpectedHead) || input.ExpectedHead != tree.Observation.Head)
                throw Error("stale_head", "Workspace HEAD changed or is unavailable. Review the source before recovery.");
            return await Locked("workspace-consumers", async () =>
            {
                // Ignore only the activity markers, not sandbox, dev-mode, service or worker consumers.
                foreach (var app in await apps.ListAppRecordsAsync(ct))
                    if (processes?.Conflict(app.Id) is not null)
                        throw Error("consumer_unavailable", "A local service has unverified process ownership. Resolve its recovery before releasing the lease.");
                await CheckConsumers(tree with { Leases = [] }, ct);
                var receipt = new WorkspaceOperation(input.RequestId, "recover-lease", fingerprint, "succeeded",
                    tree.Observation.Head, tree.Observation.Head, Command: new(input.RequestId, input.ExpectedHead,
                        Message: "Operator " + actor + " confirmed external consumer exit.", LeaseId: input.LeaseId));
                tree = tree with { Leases = tree.Leases.Where(l => l != input.LeaseId).ToArray(),
                    Operations = [.. tree.Operations, receipt] };
                // One atomic record write commits both the release and its replay receipt.
                await Save(tree);
                return tree;
            }, ct);
        }, ct);
}
