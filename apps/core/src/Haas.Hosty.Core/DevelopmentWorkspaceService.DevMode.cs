namespace Haas.Hosty.Core;

internal sealed partial class DevelopmentWorkspaceService
{
    internal async Task CheckDevTreeAsync(DevelopmentWorkspace tree, AppRecord app, WorkspaceOwner? actor, CancellationToken ct)
    {
        if (tree.State != "active" || tree.Operations.Any(o => o.State is "pending" or "unknown") ||
            !tree.Apps.Any(a => a.AppId == app.Id && a.Installation == app.InstalledAt))
            throw Error("source_changed", "The worktree must be active, attached to this installation and free of uncertain Git operations.");
        if (actor is not null && !tree.Owner.SameIdentity(actor)) throw Error("forbidden", "Use the current session's own worktree.");
        if (actor is null && tree.Leases.Length > 0) throw Error("in_use", "Pause active workspace writers before a manual source transition.");
        await RequireOpenWorkflow(tree.Owner, ct);
        await RequireSourceInstallationAsync(tree, ct);
        await ValidateTree(tree, ct);
        await WorkspaceGrantAsync(tree, ct);
    }

    internal async Task<T> WithDevAdmissionAsync<T>(string id, AppRecord app, WorkspaceOwner? actor, Func<Task<T>> action, CancellationToken ct, bool returning = false)
    {
        var tree = await Read(id, returning ? null : actor, ct);
        await Locked(Hash(OwnerIdentity(tree.Owner)), () => Locked("repository-admission:" + tree.RepositoryId, async () =>
        {
            tree = await Read(id, returning ? null : actor, ct);
            if (actor is not null && !tree.Owner.SameIdentity(actor)) throw Error("forbidden", "Use the current session's own worktree.");
            if (returning)
            {
                if (actor is null && tree.Leases.Length > 0) throw Error("in_use", "Pause workspace writers before a manual Return.");
                if (tree.Operations.Any(o => o.State is "pending" or "unknown")) throw Error("operation_pending", "Recover the pending Git operation before Return.");
                // Closing the workflow, source revocation or damaged source must not trap a runtime.
                // Return stops the consumer and keeps every source file; it grants no new source read.
            }
            else await CheckDevTreeAsync(tree, app, actor, ct);
            return true;
        }, ct), ct);
        // The app's persisted operation pointer is already present and blocks destructive Git and
        // cleanup/new writers during transition. Release repository admission before taking the
        // host-path gate (the normal source lock order), or stopping/starting Docker services.
        return await action();
    }

    private async Task RequireDevConsumerIdleAsync(DevelopmentWorkspace tree, CancellationToken ct, bool writer = false)
    {
        foreach (var app in await apps.ListAppRecordsAsync(ct))
            if (await AppDevStore.ReadAsync(paths, app, ct) is { Active: true } op && op.WorktreeId == tree.Id &&
                (!writer || op.Phase != "active"))
                throw Error("in_use", "An ordinary app development runtime consumes this worktree. Return before cleanup or destructive Git changes; recover a pending transition before starting writers.");
    }
}
