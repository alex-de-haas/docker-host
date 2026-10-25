using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

internal sealed partial class CoreLifecycleService
{
    private DevelopmentWorkspaceService DevWorkspaces => new(paths, apps, clock, localProcesses, privateSources: privateSources);
    private static AppLifecycleException DevError(string code, string message) => new("dev_" + code, message);

    public async Task<AppDevStatus> GetDevModeAsync(string appId, CancellationToken ct = default)
    {
        var app = await RequireAppAsync(appId, ct);
        var op = await AppDevStore.ReadAsync(paths, app, ct);
        return new(appId, op?.Id, op?.Phase ?? "inactive", op?.WorktreeId, op?.SourcePath, op?.PreviousRuntime,
            op?.TargetRuntime, op?.BackupId, op?.Error, await BuildAppSummaryAsync(app, ct), op?.Receipts ?? []);
    }

    public Task<AppDevPlan> PlanDevModeAsync(string appId, AppDevRequest input, AppDevActor actor, CancellationToken ct = default)
        => WithAppLockAsync(appId, () => PlanDevModeCoreAsync(appId, input, actor, ct), ct, developmentOperation: true);

    private async Task<AppDevPlan> PlanDevModeCoreAsync(string appId, AppDevRequest input, AppDevActor actor, CancellationToken ct, bool workspaceActivation = false)
    {
        _ = AppDevStore.Record(paths, appId, input.RequestId);
        if (input.Action is not ("enter" or "return" or "restart")) throw DevError("action_invalid", "Choose enter, restart or return.");
        var app = await RequireAppAsync(appId, ct);
        if (app.System && !workspaceActivation && input.Action == "enter") throw DevError("system_unsupported", "System app development keeps its existing manual workflow.");
        var op = await AppDevStore.ReadAsync(paths, app, ct);
        string? source, treeId, head = null;
        var changes = new List<string>();
        var outside = new List<string> { "Shared/external directories, remote databases, provider state and external side effects are not included in the managed-data backup." };
        foreach (var mount in AppConfigurationFingerprint.ResolveMounts(app, await globalMounts.ReadAsync(ct)))
            outside.Add($"{mount.Key}: {mount.HostPath} ({(mount.ReadOnly ? "read-only" : "writable")})");
        var installed = input.Action == "return"
            ? await LoadDevReturnSelectionAsync(app, op, ct)
            : await manifests.LoadAsync(app.ManifestPath!, app.SelectedRuntime, ct);
        if (input.Action != "return") await ValidateDevSourceAuthorityAsync(app, installed, actor, ct);
        var target = input.TargetRuntime;
        bool changed = false;
        if (input.Action == "enter")
        {
            if (op is { Active: true }) throw DevError("already_active", "This installation already has a development operation. Inspect it, retry its original request or return first.");
            var selection = await manifests.LoadAsync(app.ManifestPath!, target, ct);
            if (!selection.RuntimeProfile.Development || selection.Services.Any(s => workspaceActivation
                ? s.Runtime.Type is not ("docker" or "localCommand") : s.Runtime.Type != "docker"))
                throw DevError("profile_unsupported", "Choose an installed Docker development profile. Other manual runtime profiles remain available through Switch runtime.");
            target = selection.RuntimeProfile.Key;
            if (app.SourceState is null) throw DevError("source_required", "Configure the application's Git source first.");
            treeId = input.WorktreeId;
            source = treeId is null ? app.SourceState.LocalOverridePath ?? ResolveLiveSourcePath(app with { SelectedRuntime = target }) :
                (await DevWorkspaces.Read(treeId, actor.WorkspaceOwner, ct)).Path;
            if (source is null || !Directory.Exists(source)) throw DevError("source_required", "Prepare a workspace or configure an existing local Git source before entering development mode.");
            source = MountPathPolicy.ResolveRealPath(source);
            if (treeId is null && actor.WorkspaceOwner is not null)
                throw DevError("worktree_required", "An assistant must use its registered worktree; manual control may use an existing configured source.");
            if (treeId is not null)
            {
                var tree = await DevWorkspaces.Read(treeId, actor.WorkspaceOwner, ct);
                await DevWorkspaces.CheckDevTreeAsync(tree, app, actor.WorkspaceOwner, ct);
            }
            if (treeId is null && app.SourceState.Type != "local-git" && app.SourceState.LocalOverridePath is null)
                throw DevError("manual_source_unsupported", "This managed checkout keeps the existing manual switch workflow. Prepare a registered worktree for managed dev mode.");
            await new HostPathAuthority(paths, apps).OverrideAsync(app, source, ct);
            var git = await AppSourceService.ReadScopeStatusAsync(appId, () => source, null, clock.UtcNow, ct);
            if (git.Head is null || git.State is not ("clean" or "changes")) throw DevError("source_unavailable", "A readable Git working tree is required. Uncommitted changes are allowed.");
            head = git.Head;
            var live = await manifests.LoadAsync(CombineManifestSubpath(source, app.SourceState.ManifestSubpath), target, ct, forceRead: true);
            if (workspaceActivation)
            {
                var candidate = await PrepareExecutionCandidateAsync(app, source, target, actor, ct);
                await EnsureExecutionCandidateApprovedAsync(candidate, app, ct);
                selection = candidate.Selection;
            }
            else if (!AppDevelopmentManifest.HasSameContract(selection.ManifestJson, live.ManifestJson))
                throw DevError("contract_changed", "Review and install the source manifest first. This legacy development operation retains the installed contract.");
            if (app.StorageMappings.Any(m => m.Key == "data") && selection.DataTarget is null)
                throw DevError("data_incompatible", "The development profile has no compatible primary data directory.");
            changes.AddRange(BuildRuntimeSwitchChanges(app, installed, selection));
            changes.Add($"Live source: {source}; HEAD {head}; {git.FileCount} changed files. Future edits execute against this application's ordinary data and users.");
            changes.Add("Stop the current runtime, back up managed app data, then start the development profile. Autostart and app identity stay unchanged.");
        }
        else
        {
            if (op is not { Active: true } || op.Installation != app.InstalledAt) throw DevError("not_active", "No active development operation belongs to this installation.");
            await ValidateDevBindingAsync(app, op, ct);
            source = op.SourcePath; treeId = op.WorktreeId;
            target = input.Action == "return" ? installed.RuntimeProfile.Key : op.TargetRuntime;
            changed = op.DataHash is not null && op.DataHash != await DevDataHashAsync(GetAppDataPath(appId), ct);
            if (input.Action == "restart" && op.Phase != "active") throw DevError("recovery_required", "Recover the original request or return before restarting.");
            changes.Add(input.Action == "return" ? $"Restore runtime {target} and its prior source/artifact selection; leave it {(op.WasRunning ? "running" : "stopped")}." : "Restart the active development runtime with the same live source and ordinary data.");
            changes.Add("Keep current data, source edits, worktree, caches and backups. This does not undo writes or schema migrations.");
            if (changed) changes.Add("Data changed since entry. Core cannot prove schema downgrade compatibility. Return stays stopped unless compatibility is explicitly accepted.");
        }
        var config = await DevConfigurationHashAsync(app, ct);
        var seed = string.Join("\n", appId, app.InstalledAt.ToString("O"), actor.UserId, actor.Via, input.Action,
            input.RequestId, app.SelectedRuntime, target, source, treeId, head, installed.ManifestDigest, config,
            op?.Id, op?.Phase, CoreJson.Text(app.SourceState), CoreJson.Text(app.ArtifactLocks), changed, input.AcceptDataChanges);
        return new(appId, input.Action, DevelopmentWorkspaceService.Hash(seed), op?.Id, app.SelectedRuntime, target,
            treeId, source, head, changes.ToArray(), changed, outside.ToArray());
    }

    public Task<AppDevStatus> ApplyDevModeAsync(string appId, AppDevRequest input, AppDevActor actor, CancellationToken ct = default)
        => WithAppLockAsync(appId, () => ApplyDevModeCoreAsync(appId, input, actor, ct), ct, developmentOperation: true);

    private async Task<AppDevStatus> ApplyDevModeCoreAsync(string appId, AppDevRequest input, AppDevActor actor, CancellationToken ct)
    {
        var outcome = "refused";
        AppDevOperation? op = null;
        try
        {
            _ = AppDevStore.Record(paths, appId, input.RequestId);
            var app = await RequireAppAsync(appId, ct);
            op = await AppDevStore.ReadAsync(paths, app, ct);
            var fingerprint = DevelopmentWorkspaceService.Hash(CoreJson.Text(input) + "\n" + CoreJson.Text(actor));
            // Recover the narrow crash window between durable journal creation and the app pointer.
            if (op is not { Active: true } && op?.Id != input.RequestId && File.Exists(AppDevStore.Record(paths, appId, input.RequestId)))
            {
                var orphan = await AppDevStore.ReadAsync(paths, appId, input.RequestId, ct);
                if (orphan is not { Phase: "prepared" } || orphan.Installation != app.InstalledAt ||
                    orphan.Receipts?.Any(r => r.RequestId == input.RequestId && r.Fingerprint == fingerprint && r.State == "pending") != true ||
                    orphan.PreviousRuntime != app.SelectedRuntime || orphan.PreviousSource != app.SourceState)
                    throw DevError("request_retired", "The retained operation does not match this installation. Nothing was reapplied.");
                op = orphan;
                await apps.UpdateAppAsync(appId, a => a with { DevModeId = orphan.Id }, ct);
                app = await RequireAppAsync(appId, ct);
            }
            var receipt = op?.Receipts?.FirstOrDefault(r => r.RequestId == input.RequestId);
            if (receipt is not null)
            {
                if (receipt.Fingerprint != fingerprint) throw DevError("request_conflict", "This requestId was already used with different arguments or authority.");
                if (op!.Installation != app.InstalledAt) throw DevError("installation_changed", "This operation belongs to a different installation.");
                if (receipt.State != "pending")
                {
                    // The journal commits before its registry projection. Reconcile a completed
                    // operation after a failed projection without repeating any runtime effects.
                    if (receipt.State == "succeeded" && op.Phase is "active" or "returned" &&
                        app.OperationStatus is "development-starting" or "development-restarting" or
                            "development-return-bound" or "development-return-starting")
                        await apps.UpdateAppAsync(appId, a => a with { OperationStatus = "development-" + op.Phase }, ct);
                    outcome = receipt.State;
                    return await GetDevModeAsync(appId, ct);
                }
                await ValidateDevBindingAsync(app, op, ct);
                if (input.Action != "return")
                    await ValidateDevSourceAuthorityAsync(app, await manifests.LoadAsync(app.ManifestPath!, app.SelectedRuntime, ct), actor, ct);
            }
            else
            {
                if (await AppDevStore.ContainsRequestAsync(paths, appId, input.RequestId, ct))
                    throw DevError("request_retired", "This requestId belongs to an earlier development operation; inspect it rather than applying it again.");
                var plan = await PlanDevModeCoreAsync(appId, input, actor, ct);
                if (plan.PlanDigest != input.PlanDigest) throw DevError("plan_changed", "The development plan changed. Prepare and review it again.");
                // Legacy controls also supersede earlier execution selections. Claim before
                // persisting their app pointer so recovery cannot return a newer workspace.
                await ClaimExecutionTargetAsync(app, input.RequestId, ct);
                if (input.Action == "enter")
                {
                    var selection = await manifests.LoadAsync(app.ManifestPath!, plan.TargetRuntime, ct);
                    var previous = await manifests.LoadAsync(app.ManifestPath!, app.SelectedRuntime, ct);
                    var directory = AppDevStore.Root(paths, appId);
                    SecureFileSystem.EnsurePrivateDirectory(directory);
                    var saved = Path.Combine(directory, input.RequestId + ".manifest.json");
                    await File.WriteAllTextAsync(saved, previous.ManifestJson, ct);
                    op = new(input.RequestId, appId, app.InstalledAt, actor, plan.TargetRuntime!, plan.SourcePath!, plan.WorktreeId,
                        selection.ManifestDigest, saved, app.SelectedRuntime, app.SourceState, app.ArtifactLocks,
                        AppRuntimeStates.IsUp(app.RuntimeState), await DevConfigurationHashAsync(app, ct), "prepared", SourceHead: plan.Head);
                }
                op = op! with { Receipts = [.. (op!.Receipts ?? []).Select(r => input.Action == "return" && r.State == "pending" ? r with { State = "superseded" } : r),
                    new(input.RequestId, fingerprint, input.Action, "pending")], Error = null };
                await AppDevStore.SaveAsync(paths, op, ct);
                await apps.UpdateAppAsync(appId, a => a with { DevModeId = op.Id }, ct);
            }
            // From admission onward HTTP cancellation cannot strand an app after Stop.
            ct.ThrowIfCancellationRequested();
            ct = hostLifetime?.ApplicationStopping ?? CancellationToken.None;
            outcome = "failed";
            var active = op!;
            async Task Run()
            {
                if (input.Action == "enter") active = await EnterDevAsync(active, input.RequestId, ct);
                else if (input.Action == "return") active = await ReturnDevAsync(active, input.RequestId, input.AcceptDataChanges, ct);
                else
                {
                    await ValidateLiveDevManifestAsync(active, ct);
                    active = await DevPhaseAsync(active, "restarting", ct);
                    await RestartCoreAsync(appId, ct, preserveOperationStatus: true);
                    active = await DevPhaseAsync(active, "active", ct, completedRequestId: input.RequestId);
                }
            }
            if (active.WorktreeId is { } treeId)
                await DevWorkspaces.WithDevAdmissionAsync(treeId, app, actor.WorkspaceOwner, async () => { await Run(); return true; }, ct, returning: input.Action == "return");
            else await Run();
            op = active;
            outcome = "succeeded";
            return await GetDevModeAsync(appId, ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            if (outcome == "failed" && op is not null)
            {
                var saved = await AppDevStore.ReadAsync(paths, appId, op.Id, CancellationToken.None);
                if (saved?.Receipts?.Any(r => r.RequestId == input.RequestId && r.State == "pending") == true)
                    await AppDevStore.SaveAsync(paths, saved with { Error = "Operation did not complete. Inspect app status/logs, retry the original request or explicitly return." }, CancellationToken.None);
            }
            throw;
        }
        finally
        {
            try
            {
                if (audit is not null) await audit.AppendAsync(new AuditRecord("audit_" + Guid.NewGuid().ToString("N"),
                "app.development." + input.Action, "app", appId, outcome, actor.UserId, clock.UtcNow,
                new Dictionary<string, string> { ["requestId"] = input.RequestId, ["via"] = actor.Via,
                    ["operationId"] = op?.Id ?? "", ["worktreeId"] = op?.WorktreeId ?? "", ["review"] = input.PlanDigest ?? "",
                    ["installation"] = op?.Installation.ToString("O") ?? "", ["head"] = op?.SourceHead ?? "", ["manifest"] = op?.ManifestDigest ?? "" }), CancellationToken.None);
            }
            catch (Exception ex) { logger.LogWarning(ex, "Unable to record development audit for {AppId}", appId); }
        }
    }

    internal async Task<AppDevOperation> DevPhaseAsync(AppDevOperation op, string phase, CancellationToken ct, string? completedRequestId = null)
    {
        // Terminal phase and receipt share one atomic journal write. A lost response or a failure
        // updating the registry afterwards must not replay a completed runtime transition.
        var current = await AppDevStore.ReadAsync(paths, op.AppId, op.Id, ct);
        if (current is not null)
            op = op with { ExecutionManifest = current.ExecutionManifest, ExecutionManifestDigest = current.ExecutionManifestDigest,
                RunningManifest = current.RunningManifest, BaseGrantedPermissions = current.BaseGrantedPermissions,
                ExecutionGrantedPermissions = current.ExecutionGrantedPermissions, BaseConfirmedRoles = current.BaseConfirmedRoles,
                ExecutionConfirmedRoles = current.ExecutionConfirmedRoles,
                ExecutionConfigurationHash = current.ExecutionConfigurationHash,
                PriorExecutionConfigurationHash = current.PriorExecutionConfigurationHash,
                ReturnConfigurationHash = current.ReturnConfigurationHash,
                ExecutionProjectionPending = current.ExecutionProjectionPending };
        op = op with { Phase = phase, Error = completedRequestId is null ? op.Error : null,
            Receipts = completedRequestId is null ? op.Receipts : op.Receipts!.Select(r =>
                r.RequestId == completedRequestId ? r with { State = "succeeded" } : r).ToArray() };
        await AppDevStore.SaveAsync(paths, op, ct);
        await apps.UpdateAppAsync(op.AppId, a => a with { OperationStatus = "development-" + phase }, ct);
        try
        {
            if (audit is not null) await audit.AppendAsync(new("audit_" + Guid.NewGuid().ToString("N"),
                "app.development.progress", "app", op.AppId, phase, op.Actor.UserId, clock.UtcNow,
                new Dictionary<string, string> { ["operationId"] = op.Id, ["installation"] = op.Installation.ToString("O"),
                    ["via"] = op.Actor.Via, ["worktreeId"] = op.WorktreeId ?? "", ["head"] = op.SourceHead ?? "",
                    ["manifest"] = op.ManifestDigest }), ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException) { logger.LogWarning(ex, "Unable to record development progress for {AppId}", op.AppId); }
        return op;
    }

    private async Task<AppDevOperation> EnterDevAsync(AppDevOperation op, string requestId, CancellationToken ct, bool backupOnly = false)
    {
        var app = await RequireAppAsync(op.AppId, ct);
        if (op.Phase == "starting" && (op.ActivationId is not null || op.PackageReturn) &&
            app.DevModeId == op.Id && app.SelectedRuntime == op.TargetRuntime && app.SourceState?.LocalOverridePath == op.SourcePath &&
            app.RuntimeState == "running" && (await GetHealthAsync(op.AppId, ct)).Status == "healthy")
            return await DevPhaseAsync(op, "active", ct, completedRequestId: requestId);
        await ValidateLiveDevManifestAsync(op, ct);
        if (op.Phase == "prepared")
        {
            // A persisted pointer protects source cleanup even before the override is applied.
            await StopDevRuntimeAsync(app, ct);
            op = await DevPhaseAsync(op, "stopped", ct);
        }
        if (op.Phase == "stopped")
        {
            Directory.CreateDirectory(GetAppDataPath(op.AppId));
            var dataHash = await DevDataHashAsync(GetAppDataPath(op.AppId), ct);
            if (op.DataHash is not null && op.DataHash != dataHash)
                throw DevError("backup_data_changed", "Managed data changed since this backup attempt. Return and enter again to create a new pre-development backup; no development code was started.");
            // Persist the data identity BEFORE creating the stable archive. A crash after archive
            // metadata but before backed-up cannot pair an old archive with a newer data baseline.
            op = op with { DataHash = dataHash };
            await AppDevStore.SaveAsync(paths, op, ct);
            var backup = await backups.CreateBackupAsync(op.AppId, "pre-development-mode", "development:" + op.Id,
                ct, operationId: op.Id) ?? throw DevError("backup_required", "A verified managed-data backup is required before entry.");
            if (dataHash != await DevDataHashAsync(GetAppDataPath(op.AppId), ct))
                throw DevError("backup_data_changed", "Managed data changed while creating its backup. Return and enter again; no development code was started.");
            op = op with { BackupId = backup.BackupId };
            op = await DevPhaseAsync(op, "backed-up", ct);
        }
        if (backupOnly) return op;
        if (op.Phase == "backed-up")
        {
            app = await RequireAppAsync(op.AppId, ct);
            var selection = await LoadDevExecutionSelectionAsync(op, ct);
            await apps.HostPathMutationLock.WaitAsync(ct);
            try
            {
                await sources.SetLocalOverrideCoreAsync(app, new(op.SourcePath), ct);
            }
            finally { apps.HostPathMutationLock.Release(); }
            app = await RequireAppAsync(op.AppId, ct);
            var next = (op.ExecutionManifest is null ? BuildAppRecord(selection, app.ManifestPath!, app.ManifestUrl, app.System, app)
                : BuildDevelopmentRecord(app, selection, op)) with
            { InstallManifestPath = app.InstallManifestPath, SourceState = app.SourceState, ArtifactLocks = op.PreparedRuntime?.Artifacts ?? app.ArtifactLocks, DevModeId = op.Id, RuntimeState = "stopped", OperationStatus = "development", LastError = null };
            await PersistRuntimePortsAsync(next, selection, ct);
            if (op.ExecutionManifest is not null)
            {
                op = op with { ExecutionProjectionPending = false };
                await AppDevStore.SaveAsync(paths, op, ct);
            }
            op = await DevPhaseAsync(op, "bound", ct);
        }
        if (op.Phase is "bound" or "starting")
        {
            op = await DevPhaseAsync(op, "starting", ct);
            // Replay performs a verified stop before start, including a partly started multi-service app.
            await StopDevRuntimeAsync(await RequireAppAsync(op.AppId, ct), ct);
            await StartCoreAsync(op.AppId, afterOwnStop: true, ct, preserveOperationStatus: true);
            op = await DevPhaseAsync(op, "active", ct, completedRequestId: requestId);
        }
        return op;
    }

    private async Task<RuntimeAppManifestSelection> LoadDevReturnSelectionAsync(
        AppRecord app, AppDevOperation? operation, CancellationToken ct)
    {
        if (operation is not { Active: true } || operation.Installation != app.InstalledAt)
            throw DevError("not_active", "No active development operation belongs to this installation.");
        var selection = await manifests.LoadAsync(operation.PackageReturn ? app.ManifestPath! : operation.PreviousManifest,
            operation.PackageReturn ? operation.PackageRuntime ?? operation.PreviousRuntime : operation.PreviousRuntime,
            ct, forceRead: true);
        if (!operation.PackageReturn && selection.ManifestDigest != operation.ManifestDigest)
            throw DevError("previous_contract_changed", "The retained runtime contract changed; restore the operation record before returning.");
        return selection;
    }

    private AppSourceState? ReturnDevSource(AppDevOperation operation)
    {
        var source = operation.PreviousSource;
        if (!operation.PackageReturn || source is null) return source;
        // Package selection drops historical workspace overrides without deleting their source.
        // Locally created apps keep their canonical Git binding, just like clearing an override.
        var packagePath = source.Type == "local-git" ? paths.ResolveManagedCheckoutPath(operation.AppId) : null;
        return source.LocalOverridePath == packagePath ? source : source with
        { LocalOverridePath = packagePath, OverrideCommit = null, UpdatedAt = clock.UtcNow };
    }

    private async Task<AppDevOperation> ReturnDevAsync(AppDevOperation op, string requestId, bool acceptDataChanges, CancellationToken ct)
    {
        if (op.Phase == "returned") return op;
        // Review the destination before stopping the current runtime, including recovery retries.
        var previous = await LoadDevReturnSelectionAsync(await RequireAppAsync(op.AppId, ct), op, ct);
        if (op.Phase is not ("return-stopped" or "return-bound" or "return-starting"))
        {
            await StopDevRuntimeAsync(await RequireAppAsync(op.AppId, ct), ct);
            op = await DevPhaseAsync(op, "return-stopped", ct);
        }
        if (!op.PackageReturn && op.DataHash is not null && op.DataHash != await DevDataHashAsync(GetAppDataPath(op.AppId), ct) && !acceptDataChanges)
            throw DevError("data_compatibility_required", "Data changed and Core cannot prove compatibility with the previous version. The app is stopped. Review recovery or explicitly accept the current data; no data was restored.");
        if (op.Phase == "return-stopped")
        {
            var app = await RequireAppAsync(op.AppId, ct);
            // Unified switching returns to the current installed package; captured bytes are only
            // for legacy recovery. Current settings, source edits and permission revocations survive.
            if (!op.PackageReturn) await manifests.SaveManifestCopyAsync(previous, GetAppRoot(op.AppId), ct);
            var restored = BuildAppRecord(previous, app.ManifestPath!, app.ManifestUrl, app.System, app) with
            { InstallManifestPath = app.InstallManifestPath, SourceState = ReturnDevSource(op),
                ArtifactLocks = op.PackageReturn ? null : op.PreviousArtifacts, DevModeId = op.Id,
                GrantedCorePermissions = op.ExecutionManifest is null ? app.GrantedCorePermissions :
                    DevelopmentBaseGrants(app, op).Intersect(previous.Manifest.CorePermissions.Concat(previous.Manifest.OptionalCorePermissions), StringComparer.Ordinal).ToArray(),
                RequiredCorePermissions = op.ExecutionManifest is null ? app.RequiredCorePermissions : previous.Manifest.CorePermissions.ToArray(),
                OptionalCorePermissions = op.ExecutionManifest is null ? app.OptionalCorePermissions : previous.Manifest.OptionalCorePermissions.ToArray(),
                ConfirmedRoles = op.ExecutionManifest is null ? app.ConfirmedRoles : DevelopmentBaseRoles(app, op),
                RuntimeState = "stopped", OperationStatus = "development-returning", ManifestError = null, LiveChanges = null };
            if (op.ExecutionManifest is not null)
            {
                op = op with { ReturnConfigurationHash = await DevConfigurationHashAsync(restored, ct) };
                await AppDevStore.SaveAsync(paths, op, ct);
            }
            await PersistRuntimePortsAsync(restored, previous, ct);
            op = await DevPhaseAsync(op, "return-bound", ct);
        }
        if (op.Phase == "return-starting" && (op.ActivationId is not null || op.PackageReturn) && op.WasRunning)
        {
            var current = await RequireAppAsync(op.AppId, ct);
            if (current.RuntimeState == "running" && (await GetHealthAsync(op.AppId, ct)).Status == "healthy")
                return await DevPhaseAsync(op, "returned", ct, completedRequestId: requestId);
        }
        if (op.Phase is "return-bound" or "return-starting")
        {
            if (op.WasRunning)
            {
                op = await DevPhaseAsync(op, "return-starting", ct);
                await StopDevRuntimeAsync(await RequireAppAsync(op.AppId, ct), ct);
                await StartCoreAsync(op.AppId, afterOwnStop: true, ct, preserveOperationStatus: true);
            }
            op = await DevPhaseAsync(op, "returned", ct, completedRequestId: requestId);
        }
        return op;
    }

    private async Task StopDevRuntimeAsync(AppRecord app, CancellationToken ct)
    {
        // Stop uses the last launched admitted contract, even when live source is invalid or
        // an execution refresh changed its service topology before an interrupted restart.
        var operation = await AppDevStore.ReadAsync(paths, app, ct);
        var selection = operation is { Active: true } && app.SelectedRuntime == operation.TargetRuntime &&
            !operation.Phase.StartsWith("return-", StringComparison.Ordinal)
            ? await LoadDevExecutionSelectionAsync(operation, ct, running: true)
            : await manifests.LoadAsync(app.ManifestPath!, app.SelectedRuntime, ct);
        var result = await ResolveAdapter(selection.RuntimeProfile.Type).StopAsync(await CreateRuntimeContextAsync(app, selection, ct), ct);
        if (result.RuntimeState != "stopped") throw DevError("stop_unverified", "The old runtime did not confirm a stop; no new writer was started.");
        await apps.UpdateAppAsync(app.Id, a => a with { RuntimeState = "stopped", ActiveSourcePaths = null,
            ActiveMountPaths = null, Health = null }, ct);
        await ReconcileIngressAsync(ct);
    }

    private async Task ValidateDevSourceAuthorityAsync(AppRecord app, RuntimeAppManifestSelection installed, AppDevActor actor, CancellationToken ct)
    {
        if (!actor.TrustedLocalOperator && new[] { app.PrivateSources?.Git, app.PrivateSources?.Manifest }
            .OfType<SourceReadGrant>().Any(grant => grant.OwnerId != actor.UserId))
            throw DevError("source_forbidden", "Only the source connection owner can enter or change this development binding.");
        // The installed copy is local; its grant still refers to the persisted remote manifest URL.
        await ValidatePrivateSelectionAsync(installed with { PrivateSources = app.PrivateSources, ManifestUrl = app.ManifestUrl }, ct);
    }

    private async Task ValidateDevBindingAsync(AppRecord app, AppDevOperation op, CancellationToken ct)
    {
        var configuration = await DevConfigurationHashAsync(app, ct);
        // Candidate defaults and approved mount declarations are Core-owned projection changes,
        // not operator drift. Retain the immediately preceding hash until a verified start so
        // an interrupted snapshot/projection write can be recovered without accepting arbitrary edits.
        var configurationMatches = configuration == op.ConfigurationHash || op.ExecutionManifest is not null &&
            (configuration == op.ExecutionConfigurationHash || configuration == op.PriorExecutionConfigurationHash ||
                configuration == op.ReturnConfigurationHash);
        if (app.InstalledAt != op.Installation || app.DevModeId != op.Id || !configurationMatches)
            throw DevError("binding_changed", "Installation, settings or mounts changed. A stale return cannot overwrite a newer operator choice.");
        var previous = app.SelectedRuntime == (op.PackageReturn ? op.PackageRuntime ?? op.PreviousRuntime : op.PreviousRuntime) &&
            app.SourceState?.LocalOverridePath == op.PreviousSource?.LocalOverridePath;
        var live = app.SelectedRuntime == op.TargetRuntime && app.SourceState?.LocalOverridePath == op.SourcePath;
        // A crash after source persistence but before the profile write is a known intermediate state.
        var binding = op.Phase == "backed-up" && app.SelectedRuntime == op.PreviousRuntime && app.SourceState?.LocalOverridePath == op.SourcePath;
        if (!previous && !live && !binding) throw DevError("binding_changed", "The runtime or source binding changed outside this operation. Retain the current selection and inspect it.");
    }

    private async Task<RuntimeAppManifestSelection> ValidateLiveDevManifestAsync(AppDevOperation op, CancellationToken ct)
    {
        var app = await RequireAppAsync(op.AppId, ct);
        if (op.ExecutionManifest is not null)
        {
            var candidate = await PrepareExecutionCandidateAsync(app, op.SourcePath, op.TargetRuntime, op.Actor, ct);
            await EnsureExecutionCandidateApprovedAsync(candidate, app, ct);
            if (op.PreparedRuntime is not null && op.Phase is "prepared" or "stopped" or "backed-up" or "bound" or "starting" &&
                candidate.Selection.ManifestDigest != op.ExecutionManifestDigest)
                throw DevError("plan_changed", "The workspace manifest changed after preparation. Prepare the current candidate before replacing the running app.");
            return candidate.Selection;
        }
        var manifest = await manifests.LoadAsync(CombineManifestSubpath(op.SourcePath, app.SourceState?.ManifestSubpath), op.TargetRuntime, ct, forceRead: true);
        var installed = await manifests.LoadAsync(op.PreviousManifest, op.TargetRuntime, ct, forceRead: true);
        if (installed.ManifestDigest != op.ManifestDigest)
            throw DevError("previous_contract_changed", "The retained runtime contract changed; restore the operation record before restarting.");
        if (!AppDevelopmentManifest.HasSameContract(installed.ManifestJson, manifest.ManifestJson))
            throw DevError("contract_changed", "The source manifest changed. Return and review the new contract before entering again.");
        return manifest;
    }

    private async Task<string> DevConfigurationHashAsync(AppRecord app, CancellationToken ct)
        => AppConfigurationFingerprint.Compute(app, AppConfigurationFingerprint.ResolveMounts(app, await globalMounts.ReadAsync(ct)));

    private static async Task<string> DevDataHashAsync(string root, CancellationToken ct)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        if (!Directory.Exists(root)) return "absent";
        // Do not follow links into external storage while inspecting backup coverage.
        var pending = new Stack<string>(); pending.Push(root);
        while (pending.TryPop(out var dir))
            foreach (var path in Directory.EnumerateFileSystemEntries(dir).Order(StringComparer.Ordinal))
            {
                ct.ThrowIfCancellationRequested();
                hash.AppendData(Encoding.UTF8.GetBytes(Path.GetRelativePath(root, path) + "\\0"));
                var attributes = File.GetAttributes(path);
                if ((attributes & FileAttributes.ReparsePoint) != 0) throw DevError("backup_external_link", "Managed data contains a symbolic link. Review external data coverage before entering dev mode.");
                if ((attributes & FileAttributes.Directory) != 0) { pending.Push(path); continue; }
                await AppSourceService.RequireRegularFileAsync(path, ct);
                await using var file = File.OpenRead(path);
                hash.AppendData(await SHA256.HashDataAsync(file, ct));
            }
        return Convert.ToHexString(hash.GetHashAndReset());
    }
}
