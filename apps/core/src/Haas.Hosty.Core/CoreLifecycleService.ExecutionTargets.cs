using Haas.Hosty.Launch;

namespace Haas.Hosty.Core;

internal sealed partial class CoreLifecycleService
{
    internal async Task<string?> PackageRuntimeAsync(AppRecord app, CancellationToken ct)
    {
        var installed = await manifests.ReadRuntimeProfilesAsync(app.ManifestPath!, ct);
        var releases = installed.Where(p => !p.Development).ToArray();
        if (releases.Any(p => p.Key == app.SelectedRuntime)) return app.SelectedRuntime;
        var saved = await JsonStorage.ReadAsync<AppPackageBaseline>(Path.Combine(AppExecutionStore.DirectoryFor(paths, app.Id), "package.json"), ct);
        if (saved?.Installation == app.InstalledAt && releases.Any(p => p.Key == saved.Runtime)) return saved.Runtime;
        var active = await AppDevStore.ReadAsync(paths, app, ct);
        if (releases.Any(p => p.Key == active?.PreviousRuntime)) return active!.PreviousRuntime;
        return releases.FirstOrDefault(p => p.Default)?.Key ?? releases.FirstOrDefault()?.Key;
    }

    internal async Task<AppExecutionTargets> ReadExecutionTargetsAsync(string appId, WorkspaceInventory inventory, CancellationToken ct,
        IReadOnlySet<string>? selectableWorktrees = null)
    {
        var app = await RequireAppAsync(appId, ct);
        var installed = await manifests.ReadRuntimeProfilesAsync(app.ManifestPath!, ct);
        var choices = installed.Where(p => !p.Development)
            .Select(p => new AppExecutionChoice("package", p.Key, null, null, p.Key)).ToList();
        var operation = await AppDevStore.ReadAsync(paths, app, ct);
        // The recovery journal remains active before entry binds and while package Return starts.
        // Describe the persisted runtime/source binding, not the unfinished operation's worktree.
        var currentWorktreeId = operation is { Active: true } && operation.Installation == app.InstalledAt &&
            app.SelectedRuntime == operation.TargetRuntime && app.SourceState?.LocalOverridePath == operation.SourcePath
            ? operation.WorktreeId : null;
        AppExecutionChoice current = new(installed.Any(p => p.Key == app.SelectedRuntime && !p.Development)
            ? "package" : "legacy", app.SelectedRuntime, null, null, app.SelectedRuntime ?? "Unknown runtime");
        foreach (var workspace in inventory.Workspaces.Where(w => w.State != "released"))
        {
            var candidates = workspace.Worktrees.Where(t => t.State == "active" && t.Apps.Any(a => a.AppId == appId && a.Installed)).ToArray();
            if (candidates.Length == 0) continue;
            var allowed = candidates.Where(t => selectableWorktrees is null || selectableWorktrees.Contains(t.Id)).ToArray();
            var resolved = await ResolveWorkspaceTreeAsync(app, workspace.Id, allowed.Select(t => t.Id).ToArray(),
                null, currentWorktreeId, ct);
            var tree = allowed.SingleOrDefault(t => t.Id == resolved.WorktreeId);
            var recipe = tree is null ? null : await ReadWorkspaceRecipeAsync(app, installed, tree.Id, ct, resolved.Runtime);
            var reason = tree is null ? resolved.Unavailable
                : recipe is null ? "Configure a development runtime for this workspace."
                : tree.Observation?.State is "unavailable" ? "Workspace source is unavailable." : null;
            var choice = new AppExecutionChoice("workspace", recipe, workspace.Id, tree?.Id,
                workspace.Name ?? workspace.Owner.Label, reason is null, reason);
            if (allowed.Length > 0) choices.Add(choice);
            if (currentWorktreeId is not null && candidates.SingleOrDefault(t => t.Id == currentWorktreeId) is { } activeTree)
                current = new("workspace", app.SelectedRuntime, workspace.Id, activeTree.Id, choice.Name,
                    allowed.Any(t => t.Id == activeTree.Id), allowed.Any(t => t.Id == activeTree.Id) ? null
                        : "This workspace belongs to another user or credential.");
        }
        return new(appId, current, await PackageRuntimeAsync(app, ct), choices.ToArray());
    }

    private string WorkspaceRecipePath(string appId, string treeId) => Path.Combine(
        AppExecutionStore.DirectoryFor(paths, appId), "recipes", treeId + ".json");

    private async Task<string?> ReadWorkspaceRecipeAsync(AppRecord app, IReadOnlyList<RuntimeProfileManifest> installed, string treeId, CancellationToken ct,
        string? configured = null)
    {
        var profiles = installed.Where(p => p.Development).ToArray();
        if (configured is not null) return profiles.Any(p => p.Key == configured) ? configured : null;
        var recipe = await JsonStorage.ReadAsync<WorkspaceExecutionRecipe>(WorkspaceRecipePath(app.Id, treeId), ct);
        if (recipe?.Installation == app.InstalledAt && profiles.Any(p => p.Key == recipe.Runtime)) return recipe.Runtime;
        return profiles.FirstOrDefault(p => p.Default)?.Key ?? profiles.FirstOrDefault(p => p.Key == "dev")?.Key
            ?? (profiles.Length == 1 ? profiles[0].Key : null);
    }

    internal Task<AppExecutionOperation> ExecuteTargetAsync(AppExecutionOperation operation, CancellationToken ct,
        Func<CancellationToken, Task>? validateAuthority = null) =>
        WithAppLockAsync(operation.AppId, () => ExecuteTargetCoreAsync(operation, ct, validateAuthority), ct, developmentOperation: true);

    private async Task<AppExecutionOperation> ExecuteTargetCoreAsync(AppExecutionOperation journal, CancellationToken ct,
        Func<CancellationToken, Task>? validateAuthority)
    {
        DevelopmentWorkspace? preparationTree = null;
        string? heldLease = null;
        try
        {
        if (journal.State == "completed") return journal;
        var app = await RequireAppAsync(journal.AppId, ct);
        var ownerFile = Path.Combine(AppExecutionStore.DirectoryFor(paths, app.Id), "owner.json");
        var owner = await JsonStorage.ReadAsync<AppExecutionOwner>(ownerFile, ct);
        if (!File.Exists(AppExecutionStore.FileFor(paths, app.Id, journal.Request.RequestId)))
        {
            journal = journal with { PreviousRequestId = owner?.RequestId };
            await AppExecutionStore.SaveAsync(paths, journal, ct);
        }
        if (owner?.Installation == app.InstalledAt && owner.RequestId != journal.Request.RequestId && owner.RequestId != journal.PreviousRequestId)
            throw DevError("selection_changed", "A newer selection owns this app. The retained request was not reapplied.");
        async Task ClaimAsync()
        {
            await ClaimExecutionTargetAsync(app, journal.Request.RequestId, ct);
        }
        if (app.InstalledAt != journal.Installation) throw DevError("installation_changed", "This request belongs to another installation.");
        var request = journal.Request;
        var ownId = WorkspaceRuntimeFiles.ChildId(request.RequestId, "execution:" + app.Id);
        var retained = File.Exists(AppDevStore.Record(paths, app.Id, ownId))
            ? await AppDevStore.ReadAsync(paths, app.Id, ownId, ct) : null;
        if (retained is { Phase: "active" } && retained.Receipts?.Any(r => r.RequestId == request.RequestId && r.State == "succeeded") == true)
            return journal with { State = "completed", Phase = "completed", Code = null, Error = null, Review = null };
        if (retained is { Phase: "starting", PackageReturn: true } && app.DevModeId == retained.Id &&
            app.SelectedRuntime == retained.TargetRuntime && app.SourceState?.LocalOverridePath == retained.SourcePath &&
            app.RuntimeState == "running" && (await GetHealthAsync(app.Id, ct)).Status == "healthy")
        {
            if (validateAuthority is not null) await validateAuthority(ct);
            await DevPhaseAsync(retained, "active", ct, completedRequestId: request.RequestId);
            return journal with { State = "completed", Phase = "completed", Code = null, Error = null, Review = null };
        }
        var active = await AppDevStore.ReadAsync(paths, app, ct);
        if (app.DevModeId != retained?.Id && (journal.Phase is "pending" or "prepared") && AppExecutionStore.Binding(app) != journal.ExpectedBinding)
            throw DevError("selection_changed", "The application target changed before this request started. Select the intended target again.");

        if (journal.OnlyWorkspaceId is { } expectedWorkspace)
        {
            var tree = active?.WorktreeId is { } treeId ? await DevWorkspaces.Read(treeId, null, ct) : null;
            if (tree?.WorkspaceId != expectedWorkspace)
                return journal with { State = "completed", Phase = "completed", Code = "execution_target_unchanged" };
        }
        if (validateAuthority is not null) await validateAuthority(ct);
        var packageRuntime = await PackageRuntimeAsync(app, ct);
        if (request.Kind == "package")
        {
            var target = request.Runtime ?? packageRuntime ?? throw DevError("package_unavailable", "This app has no installed release runtime.");
            var selection = await manifests.LoadAsync(app.ManifestPath!, target, ct);
            if (selection.RuntimeProfile.Development)
                throw DevError("package_invalid", "A development recipe is only available through a registered workspace.");
            await ClaimAsync();
            if (active is { Active: true })
            {
                // A new explicit package selection supersedes the operation's captured previous runtime.
                active = active with { PackageReturn = true, PackageRuntime = target, WasRunning = AppRuntimeStates.IsUp(app.RuntimeState) || active.WasRunning };
                await AppDevStore.SaveAsync(paths, active, ct);
                journal = journal with { Phase = "switching" };
                await AppExecutionStore.SaveAsync(paths, journal, ct);
                if (active.Phase is "return-bound" or "return-starting" && app.SelectedRuntime != target)
                {
                    // A fresh package choice can supersede an interrupted return after its old
                    // runtime was bound. Stop that runtime before projecting the requested one.
                    await StopDevRuntimeAsync(app, ct);
                    active = await DevPhaseAsync(active, "return-stopped", ct);
                }
                await ReturnDevAsync(active, request.RequestId, false, ct);
                RetireExecutionActivation(active);
            }
            else if (app.SelectedRuntime != target)
            {
                // Persist intent before Stop; the ordinary switch is safe to replan on recovery.
                journal = journal with { Phase = "switching" };
                await AppExecutionStore.SaveAsync(paths, journal, ct);
                var plan = await CreateRuntimeSwitchPlanAsync(app.Id, new(target), ct);
                await ApplyRuntimeSwitchCoreAsync(app.Id, new(target, plan.PlanDigest), ct, request.RequestId);
            }
            await SavePackageRuntimeAsync(await RequireAppAsync(app.Id, ct), target, ct);
            return journal with { State = "completed", Phase = "completed", Code = null, Error = null, Review = null };
        }

        var candidates = (await DevWorkspaces.ListAsync(null, false, ct)).Workspaces.Where(t =>
            t.WorkspaceId == request.WorkspaceId && t.State == "active" &&
            t.Apps.Any(a => a.AppId == app.Id && a.Installation == app.InstalledAt)).ToArray();
        var explicitTree = request.WorktreeId is { } requestedTree ? await DevWorkspaces.Read(requestedTree, null, ct) : null;
        if (explicitTree is not null && (explicitTree.WorkspaceId != request.WorkspaceId))
            throw DevError("workspace_forbidden", "The selected worktree is outside this workspace.");
        var resolvedTree = await ResolveWorkspaceTreeAsync(app, request.WorkspaceId!, candidates.Select(t => t.Id).ToArray(),
            explicitTree?.Id, active is { Active: true } ? active.WorktreeId : null, ct);
        var candidateTree = candidates.SingleOrDefault(t => t.Id == resolvedTree.WorktreeId)
            ?? throw DevError("worktree_required", resolvedTree.Unavailable ?? "Configure this application's worktree in the workspace.");
        if (candidateTree.WorkspaceId != request.WorkspaceId)
            throw DevError("workspace_forbidden", "The selected worktree is outside this workspace.");
        var sourceActor = journal.Actor.AppId is { } callerApp && journal.Actor.Installation is { } installation
            ? new WorkspaceOwner(callerApp, installation, journal.Actor.UserId, journal.Request.RequestId)
            : WorkspaceOwner.ForExternal(journal.Actor.UserId, journal.Actor.Principal ?? "local-control", journal.Request.RequestId, "Runtime selection");
        // The operator deliberately selects editable workspace source; an editing lease is not a lifecycle lock.
        await DevWorkspaces.CheckDevTreeAsync(candidateTree, app, sourceActor, ct);
        var installedRecipe = await manifests.ReadRuntimeProfilesAsync(app.ManifestPath!, ct);
        var runtime = request.Runtime ?? await ReadWorkspaceRecipeAsync(app, installedRecipe, candidateTree.Id, ct, resolvedTree.Runtime)
            ?? throw DevError("recipe_required", "Configure a development runtime during workspace setup.");
        if (!installedRecipe.Any(p => p.Key == runtime && p.Development))
            throw DevError("profile_unsupported", "The workspace needs an installed development execution recipe.");
        if (active is { Phase: "active" } && active.WorktreeId == candidateTree.Id && active.TargetRuntime == runtime && journal.Phase == "pending")
        {
            await ClaimAsync();
            return journal with { State = "completed", Phase = "completed" };
        }
        var actor = new AppDevActor(journal.Actor.UserId, journal.Actor.Via, sourceActor, TrustedLocalOperator: journal.Actor.Principal == "local-control");
        var candidate = await PrepareExecutionCandidateAsync(app, candidateTree.Path, runtime, actor, ct);
        try { await EnsureExecutionCandidateApprovedAsync(candidate, app, ct); }
        catch (AppLifecycleException ex) when (ex.Code == "dev_review_required")
        {
            return journal with { State = "review-required", Code = ex.Code,
                Error = journal.Actor.Via == "local-control" ? "This workspace needs additional access. Select it in Dashboard to review the access with your signed-in identity." : ex.Message,
                Review = journal.Actor.Via == "local-control" ? null : await CreateExecutionCandidateReviewAsync(candidate, app, actor, ct) };
        }
        if (retained?.ExecutionManifestDigest is { } preparedDigest && preparedDigest != candidate.Selection.ManifestDigest)
        {
            if (retained.Phase == "prepared" && app.DevModeId != retained.Id && AppExecutionStore.Binding(app) == journal.ExpectedBinding)
            {
                // Nothing has replaced the current app yet. Rebuild the changed candidate under
                // the same intent rather than pairing a new manifest with old prepared artifacts.
                retained = null;
                journal = journal with { Prepared = null, CandidateDigest = null };
                await AppExecutionStore.SaveAsync(paths, journal, ct);
            }
            else
                throw DevError("plan_changed", "Workspace source changed after replacement began. Return to the package or select the workspace again.");
        }
        await ClaimAsync();
        if (retained is null)
        {
            SecureFileSystem.EnsurePrivateDirectory(AppDevStore.Root(paths, app.Id));
            var previous = await manifests.LoadAsync(app.ManifestPath!, app.SelectedRuntime, ct);
            var saved = Path.Combine(AppDevStore.Root(paths, app.Id), ownId + ".manifest.json");
            await File.WriteAllTextAsync(saved, previous.ManifestJson, ct);
            var git = await AppSourceService.ReadScopeStatusAsync(app.Id, () => candidateTree.Path, null, clock.UtcNow, ct);
            if (git.Head is null || git.State is not ("clean" or "changes"))
                throw DevError("source_unavailable", "The selected workspace must be a readable Git worktree.");
            retained = new(ownId, app.Id, app.InstalledAt, actor, runtime, candidateTree.Path, candidateTree.Id,
                previous.ManifestDigest, saved, packageRuntime, active is { Active: true } ? active.PreviousSource : app.SourceState,
                active is { Active: true } ? active.PreviousArtifacts : app.ArtifactLocks, AppRuntimeStates.IsUp(app.RuntimeState),
                await DevConfigurationHashAsync(app, ct), "prepared",
                Receipts: [new(request.RequestId, journal.Fingerprint, "enter", "pending")], SourceHead: git.Head,
                PreparedRuntime: journal.Prepared, PackageReturn: true, PackageRuntime: packageRuntime);
            retained = await SaveExecutionCandidateAsync(retained, candidate, ct);
            if (journal.Phase != "switching" && journal.CandidateDigest is not null && journal.CandidateDigest != candidate.Selection.ManifestDigest)
                journal = journal with { Prepared = null, CandidateDigest = null };
            if (journal.Prepared is null)
            {
                var prospective = BuildDevelopmentRecord(app, candidate.Selection, retained) with
                    { SourceState = app.SourceState! with { LocalOverridePath = candidateTree.Path }, ArtifactLocks = null, DevModeId = app.DevModeId };
                await EnsureRequiredSettingsConfiguredAsync(prospective, ct);
                var context = EnsureMountsReadyForStart(await CreateRuntimeContextAsync(prospective, candidate.Selection, ct));
                var scratch = Path.Combine(AppExecutionStore.DirectoryFor(paths, app.Id), "preparation", request.RequestId);
                context = context with { SourceRoot = candidateTree.Path, AppDataPath = Path.Combine(scratch, "data"),
                    AppCachePath = Path.Combine(scratch, "cache"), PreparationOnly = true, WorkspaceActivationId = request.RequestId };
                if (ResolveAdapter(candidate.Selection.RuntimeProfile.Type) is not IRuntimePreparation adapter)
                    throw DevError("preparation_unsupported", "This development runtime cannot prepare before replacement.");
                if (journal.PreparationLeaseId is { } abandoned && candidateTree.Leases.Contains(abandoned))
                    throw DevError("preparation_recovery_required", "A retained preparation may still use this workspace. Inspect its processes and recover that lease before retrying.");
                var lease = Guid.NewGuid().ToString("D");
                journal = journal with { PreparationLeaseId = lease };
                await AppExecutionStore.SaveAsync(paths, journal, ct);
                preparationTree = candidateTree;
                heldLease = lease;
                await DevWorkspaces.CommandAsync(candidateTree.Id, candidateTree.Owner, "lease",
                    new(WorkspaceRuntimeFiles.ChildId(lease, "acquire"), LeaseId: lease), ct);
                var prepared = await adapter.PrepareAsync(context, ct);
                journal = journal with { Prepared = prepared, CandidateDigest = candidate.Selection.ManifestDigest, Phase = "prepared" };
                await AppExecutionStore.SaveAsync(paths, journal, ct);
            }
            if (candidate.Selection.ManifestDigest != journal.CandidateDigest)
                throw DevError("source_changed", "The manifest changed after preparation. Select the workspace again.");
            if (validateAuthority is not null) await validateAuthority(ct);
            await EnsureExecutionCandidateApprovedAsync(candidate, await RequireAppAsync(app.Id, ct), ct);
            if (packageRuntime is not null) await SavePackageRuntimeAsync(app, packageRuntime, ct);
            SecureFileSystem.EnsurePrivateDirectory(AppDevStore.Root(paths, app.Id));
            retained = retained with { PreparedRuntime = journal.Prepared };
            await AppDevStore.SaveAsync(paths, retained, ct);
        }
        if (app.DevModeId != retained.Id && AppExecutionStore.Binding(app) != journal.ExpectedBinding)
            throw DevError("selection_changed", "A newer execution target owns this app. The retained request was not reapplied.");

        journal = journal with { Phase = "switching" };
        await AppExecutionStore.SaveAsync(paths, journal, ct);
        if (app.DevModeId != retained.Id)
        {
            if (active is { Active: true })
            {
                await StopDevRuntimeAsync(app, ct);
                await RemoveDevelopmentAuthorityAsync(app, active, ct);
                await AppDevStore.SaveAsync(paths, active with { Phase = "returned" }, ct);
                RetireExecutionActivation(active);
            }
            await apps.UpdateAppAsync(app.Id, current => current with { DevModeId = retained.Id }, ct);
        }
        await DevWorkspaces.WithDevAdmissionAsync(candidateTree.Id, await RequireAppAsync(app.Id, ct), sourceActor,
            async () => { await EnterDevAsync(retained, request.RequestId, ct); return true; }, ct);
        var configuredRecipe = await JsonStorage.ReadAsync<WorkspaceExecutionRecipe>(WorkspaceRecipePath(app.Id, candidateTree.Id), ct);
        await JsonStorage.WriteAsync(WorkspaceRecipePath(app.Id, candidateTree.Id), new WorkspaceExecutionRecipe(app.Id, app.InstalledAt, runtime,
            configuredRecipe?.Installation == app.InstalledAt ? configuredRecipe.Requests : null), true, ct);
        return journal with { State = "completed", Phase = "completed", Code = null, Error = null, Review = null, PreparationLeaseId = null };
        }
        finally
        {
            if (heldLease is not null && preparationTree is not null)
            {
                // Keep source reserved until native preparation has exited and the execution
                // pointer protects its consumer. A hard crash retains this lease for inspection.
                await DevWorkspaces.CommandAsync(preparationTree.Id, preparationTree.Owner, "release-lease",
                    new(WorkspaceRuntimeFiles.ChildId(heldLease, "release"), LeaseId: heldLease), CancellationToken.None);
                journal = journal with { PreparationLeaseId = null };
                await AppExecutionStore.SaveAsync(paths, journal, CancellationToken.None);
            }
        }
    }

    private Task ClaimExecutionTargetAsync(AppRecord app, string requestId, CancellationToken ct) =>
        JsonStorage.WriteAsync(Path.Combine(AppExecutionStore.DirectoryFor(paths, app.Id), "owner.json"),
            new AppExecutionOwner(app.InstalledAt, requestId), true, ct);

    private Task SavePackageRuntimeAsync(AppRecord app, string runtime, CancellationToken ct) =>
        JsonStorage.WriteAsync(Path.Combine(AppExecutionStore.DirectoryFor(paths, app.Id), "package.json"),
            new AppPackageBaseline(app.InstalledAt, runtime), true, ct);

    private void RetireExecutionActivation(AppDevOperation operation)
    {
        if (operation.ActivationId is not { } id) return;
        var activation = WorkspaceRuntimeFiles.Read(paths.DataRoot, id);
        var returned = (activation.ReturnedApps ?? []).Append(operation.AppId).Distinct(StringComparer.Ordinal).ToArray();
        WorkspaceRuntimeFiles.Save(paths.DataRoot, activation with { ReturnedApps = returned,
            Phase = activation.CoreProject is null && activation.Apps.All(returned.Contains) ? "returned" : activation.Phase });
    }
}
