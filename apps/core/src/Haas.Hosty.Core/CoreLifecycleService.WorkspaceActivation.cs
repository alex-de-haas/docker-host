using Haas.Hosty.Launch;

namespace Haas.Hosty.Core;

internal sealed partial class CoreLifecycleService
{
    internal async Task<AppDevPlan[]> PreflightActivationAppsAsync(WorkspaceRuntimeActivation activation,
        WorkspaceActivationParticipant[] participants, CancellationToken ct)
    {
        var plans = new List<AppDevPlan>();
        foreach (var row in participants)
        {
            var app = await RequireAppAsync(row.Id, ct);
            var request = new AppDevRequest(WorkspaceRuntimeFiles.ChildId(activation.Id, app.Id), "enter", row.TargetRuntime, row.WorktreeId);
            var actor = new AppDevActor(activation.UserId, activation.Authority?.Via ?? "workspace-local", TrustedLocalOperator: activation.Authority is null);
            var owned = await AppDevStore.ReadAsync(paths, app, ct);
            var plan = owned is { Phase: "prepared" } && owned.ActivationId == activation.Id
                ? new AppDevPlan(app.Id, "enter", "", owned.Id, app.SelectedRuntime, owned.TargetRuntime, owned.WorktreeId, owned.SourcePath, owned.SourceHead, [], false, [])
                : await PlanDevModeCoreAsync(app.Id, request, actor, ct, workspaceActivation: true);
            await EnsureRequiredSettingsConfiguredAsync(app, ct);
            _ = EnsureMountsReadyForStart(await CreateRuntimeContextAsync(app, await manifests.LoadAsync(app.ManifestPath!, row.TargetRuntime, ct), ct));
            if ((await apps.ListAppRecordsAsync(ct)).Any(consumer => AppRuntimeStates.IsUp(consumer.RuntimeState) &&
                    (consumer.ActiveSourcePaths ?? []).Any(p => DevelopmentWorkspaceService.IsUnder(p, plan.SourcePath!) ||
                        DevelopmentWorkspaceService.IsUnder(plan.SourcePath!, p))))
                throw DevError("preparation_source_in_use", "The candidate source is already used by a running app. Stop it explicitly or choose a separate worktree before preparation.");
            _ = await DevDataHashAsync(GetAppDataPath(app.Id), ct); // Link/coverage checks before teardown.
            var backupRoot = Path.Combine(paths.BackupsRoot, app.Id);
            SecureFileSystem.EnsurePrivateDirectory(backupRoot);
            var probe = Path.Combine(backupRoot, ".preflight-" + Guid.NewGuid().ToString("N"));
            using (SecureFileSystem.CreatePrivateFile(probe, FileMode.CreateNew, FileShare.None, FileOptions.None)) { }
            File.Delete(probe);
            plans.Add(plan);
        }
        return plans.ToArray();
    }

    internal async Task PrepareActivationAppAsync(WorkspaceRuntimeActivation activation, AppDevPlan plan, CancellationToken ct)
    {
        var app = await RequireAppAsync(plan.AppId, ct);
        var id = WorkspaceRuntimeFiles.ChildId(activation.Id, app.Id);
        var op = await AppDevStore.ReadAsync(paths, app, ct);
        if (op?.ActivationId != activation.Id && File.Exists(AppDevStore.Record(paths, app.Id, id)))
        {
            var retained = await AppDevStore.ReadAsync(paths, app.Id, id, ct);
            if (retained is { Phase: "returned" } && retained.ActivationId == activation.Id && activation.Phase == "preparing")
                retained = null; // Released before Stop; a repaired preparation may allocate the same child again.
            if (retained is not null && (retained.Phase != "prepared" || retained.ActivationId != activation.Id ||
                retained.Installation != app.InstalledAt || retained.PreviousRuntime != app.SelectedRuntime ||
                retained.PreviousSource != app.SourceState || op is { Active: true }))
                throw DevError("request_retired", "The child receipt no longer matches this installation. Nothing was reapplied.");
            if (retained is not null)
            {
                op = retained;
                await apps.UpdateAppAsync(app.Id, a => a with { DevModeId = id }, ct);
                app = await RequireAppAsync(app.Id, ct);
            }
        }
        if (op is null || op.ActivationId != activation.Id)
        {
            if (op is { Active: true }) throw DevError("already_active", "Return the existing runtime before activation.");
            var previous = await manifests.LoadAsync(app.ManifestPath!, app.SelectedRuntime, ct);
            SecureFileSystem.EnsurePrivateDirectory(AppDevStore.Root(paths, app.Id));
            var saved = Path.Combine(AppDevStore.Root(paths, app.Id), id + ".manifest.json");
            await File.WriteAllTextAsync(saved, previous.ManifestJson, ct);
            op = new(id, app.Id, app.InstalledAt, new(activation.UserId, activation.Authority?.Via ?? "workspace-local", TrustedLocalOperator: activation.Authority is null),
                plan.TargetRuntime!, plan.SourcePath!, plan.WorktreeId, previous.ManifestDigest, saved, app.SelectedRuntime,
                app.SourceState, app.ArtifactLocks, AppRuntimeStates.IsUp(app.RuntimeState), await DevConfigurationHashAsync(app, ct),
                "prepared", Receipts: [new(id, activation.Fingerprint, "enter", "pending")], SourceHead: plan.Head, ActivationId: activation.Id);
            await AppDevStore.SaveAsync(paths, op, ct);
            await apps.UpdateAppAsync(app.Id, a => a with { DevModeId = id }, ct);
        }
        _ = await DevWorkspaces.WithDevAdmissionAsync(op.WorktreeId!, app, null, () => Task.FromResult(true), ct);
        await ValidateDevBindingAsync(await RequireAppAsync(app.Id, ct), op, ct);
        await ValidateLiveDevManifestAsync(op, ct);
        var target = await manifests.LoadAsync(op.PreviousManifest, op.TargetRuntime, ct);
        var candidate = app with { SelectedRuntime = op.TargetRuntime, SourceState = app.SourceState! with { LocalOverridePath = op.SourcePath }, ArtifactLocks = null };
        var context = await CreateRuntimeContextAsync(candidate, target, ct);
        var scratch = Path.Combine(WorkspaceRuntimeFiles.Root(paths.DataRoot), activation.Id, app.Id);
        context = context with { SourceRoot = op.SourcePath, AppDataPath = Path.Combine(scratch, "data"), AppCachePath = Path.Combine(scratch, "cache"), PreparationOnly = true, WorkspaceActivationId = activation.Id };
        if (ResolveAdapter(target.RuntimeProfile.Type) is not IRuntimePreparation adapter)
            throw DevError("preparation_unsupported", "The selected adapter cannot prepare before Stop.");
        var prepared = await adapter.PrepareAsync(context, ct);
        await AppDevStore.SaveAsync(paths, op with { PreparedRuntime = prepared }, ct);
    }

    internal async Task ValidateActivationAppAsync(WorkspaceRuntimeActivation activation, string appId, CancellationToken ct)
    {
        var app = await RequireAppAsync(appId, ct);
        var op = await AppDevStore.ReadAsync(paths, app, ct);
        if (op is not { Active: true, PreparedRuntime: not null } || op.ActivationId != activation.Id)
            throw DevError("binding_changed", "The prepared workspace runtime no longer owns this installation.");
        await ValidateDevBindingAsync(app, op, ct);
        await ValidateLiveDevManifestAsync(op, ct);
        await ValidateDevSourceAuthorityAsync(app, await manifests.LoadAsync(app.ManifestPath!, app.SelectedRuntime, ct), op.Actor, ct);
        _ = await DevWorkspaces.WithDevAdmissionAsync(op.WorktreeId!, app, null, () => Task.FromResult(true), ct);
    }

    internal async Task VerifyActivationAppAsync(WorkspaceRuntimeActivation activation, string appId, CancellationToken ct)
    {
        var app = await RequireAppAsync(appId, ct);
        var op = await AppDevStore.ReadAsync(paths, app, ct);
        if (op is not { Phase: "active" } || op.ActivationId != activation.Id ||
            op.Installation != app.InstalledAt || app.SelectedRuntime != op.TargetRuntime || app.SourceState?.LocalOverridePath != op.SourcePath)
            throw DevError("activation_not_ready", "The selected runtime no longer matches its active child receipt.");
        await ValidateDevBindingAsync(app, op, ct);
        var health = await GetHealthAsync(appId, ct);
        if (health.Status != "healthy")
            throw DevError("activation_not_ready", $"{appId} has not confirmed readiness ({health.Status}). Inspect its retained operation and logs.");
    }

    internal async Task ReleaseActivationPreparationAsync(WorkspaceRuntimeActivation activation, CancellationToken ct)
    {
        // All participant locks are held. Only a pre-Stop reservation may be released for repairs.
        foreach (var id in activation.Apps)
        {
            var op = await AppDevStore.ReadAsync(paths, await RequireAppAsync(id, ct), ct);
            if (op is not null && (op.ActivationId != activation.Id || op.Phase != "prepared"))
                throw DevError("preparation_in_use", "A participant has crossed Stop or changed ownership; inspect its journal.");
        }
        foreach (var id in activation.Apps)
        {
            var op = await AppDevStore.ReadAsync(paths, await RequireAppAsync(id, ct), ct);
            if (op is null) continue;
            await AppDevStore.SaveAsync(paths, op with { Phase = "returned", Error = "Preparation released before Stop for source repair." }, ct);
            await apps.UpdateAppAsync(id, app => app with { DevModeId = null }, ct);
        }
    }

    internal async Task ReturnActivationAppAsync(WorkspaceRuntimeActivation activation, string appId,
        WorkspaceReturnRequest request, CancellationToken ct)
    {
        var app = await RequireAppAsync(appId, ct);
        var op = await AppDevStore.ReadAsync(paths, appId, WorkspaceRuntimeFiles.ChildId(activation.Id, appId), ct)
            ?? throw DevError("return_missing", "The captured child journal is unavailable.");
        if (op.ActivationId != activation.Id || op.Installation != app.InstalledAt)
            throw DevError("binding_changed", "Return cannot overwrite a different installation.");
        if (op.Phase == "returned")
        {
            if (app.SelectedRuntime != op.PreviousRuntime || app.SourceState != op.PreviousSource ||
                op.WasRunning && (await GetHealthAsync(appId, ct)).Status != "healthy" || !op.WasRunning && AppRuntimeStates.IsUp(app.RuntimeState))
                throw DevError("return_not_ready", "The previous runtime no longer confirms its captured running state. Inspect it before completing Return.");
            return;
        }
        await ValidateDevBindingAsync(app, op, ct);
        await DevWorkspaces.WithDevAdmissionAsync(op.WorktreeId!, app, null, async () =>
        {
            await ReturnDevAsync(op, WorkspaceRuntimeFiles.ChildId(request.RequestId, appId), request.AcceptDataChanges, ct);
            var restored = await RequireAppAsync(appId, ct);
            if (restored.SelectedRuntime != op.PreviousRuntime || restored.SourceState != op.PreviousSource ||
                op.WasRunning && (await GetHealthAsync(appId, ct)).Status != "healthy" ||
                !op.WasRunning && AppRuntimeStates.IsUp(restored.RuntimeState))
                throw DevError("return_not_ready", "The captured previous runtime has not confirmed its original running state.");
            return true;
        }, ct, returning: true);
    }

    internal async Task StopActivationAppAsync(string appId, CancellationToken ct)
    {
        var app = await RequireAppAsync(appId, ct);
        var op = (await AppDevStore.ReadAsync(paths, app, ct))!;
        if (op.Phase != "prepared") return;
        await StopDevRuntimeAsync(app, ct);
        await DevPhaseAsync(op, "stopped", ct);
    }

    internal async Task ApplyActivationAppAsync(string appId, bool backupOnly, CancellationToken ct)
    {
        var op = (await AppDevStore.ReadAsync(paths, await RequireAppAsync(appId, ct), ct))!;
        await EnterDevAsync(op, op.Id, ct, backupOnly);
    }

    internal async Task<T> WithActivationAppLocksAsync<T>(string[] ids, Func<Task<T>> action, CancellationToken ct)
    {
        async Task<T> Next(int index) => index == ids.Length ? await action() :
            await WithAppLockAsync(ids[index], () => Next(index + 1), ct, developmentOperation: true);
        return await Next(0);
    }

    internal async Task<string> ActivationReviewStampAsync(string appId, CancellationToken ct)
    {
        var app = await RequireAppAsync(appId, ct);
        var manifest = await manifests.LoadAsync(app.ManifestPath!, app.SelectedRuntime, ct);
        return DevelopmentWorkspaceService.Hash(string.Join("\n", app.InstalledAt.ToString("O"),
            app.SelectedRuntime, CoreJson.Text(app.SourceState), CoreJson.Text(app.ArtifactLocks),
            manifest.ManifestDigest, await DevConfigurationHashAsync(app, ct), app.DevModeId));
    }

    internal async Task<string[]> OrderActivationAppsAsync(string[] selected, CancellationToken ct)
    {
        var records = (await apps.ListAppRecordsAsync(ct)).ToDictionary(a => a.Id, StringComparer.Ordinal);
        var result = new List<string>();
        var pending = new HashSet<string>(StringComparer.Ordinal);
        void Visit(string id)
        {
            if (result.Contains(id)) return;
            if (!pending.Add(id)) throw DevError("dependency_cycle", "Selected applications have a dependency cycle.");
            var app = records[id];
            foreach (var dependency in app.Dependencies ?? [])
            {
                if (!records.TryGetValue(dependency.AppId, out var provider))
                {
                    if (dependency.Required) throw DevError("dependency_missing", $"{id} requires {dependency.AppId}.");
                    continue;
                }
                if (dependency.Endpoints.Any(e => !provider.Endpoints.Any(p => p.Key == e.EndpointKey)))
                    throw DevError("dependency_incompatible", $"{id} requires an unavailable endpoint from {provider.Id}.");
                if (selected.Contains(provider.Id)) Visit(provider.Id);
                else if (dependency.Required && !AppRuntimeStates.IsUp(provider.RuntimeState))
                    throw DevError("dependency_stopped", $"Start or explicitly select dependency {provider.Id}; activation does not start unrelated apps.");
            }
            pending.Remove(id); result.Add(id);
        }
        foreach (var id in selected) Visit(id);
        return result.ToArray();
    }
}
