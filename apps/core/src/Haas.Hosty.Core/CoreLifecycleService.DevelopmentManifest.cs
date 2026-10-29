namespace Haas.Hosty.Core;

internal sealed partial class CoreLifecycleService
{
    private static string[] DevelopmentBaseGrants(AppRecord app, AppDevOperation? operation)
        => (app.GrantedCorePermissions ?? []).Except((operation?.ExecutionGrantedPermissions ?? [])
            .Except(operation?.BaseGrantedPermissions ?? [], StringComparer.Ordinal), StringComparer.Ordinal).ToArray();
    private static string[] DevelopmentBaseRoles(AppRecord app, AppDevOperation? operation)
        => (app.ConfirmedRoles ?? []).Except((operation?.ExecutionConfirmedRoles ?? [])
            .Except(operation?.BaseConfirmedRoles ?? [], StringComparer.Ordinal), StringComparer.Ordinal).ToArray();

    internal async Task<AppDevelopmentCandidate> PrepareExecutionCandidateAsync(AppRecord app, string sourcePath,
        string runtime, AppDevActor actor, CancellationToken ct)
    {
        sourcePath = MountPathPolicy.ResolveRealPath(sourcePath);
        // The installed package is a comparison/authority baseline, never the
        // execution candidate. Its retired permissions must not block a valid
        // workspace that has already removed them.
        var installed = await manifests.LoadAsync(app.ManifestPath!, runtime, ct, forceRead: true);
        await ValidateDevSourceAuthorityAsync(app, installed, actor, ct);
        await new HostPathAuthority(paths, apps).OverrideAsync(app, sourcePath, ct);
        var candidate = await manifests.LoadAsync(CombineManifestSubpath(sourcePath, app.SourceState?.ManifestSubpath),
            runtime, ct, validateAllProfiles: true, forceRead: true);
        if (!candidate.RuntimeProfile.Development || candidate.Services.Any(s => s.Runtime.Type is not ("docker" or "localCommand")))
            throw DevError("profile_unsupported", "The selected workspace needs a supported source development recipe.");
        var operation = await AppDevStore.ReadAsync(paths, app, ct);
        var grants = DevelopmentBaseGrants(app, operation);
        var roles = DevelopmentBaseRoles(app, operation);
        // Carry only previously admitted, still-granted and still-requested workspace
        // authority into a restart of that same source/runtime. Return keeps its base.
        var sameWorkspace = operation is { Active: true, ExecutionManifest: not null } &&
            operation.SourcePath == sourcePath && operation.TargetRuntime == runtime;
        var effectiveGrants = grants.Concat(sameWorkspace ? (operation!.ExecutionGrantedPermissions ?? [])
            .Intersect(app.GrantedCorePermissions ?? [], StringComparer.Ordinal)
            .Intersect(candidate.Manifest.CorePermissions.Concat(candidate.Manifest.OptionalCorePermissions), StringComparer.Ordinal) : [])
            .Distinct(StringComparer.Ordinal).ToArray();
        var effectiveRoles = roles.Concat(sameWorkspace ? (operation!.ExecutionConfirmedRoles ?? [])
            .Intersect(app.ConfirmedRoles ?? [], StringComparer.Ordinal)
            .Intersect(PlatformCapabilities.RequestedRoles(candidate.Manifest.Provides), StringComparer.Ordinal) : [])
            .Distinct(StringComparer.Ordinal).ToArray();
        var classification = AppDevelopmentManifest.Classify(installed, candidate, effectiveGrants, effectiveRoles, app.Mounts, app.System);
        var stamp = DevelopmentWorkspaceService.Hash(string.Join("\n", app.Id, app.InstalledAt.ToString("O"),
            installed.ManifestDigest, sourcePath, runtime, candidate.ManifestDigest, app.PermissionRevision,
            string.Join(",", grants.Order(StringComparer.Ordinal)), string.Join(",", roles.Order(StringComparer.Ordinal)),
            string.Join(",", effectiveGrants.Order(StringComparer.Ordinal)), string.Join(",", effectiveRoles.Order(StringComparer.Ordinal)),
            await DevConfigurationHashAsync(BuildAppRecord(candidate, app.ManifestPath!, app.ManifestUrl, app.System, app), ct)));
        var digest = DevelopmentWorkspaceService.Hash(stamp + "\n" + actor.UserId + "\n" + actor.Via);
        var review = new AppDevelopmentAccessPlan(app.Id, installed.Manifest.Name ?? app.DisplayName, app.InstalledAt, sourcePath, runtime,
            candidate.ManifestDigest, stamp, digest, actor.UserId, actor.Via, classification.AdditionalAccess,
            candidate.Manifest.CorePermissions.ToArray(), candidate.Manifest.OptionalCorePermissions.ToArray(), grants, roles);
        return new(candidate, sourcePath, stamp, classification, review, actor, effectiveGrants, effectiveRoles);
    }

    internal Task<InstallationPrepare> CreateExecutionCandidateReviewAsync(AppDevelopmentCandidate candidate,
        AppRecord app, AppDevActor actor, CancellationToken ct)
    {
        if (candidate.Review.AppId != app.Id || candidate.Review.UserId != actor.UserId || candidate.Review.Via != actor.Via)
            throw DevError("review_stale", "Prepare the current workspace candidate again.");
        return Task.FromResult(new InstallationPrepare(WorkspaceManifest: candidate.Review));
    }

    private string DevelopmentConsentPath(string appId, string digest)
        => Path.Combine(AppDevStore.Root(paths, appId), "consents", digest + ".json");

    internal async Task EnsureExecutionCandidateApprovedAsync(AppDevelopmentCandidate candidate, AppRecord app, CancellationToken ct)
    {
        if (candidate.Review.Installation != app.InstalledAt) throw DevError("review_stale", "The app installation changed. Select the workspace again.");
        // Preparation can run for minutes. Re-read source and current authority before setup or
        // teardown, rather than treating a previously computed candidate as a fresh authorization.
        var current = await PrepareExecutionCandidateAsync(app, candidate.SourcePath, candidate.Selection.RuntimeProfile.Key, candidate.Actor, ct);
        if (current.Review.PlanDigest != candidate.Review.PlanDigest)
            throw DevError("review_stale", "The workspace manifest or current authority changed. Select the workspace again.");
        if (!candidate.ReviewRequired) return;
        var consent = await JsonStorage.ReadAsync<AppDevelopmentConsent>(DevelopmentConsentPath(app.Id, candidate.Review.PlanDigest), ct);
        if (consent?.Plan != candidate.Review && (consent is null || CoreJson.Text(consent.Plan) != CoreJson.Text(candidate.Review)))
            throw DevError("review_required", "This workspace requires additional access. Review its concrete access changes through Core confirmation, then retry the same selection.");
    }

    internal Task<AppDevelopmentAccessPlan> PrepareWorkspaceManifestReviewAsync(AppDevelopmentAccessPlan requested,
        string userId, CancellationToken ct)
        => WithAppLockAsync(requested.AppId, async () =>
        {
            if (requested.UserId != userId) throw DevError("review_forbidden", "The workspace review belongs to another administrator.");
            var app = await RequireAppAsync(requested.AppId, ct);
            var current = await PrepareExecutionCandidateAsync(app, requested.SourcePath, requested.Runtime,
                new(userId, requested.Via), ct);
            if (current.Review.PlanDigest != requested.PlanDigest || CoreJson.Text(current.Review) != CoreJson.Text(requested))
                throw DevError("review_stale", "The workspace source or current authority changed. Select the workspace again.");
            return current.Review;
        }, ct, allowDevelopment: true);

    internal Task ApproveWorkspaceManifestAsync(AppDevelopmentAccessPlan review, string userId,
        IReadOnlyList<string> optionalPermissions, CancellationToken ct)
        => WithAppLockAsync(review.AppId, async () =>
        {
            if (review.UserId != userId) throw DevError("review_forbidden", "The workspace review belongs to another administrator.");
            var app = await RequireAppAsync(review.AppId, ct);
            var candidate = await PrepareExecutionCandidateAsync(app, review.SourcePath, review.Runtime,
                new(userId, review.Via), ct);
            if (candidate.Review.PlanDigest != review.PlanDigest || CoreJson.Text(candidate.Review) != CoreJson.Text(review))
                throw DevError("review_stale", "The workspace manifest, installation or authority changed. Select the workspace again.");
            var granted = candidate.GrantedPermissions.Concat(CoreAppPermissions.ResolveGrants(review.RequiredPermissions,
                review.OptionalPermissions, optionalPermissions)).Distinct(StringComparer.Ordinal).ToArray();
            var roles = candidate.ConfirmedRoles.Concat(PlatformCapabilities.RequestedRoles(candidate.Selection.Manifest.Provides))
                .Distinct(StringComparer.Ordinal).ToArray();
            var path = DevelopmentConsentPath(app.Id, review.PlanDigest);
            SecureFileSystem.EnsurePrivateDirectory(Path.GetDirectoryName(path)!);
            await JsonStorage.WriteAsync(path, new AppDevelopmentConsent(review, granted, roles, clock.UtcNow), restrictToOwner: true, ct);
            return true;
        }, ct, allowDevelopment: true);

    internal async Task<AppDevOperation> SaveExecutionCandidateAsync(AppDevOperation operation,
        AppDevelopmentCandidate candidate, CancellationToken ct)
    {
        var app = await RequireAppAsync(operation.AppId, ct);
        await EnsureExecutionCandidateApprovedAsync(candidate, app, ct);
        var directory = AppDevStore.Root(paths, app.Id);
        SecureFileSystem.EnsurePrivateDirectory(directory);
        var file = Path.Combine(directory, "execution-" + candidate.Selection.ManifestDigest + ".manifest.json");
        await JsonStorage.WriteTextAsync(file, candidate.Selection.ManifestJson, ct);
        var consent = candidate.ReviewRequired ? await JsonStorage.ReadAsync<AppDevelopmentConsent>(
            DevelopmentConsentPath(app.Id, candidate.Review.PlanDigest), ct) : null;
        var next = operation with { ExecutionManifest = file, ExecutionManifestDigest = candidate.Selection.ManifestDigest,
            BaseGrantedPermissions = candidate.Review.BaseGrantedPermissions,
            ExecutionGrantedPermissions = consent?.GrantedPermissions ?? candidate.GrantedPermissions,
            BaseConfirmedRoles = candidate.Review.BaseConfirmedRoles,
            ExecutionConfirmedRoles = consent?.ConfirmedRoles ?? candidate.ConfirmedRoles };
        var executionHash = await DevConfigurationHashAsync(BuildDevelopmentRecord(app, candidate.Selection, next), ct);
        return next with { ExecutionConfigurationHash = executionHash,
            PriorExecutionConfigurationHash = operation.ExecutionConfigurationHash != executionHash
                ? operation.ExecutionConfigurationHash : operation.PriorExecutionConfigurationHash,
            ExecutionProjectionPending = true };
    }

    private async Task<RuntimeAppManifestSelection> LoadDevExecutionSelectionAsync(AppDevOperation operation,
        CancellationToken ct, bool running = false)
    {
        var path = running ? operation.RunningManifest ?? operation.ExecutionManifest : operation.ExecutionManifest;
        var selection = await manifests.LoadAsync(path ?? operation.PreviousManifest, operation.TargetRuntime, ct,
            forceRead: true, allowRetiredContracts: running);
        if (path is null && selection.ManifestDigest != operation.ManifestDigest)
            throw DevError("previous_contract_changed", "The retained runtime contract changed; restore the operation record before returning.");
        if (!running && path is not null && selection.ManifestDigest != operation.ExecutionManifestDigest)
            throw DevError("execution_contract_changed", "The admitted workspace execution snapshot is unreadable or changed. Restore it or return to the installed package.");
        return selection;
    }

    private AppRecord BuildDevelopmentRecord(AppRecord app, RuntimeAppManifestSelection selection, AppDevOperation operation)
    {
        var next = BuildAppRecord(selection, app.ManifestPath!, app.ManifestUrl, app.System, app);
        return next with { Version = app.Version, InstallManifestPath = app.InstallManifestPath, SourceState = app.SourceState,
            RequiredCorePermissions = selection.Manifest.CorePermissions.ToArray(),
            OptionalCorePermissions = selection.Manifest.OptionalCorePermissions.ToArray(),
            GrantedCorePermissions = (operation.BaseGrantedPermissions ?? DevelopmentBaseGrants(app, operation)).Concat(operation.ExecutionGrantedPermissions ?? [])
                .Distinct(StringComparer.Ordinal).ToArray(),
            ConfirmedRoles = (operation.BaseConfirmedRoles ?? DevelopmentBaseRoles(app, operation)).Concat(operation.ExecutionConfirmedRoles ?? [])
                .Distinct(StringComparer.Ordinal).ToArray(),
            DevModeId = operation.Id };
    }

    private async Task<AppRecord> ReconcileDevelopmentManifestAsync(AppRecord app, AppSelectionLoad load,
        AppDevOperation operation, CancellationToken ct)
    {
        var candidate = await PrepareExecutionCandidateAsync(app, operation.SourcePath, operation.TargetRuntime, operation.Actor, ct);
        if (candidate.Selection.ManifestDigest != load.Selection.ManifestDigest)
            throw DevError("plan_changed", "The workspace manifest changed during preparation. Retry with the current source.");
        operation = await SaveExecutionCandidateAsync(operation, candidate, ct);
        await AppDevStore.SaveAsync(paths, operation, ct);
        var next = BuildDevelopmentRecord(app, load.Selection, operation) with { ManifestError = null,
            LiveChanges = candidate.Changes, ArtifactLocks = RetainDevelopmentArtifacts(app, load) };
        await PersistRuntimePortsAsync(next, load.Selection, ct);
        await AppDevStore.SaveAsync(paths, operation with { ExecutionProjectionPending = false }, ct);
        return await RequireAppAsync(app.Id, ct);
    }

    private static IReadOnlyDictionary<string, ArtifactLock>? RetainDevelopmentArtifacts(AppRecord app, AppSelectionLoad load)
    {
        if (app.ArtifactLocks is null || load.Baseline is null) return null;
        return app.ArtifactLocks.Where(pair =>
        {
            var before = load.Baseline.Services.FirstOrDefault(service => service.Key == pair.Key);
            var after = load.Selection.Services.FirstOrDefault(service => service.Key == pair.Key);
            if (before is null || after is null || before.Artifact != after.Artifact || before.Image?.TagReference != after.Image?.TagReference) return false;
            return before.Runtime.Build is null && after.Runtime.Build is null ||
                before.Runtime.Build is { } prior && after.Runtime.Build is { } next &&
                DockerSourceRuntime.BuildFingerprint(prior) == DockerSourceRuntime.BuildFingerprint(next);
        }).ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
    }

    private async Task RemoveDevelopmentAuthorityAsync(AppRecord app, AppDevOperation operation, CancellationToken ct)
    {
        if (operation.ExecutionManifest is null) return;
        var installed = await manifests.LoadAsync(app.ManifestPath!, null, ct);
        await apps.UpdateAppAsync(app.Id, current => current with {
            GrantedCorePermissions = DevelopmentBaseGrants(current, operation),
            ConfirmedRoles = DevelopmentBaseRoles(current, operation),
            RequiredCorePermissions = installed.Manifest.CorePermissions.ToArray(),
            OptionalCorePermissions = installed.Manifest.OptionalCorePermissions.ToArray(),
        }, ct);
    }

    private async Task MarkDevelopmentManifestRunningAsync(string appId, CancellationToken ct)
    {
        var app = await RequireAppAsync(appId, ct);
        var operation = await AppDevStore.ReadAsync(paths, app, ct);
        if (operation is { Active: true, ExecutionManifest: not null } &&
            app.SelectedRuntime == operation.TargetRuntime && !operation.Phase.StartsWith("return-", StringComparison.Ordinal))
            await AppDevStore.SaveAsync(paths, operation with { RunningManifest = operation.ExecutionManifest,
                PriorExecutionConfigurationHash = null, ExecutionProjectionPending = false }, ct);
    }
}
