namespace Haas.Hosty.Core;

internal sealed partial class CoreLifecycleService
{
    private async Task<AppExecutionOperation> SwitchWorkspaceAndStartAsync(AppDevOperation op, AppExecutionOperation journal,
        Func<CancellationToken, Task>? validateAuthority, CancellationToken ct)
    {
        var requestId = journal.Request.RequestId;
        var app = await RequireAppAsync(op.AppId, ct);
        var alreadyBound = app.DevModeId == op.Id;
        if (!alreadyBound)
        {
            // Leave the outgoing binding and its grants intact until the backup and candidate
            // are ready. A failed backup therefore leaves the old target available to Start.
            var selection = await ValidateLiveDevManifestAsync(op, ct);
            var candidate = BuildDevelopmentRecord(app, selection, op) with
            {
                SourceState = app.SourceState! with { LocalOverridePath = op.SourcePath },
                ArtifactLocks = null, DevModeId = app.DevModeId
            };
            await EnsureRequiredSettingsConfiguredAsync(candidate, ct);
            _ = EnsureMountsReadyForStart(await CreateRuntimeContextAsync(candidate, selection, ct));

            await StopDevRuntimeAsync(app, ct);
            if (op.Phase == "prepared") op = await DevPhaseAsync(op, "stopped", ct);
            try
            {
                if (op.Phase == "stopped") op = await BackupStoppedDevDataAsync(op, ct);
                else if (op.Phase == "backed-up" && op.BackupId is { } backupId && op.DataHash == await DevDataHashAsync(GetAppDataPath(app.Id), ct))
                    await backups.VerifyWorkspaceBackupAsync(app.Id, backupId, ct);
                else throw DevError("backup_data_changed", "The outgoing data changed. Select the workspace again for a fresh backup.");
            }
            catch (Exception ex) when (IsRecordableLifecycleFailure(ex))
            {
                throw new AppLifecycleException(ex is AppLifecycleException lifecycle ? lifecycle.Code : "dev_backup_failed",
                    $"Backup failed before switching the application: {ex.Message}");
            }

            if (validateAuthority is not null) await validateAuthority(ct);
            app = await RequireAppAsync(app.Id, ct);
            var reviewed = await PrepareExecutionCandidateAsync(app, op.SourcePath, op.TargetRuntime, op.Actor, ct);
            if (reviewed.Selection.ManifestDigest != op.ExecutionManifestDigest)
                throw DevError("plan_changed", "The workspace manifest changed during the switch. Select the workspace again.");
            op = await SaveExecutionCandidateAsync(op, reviewed, ct);
            await AppDevStore.SaveAsync(paths, op, ct);

            // The repository gate protects the new consuming pointer, and the host-path gate
            // protects the selected mount/source assignment. No build runs under either gate.
            await apps.HostPathMutationLock.WaitAsync(ct);
            try
            {
                await DevWorkspaces.WithDevBindingAdmissionAsync(op.WorktreeId!, app, op.Actor.WorkspaceOwner, async () =>
                {
                    var sourced = await sources.PrepareLocalOverrideAsync(app, new(op.SourcePath), ct);
                    var bound = BuildDevelopmentRecord(sourced, reviewed.Selection, op) with
                    {
                        ArtifactLocks = null, RuntimeState = "stopped", OperationStatus = "development-bound",
                        LastError = null, Health = null, LaunchProgress = null, DependencyStart = null
                    };
                    return await PersistRuntimePortsUnderHostPathLockAsync(bound, reviewed.Selection, ct);
                }, ct);
            }
            finally { apps.HostPathMutationLock.Release(); }
        }

        if (op.Phase == "backed-up")
        {
            if (op.PackageDataBaseline)
                await backups.SetWorkspaceReturnBackupAsync(op.AppId, op.BackupId!, op.Installation, ct);
            // Registry commit and journal commit are separately durable. The outgoing journal
            // no longer owns the installation. Finish its retirement idempotently after a crash.
            if (op.SupersededDevModeId is { } previousId && await AppDevStore.ReadAsync(paths, app.Id, previousId, ct) is { } previous)
            {
                if (previous.Active) await AppDevStore.SaveAsync(paths, previous with { Phase = "returned" }, ct);
                RetireExecutionActivation(previous);
            }
            await SaveSelectedWorkspaceRecipeAsync(op, ct);
            op = op with { ExecutionProjectionPending = false };
            await AppDevStore.SaveAsync(paths, op, ct);
            op = await DevPhaseAsync(op, "bound", ct);
        }

        if (op.Phase is not ("bound" or "starting"))
            throw DevError("selection_changed", "The selected workspace changed before startup. Inspect its current binding.");

        // Start persists its own result before the selection receipt. A lost process or
        // response between those writes must not start the application a second time.
        if (op.Phase == "starting" && app is { LastOperation: "start", OperationStatus: "failed", LastError: { } error })
        {
            await SettleWorkspaceLaunchFailureAsync(op, requestId, error, ct);
            return FailedWorkspaceStart(journal, error);
        }
        var startRecorded = op.Phase == "starting" && app.LastOperation == "start" &&
            app.LaunchProgress?.Stage is "ready" or "waiting-for-dependencies";
        if (startRecorded)
        {
            if (app.LaunchProgress!.Stage == "ready") await MarkDevelopmentManifestRunningAsync(app.Id, ct);
        }
        else
        {
            try
            {
                if (validateAuthority is not null) await validateAuthority(ct);
                if (alreadyBound)
                {
                    var tree = await DevWorkspaces.Read(op.WorktreeId!, op.Actor.WorkspaceOwner, ct);
                    await DevWorkspaces.CheckDevTreeAsync(tree, app, op.Actor.WorkspaceOwner, ct);
                    if (op.Phase == "starting") await StopDevRuntimeAsync(app, ct);
                }
                op = await DevPhaseAsync(op, "starting", ct);
                await StartCoreAsync(app.Id, afterOwnStop: true, ct, preserveOperationStatus: true);
            }
            catch (Exception ex) when (IsRecordableLifecycleFailure(ex) || ex is AppIdentityException)
            {
                var actual = await RequireAppAsync(app.Id, ct);
                if (actual.LastOperation != "start" || actual.OperationStatus != "failed" || actual.LastError != ex.Message)
                    await RecordBackgroundLifecycleFailureAsync(app.Id, "start", ex.Message, ct);
                await SettleWorkspaceLaunchFailureAsync(op, requestId, ex.Message, ct);
                return FailedWorkspaceStart(journal, ex.Message);
            }
        }
        await DevPhaseAsync(op, "active", ct, completedRequestId: requestId);
        return journal with { State = "completed", Phase = "completed", Code = null, Error = null, Review = null };
    }

    private async Task<AppDevOperation> SettleWorkspaceLaunchFailureAsync(AppDevOperation op, string requestId, string error, CancellationToken ct)
    {
        // Active means the worktree is selected. The normal lifecycle owns runtime and health
        // observations independently. The original request retains its failure after a repair.
        op = (await AppDevStore.ReadAsync(paths, op.AppId, op.Id, ct))!;
        op = op with { Phase = "active", Error = error, Receipts = op.Receipts!.Select(receipt =>
            receipt.RequestId == requestId ? receipt with { State = "failed", Error = error } : receipt).ToArray() };
        await AppDevStore.SaveAsync(paths, op, ct);
        return op;
    }
}
