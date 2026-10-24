using Haas.Hosty.Launch;

namespace Haas.Hosty.Core;

internal sealed record WorkspaceActivationRequest(string RequestId, string UserId, WorkspaceActivationSelection Selection, string? PlanDigest = null, WorkspaceActivationActor? Authority = null);
internal sealed record WorkspaceActivationPreparationTarget(string Id, string Kind, string? WorktreeId, string? SourcePath, string? TargetRuntime);
internal sealed partial class WorkspaceActivationService(CoreDataPaths paths, WorkspaceActivationPlanner planner,
    CoreDevelopmentService core, CoreLifecycleService lifecycle, DevelopmentWorkspaceService workspaces, WorkspaceActivationAccess? access = null)
{
    private readonly SemaphoreSlim gate = new(1, 1);

    internal async Task<WorkspaceRuntimeActivation> PrepareAsync(string workspaceId, WorkspaceActivationRequest input, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            if (input.Authority is not null)
            {
                if (input.Authority.UserId != input.UserId || access is null) throw Error("authority_invalid", "Activation authority is unavailable.");
                await access.ValidateAsync(input.Authority, false, ct);
            }
            var file = WorkspaceRuntimeFiles.PathFor(paths.DataRoot, input.RequestId);
            var fingerprint = DevelopmentWorkspaceService.Hash(workspaceId + "\n" + CoreJson.Text(input));
            // A repaired source requires a new review, but retains its original selection and authority.
            var preparationIdentity = workspaceId + "\n" + CoreJson.Text(input with
            {
                PlanDigest = null,
                Authority = input.Authority is null ? null : input.Authority with { Review = null }
            });
            var prior = File.Exists(file) ? WorkspaceRuntimeFiles.Read(paths.DataRoot, input.RequestId) : null;
            if (prior is not null && input.Authority is not null) await access!.ValidateAsync(input.Authority, prior.CoreProject is not null && !prior.CoreReturned, ct);
            var refreshReview = prior is not null && prior.Fingerprint != fingerprint;
            if (refreshReview && !(prior is { Phase: "preparing", PreparationReleased: true, CoreReserved: false, PreparedExecutable: null,
                    Generation: null, Snapshot: null, ActivatedCore: null, CoreReturned: false } &&
                (prior.Returns?.Length ?? 0) == 0 && (prior.ReturnedApps?.Length ?? 0) == 0 &&
                prior.PreparationFingerprint is not null && input.PlanDigest is not null))
                throw Error("request_conflict", "Preserve the original request ID and selection; only released preparation can accept a new review.");
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
            if (input.PlanDigest is not null && input.PlanDigest != (await ReviewAsync(workspaceId, input.UserId, input.Selection, ct)).PlanDigest)
                throw Error("review_changed", "Authoritative inputs changed. Review the current selection again before admission.");
            foreach (var row in plan.Participants.Where(p => p.Kind == "app" && p.Unavailable is not null))
                if (input.Selection.Apps?.Any(c => c.AppId == row.Id && !c.Selected) != true)
                    throw Error("participant_unavailable", row.Name + ": " + row.Unavailable + " Exclude it explicitly to continue.");
            var selected = plan.Participants.Where(p => p.Selected).ToArray();
            if (selected.Length == 0) throw Error("empty", "Select at least one available participant.");
            var preparationFingerprint = DevelopmentWorkspaceService.Hash(preparationIdentity + "\n" + CoreJson.Text(
                selected.OrderBy(p => p.Id, StringComparer.Ordinal).Select(p => new WorkspaceActivationPreparationTarget(
                    p.Id, p.Kind, p.WorktreeId, p.SourcePath, p.TargetRuntime)).ToArray()));
            if (prior?.PreparationFingerprint is not null && prior.PreparationFingerprint != preparationFingerprint)
                throw Error("request_conflict", "The original request's resolved participants or authority changed. Return it before choosing another target.");
            if (refreshReview) prior = prior! with { Fingerprint = fingerprint, Authority = input.Authority };
            var coreRow = selected.SingleOrDefault(p => p.Kind == "core");
            if (prior is not null && (prior.CoreWorktreeId != coreRow?.WorktreeId || prior.CoreProject != coreRow?.SourcePath ||
                !prior.Apps.Order(StringComparer.Ordinal).SequenceEqual(selected.Where(p => p.Kind == "app").Select(p => p.Id).Order(StringComparer.Ordinal))))
                throw Error("request_conflict", "The original request's resolved participants changed. Return it before choosing another target.");
            if (input.Authority is not null) await access!.ValidateAsync(input.Authority, coreRow is not null, ct);
            var rows = selected.Where(p => p.Kind == "app").ToArray();
            var ids = rows.Select(p => p.Id).Order(StringComparer.Ordinal).ToArray();
            using var coreAdmission = coreRow is not null ? CoreLaunchFiles.Lock(paths.DataRoot) : null;
            var state = await core.GetAsync(ct);
            if (coreRow is not null)
            {
                WorkspaceCoreLaunchContinuation.Reconcile(paths.DataRoot, state.Launch);
                if (WorkspaceCoreLaunchContinuation.PendingGenerations(paths.DataRoot).Any())
                    throw Error("core_restart_pending", "Recover the retained Core restart before switching workspaces. Current Core was not stopped.");
                WorkspaceActivationHandover.ReconcileReplacements(paths.DataRoot);
            }
            var activation = prior ?? new WorkspaceRuntimeActivation(input.RequestId, workspaceId, input.UserId, fingerprint,
                plan.CoreInstance, plan.CoreSourceRevision, coreRow?.WorktreeId, coreRow?.SourcePath, state.Launch, ids, "preparing",
                Authority: input.Authority, PreparationFingerprint: preparationFingerprint);
            if (state.Instance != activation.CoreInstance || state.Source.Revision != activation.CoreSourceRevision)
                throw Error("core_changed", "Core or its source selection changed. Inspect the retained activation before proceeding.");
            if (coreRow is not null)
            {
                await ValidateCoreTreeAsync(activation, ct);
                var owners = WorkspaceRuntimeFiles.List(paths.DataRoot).Where(a => a.Id != activation.Id &&
                    a.CoreProject is not null && !a.CoreReturned && a.Phase is not ("returned" or "cancelled") &&
                    (a.Phase != "preparing" || a.CoreReserved)).ToArray();
                if (owners.Length != 0)
                {
                    var previous = owners.Length == 1 ? owners[0] : null;
                    var previousHelper = previous is null ? null : WorkspaceActivationSupervisor.Read(paths.DataRoot, previous.Id);
                    if (previous is not { Phase: "active", ActivatedCore: not null, CoreReserved: true, CoreSupersededBy: null } || previous.ActivatedCore != state.Launch ||
                        !WorkspaceActivationHandover.IsCandidate(previous, state.Launch) ||
                        previous.Returns?.Any(r => r.State == "pending") == true ||
                        WorkspaceActivationSupervisor.Pending(previousHelper) && WorkspaceActivationSupervisor.Alive(previousHelper!) ||
                        previous.CoreProject == activation.CoreProject)
                        throw Error("core_owned", "The current Core activation is not ready for a direct switch. Reconcile its retained operation first.");
                    if (prior is not null && prior.ReplacesCoreActivationId != previous.Id)
                        throw Error("core_changed", "The reviewed previous activation changed. Preserve the retained request for recovery.");
                    var baseline = previous.CoreReturnTarget ?? WorkspaceActivationReturn.ImmediateTarget(previous);
                    if (baseline.Executable is null || baseline.ExecutableHash is null ||
                        WorkspaceActivationReturn.ExecutableHash(baseline.Executable) != baseline.ExecutableHash)
                        throw Error("core_return_unavailable", "The captured Return executable is unavailable or changed. Current Core remains running.");
                    activation = activation with { ReplacesCoreActivationId = previous.Id, CoreReturnTarget = baseline };
                }
                else if (prior?.ReplacesCoreActivationId is not null)
                    throw Error("core_changed", "The reviewed previous activation no longer owns Core. No runtime was changed.");
            }
            return await lifecycle.WithActivationAppLocksAsync(ids, async () =>
            {
                var order = await lifecycle.OrderActivationAppsAsync(ids, ct);
                var plans = await lifecycle.PreflightActivationAppsAsync(activation, rows, ct);
                activation = activation with { Apps = order, Error = null, CoreReserved = activation.CoreProject is not null, PreparationReleased = false };
                if (activation.CoreProject is not null) await workspaces.ReserveCoreActivationAsync(activation, ct);
                else WorkspaceRuntimeFiles.Save(paths.DataRoot, activation);
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
                    WorkspaceRuntimeFiles.Save(paths.DataRoot, activation with { CoreReserved = false, PreparationReleased = true, Error = "Preparation failed; running services were not stopped. Inspect build diagnostics and retry the original request." });
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
                activation = activation with { Phase = phase, CoreReserved = false, PreparationReleased = true, SourceStamps = null, PreparedExecutable = null, Generation = null };
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
            await ValidateAuthorityAsync(activation, ct);
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
            await ValidateAuthorityAsync(activation, ct);
            return await lifecycle.WithActivationAppLocksAsync(activation.Apps.Order(StringComparer.Ordinal).ToArray(), async () =>
            {
                foreach (var app in activation.Apps.Except(activation.ReturnedApps ?? [])) await lifecycle.VerifyActivationAppAsync(activation, app, ct);
                return activation;
            }, ct);
        }
        finally { gate.Release(); }
    }

    private Task ValidateAuthorityAsync(WorkspaceRuntimeActivation activation, CancellationToken ct) => activation.Authority is null
        ? Task.CompletedTask : access is null ? throw Error("authority_invalid", "Activation authority is unavailable.")
        : access.ValidateAsync(activation.Authority, activation.CoreProject is not null && !activation.CoreReturned, ct);

    internal async Task<WorkspaceActivationReview> ReviewAsync(string workspaceId, string userId, WorkspaceActivationSelection input, CancellationToken ct)
    {
        var plan = await planner.PlanAsync(workspaceId, userId, input, ct);
        var stamps = new List<string>();
        if (plan.Participants.Any(p => p.Selected && p.Kind == "core"))
            foreach (var owner in WorkspaceRuntimeFiles.List(paths.DataRoot).Where(a => a.CoreProject is not null &&
                !a.CoreReturned && a.Phase is not ("returned" or "cancelled") && (a.Phase != "preparing" || a.CoreReserved))
                .OrderBy(a => a.Id, StringComparer.Ordinal))
            {
                // The reviewed handover includes the exact current ownership and captured Return
                // executable, not merely the destination project and process-start identity.
                stamps.Add("core-owner:" + CoreJson.Text(owner));
                var baseline = owner.CoreReturnTarget ?? WorkspaceActivationReturn.ImmediateTarget(owner);
                stamps.Add("core-baseline:" + WorkspaceActivationReturn.ExecutableHash(baseline.Executable));
            }
        foreach (var id in plan.Participants.Where(p => p.Selected).Select(p => p.WorktreeId!).Distinct().Order(StringComparer.Ordinal))
            stamps.Add(id + ":" + (await workspaces.ObserveAsync(id, null, ct)).SourceStamp);
        foreach (var app in plan.Participants.Where(p => p.Selected && p.Kind == "app").OrderBy(p => p.Id, StringComparer.Ordinal))
            stamps.Add(app.Id + ":" + await lifecycle.ActivationReviewStampAsync(app.Id, ct));
        return new(plan, DevelopmentWorkspaceService.Hash(CoreJson.Text(plan) + "\n" + string.Join("\n", stamps)),
            ["Selected runtimes use this Core's ordinary users and current data.",
             "Managed app data and stopped Core state are backed up; external mounts and remote services are outside coverage.",
             "Selecting Shell, Harness or Core interrupts its interface and agents. The detached helper retains progress.",
             "Return keeps current data and source edits; compatibility with an older executable requires explicit acceptance."]);
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

internal sealed record WorkspaceActivationReview(WorkspaceActivationPlan Plan, string PlanDigest, string[] Consequences);
