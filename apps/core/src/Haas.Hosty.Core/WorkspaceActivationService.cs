using Haas.Hosty.Launch;

namespace Haas.Hosty.Core;

internal sealed record WorkspaceActivationRequest(string RequestId, string UserId, WorkspaceActivationSelection Selection);
internal sealed class WorkspaceActivationService(CoreDataPaths paths, WorkspaceActivationPlanner planner,
    CoreDevelopmentService core, CoreLifecycleService lifecycle, DevelopmentWorkspaceService workspaces)
{
    private readonly SemaphoreSlim gate = new(1, 1);

    internal async Task<WorkspaceRuntimeActivation> PrepareAsync(string workspaceId, WorkspaceActivationRequest input, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            var file = WorkspaceRuntimeFiles.PathFor(paths.DataRoot, input.RequestId);
            var fingerprint = DevelopmentWorkspaceService.Hash(workspaceId + "\n" + CoreJson.Text(input));
            var prior = File.Exists(file) ? WorkspaceRuntimeFiles.Read(paths.DataRoot, input.RequestId) : null;
            if (prior is not null && prior.Fingerprint != fingerprint) throw Error("request_conflict", "Preserve the original request ID and selection.");
            if (prior is { Phase: "prepared" })
            {
                var unchanged = true;
                foreach (var pair in prior.SourceStamps ?? new Dictionary<string, string>())
                {
                    var tree = await workspaces.ObserveAsync(pair.Key, null, ct);
                    unchanged &= tree.Observation?.State == "ok" && tree.SourceStamp == pair.Value;
                }
                if (unchanged) return prior;
                prior = prior with { Phase = "preparing" };
            }
            if (prior is { Phase: not "preparing" }) return prior;
            var plan = await planner.PlanAsync(workspaceId, input.UserId, input.Selection, ct);
            foreach (var row in plan.Participants.Where(p => p.Kind == "app" && p.Unavailable is not null))
                if (input.Selection.Apps?.Any(c => c.AppId == row.Id && !c.Selected) != true)
                    throw Error("participant_unavailable", row.Name + ": " + row.Unavailable + " Exclude it explicitly to continue.");
            var selected = plan.Participants.Where(p => p.Selected).ToArray();
            if (selected.Length == 0) throw Error("empty", "Select at least one available participant.");
            var coreRow = selected.SingleOrDefault(p => p.Kind == "core");
            var rows = selected.Where(p => p.Kind == "app").ToArray();
            var ids = rows.Select(p => p.Id).Order(StringComparer.Ordinal).ToArray();
            var state = await core.GetAsync(ct);
            var activation = prior ?? new WorkspaceRuntimeActivation(input.RequestId, workspaceId, input.UserId, fingerprint,
                plan.CoreInstance, plan.CoreSourceRevision, coreRow?.WorktreeId, coreRow?.SourcePath, state.Launch, ids, "preparing");
            if (state.Instance != activation.CoreInstance || state.Source.Revision != activation.CoreSourceRevision)
                throw Error("core_changed", "Core or its source selection changed. Inspect the retained activation before proceeding.");
            if (coreRow is not null)
            {
                await ValidateCoreTreeAsync(activation, ct);
                if (WorkspaceRuntimeFiles.List(paths.DataRoot).Any(a => a.Id != activation.Id && a.CoreProject is not null && a.Phase is not ("returned" or "cancelled")))
                    throw Error("core_owned", "Another activation owns Core. Return it before switching again.");
            }
            return await lifecycle.WithActivationAppLocksAsync(ids, async () =>
            {
                var order = await lifecycle.OrderActivationAppsAsync(ids, ct);
                var plans = await lifecycle.PreflightActivationAppsAsync(activation, rows, ct);
                activation = activation with { Apps = order, Error = null };
                WorkspaceRuntimeFiles.Save(paths.DataRoot, activation);
                try
                {
                    foreach (var app in plans) await lifecycle.PrepareActivationAppAsync(activation, app, ct);
                    var stamps = new Dictionary<string, string>(StringComparer.Ordinal);
                    foreach (var treeId in selected.Select(p => p.WorktreeId!).Distinct())
                    {
                        var tree = await workspaces.ObserveAsync(treeId, null, ct);
                        if (tree.Observation?.State != "ok" || tree.SourceStamp is null) throw Error("source_unavailable", "Cannot record prepared source identity.");
                        stamps[treeId] = tree.SourceStamp;
                    }
                    activation = activation with { Phase = "prepared", SourceStamps = stamps };
                    WorkspaceRuntimeFiles.Save(paths.DataRoot, activation);
                    return activation;
                }
                catch
                {
                    await lifecycle.ReleaseActivationPreparationAsync(activation, CancellationToken.None);
                    WorkspaceRuntimeFiles.Save(paths.DataRoot, activation with { Error = "Preparation failed; running services were not stopped. Inspect build diagnostics and retry the original request." });
                    throw;
                }
            }, ct);
        }
        finally { gate.Release(); }
    }

    internal async Task<WorkspaceRuntimeActivation> ReleasePreparationAsync(string id, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            var activation = WorkspaceRuntimeFiles.Read(paths.DataRoot, id);
            if (activation.Phase is not ("prepared" or "preparing"))
                throw Error("preparation_in_use", "Only pre-Stop preparation can be released for source repair.");
            return await lifecycle.WithActivationAppLocksAsync(activation.Apps.Order(StringComparer.Ordinal).ToArray(), async () =>
            {
                await lifecycle.ReleaseActivationPreparationAsync(activation, ct);
                var current = await core.GetAsync(ct);
                // Releasing a pre-Stop request from a replaced Core retires its stale review.
                var phase = current.Instance == activation.CoreInstance && current.Source.Revision == activation.CoreSourceRevision ? "preparing" : "returned";
                activation = activation with { Phase = phase, SourceStamps = null, PreparedExecutable = null, Generation = null };
                WorkspaceRuntimeFiles.Save(paths.DataRoot, activation);
                return activation;
            }, ct);
        }
        finally { gate.Release(); }
    }

    internal async Task<WorkspaceRuntimeActivation> ApplyAppsAsync(string id, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            var activation = WorkspaceRuntimeFiles.Read(paths.DataRoot, id);
            if (activation.Phase == "active") return activation;
            if (activation.Phase is not ("prepared" or "applying" or "apps-active")) throw Error("not_prepared", "Prepare every participant before activation.");
            if (activation.CoreProject is not null && (activation.PreparedExecutable is null || !File.Exists(activation.PreparedExecutable)))
                throw Error("core_not_built", "Build Core before stopping any selected application.");
            var state = await core.GetAsync(ct);
            if (state.Source.Revision != activation.CoreSourceRevision ||
                (activation.Phase == "prepared" ? state.Instance != activation.CoreInstance :
                    !WorkspaceActivationHandover.SameTarget(activation.PreviousCore, state.Launch)))
                throw Error("core_changed", "Core or its source selection changed after preparation.");
            if (activation.CoreProject is not null) await ValidateCoreTreeAsync(activation, ct);
            if (activation.Phase == "prepared")
                foreach (var pair in activation.SourceStamps ?? new Dictionary<string, string>())
                {
                    var tree = await workspaces.ObserveAsync(pair.Key, null, ct);
                    if (tree.Observation?.State != "ok" || tree.SourceStamp != pair.Value)
                        throw Error("source_changed", "Source changed after preparation. No runtime was stopped; prepare a fresh review before applying.");
                }
            if (activation.Phase == "apps-active") return activation;
            return await lifecycle.WithActivationAppLocksAsync(activation.Apps.Order(StringComparer.Ordinal).ToArray(), async () =>
            {
                foreach (var app in activation.Apps) await lifecycle.ValidateActivationAppAsync(activation, app, ct);
                _ = await lifecycle.OrderActivationAppsAsync(activation.Apps, ct);
                ct.ThrowIfCancellationRequested();
                // An admitted local transition does not belong to the HTTP connection lifetime.
                ct = CancellationToken.None;
                activation = activation with { Phase = "applying", Error = null };
                WorkspaceRuntimeFiles.Save(paths.DataRoot, activation);
                try
                {
                    foreach (var app in activation.Apps.Reverse())
                    {
                        WorkspaceActivationSupervisor.CheckCancellation(paths.DataRoot, id);
                        await lifecycle.StopActivationAppAsync(app, ct);
                    }
                    foreach (var app in activation.Apps)
                    {
                        WorkspaceActivationSupervisor.CheckCancellation(paths.DataRoot, id);
                        await lifecycle.ApplyActivationAppAsync(app, backupOnly: true, ct);
                    }
                    foreach (var app in activation.Apps)
                    {
                        WorkspaceActivationSupervisor.CheckCancellation(paths.DataRoot, id);
                        await lifecycle.ApplyActivationAppAsync(app, backupOnly: false, ct);
                        await lifecycle.VerifyActivationAppAsync(activation, app, ct);
                    }
                    activation = activation with { Phase = activation.CoreProject is null ? "active" : "apps-active" };
                    WorkspaceRuntimeFiles.Save(paths.DataRoot, activation);
                    return activation;
                }
                catch
                {
                    WorkspaceRuntimeFiles.Save(paths.DataRoot, activation with { Error = "Activation stopped at a failed boundary. Inspect participant journals; source and current data are retained." });
                    throw;
                }
            }, ct);
        }
        finally { gate.Release(); }
    }

    internal async Task<WorkspaceActivationDetail> StatusAsync(string id, CancellationToken ct)
    {
        var status = WorkspaceActivationSupervisor.Status(paths.DataRoot, id);
        var children = new List<AppDevStatus>();
        foreach (var app in status.Activation.Apps) children.Add(await lifecycle.GetDevModeAsync(app, ct));
        return new(status, children.ToArray());
    }

    internal async Task<WorkspaceRuntimeActivation> VerifyAppsAsync(string id, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            var activation = WorkspaceRuntimeFiles.Read(paths.DataRoot, id);
            return await lifecycle.WithActivationAppLocksAsync(activation.Apps.Order(StringComparer.Ordinal).ToArray(), async () =>
            {
                foreach (var app in activation.Apps) await lifecycle.VerifyActivationAppAsync(activation, app, ct);
                return activation;
            }, ct);
        }
        finally { gate.Release(); }
    }

    private async Task ValidateCoreTreeAsync(WorkspaceRuntimeActivation activation, CancellationToken ct)
    {
        var tree = await workspaces.ObserveAsync(activation.CoreWorktreeId!, null, ct);
        if (tree.Owner.UserId != activation.UserId || tree.WorkspaceId != activation.WorkspaceId || tree.State != "active" ||
            tree.Leases.Length != 0 || tree.Operations.Any(o => o.State is "pending" or "unknown") || tree.Observation?.State != "ok")
            throw Error("core_source_busy", "Pause workspace writers and resolve pending Git operations before switching Core.");
        var source = await core.SourceSettingsAsync(ct);
        if (source.RepositoryUrl is null || core.NormalizeRepository(source.RepositoryUrl) != core.NormalizeRepository(tree.Repository) ||
            CoreDevelopmentService.Project(tree.Path, source.ProjectPath) != activation.CoreProject)
            throw Error("core_source_changed", "Core no longer matches the selected repository/project.");
        _ = await core.SourceGrantAsync(source, activation.UserId, ct);
    }

    private static AppLifecycleException Error(string code, string message) => new("activation_" + code, message);
}

internal sealed record WorkspaceActivationDetail(WorkspaceActivationStatus Status, AppDevStatus[] Children);
