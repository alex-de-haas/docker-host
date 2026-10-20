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

    internal async Task<string[]> DevConsumerAppsAsync(DevelopmentWorkspace tree, CancellationToken ct)
    {
        var result = new List<string>();
        foreach (var app in await apps.ListAppRecordsAsync(ct))
            if (await AppDevStore.ReadAsync(paths, app, ct) is { Active: true } op && op.WorktreeId == tree.Id)
                result.Add(app.Id);
        if (CoreActivationConsumers(tree).Length > 0 || RunningCoreUses(tree)) result.Add("hosty:core");
        return result.ToArray();
    }

    internal async Task ReserveCoreActivationAsync(Haas.Hosty.Launch.WorkspaceRuntimeActivation activation, CancellationToken ct)
    {
        var tree = await Read(activation.CoreWorktreeId!, null, ct);
        await Locked(Hash(OwnerIdentity(tree.Owner)), () => Locked("repository-admission:" + tree.RepositoryId, async () =>
        {
            tree = await Read(tree.Id, null, ct);
            if (tree.Leases.Length > 0 || tree.State != "active" || tree.Operations.Any(o => o.State is "pending" or "unknown"))
                throw Error("in_use", "Pause workspace writers before reserving Core source.");
            await RequireOpenWorkflow(tree.Owner, ct);
            await WorkspaceGrantAsync(tree, ct);
            Haas.Hosty.Launch.WorkspaceRuntimeFiles.Save(paths.DataRoot, activation);
            return true;
        }, ct), ct);
    }

    internal Haas.Hosty.Launch.WorkspaceRuntimeActivation[] CoreActivationConsumers(DevelopmentWorkspace tree) =>
        Haas.Hosty.Launch.WorkspaceRuntimeFiles.List(paths.DataRoot).Where(a => a.CoreProject is not null && !a.CoreReturned &&
            a.Phase is not ("returned" or "cancelled") && (a.Phase != "preparing" || a.CoreReserved) &&
            (a.CoreWorktreeId == tree.Id || a.PreviousCore.ProjectPath is { } prior && IsUnder(tree.Path, prior))).ToArray();

    private bool RunningCoreUses(DevelopmentWorkspace tree) => coreDevelopment?.Launch.ProjectPath is { } project && IsUnder(tree.Path, project);

    private async Task RequireDevConsumerIdleAsync(DevelopmentWorkspace tree, CancellationToken ct, bool writer = false)
    {
        if (!writer && RunningCoreUses(tree))
            throw Error("in_use", "The running Core uses this worktree. Select another Core target before destructive Git or cleanup.");
        if (CoreActivationConsumers(tree).Any(a => !writer || a.Phase != "active"))
            throw Error("in_use", "Core consumes this worktree through a workspace activation. Return Core before destructive Git or cleanup; resume an interrupted transition before editing.");
        foreach (var app in await apps.ListAppRecordsAsync(ct))
            if (await AppDevStore.ReadAsync(paths, app, ct) is { Active: true } op && op.WorktreeId == tree.Id &&
                (!writer || op.Phase != "active"))
                throw Error("in_use", "An ordinary app development runtime consumes this worktree. Return before cleanup or destructive Git changes; recover a pending transition before starting writers.");
    }
}
