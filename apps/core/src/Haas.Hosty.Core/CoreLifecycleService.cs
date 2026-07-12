using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;

namespace Haas.Hosty.Core;

internal sealed class CoreLifecycleService(
    CoreDataPaths paths,
    AppRegistryStore apps,
    AppManifestService manifests,
    AppBackupService backups,
    AppSourceService sources,
    IEnumerable<IAppRuntimeAdapter> adapters,
    IIngressController ingress,
    ILogger<CoreLifecycleService> logger,
    NotificationService? notifications = null,
    IClock? clock = null,
    GlobalMountStore? globalMounts = null,
    MountPathPolicy? mountPathPolicy = null,
    // Generic app-owned feed loader. Optional only for legacy unit fixtures that do not exercise feeds;
    // production DI always supplies it.
    AppFeedService? feedService = null)
{
    private static readonly Regex BackupReasonPattern = new("^[a-z0-9][a-z0-9-]{0,30}$", RegexOptions.Compiled);
    private static readonly Regex MountLabelPattern = new("^[a-z0-9][a-z0-9._-]{0,62}$", RegexOptions.Compiled);

    // Optional in tests (which exercise lifecycle, not telemetry); DI always supplies the singletons.
    private readonly IClock clock = clock ?? new SystemClock();
    // Host-level shared-mounts library and the shared host-path policy. Default-constructed in tests
    // (both only need CoreDataPaths); DI supplies the singletons.
    private readonly GlobalMountStore globalMounts = globalMounts ?? new GlobalMountStore(paths);
    private readonly MountPathPolicy mountPathPolicy = mountPathPolicy ?? new MountPathPolicy(paths);

    // Per-app operation lock. AppRegistryStore.appLocks only serializes a single record write; a whole
    // lifecycle verb reads a record, runs a long operation, then commits a rebuilt record, so two verbs
    // on one app can still interleave — a concurrent Configure committing mid-update is silently reverted,
    // concurrent Starts interleave docker rm -f/run. This holds one app's verb to completion. Keyed by app
    // id and unbounded like appLocks (bounded in practice by the number of distinct apps ever operated).
    // NOT reentrant: verbs that internally start an app (ConfigureDevelopmentMode, ApplyUpdate,
    // ApplyRuntimeSwitch, CreateManualBackup) call StartCoreAsync — the unlocked body — never StartAsync.
    private readonly ConcurrentDictionary<string, SemaphoreSlim> operationLocks = new(StringComparer.Ordinal);

    private async Task<T> WithAppLockAsync<T>(string appId, Func<Task<T>> operation, CancellationToken cancellationToken)
    {
        var mutex = operationLocks.GetOrAdd(appId, _ => new SemaphoreSlim(1, 1));
        await mutex.WaitAsync(cancellationToken);
        try
        {
            return await operation();
        }
        finally
        {
            mutex.Release();
        }
    }

    public async Task<IReadOnlyList<AppSummary>> ListAppsAsync(CancellationToken cancellationToken = default)
    {
        var records = await apps.ListAppRecordsAsync(cancellationToken);
        var summaries = new List<AppSummary>(records.Count);
        foreach (var app in records)
        {
            var reconciled = await ReconcileRuntimeStateForSummaryAsync(app, cancellationToken);
            summaries.Add(await BuildAppSummaryAsync(reconciled, cancellationToken));
        }

        return summaries;
    }

    public async Task<AppInstallPlan> CreateInstallPlanAsync(AppInstallPlanRequest request, CancellationToken cancellationToken = default)
    {
        var selection = await manifests.LoadAsync(request.ManifestPath, request.SelectedRuntime, cancellationToken);
        return await BuildInstallPlanAsync(request, selection, cancellationToken);
    }

    private async Task<AppInstallPlan> BuildInstallPlanAsync(
        AppInstallPlanRequest request,
        RuntimeAppManifestSelection selection,
        CancellationToken cancellationToken)
    {
        var existing = await apps.GetAppAsync(selection.Manifest.Id!, cancellationToken);
        string? currentManifestDigest = null;
        if (!string.IsNullOrWhiteSpace(existing?.ManifestPath) && File.Exists(existing.ManifestPath))
        {
            try
            {
                currentManifestDigest = (await manifests.LoadAsync(existing.ManifestPath, existing.SelectedRuntime, cancellationToken)).ManifestDigest;
            }
            catch (AppManifestException)
            {
                currentManifestDigest = null;
            }
        }

        return new AppInstallPlan(
            AppId: selection.Manifest.Id!,
            DisplayName: selection.Manifest.Name!,
            Description: selection.Manifest.Description,
            Action: existing is null ? "install" : "already-installed",
            CurrentVersion: existing?.Version,
            TargetVersion: selection.Manifest.Version!,
            CurrentRuntime: existing?.SelectedRuntime,
            TargetRuntime: selection.RuntimeProfile.Key,
            TargetRuntimeType: selection.RuntimeProfile.Type,
            ManifestPath: selection.ManifestPath,
            CurrentManifestDigest: currentManifestDigest,
            TargetManifestDigest: selection.ManifestDigest,
            DefaultAutostart: request.Autostart ?? true,
            System: request.System || IsSystemManifest(selection.Manifest),
            RuntimeProfiles: BuildRuntimeProfileSummaries(selection.Manifest),
            Settings: selection.Manifest.Settings
                .Where(setting => !PublicOriginSettings.IsSettingKey(setting.Key))
                .Select(setting => new AppInstallSetting(setting.Key, setting.Type, setting.Secret ? null : setting.Default, setting.Secret, setting.Required, setting.Label, setting.Description))
                .ToArray());
    }

    public async Task<AppFeedInstallPlan> CreateFeedInstallPlanAsync(
        AppFeedInstallPlanRequest request,
        CancellationToken cancellationToken = default)
        => (await CreateFeedInstallPlanCoreAsync(request, cancellationToken)).Plan;

    private async Task<(AppFeedInstallPlan Plan, RuntimeAppManifestSelection Selection)> CreateFeedInstallPlanCoreAsync(
        AppFeedInstallPlanRequest request,
        CancellationToken cancellationToken)
    {
        var resolution = await RequireFeedService().ResolveAsync(request.FeedsUrl, request.FeedId, cancellationToken);
        var selection = await manifests.LoadAsync(resolution.Feed.ManifestRef, request.SelectedRuntime, cancellationToken);
        if (!string.Equals(selection.Manifest.Id, resolution.AppId, StringComparison.Ordinal))
        {
            throw new AppLifecycleException(
                "app_feed_manifest_app_mismatch",
                $"Feed document appId '{resolution.AppId}' does not match selected manifest app id '{selection.Manifest.Id}'.");
        }

        var install = await BuildInstallPlanAsync(
            new AppInstallPlanRequest(resolution.Feed.ManifestRef, request.SelectedRuntime, System: false, Autostart: request.Autostart),
            selection,
            cancellationToken);
        var seed = new AppFeedInstallPlanDigestSeed(
            resolution.FeedsUrl,
            resolution.DocumentDigest,
            resolution.Feed.Id,
            resolution.Feed.ManifestRef,
            install.AppId,
            install.CurrentVersion,
            install.CurrentRuntime,
            install.CurrentManifestDigest,
            install.TargetManifestDigest,
            install.TargetRuntime,
            install.DefaultAutostart);
        var plan = new AppFeedInstallPlan(
            install,
            resolution.FeedsUrl,
            resolution.Feed.Id,
            resolution.Feed.ManifestRef,
            resolution.DocumentDigest,
            HashPlanSeed(seed));
        return (plan, selection);
    }

    public async Task<AppLifecycleResponse> ApplyFeedInstallAsync(
        AppFeedInstallApplyRequest request,
        CancellationToken cancellationToken = default)
    {
        var planRequest = new AppFeedInstallPlanRequest(
            request.FeedsUrl,
            request.FeedId,
            request.SelectedRuntime,
            request.Autostart);
        // Resolve once to discover the app-id lock, then repeat the authoritative review while holding
        // it. Otherwise another install/update could change the current-state portion of the digest
        // between validation and persistence.
        var candidate = await CreateFeedInstallPlanCoreAsync(planRequest, cancellationToken);
        return await WithAppLockAsync(
            candidate.Plan.Install.AppId,
            async () =>
            {
                var reviewed = await CreateFeedInstallPlanCoreAsync(planRequest, cancellationToken);
                if (!string.Equals(reviewed.Plan.PlanDigest, request.PlanDigest, StringComparison.Ordinal))
                {
                    throw new AppLifecycleException(
                        "feed_install_plan_digest_mismatch",
                        "Feed install plan digest does not match the current feed and manifest inputs.");
                }

                var install = new AppInstallRequest(
                    ManifestPath: reviewed.Plan.ManifestUrl,
                    SelectedRuntime: reviewed.Plan.Install.TargetRuntime,
                    System: false,
                    Settings: request.Settings,
                    Autostart: request.Autostart,
                    StartOnInstall: request.StartOnInstall,
                    FeedsUrl: reviewed.Plan.FeedsUrl,
                    FeedId: reviewed.Plan.FeedId);
                return await InstallCoreAsync(install, reviewed.Selection, cancellationToken);
            },
            cancellationToken);
    }

    public async Task<AppLifecycleResponse> InstallAsync(AppInstallRequest request, CancellationToken cancellationToken = default)
    {
        var selection = await manifests.LoadAsync(request.ManifestPath, request.SelectedRuntime, cancellationToken);
        return await WithAppLockAsync(selection.Manifest.Id!, () => InstallCoreAsync(request, selection, cancellationToken), cancellationToken);
    }

    private async Task<AppLifecycleResponse> InstallCoreAsync(AppInstallRequest request, RuntimeAppManifestSelection selection, CancellationToken cancellationToken)
    {
        var appRoot = GetAppRoot(selection.Manifest.Id!);
        var manifestCopyPath = Path.Combine(appRoot, "manifest.json");

        await manifests.SaveManifestCopyAsync(selection, appRoot, cancellationToken);
        await manifests.VendorDisplayAssetsAsync(selection, appRoot, cancellationToken);
        if (selection.Manifest.Data?.Enabled == true)
        {
            Directory.CreateDirectory(GetAppDataPath(selection.Manifest.Id!));
        }

        var record = BuildAppRecord(
            selection,
            manifestCopyPath,
            manifestUrl: selection.ManifestUrl,
            system: request.System || IsSystemManifest(selection.Manifest),
            existing: null) with
        {
            OperationStatus = "installed",
            RuntimeState = "stopped",
            LastOperation = "install",
            Autostart = request.Autostart ?? true,
            FeedsUrl = string.IsNullOrWhiteSpace(request.FeedsUrl) ? null : request.FeedsUrl.Trim(),
            FollowedFeedId = string.IsNullOrWhiteSpace(request.FeedId) ? null : request.FeedId.Trim(),
        };

        // Restore operator config retained from a prior uninstall-that-kept-data, before applying
        // any settings supplied in this install request (which take precedence). Only keys the new
        // manifest still declares survive; mounts are filtered to still-declared slots.
        var retained = await TryReadRetainedConfigAsync(selection.Manifest.Id!, cancellationToken);
        if (retained is not null)
        {
            record = record with
            {
                Settings = OverlayRetainedSettings(record.Settings, retained.Settings),
                Mounts = PreserveMounts(selection.Manifest, retained.Mounts),
                Autostart = request.Autostart ?? retained.Autostart ?? record.Autostart,
            };
        }

        if (request.Settings is { Count: > 0 })
        {
            ValidatePublicOriginSettings(request.Settings);
            record = record with { Settings = MergeSettings(record.Settings, request.Settings) };
        }

        var document = await apps.UpsertAppAsync(record, cancellationToken);
        // Consume the snapshot only once it has been applied. A null `retained` may mean a transient
        // read failure (IO/permissions), so leaving the file lets a later reinstall recover the
        // config instead of permanently discarding it over a hiccup.
        if (retained is not null)
        {
            TryDelete(GetRetainedConfigPath(selection.Manifest.Id!));
        }

        var installed = document.App;
        // An interactive install with autostart enabled starts the app right away, matching the operator's
        // intent ("this app should be running") instead of leaving it stopped until the next Core restart —
        // the only other time Autostart is honored (StartAutostartAppsAsync at boot). We already hold this
        // app's operation lock, so we call the unlocked StartCoreAsync directly (see the operationLocks note).
        // Best-effort: a recordable start failure (missing required setting, runtime unavailable) is already
        // recorded on the app by StartCoreAsync and leaves it stopped, but the install itself still succeeds.
        if (request.StartOnInstall == true &&
            string.Equals(installed.Kind, "runtime", StringComparison.Ordinal) &&
            (installed.Autostart ?? true))
        {
            try
            {
                await StartCoreAsync(installed.Id, cancellationToken);
            }
            catch (Exception ex) when (IsRecordableLifecycleFailure(ex))
            {
                // Intentionally swallowed: StartCoreAsync already recorded the failure on the app
                // (LastError + RuntimeState "stopped"). Install still succeeds and returns "installed".
            }

            installed = await RequireAppAsync(installed.Id, cancellationToken);
        }

        return new AppLifecycleResponse(await BuildAppSummaryAsync(installed, cancellationToken), null, "installed");
    }

    public Task<AppLifecycleResponse> ConfigureAsync(string appId, AppConfigureRequest request, CancellationToken cancellationToken = default)
        => WithAppLockAsync(appId, () => ConfigureCoreAsync(appId, request, cancellationToken), cancellationToken);

    private async Task<AppLifecycleResponse> ConfigureCoreAsync(string appId, AppConfigureRequest request, CancellationToken cancellationToken)
    {
        var policy = NormalizeConfiguredUpdatePolicy(request.UpdatePolicy);
        var document = await apps.UpdateAppAsync(appId, app =>
        {
            ValidatePublicOriginSettings(request.Settings);
            return app with
            {
                Settings = request.Settings is { Count: > 0 } ? MergeSettings(app.Settings, request.Settings) : app.Settings,
                Autostart = request.Autostart ?? app.Autostart,
                UpdatePolicy = policy ?? app.UpdatePolicy,
                OperationStatus = "configured",
                LastOperation = "configure",
                LastError = null,
            };
        }, cancellationToken);

        return new AppLifecycleResponse(await BuildAppSummaryAsync(document.App, cancellationToken), null, "configured");
    }

    // Validates an operator-supplied update policy. null leaves the policy unchanged; otherwise it
    // must be "pinned" or "rolling" (case-insensitive), normalized to lowercase for storage.
    private static string? NormalizeConfiguredUpdatePolicy(string? policy)
    {
        if (string.IsNullOrWhiteSpace(policy))
        {
            return null;
        }

        var trimmed = policy.Trim();
        if (!string.Equals(trimmed, "pinned", StringComparison.OrdinalIgnoreCase) &&
            !string.Equals(trimmed, "rolling", StringComparison.OrdinalIgnoreCase))
        {
            throw new AppLifecycleException("app_update_policy_invalid", $"Update policy '{policy}' must be 'pinned' or 'rolling'.");
        }

        return trimmed.ToLowerInvariant();
    }

    public Task<AppLifecycleResponse> ConfigureAutostartAsync(
        string appId,
        AppAutostartRequest request,
        CancellationToken cancellationToken = default)
        => WithAppLockAsync(appId, () => ConfigureAutostartCoreAsync(appId, request, cancellationToken), cancellationToken);

    private async Task<AppLifecycleResponse> ConfigureAutostartCoreAsync(
        string appId,
        AppAutostartRequest request,
        CancellationToken cancellationToken)
    {
        var document = await apps.UpdateAppAsync(appId, app => app with
        {
            Autostart = request.Autostart,
            OperationStatus = "configured",
            LastOperation = "configure-autostart",
            LastError = null,
        }, cancellationToken);

        return new AppLifecycleResponse(await BuildAppSummaryAsync(document.App, cancellationToken), null, "configured");
    }

    public async Task<AppFeedsResponse> GetFeedsAsync(string appId, CancellationToken cancellationToken = default)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        if (string.IsNullOrWhiteSpace(app.FeedsUrl))
        {
            throw new AppLifecycleException("app_feeds_not_configured", $"Runtime app '{appId}' is not bound to a feeds document.");
        }

        var snapshot = await RequireFeedService().LoadAsync(app.FeedsUrl, cancellationToken);
        RequireFeedAppMatch(app, snapshot.AppId);
        return new AppFeedsResponse(snapshot.FeedsUrl, app.FollowedFeedId, snapshot.Feeds);
    }

    // Changes the selected feed inside the app-owned feeds document. This only changes the future
    // manifest source; the running app changes through the ordinary reviewed update flow.
    public Task<AppLifecycleResponse> SetFeedAsync(
        string appId,
        AppFeedRequest request,
        CancellationToken cancellationToken = default)
        => WithAppLockAsync(appId, () => SetFeedCoreAsync(appId, request, cancellationToken), cancellationToken);

    private async Task<AppLifecycleResponse> SetFeedCoreAsync(
        string appId,
        AppFeedRequest request,
        CancellationToken cancellationToken)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        var feedId = string.IsNullOrWhiteSpace(request.FeedId) ? null : request.FeedId.Trim();
        string? manifestUrl = null;
        if (feedId is not null)
        {
            if (string.IsNullOrWhiteSpace(app.FeedsUrl))
            {
                throw new AppLifecycleException("app_feeds_not_configured", $"Runtime app '{appId}' is not bound to a feeds document.");
            }

            var resolution = await RequireFeedService().ResolveAsync(app.FeedsUrl, feedId, cancellationToken);
            RequireFeedAppMatch(app, resolution.AppId);
            manifestUrl = resolution.Feed.ManifestRef;
        }

        var document = await apps.UpdateAppAsync(appId, current => current with
        {
            FollowedFeedId = feedId,
            ManifestUrl = manifestUrl ?? current.ManifestUrl,
            OperationStatus = "configured",
            LastOperation = "set-feed",
            LastError = null,
        }, cancellationToken);

        return new AppLifecycleResponse(await BuildAppSummaryAsync(document.App, cancellationToken), null, "configured");
    }

    // Operator toggle of a runtime's Development Mode (runtime-artifact-model.md). Records an explicit
    // per-runtime override; an unset runtime falls back to the manifest `development` default. Valid only
    // for a source (localCommand) runtime — image/prebuilt have no working copy to run live. Takes effect
    // on the next start of that runtime; when it is the selected runtime the summary's Live flag flips
    // immediately.
    public Task<AppLifecycleResponse> ConfigureDevelopmentModeAsync(
        string appId,
        AppDevelopmentModeRequest request,
        CancellationToken cancellationToken = default)
        => WithAppLockAsync(appId, () => ConfigureDevelopmentModeCoreAsync(appId, request, cancellationToken), cancellationToken);

    private async Task<AppLifecycleResponse> ConfigureDevelopmentModeCoreAsync(
        string appId,
        AppDevelopmentModeRequest request,
        CancellationToken cancellationToken)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        var profiles = await ResolveRuntimeProfilesAsync(app, cancellationToken);
        var profile = profiles.FirstOrDefault(candidate => string.Equals(candidate.Key, request.Runtime, StringComparison.Ordinal))
            ?? throw new AppLifecycleException("runtime_not_found", $"Runtime '{request.Runtime}' is not declared by app '{appId}'.");
        if (!string.Equals(profile.Type, "localCommand", StringComparison.Ordinal))
        {
            throw new AppLifecycleException(
                "development_mode_unsupported_runtime",
                $"Development Mode is only available for a source (localCommand) runtime, not '{profile.Key}' ({profile.Type}).");
        }

        var currentlyOn = AppSummary.ResolveDevelopmentMode(app, profile);
        var targetsSelected = string.Equals(request.Runtime, app.SelectedRuntime, StringComparison.Ordinal);
        var enabling = request.Enabled && !currentlyOn;
        var disabling = !request.Enabled && currentlyOn;
        var changing = enabling || disabling;
        // System apps (e.g. the Shell) are never stopped/snapshotted/restarted from here: cycling the
        // Shell would drop the operator's own session, and the manual start/stop affordances are gated
        // off system apps too. Their toggle just flips the flag and takes effect on their next start.
        var manageLifecycle = !app.System;

        // Detect a risky disable up front — before we flip or restart, while app.Version still reflects
        // the version that ran live in dev mode. Risk = a pre-dev-mode snapshot exists AND the app has
        // since run a different version (a likely one-way data migration the reviewed version may not
        // read back). Require the snapshot (baseline.BackupId): without one there is nothing to roll back
        // to (also implies the app had no data at enable), so a restart is fine. When risky the app is
        // left stopped and the caller is handed the snapshot to offer before the reviewed version boots.
        AppDevelopmentModeRestoreHint? restoreHint = null;
        if (disabling && targetsSelected && manageLifecycle
            && app.DevelopmentModeBaselines is not null
            && app.DevelopmentModeBaselines.TryGetValue(request.Runtime, out var baseline)
            && baseline.BackupId is not null
            && !string.Equals(baseline.Version, app.Version, StringComparison.Ordinal))
        {
            restoreHint = new AppDevelopmentModeRestoreHint(
                Recommended: true,
                Runtime: request.Runtime,
                BackupId: baseline.BackupId,
                BaselineVersion: baseline.Version,
                CurrentVersion: app.Version);
        }

        // Development Mode is only read at start, so flipping the *selected* running runtime needs a
        // stop/start cycle to take effect. A no-op call (mode already matches) or a non-selected runtime
        // cycles nothing, so an idempotent retry never interrupts a running app. Mirror the manual-backup
        // path's stop->operate->restart so the enable snapshot below copies stopped (consistent) data —
        // and, per that pattern, the stop lives inside the try so the finally still restores a running app
        // if the snapshot or persistence step fails partway.
        var wasRunning = targetsSelected && manageLifecycle && changing && string.Equals(app.RuntimeState, "running", StringComparison.Ordinal);
        var completed = false;
        try
        {
            if (wasRunning)
            {
                var selection = await LoadSelectionForAppAsync(app, cancellationToken);
                _ = await ResolveAdapter(selection.RuntimeProfile.Type)
                    .StopAsync(await CreateRuntimeContextAsync(app, selection, cancellationToken), cancellationToken);
                _ = await apps.UpdateAppAsync(appId, current => current with { RuntimeState = "stopped" }, cancellationToken);
            }

            // Snapshot the pre-migration data before going live so a later disable can roll back to the
            // reviewed version's last-known-good state. CreateBackupAsync returns null when the app has no
            // data directory (nothing to migrate), which the baseline records faithfully.
            AppBackupRecord? backup = enabling && manageLifecycle
                ? await backups.CreateBackupAsync(appId, "pre-development-mode", cancellationToken: cancellationToken)
                : null;
            var baselineVersion = app.Version;
            var recordBaseline = enabling && manageLifecycle;

            var document = await apps.UpdateAppAsync(appId, current =>
            {
                var modes = current.DevelopmentModes is not null
                    ? new Dictionary<string, bool>(current.DevelopmentModes, StringComparer.Ordinal)
                    : new Dictionary<string, bool>(StringComparer.Ordinal);
                modes[request.Runtime] = request.Enabled;

                // Record the reviewed baseline (version + snapshot) on enable so a later disable can weigh a
                // rollback; clear it on any disable so a re-enable captures a fresh baseline.
                var baselines = current.DevelopmentModeBaselines is not null
                    ? new Dictionary<string, DevelopmentModeBaseline>(current.DevelopmentModeBaselines, StringComparer.Ordinal)
                    : new Dictionary<string, DevelopmentModeBaseline>(StringComparer.Ordinal);
                if (recordBaseline)
                {
                    baselines[request.Runtime] = new DevelopmentModeBaseline(baselineVersion, backup?.BackupId);
                }
                else if (!request.Enabled)
                {
                    baselines.Remove(request.Runtime);
                }

                return current with
                {
                    DevelopmentModes = modes,
                    DevelopmentModeBaselines = baselines.Count > 0 ? baselines : null,
                    OperationStatus = "configured",
                    LastOperation = "configure-development-mode",
                    LastError = null,
                };
            }, cancellationToken);

            // The flip is now durable; the restart below is best-effort, so mark the operation complete
            // here — the finally must not double-restart if StartAsync itself throws (it records + rethrows
            // its own failure), nor restart a risky disable that is intentionally left stopped.
            completed = true;

            // Restart to apply — except a risky disable, which is left stopped so the operator can restore
            // the snapshot (via the returned hint) before the reviewed version boots onto migrated data.
            if (wasRunning && restoreHint is null)
            {
                var restarted = await StartCoreAsync(appId, cancellationToken);
                return new AppLifecycleResponse(restarted.App, backup, "configured", restoreHint);
            }

            return new AppLifecycleResponse(await BuildAppSummaryAsync(document.App, cancellationToken), backup, "configured", restoreHint);
        }
        finally
        {
            // The snapshot/persistence step failed or was cancelled after we stopped a running app: restore
            // its prior running state so the toggle never silently leaves it down. CancellationToken.None so
            // a cancelled operation still restarts; a restart failure surfaces through StartAsync.
            if (wasRunning && !completed)
            {
                _ = await StartCoreAsync(appId, CancellationToken.None);
            }
        }
    }

    // Operator-configured external mount bindings. Replaces the full set for the app (idempotent
    // PUT semantics), validating each host path against the manifest-declared slots and the path
    // policy before persisting. Existence of the host paths is enforced lazily at start time.
    public Task<AppLifecycleResponse> ConfigureMountsAsync(
        string appId,
        AppMountsRequest request,
        CancellationToken cancellationToken = default)
        => WithAppLockAsync(appId, () => ConfigureMountsCoreAsync(appId, request, cancellationToken), cancellationToken);

    private async Task<AppLifecycleResponse> ConfigureMountsCoreAsync(
        string appId,
        AppMountsRequest request,
        CancellationToken cancellationToken)
    {
        // Read the library snapshot up front (async); validation itself is synchronous and runs
        // against the current record inside UpdateAppAsync so bindings are checked against the
        // record's live mount slots, not a stale pre-fetched copy.
        var registry = await globalMounts.ReadAsync(cancellationToken);

        var document = await apps.UpdateAppAsync(appId, current => current with
        {
            Mounts = ValidateMountBindings(current, request.Mounts ?? [], registry),
            OperationStatus = "configured",
            LastOperation = "configure-mounts",
            LastError = null,
        }, cancellationToken);

        return new AppLifecycleResponse(await BuildAppSummaryAsync(document.App, cancellationToken), null, "configured");
    }

    private IReadOnlyList<AppMountBinding> ValidateMountBindings(AppRecord app, IReadOnlyList<AppMountBindingInput> inputs, GlobalMountState registry)
    {
        var slots = (app.MountSlots ?? []).ToDictionary(slot => slot.Key, StringComparer.Ordinal);
        var library = registry.Mounts.ToDictionary(mount => mount.Name, StringComparer.Ordinal);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var perKeyCount = new Dictionary<string, int>(StringComparer.Ordinal);
        var result = new List<AppMountBinding>(inputs.Count);

        foreach (var input in inputs)
        {
            var key = input.Key?.Trim() ?? string.Empty;
            if (!slots.TryGetValue(key, out var slot))
            {
                throw new AppLifecycleException("app_mount_slot_unknown", $"App '{app.Id}' does not declare an external mount slot '{key}'.");
            }

            // A global binding references a shared-mounts library entry by name; its label is the entry
            // name (operator cannot rename it) and the host path is resolved from the library. A local
            // binding carries an operator-chosen label and an inline host path.
            var globalName = input.GlobalMountName?.Trim();
            var isGlobal = !string.IsNullOrEmpty(globalName);
            string label;
            string hostPath;
            string? boundGlobalName;
            if (isGlobal)
            {
                if (!library.TryGetValue(globalName!, out var entry))
                {
                    throw new AppLifecycleException("global_mount_not_found", $"Shared mount '{globalName}' was not found.");
                }

                label = entry.Name;
                hostPath = entry.HostPath;
                boundGlobalName = entry.Name;
            }
            else
            {
                label = input.Label?.Trim() ?? string.Empty;
                hostPath = mountPathPolicy.NormalizeAndValidate(input.HostPath);
                boundGlobalName = null;
            }

            if (!MountLabelPattern.IsMatch(label) || label is "." or "..")
            {
                throw new AppLifecycleException("app_mount_label_invalid", $"External mount label '{label}' must match ^[a-z0-9][a-z0-9._-]{{0,62}}$.");
            }

            if (!seen.Add($"{key}/{label}"))
            {
                throw new AppLifecycleException("app_mount_label_duplicate", $"External mount '{key}' declares the label '{label}' more than once.");
            }

            perKeyCount[key] = perKeyCount.GetValueOrDefault(key) + 1;
            if (!slot.Multiple && perKeyCount[key] > 1)
            {
                throw new AppLifecycleException("app_mount_multiple_not_allowed", $"External mount '{key}' does not allow more than one host path.");
            }

            result.Add(new AppMountBinding(key, label, hostPath, boundGlobalName));
        }

        return result;
    }

    private static bool PathEqualsOrWithin(string root, string candidate)
    {
        var fullRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar);
        var fullCandidate = Path.GetFullPath(candidate).TrimEnd(Path.DirectorySeparatorChar);
        if (string.Equals(fullRoot, fullCandidate, PathComparison))
        {
            return true;
        }

        return fullCandidate.StartsWith(fullRoot + Path.DirectorySeparatorChar, PathComparison);
    }

    private static StringComparison PathComparison
        => OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    public Task<AppLifecycleResponse> StartAsync(string appId, CancellationToken cancellationToken = default)
        => WithAppLockAsync(appId, () => StartCoreAsync(appId, cancellationToken), cancellationToken);

    private async Task<AppLifecycleResponse> StartCoreAsync(string appId, CancellationToken cancellationToken)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        IAppRuntimeAdapter? adapter = null;
        RuntimeLifecycleContext? context = null;
        var runtimeStarted = false;
        try
        {
            var load = await LoadSelectionWithStatusAsync(app, cancellationToken);
            var selection = load.Selection;
            // Adopt a live source folder edit before the gates below so they see the live contract
            // (e.g. a newly-required setting blocks start, R8; a new required mount slot is enforced).
            if (load.LiveReconciled)
            {
                app = await ReconcileLiveContractAsync(app, load, cancellationToken);
            }

            await EnsureRequiredSettingsConfiguredAsync(app, cancellationToken);
            app = await EnsureLocalCommandSourceReadyAsync(app, selection, cancellationToken);
            app = await EnsureIngressPublicOriginsAsync(app, selection, cancellationToken);
            adapter = ResolveAdapter(selection.RuntimeProfile.Type);
            context = await CreateRuntimeContextAsync(app, selection, cancellationToken);
            EnsureMountsReadyForStart(context);
            await NotifyMissingDependenciesAsync(app, cancellationToken);
            if (load.ManifestError is not null)
            {
                await NotifyManifestInvalidAsync(app, load.ManifestError, cancellationToken);
            }

            var result = await adapter.StartAsync(context, cancellationToken);
            runtimeStarted = true;
            var updated = await apps.UpdateAppAsync(appId, current => current with
            {
                RuntimeState = result.RuntimeState,
                OperationStatus = "started",
                LastOperation = "start",
                LastError = null,
                Endpoints = MergeEndpointUrls(current.Endpoints, result.Endpoints, selection),
                // Persist the run-locks the adapter resolved (TOFU backfill / rolling advance);
                // a runtime with nothing to pin returns null, leaving any existing locks intact.
                ArtifactLocks = result.ArtifactLocks ?? current.ArtifactLocks,
                // A live source app records the last invalid-folder error (null clears it once the
                // operator's edit validates again); non-source apps always clear it (2b/R14).
                ManifestError = load.ManifestError,
            }, cancellationToken);

            await ReconcileIngressAsync(cancellationToken);
            return new AppLifecycleResponse(await BuildAppSummaryAsync(updated.App, cancellationToken), null, "started");
        }
        catch (Exception ex) when (IsRecordableLifecycleFailure(ex))
        {
            if (runtimeStarted && adapter is not null && context is not null)
            {
                await TryStopRuntimeAsync(adapter, context);
            }

            await RecordForegroundLifecycleFailureAsync(appId, "start", "stopped", ex.Message, cancellationToken);
            throw;
        }
    }

    public Task<AppLifecycleResponse> StopAsync(string appId, CancellationToken cancellationToken = default)
        => WithAppLockAsync(appId, () => StopCoreAsync(appId, cancellationToken), cancellationToken);

    private async Task<AppLifecycleResponse> StopCoreAsync(string appId, CancellationToken cancellationToken)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        var selection = await LoadSelectionForAppAsync(app, cancellationToken);
        var adapter = ResolveAdapter(selection.RuntimeProfile.Type);
        var result = await adapter.StopAsync(await CreateRuntimeContextAsync(app, selection, cancellationToken), cancellationToken);
        var updated = await apps.UpdateAppAsync(appId, current => current with
        {
            RuntimeState = result.RuntimeState,
            OperationStatus = "stopped",
            LastOperation = "stop",
            LastError = null,
        }, cancellationToken);

        await ReconcileIngressAsync(cancellationToken);
        return new AppLifecycleResponse(await BuildAppSummaryAsync(updated.App, cancellationToken), null, "stopped");
    }

    public Task<AppLifecycleResponse> RestartAsync(string appId, CancellationToken cancellationToken = default)
        => WithAppLockAsync(appId, () => RestartCoreAsync(appId, cancellationToken), cancellationToken);

    private async Task<AppLifecycleResponse> RestartCoreAsync(string appId, CancellationToken cancellationToken)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        IAppRuntimeAdapter? adapter = null;
        RuntimeLifecycleContext? context = null;
        var runtimeStarted = false;
        try
        {
            var load = await LoadSelectionWithStatusAsync(app, cancellationToken);
            var selection = load.Selection;
            // Stop must target the contract the running process was started with — the last-good
            // baseline when a live edit is being adopted — so a mid-edit service rename/removal (or
            // runtime-type change) still stops the old process instead of orphaning it; the adopted
            // contract only governs the start below. Built from the pre-reconcile record for the same
            // reason. Without a baseline (non-live app, or invalid edit already falling back to
            // last-good) the stop selection is the start selection, as before.
            var stopSelection = load.Baseline ?? selection;
            var stopAdapter = ResolveAdapter(stopSelection.RuntimeProfile.Type);
            var stopContext = await CreateRuntimeContextAsync(app, stopSelection, cancellationToken);

            // Restart is the natural dev-mode iteration step, so a live source app adopts the folder
            // manifest here exactly like a cold start: the persisted contract (ui/navigation) and the
            // vendored display assets track the folder, not just the process command line. Non-live
            // apps never reconcile (LiveReconciled is false).
            if (load.LiveReconciled)
            {
                app = await ReconcileLiveContractAsync(app, load, cancellationToken);
            }

            adapter = ResolveAdapter(selection.RuntimeProfile.Type);
            context = await CreateRuntimeContextAsync(app, selection, cancellationToken);
            EnsureMountsReadyForStart(context);
            _ = await stopAdapter.StopAsync(stopContext, cancellationToken);
            if (load.ManifestError is not null)
            {
                await NotifyManifestInvalidAsync(app, load.ManifestError, cancellationToken);
            }

            var start = await adapter.StartAsync(context, cancellationToken);
            runtimeStarted = true;
            var updated = await apps.UpdateAppAsync(appId, current => current with
            {
                RuntimeState = start.RuntimeState,
                OperationStatus = "restarted",
                LastOperation = "restart",
                LastError = null,
                Endpoints = MergeEndpointUrls(current.Endpoints, start.Endpoints, selection),
                ArtifactLocks = start.ArtifactLocks ?? current.ArtifactLocks,
                // A live source app records the last invalid-folder error (null clears it once the
                // operator's edit validates again); non-source apps always clear it (2b/R14).
                ManifestError = load.ManifestError,
            }, cancellationToken);

            // Same best-effort ingress reconciliation as start/stop: an adopted live edit can change
            // the endpoint/public-origin shape, so ingress must not stay pinned to the old contract.
            await ReconcileIngressAsync(cancellationToken);
            return new AppLifecycleResponse(await BuildAppSummaryAsync(updated.App, cancellationToken), null, "restarted");
        }
        catch (Exception ex) when (IsRecordableLifecycleFailure(ex))
        {
            if (runtimeStarted && adapter is not null && context is not null)
            {
                await TryStopRuntimeAsync(adapter, context);
            }

            await RecordForegroundLifecycleFailureAsync(appId, "restart", "stopped", ex.Message, cancellationToken);
            throw;
        }
    }

    public async Task<AppUpdatePlan> CreateUpdatePlanAsync(string appId, AppUpdatePlanRequest request, CancellationToken cancellationToken = default)
    {
        var app = await RequireAppAsync(appId, cancellationToken);

        // A live source app (operator-owned folder + source runtime) has no reviewed-update path: its
        // manifest is adopted live on restart, not advanced through a plan (runtime-app-marketplace.md,
        // "Live source"). With no explicit external source to compare against, building a plan would
        // re-read and validate the live folder with no fallback and surface a confusing "manifest failed
        // validation" when it is mid-edit. Refuse with a clear, actionable error instead. Passing an
        // explicit manifestPath/URL still works as an escape hatch for an out-of-band comparison.
        // Resolve profiles with the same fallback as summaries so a legacy record that never persisted
        // RuntimeProfiles is still classified correctly (and not silently treated as non-live).
        var profiles = await ResolveRuntimeProfilesAsync(app, cancellationToken);
        if (string.IsNullOrWhiteSpace(request.ManifestPath) && IsLiveSourceApp(app, profiles))
        {
            throw new AppLifecycleException(
                "update_live_source_runtime",
                "This runtime runs live from your source folder; its manifest is adopted on restart, not through a reviewed update. Switch to a compiled runtime to use reviewed updates.");
        }

        AppFeedResolution? feedResolution = null;
        string? manifestPath;
        if (string.IsNullOrWhiteSpace(request.ManifestPath) && !string.IsNullOrWhiteSpace(app.FeedsUrl))
        {
            if (string.IsNullOrWhiteSpace(app.FollowedFeedId))
            {
                throw new AppLifecycleException(
                    "app_feed_selection_required",
                    $"Runtime app '{appId}' is bound to a feeds document but has no selected feed.");
            }

            feedResolution = await RequireFeedService().ResolveAsync(app.FeedsUrl, app.FollowedFeedId, cancellationToken);
            RequireFeedAppMatch(app, feedResolution.AppId);
            manifestPath = feedResolution.Feed.ManifestRef;
        }
        else
        {
            manifestPath = request.ManifestPath ?? app.ManifestUrl ?? ResolveLocalUpdateManifestPath(app);
        }

        if (string.IsNullOrWhiteSpace(manifestPath))
        {
            throw new AppLifecycleException("manifest_path_required", "Installed app has no manifest path and update request did not provide one.");
        }

        var currentSelection = await LoadSelectionForAppAsync(app, cancellationToken);
        var selection = await manifests.LoadAsync(manifestPath, request.SelectedRuntime ?? app.SelectedRuntime, cancellationToken);
        if (!string.Equals(selection.Manifest.Id, app.Id, StringComparison.Ordinal))
        {
            throw new AppLifecycleException("manifest_app_mismatch", $"Update manifest app id '{selection.Manifest.Id}' does not match installed app '{app.Id}'.");
        }

        var willCreateBackup = Directory.Exists(GetAppDataPath(appId));
        var sourceConfigured = HasExternalUpdateSource(app, request.ManifestPath);
        var changes = BuildUpdateChanges(app, currentSelection, selection).ToList();
        // Surface a compiled-artifact change even when the manifest JSON is byte-identical (a
        // re-pushed tag): resolve the target tag's digest with a light remote lookup and compare it
        // to the current lock. This closes the invisible-update gap and folds the artifact delta into
        // the plan digest the operator confirms. See runtime-app-marketplace.md (Reviewed update / A4).
        changes.AddRange(await BuildArtifactDigestChangesAsync(app, selection, cancellationToken));
        var seed = new AppUpdatePlanDigestSeed(
            appId,
            app.Version,
            selection.Manifest.Version,
            app.SelectedRuntime,
            selection.RuntimeProfile.Key,
            currentSelection.ManifestDigest,
            selection.ManifestDigest,
            manifestPath,
            feedResolution?.FeedsUrl,
            feedResolution?.Feed.Id,
            feedResolution?.DocumentDigest,
            willCreateBackup,
            changes);
        var digest = HashPlanSeed(seed);
        return new AppUpdatePlan(
            AppId: appId,
            CurrentVersion: app.Version,
            TargetVersion: selection.Manifest.Version!,
            CurrentRuntime: app.SelectedRuntime,
            TargetRuntime: selection.RuntimeProfile.Key,
            ManifestPath: selection.ManifestPath,
            ManifestDigest: selection.ManifestDigest,
            PlanDigest: digest,
            WillCreatePreUpdateBackup: willCreateBackup,
            Changes: changes,
            SourceConfigured: sourceConfigured);
    }

    public Task<AppLifecycleResponse> ApplyUpdateAsync(string appId, AppUpdateApplyRequest request, CancellationToken cancellationToken = default)
        => WithAppLockAsync(appId, () => ApplyUpdateCoreAsync(appId, request, cancellationToken), cancellationToken);

    private async Task<AppLifecycleResponse> ApplyUpdateCoreAsync(string appId, AppUpdateApplyRequest request, CancellationToken cancellationToken)
    {
        var plan = await CreateUpdatePlanAsync(appId, new AppUpdatePlanRequest(request.ManifestPath, request.SelectedRuntime), cancellationToken);
        if (!string.Equals(plan.PlanDigest, request.PlanDigest, StringComparison.Ordinal))
        {
            throw new AppLifecycleException("update_plan_digest_mismatch", "Update plan digest does not match the current update plan.");
        }

        var app = await RequireAppAsync(appId, cancellationToken);
        var selection = await manifests.LoadAsync(plan.ManifestPath, plan.TargetRuntime, cancellationToken);
        if (!string.Equals(selection.ManifestDigest, plan.ManifestDigest, StringComparison.Ordinal))
        {
            throw new AppLifecycleException(
                "update_plan_digest_mismatch",
                "Update manifest changed after the current update plan was calculated.");
        }

        var currentSelection = await LoadSelectionForAppAsync(app, cancellationToken);
        var adapter = ResolveAdapter(currentSelection.RuntimeProfile.Type);
        var wasRunning = string.Equals(app.RuntimeState, "running", StringComparison.Ordinal);
        if (wasRunning)
        {
            _ = await adapter.StopAsync(await CreateRuntimeContextAsync(app, currentSelection, cancellationToken), cancellationToken);
            _ = await apps.UpdateAppAsync(appId, current => current with { RuntimeState = "stopped" }, cancellationToken);
        }

        var backup = plan.WillCreatePreUpdateBackup
            ? await backups.CreateBackupAsync(appId, "pre-update", cancellationToken: cancellationToken)
            : null;

        await manifests.SaveManifestCopyAsync(selection, GetAppRoot(appId), cancellationToken);
        await manifests.VendorDisplayAssetsAsync(selection, GetAppRoot(appId), cancellationToken);
        var manifestCopyPath = Path.Combine(GetAppRoot(appId), "manifest.json");
        var next = BuildAppRecord(
            selection,
            manifestCopyPath,
            manifestUrl: selection.ManifestUrl,
            // Sticky true: a reviewed update can escalate to system (the plan surfaced it as a
            // "role" change) but never silently downgrades a system app back to a runtime app.
            system: app.System || IsSystemManifest(selection.Manifest),
            existing: app) with
        {
            OperationStatus = "updated",
            RuntimeState = "stopped",
            LastOperation = "update",
            LastError = null,
        };
        var document = await apps.UpsertAppAsync(next, cancellationToken);
        if (wasRunning)
        {
            var restarted = await StartCoreAsync(appId, cancellationToken);
            return new AppLifecycleResponse(restarted.App, backup, "updated");
        }

        return new AppLifecycleResponse(await BuildAppSummaryAsync(document.App, cancellationToken), backup, "updated");
    }

    public async Task<AppRuntimeSwitchPlan> CreateRuntimeSwitchPlanAsync(
        string appId,
        AppRuntimeSwitchPlanRequest request,
        CancellationToken cancellationToken = default)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        if (string.IsNullOrWhiteSpace(request.TargetRuntime))
        {
            throw new AppLifecycleException("target_runtime_required", "Target runtime is required.");
        }

        if (string.IsNullOrWhiteSpace(app.ManifestPath))
        {
            throw new AppLifecycleException("manifest_path_required", $"Runtime app '{appId}' has no manifest path.");
        }

        var currentSelection = await LoadSelectionForAppAsync(app, cancellationToken);
        var selection = await manifests.LoadAsync(app.ManifestPath, request.TargetRuntime, cancellationToken);
        var willCreateBackup = Directory.Exists(GetAppDataPath(appId));
        if (willCreateBackup &&
            app.StorageMappings.Any(mapping => string.Equals(mapping.Key, "data", StringComparison.Ordinal)) &&
            selection.DataTarget is null)
        {
            throw new AppLifecycleException(
                "runtime_switch_data_incompatible",
                $"Target runtime '{selection.RuntimeProfile.Key}' does not declare a compatible primary data directory target.");
        }

        var changes = BuildRuntimeSwitchChanges(app, currentSelection, selection);
        var seed = new AppRuntimeSwitchDigestSeed(
            appId,
            app.SelectedRuntime,
            selection.RuntimeProfile.Key,
            app.Version,
            selection.ManifestDigest,
            willCreateBackup,
            changes);
        return new AppRuntimeSwitchPlan(
            AppId: appId,
            CurrentRuntime: app.SelectedRuntime,
            TargetRuntime: selection.RuntimeProfile.Key,
            TargetRuntimeType: selection.RuntimeProfile.Type,
            PlanDigest: HashPlanSeed(seed),
            AutomaticBackup: willCreateBackup,
            Changes: changes);
    }

    public Task<AppLifecycleResponse> ApplyRuntimeSwitchAsync(
        string appId,
        AppRuntimeSwitchApplyRequest request,
        CancellationToken cancellationToken = default)
        => WithAppLockAsync(appId, () => ApplyRuntimeSwitchCoreAsync(appId, request, cancellationToken), cancellationToken);

    private async Task<AppLifecycleResponse> ApplyRuntimeSwitchCoreAsync(
        string appId,
        AppRuntimeSwitchApplyRequest request,
        CancellationToken cancellationToken)
    {
        var plan = await CreateRuntimeSwitchPlanAsync(appId, new AppRuntimeSwitchPlanRequest(request.TargetRuntime), cancellationToken);
        if (!string.Equals(plan.PlanDigest, request.PlanDigest, StringComparison.Ordinal))
        {
            throw new AppLifecycleException("runtime_switch_plan_digest_mismatch", "Runtime switch plan digest does not match the current switch plan.");
        }

        var app = await RequireAppAsync(appId, cancellationToken);
        var currentSelection = await LoadSelectionForAppAsync(app, cancellationToken);
        var wasRunning = string.Equals(app.RuntimeState, "running", StringComparison.Ordinal);
        if (wasRunning)
        {
            await ResolveAdapter(currentSelection.RuntimeProfile.Type).StopAsync(await CreateRuntimeContextAsync(app, currentSelection, cancellationToken), cancellationToken);
            _ = await apps.UpdateAppAsync(appId, current => current with { RuntimeState = "stopped" }, cancellationToken);
        }

        var backup = plan.AutomaticBackup
            ? await backups.CreateBackupAsync(appId, "pre-runtime-switch", cancellationToken: cancellationToken)
            : null;

        var targetSelection = await manifests.LoadAsync(app.ManifestPath!, request.TargetRuntime, cancellationToken);
        var next = BuildAppRecord(
            targetSelection,
            app.ManifestPath!,
            manifestUrl: app.ManifestUrl,
            system: app.System,
            existing: app) with
        {
            SelectedRuntime = targetSelection.RuntimeProfile.Key,
            RuntimeState = "stopped",
            OperationStatus = "runtime-switched",
            LastOperation = "switch-runtime",
            LastError = null,
        };
        await apps.UpsertAppAsync(next, cancellationToken);

        if (wasRunning)
        {
            try
            {
                var restarted = await StartCoreAsync(appId, cancellationToken);
                return new AppLifecycleResponse(restarted.App, backup, "runtime-switched");
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                await RollBackRuntimeSwitchStateAsync(app, currentSelection, ex, cancellationToken);
                throw new AppLifecycleException(
                    "runtime_switch_restart_failed",
                    $"Runtime switch to '{targetSelection.RuntimeProfile.Key}' failed while restarting. Selected runtime was restored to '{currentSelection.RuntimeProfile.Key}' and the app was left stopped. {ex.Message}");
            }
        }

        var document = await apps.GetAppAsync(appId, cancellationToken);
        return new AppLifecycleResponse(document is null ? null : await BuildAppSummaryAsync(document, cancellationToken), backup, "runtime-switched");
    }

    // allowSystemRemoval distinguishes the calling surface: the local control plane (CLI) keeps full
    // removal for operator recovery, while the browser surface refuses to remove a system app — the
    // Shell only hides the button, so the API must be the actual boundary.
    public Task<AppLifecycleResponse> RemoveAsync(string appId, AppRemoveRequest request, bool allowSystemRemoval = false, CancellationToken cancellationToken = default)
        => WithAppLockAsync(appId, () => RemoveCoreAsync(appId, request, allowSystemRemoval, cancellationToken), cancellationToken);

    private async Task<AppLifecycleResponse> RemoveCoreAsync(string appId, AppRemoveRequest request, bool allowSystemRemoval, CancellationToken cancellationToken)
    {
        var app = await apps.GetAppAsync(appId, cancellationToken);
        if (app is { System: true } && !allowSystemRemoval)
        {
            throw new AppLifecycleException(
                "system_app_remove_requires_control",
                "System apps can only be removed through the local control plane (hosty CLI).");
        }
        if (app is not null && !string.IsNullOrWhiteSpace(app.ManifestPath))
        {
            try
            {
                var selection = await LoadSelectionForAppAsync(app, cancellationToken);
                await ResolveAdapter(selection.RuntimeProfile.Type).RemoveAsync(await CreateRuntimeContextAsync(app, selection, cancellationToken), cancellationToken);
            }
            catch (Exception ex) when (ex is AppLifecycleException or AppManifestException)
            {
                if (!request.IgnoreRuntimeErrors)
                {
                    throw;
                }
            }
        }

        // Keep the operator's configuration alongside retained app data so a reinstall restores it.
        // Written before state.json is deleted; skipped (and any stale snapshot purged) when data is
        // being deleted, since the whole app root is then removed. The snapshot keeps the app root
        // non-empty, so it survives TryDeleteDirectoryIfEmpty even for data-less apps.
        if (!request.DeleteData && app is not null)
        {
            // Best-effort: a disk/permission failure to snapshot config must not abort the
            // uninstall the operator asked for. The cost is losing config retention on reinstall.
            try
            {
                await WriteRetainedConfigAsync(app, cancellationToken);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
            {
                logger.LogWarning(ex, "Failed to retain configuration for app {AppId} during uninstall.", appId);
            }
        }
        else if (request.DeleteData)
        {
            TryDelete(GetRetainedConfigPath(appId));
        }

        if (request.DeleteRuntimeState)
        {
            TryDelete(Path.Combine(GetAppRoot(appId), "state.json"));
            TryDelete(Path.Combine(GetAppRoot(appId), "manifest.json"));
        }

        if (request.DeleteData)
        {
            TryDeleteDirectory(GetAppDataPath(appId));
        }

        if (request.DeleteBackups)
        {
            await backups.DeleteAllBackupsAsync(appId, cancellationToken);
        }

        if (request.DeleteSource)
        {
            TryDeleteDirectory(CoreDataPaths.ResolveContainedPath(paths.SourcesRoot, appId));
        }

        TryDeleteDirectoryIfEmpty(GetAppRoot(appId));
        // Telemetry now lives in the backend, which ages out an uninstalled app's data via retention
        // (Core no longer holds a per-app store to purge here).
        await ReconcileIngressAsync(cancellationToken);
        return new AppLifecycleResponse(app is null ? null : await BuildAppSummaryAsync(app, cancellationToken), null, "removed");
    }

    public async Task<AppBackupsResponse> ListBackupsAsync(string appId, CancellationToken cancellationToken = default)
    {
        _ = await RequireAppAsync(appId, cancellationToken);
        return new AppBackupsResponse(await backups.ListBackupsAsync(appId, cancellationToken));
    }

    public Task<AppBackupResponse> CreateManualBackupAsync(string appId, AppManualBackupRequest request, CancellationToken cancellationToken = default)
        => WithAppLockAsync(appId, () => CreateManualBackupCoreAsync(appId, request, cancellationToken), cancellationToken);

    private async Task<AppBackupResponse> CreateManualBackupCoreAsync(string appId, AppManualBackupRequest request, CancellationToken cancellationToken)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        var reason = string.IsNullOrWhiteSpace(request.Reason) ? "manual" : request.Reason.Trim();
        if (!BackupReasonPattern.IsMatch(reason))
        {
            throw new AppLifecycleException("backup_reason_invalid", "Backup reason must match ^[a-z0-9][a-z0-9-]{0,30}$.");
        }

        if (AppBackupService.IsReservedReason(reason))
        {
            throw new AppLifecycleException("backup_reason_reserved", $"{reason} backup reason is reserved for Core lifecycle and app-initiated operations.");
        }

        // Stop the app while its data directory is copied so the snapshot is consistent.
        // Core zips the live data directory with no app-side coordination, so a running app
        // could be mid-write (e.g. an open SQLite transaction) and produce a torn archive.
        // The other Core-initiated backups (pre-update/-runtime-switch/-restore) already copy
        // stopped data; this mirrors that stop->operate->restart pattern for operator backups.
        var wasRunning = string.Equals(app.RuntimeState, "running", StringComparison.Ordinal);
        try
        {
            // Stop inside the try so the finally restart still runs if the stop sequence itself
            // throws partway (e.g. UpdateAppAsync fails after the runtime is already stopped).
            if (wasRunning)
            {
                var selection = await LoadSelectionForAppAsync(app, cancellationToken);
                _ = await ResolveAdapter(selection.RuntimeProfile.Type)
                    .StopAsync(await CreateRuntimeContextAsync(app, selection, cancellationToken), cancellationToken);
                _ = await apps.UpdateAppAsync(appId, current => current with { RuntimeState = "stopped" }, cancellationToken);
            }

            return new AppBackupResponse(await backups.CreateBackupAsync(appId, reason, cancellationToken: cancellationToken));
        }
        finally
        {
            // Always attempt to restore the prior running state, even if the backup failed or was
            // cancelled, so an operator-triggered backup never silently leaves a running app stopped.
            // Use CancellationToken.None so a cancelled backup still restarts; a restart failure
            // surfaces through StartAsync (recorded + thrown), which is the right signal.
            if (wasRunning)
            {
                _ = await StartCoreAsync(appId, CancellationToken.None);
            }
        }
    }

    public Task<AppBackupResponse> RestoreBackupAsync(string appId, string backupId, AppRestoreBackupRequest request, CancellationToken cancellationToken = default)
        => WithAppLockAsync(appId, () => RestoreBackupCoreAsync(appId, backupId, request, cancellationToken), cancellationToken);

    private async Task<AppBackupResponse> RestoreBackupCoreAsync(string appId, string backupId, AppRestoreBackupRequest request, CancellationToken cancellationToken)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        if (string.Equals(app.RuntimeState, "running", StringComparison.Ordinal))
        {
            throw new AppLifecycleException("app_must_be_stopped", "Stop the runtime app before restoring data.");
        }

        return new AppBackupResponse(await backups.RestoreBackupAsync(appId, backupId, request.CreatePreRestoreBackup, cancellationToken));
    }

    public async Task<AppBackupDeleteResponse> DeleteBackupAsync(string appId, string backupId, CancellationToken cancellationToken = default)
    {
        _ = await RequireAppAsync(appId, cancellationToken);
        return new AppBackupDeleteResponse(await backups.DeleteBackupAsync(appId, backupId, cancellationToken));
    }

    public async Task<AppBackupCleanupPlan> CreateBackupCleanupPlanAsync(string appId, CancellationToken cancellationToken = default)
    {
        _ = await RequireAppAsync(appId, cancellationToken);
        return await backups.CreateCleanupPlanAsync(appId, cancellationToken);
    }

    public async Task<AppBackupCleanupApplyResponse> ApplyBackupCleanupAsync(
        string appId,
        AppBackupCleanupApplyRequest request,
        CancellationToken cancellationToken = default)
    {
        _ = await RequireAppAsync(appId, cancellationToken);
        return await backups.ApplyCleanupAsync(appId, request, cancellationToken);
    }

    public async Task<AppLogsResponse> GetLogsAsync(string appId, int tail, CancellationToken cancellationToken = default)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        var selection = await LoadSelectionForAppAsync(app, cancellationToken);
        var logs = await ResolveAdapter(selection.RuntimeProfile.Type).GetLogsAsync(await CreateRuntimeContextAsync(app, selection, cancellationToken), tail, cancellationToken);
        var services = (logs.Services ?? [])
            .Select(segment => new AppLogsServiceSegment(segment.Service, segment.Text))
            .ToArray();
        return new AppLogsResponse(appId, logs.Text, services);
    }

    public async Task<AppRuntimeHealthResponse> GetHealthAsync(string appId, CancellationToken cancellationToken = default)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        var selection = await LoadSelectionForAppAsync(app, cancellationToken);
        var health = await ResolveAdapter(selection.RuntimeProfile.Type).GetHealthAsync(
            await CreateRuntimeContextAsync(app, selection, cancellationToken),
            cancellationToken);
        return new AppRuntimeHealthResponse(
            AppId: appId,
            Runtime: selection.RuntimeProfile.Key,
            RuntimeType: selection.RuntimeProfile.Type,
            Status: health.Status,
            Services: health.Services);
    }

    // Read-only "update available" detection (runtime-app-marketplace.md, "Update-available
    // detection"): for each compiled (docker image) service, compare the currently-locked digest to
    // the tag's remotely-resolved candidate digest via a light registry lookup (IImageDigestResolver,
    // no full pull). A service is "update available" only when a lock exists and the candidate differs;
    // an unreachable registry yields a null candidate reported as "unknown" rather than failing. This
    // never mutates state — applying an update still goes through the reviewed-update plan.
    public async Task<AppUpdateStatusResponse> GetUpdateStatusAsync(string appId, CancellationToken cancellationToken = default)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        var selection = await LoadSelectionForAppAsync(app, cancellationToken);
        var candidateSelection = selection;
        var manifestUpdateAvailable = false;
        var manifestUnknown = false;
        if (!string.IsNullOrWhiteSpace(app.FeedsUrl) && !string.IsNullOrWhiteSpace(app.FollowedFeedId))
        {
            try
            {
                var feed = await RequireFeedService().ResolveAsync(app.FeedsUrl, app.FollowedFeedId, cancellationToken);
                RequireFeedAppMatch(app, feed.AppId);
                candidateSelection = await manifests.LoadAsync(feed.Feed.ManifestRef, app.SelectedRuntime, cancellationToken);
                if (!string.Equals(candidateSelection.Manifest.Id, app.Id, StringComparison.Ordinal))
                {
                    throw new AppLifecycleException(
                        "app_feed_manifest_app_mismatch",
                        $"Feed document appId '{feed.AppId}' does not match selected manifest app id '{candidateSelection.Manifest.Id}'.");
                }

                manifestUpdateAvailable = !string.Equals(
                    selection.ManifestDigest,
                    candidateSelection.ManifestDigest,
                    StringComparison.Ordinal);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                manifestUnknown = true;
                logger.LogWarning(ex, "Failed to resolve feed update status for app {AppId}.", appId);
            }
        }

        var policy = DockerRuntimeAdapter.ResolveUpdatePolicy(app.UpdatePolicy);
        var resolver = adapters.OfType<IImageDigestResolver>().FirstOrDefault();

        var services = new List<AppServiceUpdateStatus>();
        foreach (var service in candidateSelection.Services
            .Where(service => service.Image is not null)
            .OrderBy(service => service.Key, StringComparer.Ordinal))
        {
            var lockedDigest = app.ArtifactLocks?.GetValueOrDefault(service.Key)?.ImageDigest;

            // Without a recorded lock (an app not yet started, or a local-only image that has no
            // digest) there is nothing to compare a candidate against, so update availability cannot
            // be determined — report "unknown" and skip the registry lookup entirely.
            if (string.IsNullOrWhiteSpace(lockedDigest))
            {
                services.Add(new AppServiceUpdateStatus(service.Key, lockedDigest, null, UpdateAvailable: false, Unknown: true));
                continue;
            }

            string? candidateDigest = null;
            if (resolver is not null)
            {
                try
                {
                    candidateDigest = await resolver.ResolveRemoteDigestAsync(service.Image!, cancellationToken);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    // A network/registry failure must not fail the whole read-only status check; the
                    // service is just reported "unknown" (candidate stays null) and the error is logged.
                    logger.LogWarning(ex, "Failed to resolve remote image digest for app {AppId} service {Service}.", appId, service.Key);
                }
            }

            var unknown = string.IsNullOrWhiteSpace(candidateDigest);
            var serviceUpdateAvailable = !unknown
                && !string.Equals(lockedDigest, candidateDigest, StringComparison.Ordinal);

            services.Add(new AppServiceUpdateStatus(
                Service: service.Key,
                LockedDigest: lockedDigest,
                CandidateDigest: candidateDigest,
                UpdateAvailable: serviceUpdateAvailable,
                Unknown: unknown));
        }

        return new AppUpdateStatusResponse(
            AppId: appId,
            Runtime: selection.RuntimeProfile.Key,
            RuntimeType: selection.RuntimeProfile.Type,
            UpdatePolicy: policy,
            UpdateAvailable: manifestUpdateAvailable || services.Any(service => service.UpdateAvailable),
            Services: services,
            ManifestUpdateAvailable: manifestUpdateAvailable,
            ManifestUnknown: manifestUnknown);
    }

    public async Task<IReadOnlyList<AppBackgroundLifecycleResult>> StartAutostartAppsAsync(CancellationToken cancellationToken = default)
    {
        var results = new List<AppBackgroundLifecycleResult>();
        var records = await apps.ListAppRecordsAsync(cancellationToken);
        // System apps with a start priority go first — the telemetry collector is the OTLP sink other
        // apps point at, so its endpoint URL must be resolved and persisted before their start-time
        // env injection reads it (see ResolveTelemetryEndpointAsync). Otherwise alphabetical id order.
        foreach (var app in records.Where(app =>
            string.Equals(app.Kind, "runtime", StringComparison.Ordinal) &&
            (app.Autostart ?? true))
            .OrderByDescending(app => SystemAppBootstraps.StartPriority(app.Id))
            .ThenBy(app => app.Id, StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            results.Add(await RunBackgroundLifecycleActionAsync(
                app.Id,
                "autostart",
                async () => await StartAsync(app.Id, cancellationToken),
                cancellationToken));
        }

        return results;
    }

    public async Task<IReadOnlyList<AppBackgroundLifecycleResult>> StopAutostartDisabledAppsAsync(CancellationToken cancellationToken = default)
    {
        var results = new List<AppBackgroundLifecycleResult>();
        var records = await apps.ListAppRecordsAsync(cancellationToken);
        foreach (var app in records.Where(app =>
            string.Equals(app.Kind, "runtime", StringComparison.Ordinal) &&
            !(app.Autostart ?? true)).OrderByDescending(app => app.Id, StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            results.Add(await RunBackgroundLifecycleActionAsync(
                app.Id,
                "autostart-disabled-stop",
                async () => await StopAsync(app.Id, cancellationToken),
                cancellationToken));
        }

        return results;
    }

    public async Task<IReadOnlyList<AppBackgroundLifecycleResult>> StopRuntimeAppsAsync(CancellationToken cancellationToken = default)
    {
        var results = new List<AppBackgroundLifecycleResult>();
        var records = await apps.ListAppRecordsAsync(cancellationToken);
        foreach (var app in records.Where(app =>
            string.Equals(app.Kind, "runtime", StringComparison.Ordinal)).OrderByDescending(app => app.Id, StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            results.Add(await RunBackgroundLifecycleActionAsync(
                app.Id,
                "core-shutdown-stop",
                async () => await StopAsync(app.Id, cancellationToken),
                cancellationToken));
        }

        return results;
    }

    // Startup sweep: kills localCommand process trees a previous, non-gracefully-exited Core left
    // orphaned (holding their ports) by reading the durable pidfiles under each app's {AppRoot}/run.
    // Runs regardless of an app's currently selected runtime — an orphan survives a runtime switch — and
    // per-file failures are logged without breaking the loop. Returns how many trees were reclaimed.
    public async Task<int> ReclaimOrphanedLocalCommandProcessesAsync(CancellationToken cancellationToken = default)
    {
        var reclaimed = 0;
        var records = await apps.ListAppRecordsAsync(cancellationToken);
        foreach (var app in records)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var runDirectory = Path.Combine(GetAppRoot(app.Id), "run");
            if (!Directory.Exists(runDirectory))
            {
                continue;
            }

            foreach (var pidFilePath in Directory.EnumerateFiles(runDirectory, "*.json"))
            {
                var serviceKey = Path.GetFileNameWithoutExtension(pidFilePath);
                try
                {
                    if (await LocalCommandProcessReclaim.ReclaimAsync(GetAppRoot(app.Id), serviceKey, logger, cancellationToken))
                    {
                        reclaimed++;
                    }
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    logger.LogWarning(ex, "Failed to reclaim orphaned localCommand process for app {AppId} service {Service}.", app.Id, serviceKey);
                }
            }
        }

        return reclaimed;
    }

    // The manifest role vocabulary is validated fail-closed by AppManifestService.Select, so by the
    // time a selection reaches lifecycle code the role is either absent or exactly "system".
    private static bool IsSystemManifest(RuntimeAppManifest manifest)
        => string.Equals(manifest.Role, "system", StringComparison.Ordinal);

    private AppRecord BuildAppRecord(
        RuntimeAppManifestSelection selection,
        string manifestPath,
        string? manifestUrl,
        bool system,
        AppRecord? existing)
    {
        var manifest = selection.Manifest;
        var settings = BuildSettingDefinitions(selection).ToDictionary(
            setting => setting.Key,
            setting =>
            {
                var current = existing?.Settings.GetValueOrDefault(setting.Key);
                return new AppSettingValue(setting.Key, setting.Type, current?.Value ?? setting.Default, setting.Secret, setting.Required, setting.Label, setting.Description);
            },
            StringComparer.Ordinal);

        // Carry forward Core-reserved host-port overrides (HOSTY_PORT_<key>) across a rebuild. They are
        // not manifest-declared settings, so BuildSettingDefinitions omits them; without this a runtime
        // switch or update drops the override and the app's assigned host port reverts to the manifest's
        // localPort — e.g. the Shell (assigned config.ShellPort via the bootstrap) reverting to 3000. An
        // app's assigned port must not change on switch. See RuntimePortHelper.TryReadHostPortOverride.
        if (existing is not null)
        {
            foreach (var (key, value) in existing.Settings)
            {
                if (key.StartsWith("HOSTY_PORT_", StringComparison.Ordinal) && !settings.ContainsKey(key))
                {
                    settings[key] = value;
                }
            }
        }
        var storageMappings = selection.DataTarget is null
            ? []
            : new AppStorageMapping[]
            {
                new(
                    Key: "data",
                    HostPath: GetAppDataPath(manifest.Id!),
                    TargetPath: selection.DataTarget.ContainerPath ?? GetAppDataPath(manifest.Id!),
                    ReadOnly: false),
            };
        var dependencies = manifest.Dependencies.Select(ToDependencyContract).ToArray();
        var endpointContracts = manifest.Endpoints.Count == 0
            ? selection.Services.SelectMany(service => service.Runtime.Ports.Select(port => new AppEndpointContract(
                Key: $"{service.Key}.{port.Key ?? port.ContainerPort?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "port"}",
                Protocol: string.IsNullOrWhiteSpace(port.Protocol) ? "http" : port.Protocol,
                Url: null,
                Public: port.Public ?? false,
                Service: service.Key,
                Port: port.Key ?? port.ContainerPort?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "port"))).ToArray()
            : manifest.Endpoints.Select(endpoint => new AppEndpointContract(
                Key: endpoint.Key,
                Protocol: endpoint.Protocol ?? "http",
                Url: null,
                Public: endpoint.Public,
                Service: endpoint.Service,
                Port: endpoint.Port)).ToArray();
        var endpoints = PreserveEndpointUrls(endpointContracts, existing?.Endpoints);

        return new AppRecord(
            Id: manifest.Id!,
            DisplayName: manifest.Name!,
            Description: manifest.Description,
            Version: manifest.Version!,
            Kind: "runtime",
            System: system,
            Source: manifest.Source?.Repository ?? "manifest",
            ManifestPath: manifestPath,
            ManifestUrl: manifestUrl,
            SelectedRuntime: selection.RuntimeProfile.Key,
            OperationStatus: existing?.OperationStatus ?? "installed",
            RuntimeState: existing?.RuntimeState ?? "stopped",
            LastOperation: existing?.LastOperation,
            LastError: existing?.LastError,
            Capabilities: ResolveCapabilities(manifest),
            Settings: settings,
            StorageMappings: storageMappings,
            Dependencies: dependencies,
            Endpoints: endpoints,
            InstalledAt: existing?.InstalledAt ?? default,
            UpdatedAt: default,
            SourceState: BuildSourceState(selection, existing),
            Ui: AppUiContract.FromManifest(manifest.Ui),
            CatalogMetadata: AppCatalogMetadataContract.FromManifest(manifest.CatalogMetadata),
            Autostart: existing?.Autostart ?? true,
            RuntimeProfiles: BuildRuntimeProfileSummaries(manifest),
            MountSlots: BuildMountSlots(manifest),
            Mounts: PreserveMounts(manifest, existing?.Mounts),
            // Sticky once captured at install; URL installs leave it null (covered by ManifestUrl).
            // At install selection.ManifestPath is the operator's original path, resolved before
            // the internal copy is written; on update/switch we keep the first captured value.
            // Normalized to an absolute path so it still resolves if Core later runs from a
            // different working directory (e.g. as a background service).
            InstallManifestPath: existing?.InstallManifestPath ??
                (string.IsNullOrWhiteSpace(selection.ManifestUrl)
                    && !string.IsNullOrWhiteSpace(selection.ManifestPath)
                    // Never treat Core's own internal copy as the operator source. Capturing it here
                    // is what made folder installs silently re-read their stale snapshot on Recheck.
                    && !IsInternalAppPath(manifest.Id!, selection.ManifestPath)
                    ? Path.GetFullPath(selection.ManifestPath)
                    : null),
            // ArtifactLocks is deliberately left null on (re)build: install has nothing to lock yet,
            // and update/runtime-switch must drop the old lock so the next start re-resolves the new
            // target (a re-pushed tag advances the digest). The policy is operator config, preserved.
            UpdatePolicy: existing?.UpdatePolicy,
            // App-owned feed state is lifecycle bookkeeping, not manifest contract — preserve it
            // across update/switch/reconcile like UpdatePolicy.
            FeedsUrl: existing?.FeedsUrl,
            FollowedFeedId: existing?.FollowedFeedId);
    }

    // External-mount slots are redeclared from the manifest on every (re)build, like runtime
    // profiles. Operator bindings are preserved from the existing record (like settings) so they
    // survive update / runtime-switch; bindings whose slot the manifest no longer declares are
    // dropped here so they cannot linger as orphans.
    private static IReadOnlyList<AppMountSlot> BuildMountSlots(RuntimeAppManifest manifest)
        => manifest.ExternalMounts
            .OrderBy(entry => entry.Key, StringComparer.Ordinal)
            .Select(entry => new AppMountSlot(entry.Key, entry.Value.Mode, entry.Value.Multiple, entry.Value.Required, entry.Value.Service))
            .ToArray();

    private static IReadOnlyList<AppMountBinding> PreserveMounts(
        RuntimeAppManifest manifest,
        IReadOnlyList<AppMountBinding>? existing)
    {
        // Keep every operator-configured binding, even one whose slot the manifest no longer declares
        // (R7): Hosty never deletes an operator mount. An orphaned binding is inert — RuntimeMountPlanner
        // (Resolve / EnsureRequiredConfigured) and the mount summaries all key off the current slots, so
        // it is neither injected nor surfaced — and it re-activates automatically if the slot returns.
        if (existing is null || existing.Count == 0)
        {
            return [];
        }

        return existing.ToArray();
    }

    private static IReadOnlyList<AppEndpointContract> PreserveEndpointUrls(
        IReadOnlyList<AppEndpointContract> endpoints,
        IReadOnlyList<AppEndpointContract>? existing)
    {
        if (existing is null || existing.Count == 0)
        {
            return endpoints;
        }

        return endpoints.Select(endpoint =>
        {
            var match = existing.FirstOrDefault(candidate =>
                    string.Equals(candidate.Key, endpoint.Key, StringComparison.Ordinal) &&
                    !string.IsNullOrWhiteSpace(candidate.Url)) ??
                existing.FirstOrDefault(candidate =>
                    string.Equals(candidate.Service, endpoint.Service, StringComparison.Ordinal) &&
                    string.Equals(candidate.Port, endpoint.Port, StringComparison.Ordinal) &&
                    !string.IsNullOrWhiteSpace(candidate.Url));

            return string.IsNullOrWhiteSpace(match?.Url)
                ? endpoint
                : endpoint with { Url = match.Url };
        }).ToArray();
    }

    // Single choke point for building a summary so the live-source flag is computed consistently for
    // every response (list and lifecycle actions alike), not just the app list. Callers that mutate the
    // record then build a response should use this rather than AppSummary.From directly.
    private async Task<AppSummary> BuildAppSummaryAsync(AppRecord app, CancellationToken cancellationToken)
    {
        var profiles = await ResolveRuntimeProfilesAsync(app, cancellationToken);
        var liveSourcePath = ResolveLiveSourcePath(app, profiles);
        return AppSummary.From(app, profiles, liveSourcePath is not null, liveSourcePath);
    }

    // The app's runtime profiles, preferring the persisted record and falling back to a live load from
    // the reviewed internal manifest for legacy records that never persisted them. Returns [] (never
    // null) when neither is available.
    private async Task<IReadOnlyList<AppRuntimeProfileSummary>> ResolveRuntimeProfilesAsync(AppRecord app, CancellationToken cancellationToken)
        => app.RuntimeProfiles is { Count: > 0 }
            ? app.RuntimeProfiles
            : await TryLoadRuntimeProfilesForSummaryAsync(app, cancellationToken);

    private async Task<IReadOnlyList<AppRuntimeProfileSummary>> TryLoadRuntimeProfilesForSummaryAsync(
        AppRecord app,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(app.ManifestPath))
        {
            return [];
        }

        try
        {
            var selection = await manifests.LoadAsync(app.ManifestPath, app.SelectedRuntime, cancellationToken);
            return string.Equals(selection.Manifest.Id, app.Id, StringComparison.Ordinal)
                ? BuildRuntimeProfileSummaries(selection.Manifest)
                : [];
        }
        catch (Exception ex) when (ex is AppManifestException or IOException or UnauthorizedAccessException or JsonException or HttpRequestException)
        {
            return [];
        }
    }

    private async Task<AppBackgroundLifecycleResult> RunBackgroundLifecycleActionAsync(
        string appId,
        string operation,
        Func<Task<AppLifecycleResponse>> action,
        CancellationToken cancellationToken)
    {
        try
        {
            var response = await action();
            return new AppBackgroundLifecycleResult(appId, operation, Succeeded: true, ErrorCode: null, Message: response.Status);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex) when (ex is AppLifecycleException or AppManifestException or IOException or UnauthorizedAccessException or JsonException)
        {
            var code = ex is AppLifecycleException lifecycleException
                ? lifecycleException.Code
                : ex is AppManifestException manifestException
                    ? manifestException.Code
                    : "background_lifecycle_failed";
            await RecordBackgroundLifecycleFailureAsync(appId, operation, ex.Message, cancellationToken);
            return new AppBackgroundLifecycleResult(appId, operation, Succeeded: false, ErrorCode: code, Message: ex.Message);
        }
    }

    private async Task RecordBackgroundLifecycleFailureAsync(
        string appId,
        string operation,
        string message,
        CancellationToken cancellationToken)
    {
        try
        {
            await apps.UpdateAppAsync(appId, current => current with
            {
                OperationStatus = "failed",
                LastOperation = operation,
                LastError = message,
            }, cancellationToken);
        }
        catch (Exception ex) when (ex is InvalidOperationException or IOException or UnauthorizedAccessException or JsonException)
        {
        }
    }

    private async Task RecordForegroundLifecycleFailureAsync(
        string appId,
        string operation,
        string runtimeState,
        string message,
        CancellationToken cancellationToken)
    {
        try
        {
            await apps.UpdateAppAsync(appId, current => current with
            {
                RuntimeState = runtimeState,
                OperationStatus = "failed",
                LastOperation = operation,
                LastError = message,
            }, cancellationToken);
        }
        catch (Exception ex) when (ex is InvalidOperationException or IOException or UnauthorizedAccessException or JsonException)
        {
        }
    }

    private static async Task TryStopRuntimeAsync(IAppRuntimeAdapter adapter, RuntimeLifecycleContext context)
    {
        try
        {
            _ = await adapter.StopAsync(context, CancellationToken.None);
        }
        catch
        {
        }
    }

    private static bool IsRecordableLifecycleFailure(Exception ex)
        => ex is AppLifecycleException or AppManifestException or IOException or UnauthorizedAccessException or JsonException;

    private AppSourceState? BuildSourceState(RuntimeAppManifestSelection selection, AppRecord? existing)
    {
        var source = selection.Manifest.Source;
        var localOverridePath = ResolveInstallLocalSourcePath(selection, source);
        if (source?.Repository is null)
        {
            if (!string.Equals(selection.RuntimeProfile.Type, "localCommand", StringComparison.Ordinal))
            {
                return existing?.SourceState;
            }

            return existing?.SourceState ?? (localOverridePath is null
                ? null
                : new AppSourceState(
                    Type: "local",
                    Repository: null,
                    ResolvedRef: null,
                    Commit: null,
                    ManagedCheckoutPath: Path.Combine(paths.SourcesRoot, selection.Manifest.Id!),
                    LocalOverridePath: localOverridePath,
                    UpdatedAt: null,
                    ManifestSubpath: ResolveInstallManifestSubpath(selection, localOverridePath)));
        }

        var resolvedRef = source.Commit ?? source.Tag ?? source.Branch;
        var manifestSubpath = ResolveInstallManifestSubpath(selection, localOverridePath);
        if (existing?.SourceState is not null &&
            string.Equals(existing.SourceState.Repository, source.Repository, StringComparison.Ordinal))
        {
            var resolvedRefChanged = !string.Equals(existing.SourceState.ResolvedRef, resolvedRef, StringComparison.Ordinal);
            return existing.SourceState with
            {
                Type = source.Type,
                Repository = source.Repository,
                ResolvedRef = resolvedRef ?? existing.SourceState.ResolvedRef,
                Commit = source.Commit ?? (resolvedRefChanged ? null : existing.SourceState.Commit),
                ManagedCheckoutPath = existing.SourceState.ManagedCheckoutPath ?? Path.Combine(paths.SourcesRoot, selection.Manifest.Id!),
                LocalOverridePath = existing.SourceState.LocalOverridePath ?? localOverridePath,
                ManifestSubpath = manifestSubpath ?? existing.SourceState.ManifestSubpath,
            };
        }

        return new AppSourceState(
            Type: source.Type,
            Repository: source.Repository,
            ResolvedRef: resolvedRef,
            Commit: source.Commit,
            ManagedCheckoutPath: Path.Combine(paths.SourcesRoot, selection.Manifest.Id!),
            LocalOverridePath: localOverridePath,
            UpdatedAt: null,
            ManifestSubpath: manifestSubpath);
    }

    // Combines a live source root with its captured manifest subpath, contained within the root. A
    // null/empty or escaping subpath yields the root unchanged (manifest-at-root / untrusted subpath).
    private static string CombineManifestSubpath(string sourceRoot, string? manifestSubpath)
    {
        if (string.IsNullOrWhiteSpace(manifestSubpath))
        {
            return sourceRoot;
        }

        var canonicalRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(sourceRoot));
        var combined = Path.GetFullPath(Path.Combine(canonicalRoot, manifestSubpath));
        // OS-aware containment (case-insensitive on Windows), matching PathEqualsOrWithin elsewhere.
        return string.Equals(combined, canonicalRoot, PathComparison)
            || combined.StartsWith(canonicalRoot + Path.DirectorySeparatorChar, PathComparison)
            ? combined
            : sourceRoot;
    }

    // The manifest's directory relative to the source repository root (e.g. "apps/shell"), or null when
    // the manifest is at the root / the layout can't be determined. The source root — override folder or
    // managed checkout — is the repo root by convention, and each service's workingDirectory is resolved
    // against it, so the manifest sits at the same offset for a monorepo app. Captured at install so the
    // live-source manifest read (and the managed-checkout live path) can target the right subfolder.
    private static string? ResolveInstallManifestSubpath(RuntimeAppManifestSelection selection, string? localSourceRoot)
    {
        // Folder/git install: the manifest is a local file under the resolved source root.
        if (string.IsNullOrWhiteSpace(selection.ManifestUrl)
            && !string.IsNullOrWhiteSpace(selection.ManifestPath)
            && !string.IsNullOrWhiteSpace(localSourceRoot))
        {
            var manifestDirectory = Path.GetDirectoryName(Path.GetFullPath(selection.ManifestPath));
            return string.IsNullOrWhiteSpace(manifestDirectory)
                ? null
                : NormalizeManifestSubpath(Path.GetRelativePath(Path.GetFullPath(localSourceRoot), manifestDirectory));
        }

        // URL install: derive the in-repo manifest directory from the manifest URL, anchored on the
        // repository owner/repo and with the known ref stripped (best-effort; null when not confident).
        return string.IsNullOrWhiteSpace(selection.ManifestUrl)
            ? null
            : ResolveManifestSubpathFromUrl(selection.ManifestUrl, selection.Manifest.Source);
    }

    // Normalizes a computed relative path into a forward-slash in-repo subpath, or null when it denotes
    // the root ("" / ".") or escapes it ("../…") — neither is a usable subfolder for the live manifest.
    private static string? NormalizeManifestSubpath(string? relative)
    {
        if (string.IsNullOrWhiteSpace(relative))
        {
            return null;
        }

        var normalized = relative.Replace('\\', '/').Trim('/');
        return normalized is "" or "."
            || normalized == ".."
            || normalized.StartsWith("../", StringComparison.Ordinal)
            ? null
            : normalized;
    }

    // Extracts the in-repo manifest directory from a "raw file in repo" manifest URL by anchoring on the
    // repository's <owner>/<repo> (from source.repository) and stripping the ref segment(s). Works for
    // raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>, GitLab raw, and similar layouts; returns
    // null when the URL/repository can't be matched confidently (caller then treats the manifest as
    // root-level, i.e. the pre-existing behavior).
    private static string? ResolveManifestSubpathFromUrl(string manifestUrl, RuntimeAppSource? source)
    {
        if (!Uri.TryCreate(manifestUrl, UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
        {
            return null;
        }

        var segments = uri.AbsolutePath.Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length < 2)
        {
            return null;
        }

        // Drop the trailing file name, leaving directory segments.
        var directorySegments = segments[..^1];
        var (owner, repository) = ExtractOwnerRepo(source?.Repository);
        if (owner is null || repository is null)
        {
            return null;
        }

        var anchor = -1;
        for (var index = 0; index + 1 < directorySegments.Length; index++)
        {
            if (string.Equals(directorySegments[index], owner, StringComparison.OrdinalIgnoreCase)
                && string.Equals(directorySegments[index + 1], repository, StringComparison.OrdinalIgnoreCase))
            {
                anchor = index + 2;
                break;
            }
        }

        if (anchor < 0)
        {
            return null;
        }

        var afterRepo = directorySegments[anchor..];
        var refValue = (source?.Commit ?? source?.Tag ?? source?.Branch)?.Trim('/');
        var subpathSegments = StripRefPrefix(afterRepo, refValue);
        return subpathSegments is null ? null : NormalizeManifestSubpath(string.Join('/', subpathSegments));
    }

    // Drops the ref prefix (branch/tag/commit — possibly multi-segment like "release/1.0") from the
    // path that follows <owner>/<repo>. When the known ref matches, it is stripped whole — including the
    // case where it consumes the entire remainder (manifest at the repo root ⇒ empty ⇒ null subpath).
    // Falls back to assuming a single-segment ref when the known ref doesn't match, the common raw-URL case.
    private static string[]? StripRefPrefix(string[] afterRepo, string? refValue)
    {
        if (!string.IsNullOrWhiteSpace(refValue))
        {
            var refSegments = refValue.Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (refSegments.Length <= afterRepo.Length
                && afterRepo[..refSegments.Length].SequenceEqual(refSegments, StringComparer.Ordinal))
            {
                return afterRepo[refSegments.Length..];
            }
        }

        return afterRepo.Length >= 1 ? afterRepo[1..] : null;
    }

    // The <owner, repo> pair from a git repository reference (HTTPS URL, scp-style SSH, or bare path),
    // with a trailing ".git" stripped. Null pair when fewer than two path segments are present.
    private static (string? Owner, string? Repository) ExtractOwnerRepo(string? repository)
    {
        if (string.IsNullOrWhiteSpace(repository))
        {
            return (null, null);
        }

        var reference = repository.Trim();
        var path = Uri.TryCreate(reference, UriKind.Absolute, out var uri) && !uri.IsFile
            ? uri.AbsolutePath
            : reference;

        var segments = path.Split(['/', ':'], StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length < 2)
        {
            return (null, null);
        }

        var repo = segments[^1];
        if (repo.EndsWith(".git", StringComparison.OrdinalIgnoreCase))
        {
            repo = repo[..^4];
        }

        return (segments[^2], repo);
    }

    private string? ResolveInstallLocalSourcePath(RuntimeAppManifestSelection selection, RuntimeAppSource? source)
    {
        if (!string.IsNullOrWhiteSpace(selection.ManifestUrl) ||
            string.IsNullOrWhiteSpace(selection.ManifestPath))
        {
            return null;
        }

        // A manifest path inside the app's own Core-managed root is the internal copy, not a real
        // source checkout. Using it as the local override pins localCommand working dirs to the app
        // data folder instead of the operator's repository.
        if (IsInternalAppPath(selection.Manifest.Id!, selection.ManifestPath))
        {
            return null;
        }

        var manifestDirectory = Path.GetDirectoryName(Path.GetFullPath(selection.ManifestPath));
        if (string.IsNullOrWhiteSpace(manifestDirectory))
        {
            return null;
        }

        var repository = source?.Repository?.Trim();
        if (!string.IsNullOrWhiteSpace(repository))
        {
            if (Uri.TryCreate(repository, UriKind.Absolute, out var repositoryUri) && repositoryUri.IsFile)
            {
                return Directory.Exists(repositoryUri.LocalPath)
                    ? Path.GetFullPath(repositoryUri.LocalPath)
                    : null;
            }

            if (Path.IsPathFullyQualified(repository))
            {
                return Directory.Exists(repository) ? Path.GetFullPath(repository) : null;
            }
        }

        var gitRoot = FindGitRoot(manifestDirectory);
        if (gitRoot is not null)
        {
            return gitRoot;
        }

        if (string.IsNullOrWhiteSpace(repository))
        {
            return InferLocalSourceRootFromWorkingDirectories(manifestDirectory, selection) ?? manifestDirectory;
        }

        if (Uri.TryCreate(repository, UriKind.Absolute, out var absoluteRepositoryUri) && !absoluteRepositoryUri.IsFile)
        {
            return null;
        }

        if (repository == ".")
        {
            return manifestDirectory;
        }

        var manifestRelativePath = Path.GetFullPath(Path.Combine(manifestDirectory, repository));
        if (Directory.Exists(manifestRelativePath))
        {
            return manifestRelativePath;
        }

        return InferLocalSourceRootFromWorkingDirectories(manifestDirectory, selection) ?? manifestDirectory;
    }

    private static string? InferLocalSourceRootFromWorkingDirectories(
        string manifestDirectory,
        RuntimeAppManifestSelection selection)
    {
        foreach (var workingDirectory in selection.Services
            .Select(service => service.Runtime.WorkingDirectory)
            .Where(directory => !string.IsNullOrWhiteSpace(directory))
            .Distinct(StringComparer.Ordinal))
        {
            var root = TryStripRelativeSuffix(manifestDirectory, workingDirectory!);
            if (root is not null)
            {
                return root;
            }
        }

        return null;
    }

    private static string? TryStripRelativeSuffix(string path, string suffix)
    {
        if (Path.IsPathFullyQualified(suffix))
        {
            return null;
        }

        var suffixParts = suffix
            .Replace('\\', Path.DirectorySeparatorChar)
            .Replace('/', Path.DirectorySeparatorChar)
            .Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries)
            .Where(part => part != ".")
            .ToArray();
        if (suffixParts.Length == 0)
        {
            return path;
        }

        if (suffixParts.Any(part => part == ".."))
        {
            return null;
        }

        var current = new DirectoryInfo(path);
        for (var index = suffixParts.Length - 1; index >= 0; index--)
        {
            if (!string.Equals(current.Name, suffixParts[index], StringComparison.Ordinal))
            {
                return null;
            }

            current = current.Parent ?? current;
        }

        return current.FullName;
    }

    private static string? FindGitRoot(string startDirectory)
    {
        var directory = new DirectoryInfo(startDirectory);
        while (directory is not null)
        {
            var gitPath = Path.Combine(directory.FullName, ".git");
            if (Directory.Exists(gitPath) || File.Exists(gitPath))
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        return null;
    }

    private static IReadOnlyList<AppEndpointContract> MergeEndpointUrls(
        IReadOnlyList<AppEndpointContract> current,
        IReadOnlyList<AppEndpointContract> started,
        RuntimeAppManifestSelection selection)
    {
        var baseEndpoints = BuildEndpointContracts(selection);
        if (baseEndpoints.Count == 0)
        {
            baseEndpoints = current;
        }

        var startedByKey = started.ToDictionary(endpoint => endpoint.Key, StringComparer.Ordinal);
        var aliases = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var endpoint in selection.Manifest.Endpoints)
        {
            if (!string.IsNullOrWhiteSpace(endpoint.Key) &&
                !string.IsNullOrWhiteSpace(endpoint.Service) &&
                !string.IsNullOrWhiteSpace(endpoint.Port))
            {
                aliases.TryAdd(endpoint.Key, $"{endpoint.Service}.{endpoint.Port}");
            }
        }
        var usedStartedKeys = new HashSet<string>(StringComparer.Ordinal);
        var merged = baseEndpoints.Select(endpoint =>
        {
            if (startedByKey.TryGetValue(endpoint.Key, out var direct))
            {
                usedStartedKeys.Add(direct.Key);
                return endpoint with
                {
                    Url = direct.Url,
                    Protocol = direct.Protocol,
                    Public = endpoint.Public,
                    Service = endpoint.Service ?? direct.Service,
                    Port = endpoint.Port ?? direct.Port,
                };
            }

            if (aliases.TryGetValue(endpoint.Key, out var runtimeKey) &&
                startedByKey.TryGetValue(runtimeKey, out var aliased))
            {
                usedStartedKeys.Add(aliased.Key);
                return endpoint with
                {
                    Url = aliased.Url,
                    Protocol = aliased.Protocol,
                    Public = endpoint.Public,
                    Service = endpoint.Service ?? aliased.Service,
                    Port = endpoint.Port ?? aliased.Port,
                };
            }

            return endpoint;
        }).ToArray();

        // When the manifest declares an explicit endpoint set, that set is authoritative: persist
        // only the declared endpoints (enriched with runtime URLs above). Runtime-reported ports
        // that have no declared endpoint — e.g. an internal-only HTTP port or a raw TCP/UDP port —
        // must NOT be appended here. Otherwise they linger in the persisted record while the update
        // plan rebuilds its target from the manifest (declared endpoints only), so every check
        // reports them as "removed" and the plan never converges.
        if (selection.Manifest.Endpoints.Count > 0)
        {
            return merged;
        }

        return merged
            .Concat(started.Where(endpoint =>
                !usedStartedKeys.Contains(endpoint.Key) &&
                baseEndpoints.All(existing => !string.Equals(existing.Key, endpoint.Key, StringComparison.Ordinal))))
            .ToArray();
    }

    private async Task RollBackRuntimeSwitchStateAsync(
        AppRecord app,
        RuntimeAppManifestSelection currentSelection,
        Exception error,
        CancellationToken cancellationToken)
    {
        var rolledBack = BuildAppRecord(
            currentSelection,
            app.ManifestPath!,
            manifestUrl: app.ManifestUrl,
            system: app.System,
            existing: app) with
        {
            SelectedRuntime = currentSelection.RuntimeProfile.Key,
            RuntimeState = "stopped",
            OperationStatus = "runtime-switch-rollback",
            LastOperation = "switch-runtime",
            LastError = $"Target runtime failed to start: {error.Message}",
        };
        await apps.UpsertAppAsync(rolledBack, cancellationToken);
    }

    private async Task<RuntimeLifecycleContext> CreateRuntimeContextAsync(
        AppRecord app,
        RuntimeAppManifestSelection selection,
        CancellationToken cancellationToken)
    {
        // Dereference global mount bindings against the live library, then resolve. A ref whose
        // entry was deleted is dropped (inert); an entry capped to read-only forces ReadOnly on top
        // of the slot mode (the slot stays authoritative — it can only further restrict).
        var registry = await globalMounts.ReadAsync(cancellationToken);
        var globalsByName = registry.Mounts.ToDictionary(mount => mount.Name, StringComparer.Ordinal);
        var (bindings, forcedReadOnly) = RuntimeMountPlanner.MaterializeBindings(app.Mounts, globalsByName);
        var mounts = RuntimeMountPlanner.Resolve(app.MountSlots, bindings);
        if (forcedReadOnly.Count > 0)
        {
            mounts = mounts
                .Select(mount => forcedReadOnly.Contains((mount.Key, mount.Label)) ? mount with { ReadOnly = true } : mount)
                .ToArray();
        }

        return new(
            app,
            selection,
            GetAppRoot(app.Id),
            GetAppDataPath(app.Id),
            await ResolveDependencyUrlsAsync(app, cancellationToken),
            mounts,
            await ResolveTelemetryEndpointAsync(app, cancellationToken),
            ResolveLockedSourceRoot(app, await ResolveRuntimeProfilesAsync(app, cancellationToken)));
    }

    // The source root a locked (Development Mode off) source runtime executes from: the managed checkout
    // pinned to its commit by EnsureLocalCommandSourceReadyAsync, so the reviewed source runs and any live
    // override is ignored. Null for a live runtime (Dev Mode on — the adapter uses override/checkout HEAD),
    // a non-source runtime, or a locked runtime with no pinnable URL/git source (a folder install runs
    // from its own folder). Passed to the adapter via RuntimeLifecycleContext.SourceRoot.
    private string? ResolveLockedSourceRoot(AppRecord app, IReadOnlyList<AppRuntimeProfileSummary>? profiles)
    {
        var selectedProfile = ((profiles ?? app.RuntimeProfiles) ?? [])
            .FirstOrDefault(profile => string.Equals(profile.Key, app.SelectedRuntime, StringComparison.Ordinal));
        if (selectedProfile is null
            || !string.Equals(selectedProfile.Type, "localCommand", StringComparison.Ordinal)
            || AppSummary.ResolveDevelopmentMode(app, selectedProfile))
        {
            return null;
        }

        // Fall back to the default managed-checkout path for legacy records that never persisted it,
        // matching EnsurePinnedCommitAsync so the resolved root and the pinned checkout stay consistent.
        var checkout = app.SourceState?.ManagedCheckoutPath is { Length: > 0 } stored
            ? stored
            : Path.Combine(paths.SourcesRoot, app.Id);
        return !string.IsNullOrWhiteSpace(app.ManifestUrl)
            && !string.IsNullOrWhiteSpace(app.SourceState?.Repository)
            && Directory.Exists(Path.Combine(checkout, ".git"))
            ? checkout
            : null;
    }

    // The OTLP/HTTP origin an app should export telemetry to: the collector system app's host-exposed
    // otlp-http endpoint, resolved fresh at each start (like dependency URLs) so the docker adapter can
    // rewrite the loopback host to host.docker.internal. The collector's presence is the gate — it is
    // never installed when observability is off, so the lookup returns null and the adapter injects no
    // OTEL_* env. Returns null when the collector is absent / not yet started (no persisted endpoint
    // URL) or when the app is the collector itself (graceful no-op in every case).
    private async Task<string?> ResolveTelemetryEndpointAsync(AppRecord app, CancellationToken cancellationToken)
    {
        if (string.Equals(app.Id, CollectorBootstrap.AppId, StringComparison.Ordinal))
        {
            return null;
        }

        var collector = await apps.GetAppAsync(CollectorBootstrap.AppId, cancellationToken);
        var endpoint = (collector?.Endpoints ?? []).FirstOrDefault(candidate =>
            string.Equals(candidate.Key, CollectorBootstrap.OtlpEndpointKey, StringComparison.Ordinal));
        return string.IsNullOrWhiteSpace(endpoint?.Url) ? null : endpoint.Url;
    }

    // Start-time gate for external mounts: a declared-required slot must have a binding, every
    // configured host path must still pass the path policy (defense-in-depth against a binding
    // tampered on disk), and must exist as a directory. We check existence in Core rather than
    // let docker bind a missing path, which would silently create an empty root-owned dir.
    private void EnsureMountsReadyForStart(RuntimeLifecycleContext context)
    {
        // Required check runs over the resolved mounts (context.Mounts): a global binding whose
        // library entry was deleted is already dropped there, so a required slot left with only such
        // a ref correctly counts as unconfigured.
        var configuredKeys = context.Mounts.Select(mount => mount.Key).ToHashSet(StringComparer.Ordinal);
        foreach (var slot in context.App.MountSlots ?? [])
        {
            if (slot.Required && !configuredKeys.Contains(slot.Key))
            {
                throw new AppLifecycleException(
                    "app_mount_required_unconfigured",
                    $"External mount '{slot.Key}' is required but no host path is configured. Configure it before starting the app.");
            }
        }

        foreach (var mount in context.Mounts)
        {
            // Re-check both the stored path and its symlink-resolved target: a path validated at
            // config time could have been repointed at a forbidden location since (TOCTOU).
            mountPathPolicy.EnsureAllowed(mount.HostPath);
            mountPathPolicy.EnsureAllowed(MountPathPolicy.ResolveRealPath(mount.HostPath));
            if (!Directory.Exists(mount.HostPath))
            {
                throw new AppLifecycleException(
                    "app_mount_source_missing",
                    $"External mount '{mount.Key}/{mount.Label}' host path was not found or is not a directory: {mount.HostPath}");
            }
        }
    }

    private async Task<AppRecord> EnsureLocalCommandSourceReadyAsync(
        AppRecord app,
        RuntimeAppManifestSelection selection,
        CancellationToken cancellationToken)
    {
        if (!string.Equals(selection.RuntimeProfile.Type, "localCommand", StringComparison.Ordinal))
        {
            return app;
        }

        var source = app.SourceState;

        // A locked (Development Mode off) source runtime from a URL/publisher install runs the reviewed
        // source pinned to its commit, from the managed checkout — ignoring any live override. This is the
        // honest lock: only a reviewed source-resolve/update advances the commit. A folder install has no
        // separate reviewed source to pin (the operator's own folder is the source), so it falls through
        // to the live path below.
        var profiles = await ResolveRuntimeProfilesAsync(app, cancellationToken);
        var selectedProfile = profiles.FirstOrDefault(profile => string.Equals(profile.Key, app.SelectedRuntime, StringComparison.Ordinal));
        var developmentModeOn = selectedProfile is not null && AppSummary.ResolveDevelopmentMode(app, selectedProfile);
        if (!developmentModeOn
            && !string.IsNullOrWhiteSpace(app.ManifestUrl)
            && !string.IsNullOrWhiteSpace(source?.Repository))
        {
            if (IsRelativeSourceRepository(source.Repository))
            {
                throw new AppLifecycleException(
                    "source_repository_relative_remote_unsupported",
                    $"Remote manifest runtime '{selection.RuntimeProfile.Key}' uses localCommand, so source.repository must be an absolute Git URL or local repository path.");
            }

            await sources.EnsurePinnedCommitAsync(app.Id, cancellationToken);
            return await RequireAppAsync(app.Id, cancellationToken);
        }

        if (!string.IsNullOrWhiteSpace(source?.LocalOverridePath))
        {
            if (!Directory.Exists(source.LocalOverridePath))
            {
                throw new AppLifecycleException(
                    "source_override_not_found",
                    $"Local source override path was not found: {source.LocalOverridePath}");
            }

            return app;
        }

        if (string.IsNullOrWhiteSpace(app.ManifestUrl))
        {
            throw new AppLifecycleException(
                "local_command_source_root_required",
                $"Runtime app '{app.Id}' uses localCommand but no local source root was resolved.");
        }

        if (string.IsNullOrWhiteSpace(selection.Manifest.Source?.Repository))
        {
            throw new AppLifecycleException(
                "source_required_for_local_command",
                $"Remote manifest runtime '{selection.RuntimeProfile.Key}' uses localCommand and must declare source.repository.");
        }

        if (IsRelativeSourceRepository(selection.Manifest.Source.Repository))
        {
            throw new AppLifecycleException(
                "source_repository_relative_remote_unsupported",
                $"Remote manifest runtime '{selection.RuntimeProfile.Key}' uses localCommand, so source.repository must be an absolute Git URL or local repository path.");
        }

        var checkoutPath = source?.ManagedCheckoutPath ?? Path.Combine(paths.SourcesRoot, app.Id);
        if (Directory.Exists(Path.Combine(checkoutPath, ".git")) &&
            !string.IsNullOrWhiteSpace(source?.Commit))
        {
            return app;
        }

        await sources.ResolveManagedAsync(
            app.Id,
            new AppSourceResolveRequest(
                Branch: selection.Manifest.Source.Branch,
                Tag: selection.Manifest.Source.Tag,
                Commit: selection.Manifest.Source.Commit,
                Fetch: !string.IsNullOrWhiteSpace(selection.Manifest.Source.Branch)),
            cancellationToken);

        return await RequireAppAsync(app.Id, cancellationToken);
    }

    private static bool IsRelativeSourceRepository(string repository)
    {
        var trimmed = repository.Trim();
        if (Uri.TryCreate(trimmed, UriKind.Absolute, out var uri) && !string.IsNullOrWhiteSpace(uri.Scheme))
        {
            return false;
        }

        if (Path.IsPathFullyQualified(trimmed))
        {
            return false;
        }

        return true;
    }

    // Best-effort advisory at start: Hosty does not auto-install/auto-start cross-app dependencies,
    // so warn host admins when a declared dependency is missing or not running (required + missing =
    // error, otherwise warning). Never blocks the start; failures to publish are swallowed.
    private async Task NotifyMissingDependenciesAsync(AppRecord app, CancellationToken cancellationToken)
    {
        if (notifications is null || app.Dependencies?.Count is null or 0)
        {
            return;
        }

        // Publishes one advisory; never throws (a notification failure must not break start).
        async Task PublishAsync(string level, string title, string body, string dedupeKey)
        {
            try
            {
                await notifications.PublishAsync(
                    new CoreScope(), NotificationService.BroadcastTarget, NotificationService.AudienceHostAdmin,
                    level, title, body, link: null, dedupeKey, cancellationToken);
            }
            catch (Exception exception)
            {
                logger.LogWarning(exception, "Failed to publish dependency advisory for {AppId}.", app.Id);
            }
        }

        foreach (var dependency in app.Dependencies ?? [])
        {
            var version = dependency.Version is { Length: > 0 } v ? $" ({v})" : string.Empty;
            var dependencyApp = await apps.GetAppAsync(dependency.AppId, cancellationToken);

            if (dependencyApp is null)
            {
                await PublishAsync(
                    dependency.Required ? "error" : "warning",
                    $"Dependency '{dependency.AppId}' is not installed",
                    $"'{app.Id}' depends on '{dependency.AppId}'{version}, which is not installed. Hosty does not auto-install dependencies — install it so the wired endpoints resolve.",
                    $"dependency-missing:{app.Id}:{dependency.AppId}");
                continue;
            }

            if (!string.Equals(dependencyApp.RuntimeState, "running", StringComparison.Ordinal))
            {
                await PublishAsync(
                    "warning",
                    $"Dependency '{dependency.AppId}' is not running",
                    $"'{app.Id}' depends on '{dependency.AppId}'{version}, which is installed but not running. Start it so the wired endpoints resolve.",
                    $"dependency-stopped:{app.Id}:{dependency.AppId}");
                continue;
            }

            // Running: warn about any wired endpoint that does not resolve to a URL (e.g. a typo'd key),
            // since that endpoint's HOSTY_DEPENDENCY_{ALIAS}_URL is silently skipped during injection.
            foreach (var wired in dependency.Endpoints ?? [])
            {
                var resolved = (dependencyApp.Endpoints ?? []).Any(endpoint =>
                    string.Equals(endpoint.Key, wired.EndpointKey, StringComparison.Ordinal) && !string.IsNullOrWhiteSpace(endpoint.Url));
                if (!resolved)
                {
                    await PublishAsync(
                        "warning",
                        $"Dependency endpoint '{dependency.AppId}/{wired.EndpointKey}' is unavailable",
                        $"'{app.Id}' wires endpoint '{wired.EndpointKey}' of '{dependency.AppId}', but it has no resolvable URL — HOSTY_DEPENDENCY_{wired.Alias}_URL will be missing.",
                        $"dependency-endpoint:{app.Id}:{dependency.AppId}:{wired.EndpointKey}");
                }
            }
        }
    }

    // Host-admin advisory when a live source app started from its last-good copy because the operator
    // folder manifest is currently invalid (2b/R14). Best-effort, never throws — a notification
    // failure must not break a start that otherwise succeeded. Dedupe key is per-app so repeated bad
    // starts coalesce into one advisory until the edit validates again.
    private async Task NotifyManifestInvalidAsync(AppRecord app, string error, CancellationToken cancellationToken)
    {
        if (notifications is null)
        {
            return;
        }

        try
        {
            await notifications.PublishAsync(
                new CoreScope(), NotificationService.BroadcastTarget, NotificationService.AudienceHostAdmin,
                "warning",
                $"'{app.Id}' is running an older manifest",
                $"The live source folder manifest for '{app.Id}' failed validation, so Hosty kept running the last-good copy. Fix the edit and restart to adopt it. Error: {error}",
                link: null,
                $"manifest-invalid:{app.Id}",
                cancellationToken);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            logger.LogWarning(exception, "Failed to publish manifest-invalid advisory for {AppId}.", app.Id);
        }
    }

    // Start-time gate: a runtime app must not launch while a required setting is unset,
    // otherwise it comes up misconfigured with no clear signal to the operator. Checks the
    // stored settings (so it covers required secrets too, whose values Core holds but the UI
    // cannot see). Throws a recordable lifecycle failure — surfaced as a Shell toast on a manual
    // start, recorded as LastError, and (via the advisory below) as a host-admin notification,
    // which is the only signal on the autostart path.
    private async Task EnsureRequiredSettingsConfiguredAsync(AppRecord app, CancellationToken cancellationToken)
    {
        var missing = CollectMissingRequiredSettings(app);
        if (missing.Count == 0)
        {
            return;
        }

        await NotifyRequiredSettingsMissingAsync(app, missing, cancellationToken);
        throw new AppLifecycleException(
            "app_required_settings_missing",
            $"Runtime app '{app.Id}' is missing required setting(s): {string.Join(", ", missing)}. Configure them before starting.");
    }

    private static IReadOnlyList<string> CollectMissingRequiredSettings(AppRecord app)
        => (app.Settings?.Values ?? [])
            .Where(setting => setting.Required && string.IsNullOrWhiteSpace(setting.Value))
            .Select(setting => setting.Key)
            .OrderBy(key => key, StringComparer.Ordinal)
            .ToArray();

    // Host-admin advisory mirroring NotifyMissingDependenciesAsync: best-effort, never throws so a
    // notification failure cannot mask the start error. Dedupe key is per-app so re-attempts coalesce.
    private async Task NotifyRequiredSettingsMissingAsync(AppRecord app, IReadOnlyList<string> missing, CancellationToken cancellationToken)
    {
        if (notifications is null)
        {
            return;
        }

        try
        {
            await notifications.PublishAsync(
                new CoreScope(), NotificationService.BroadcastTarget, NotificationService.AudienceHostAdmin,
                "error",
                $"'{app.Id}' can't start: required settings missing",
                $"'{app.DisplayName}' cannot start until required setting(s) are configured: {string.Join(", ", missing)}.",
                link: null,
                $"required-settings-missing:{app.Id}",
                cancellationToken);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            // Best-effort advisory: swallow disk/IO/store failures so they cannot mask the start
            // error, but let a genuine cancellation propagate naturally instead of being absorbed.
            logger.LogWarning(exception, "Failed to publish required-settings advisory for {AppId}.", app.Id);
        }
    }

    private async Task<IReadOnlyDictionary<string, string>> ResolveDependencyUrlsAsync(AppRecord app, CancellationToken cancellationToken)
    {
        var urls = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var dependency in app.Dependencies ?? [])
        {
            var dependencyApp = await apps.GetAppAsync(dependency.AppId, cancellationToken);
            if (dependencyApp is null)
            {
                continue;
            }

            foreach (var wired in dependency.Endpoints ?? [])
            {
                var endpoint = (dependencyApp.Endpoints ?? []).FirstOrDefault(candidate =>
                    string.Equals(candidate.Key, wired.EndpointKey, StringComparison.Ordinal));
                if (!string.IsNullOrWhiteSpace(endpoint?.Url))
                {
                    // Keyed by the consumer-chosen alias → injected as HOSTY_DEPENDENCY_{ALIAS}_URL.
                    urls[wired.Alias] = endpoint.Url;
                }
            }
        }

        return urls;
    }

    private async Task<AppRecord> RequireAppAsync(string appId, CancellationToken cancellationToken)
        => await apps.GetAppAsync(appId, cancellationToken) ??
            throw new AppLifecycleException("app_not_found", $"Runtime app '{appId}' was not found.");

    // The effective manifest an app runs with, plus whether it came from the live source folder, the
    // last-good baseline it superseded (for the reconcile diff, R11), and any error from a mid-edit-
    // invalid folder manifest (Selection then holds the last-good copy). Internal (not private) so the
    // live-source reconcile is unit-testable without starting a process.
    internal sealed record AppSelectionLoad(
        RuntimeAppManifestSelection Selection,
        bool LiveReconciled,
        string? ManifestError,
        RuntimeAppManifestSelection? Baseline = null);

    // The effective manifest selection an app runs with. For a live source app (operator-owned
    // localCommand folder) the live folder manifest is preferred over the reviewed internal copy and
    // adopted with no reviewed-update ceremony (2b/R5); a mid-edit-invalid manifest falls back to the
    // last-good copy and is surfaced, not fatal (R13). Most callers only need the selection, so this
    // stays a thin wrapper; StartAsync uses LoadSelectionWithStatusAsync to also act on the error.
    private async Task<RuntimeAppManifestSelection> LoadSelectionForAppAsync(AppRecord app, CancellationToken cancellationToken)
        => (await LoadSelectionWithStatusAsync(app, cancellationToken)).Selection;

    internal async Task<AppSelectionLoad> LoadSelectionWithStatusAsync(AppRecord app, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(app.ManifestPath))
        {
            throw new AppLifecycleException("manifest_path_required", $"Runtime app '{app.Id}' has no manifest path.");
        }

        // The reviewed internal copy is always valid (validated + saved at install/update); it is the
        // last-good snapshot a live source app falls back to when its folder manifest is mid-edit.
        var lastGood = await manifests.LoadAsync(app.ManifestPath, app.SelectedRuntime, cancellationToken);

        // Legacy records may predate persisted RuntimeProfiles; fall back to the profiles of the
        // just-loaded internal copy (same source as ResolveRuntimeProfilesAsync, but reusing lastGood so
        // there is no extra load) so a development runtime is never misread as non-live here.
        var profiles = app.RuntimeProfiles is { Count: > 0 }
            ? app.RuntimeProfiles
            : BuildRuntimeProfileSummaries(lastGood.Manifest);
        var livePath = ResolveLiveSourcePath(app, profiles);
        if (livePath is null)
        {
            return new AppSelectionLoad(lastGood, LiveReconciled: false, ManifestError: null);
        }

        // The live path is the source root (repo root); a monorepo app's manifest lives one subtree in,
        // so read from <root>/<ManifestSubpath>/manifest.json (LoadAsync resolves manifest.json in a
        // directory). Null/empty subpath ⇒ the root itself (manifest-at-root, the pre-subpath behavior).
        var liveManifestPath = CombineManifestSubpath(livePath, app.SourceState?.ManifestSubpath);

        try
        {
            var live = await manifests.LoadAsync(liveManifestPath, app.SelectedRuntime, cancellationToken);
            // A folder whose manifest now describes a different app is an operator mistake, not a
            // contract Core should adopt — treat it like an invalid edit and keep the last-good copy.
            if (!string.Equals(live.Manifest.Id, app.Id, StringComparison.Ordinal))
            {
                return new AppSelectionLoad(lastGood, LiveReconciled: false,
                    ManifestError: $"Live source manifest declares app id '{live.Manifest.Id}', expected '{app.Id}'.");
            }

            return new AppSelectionLoad(live, LiveReconciled: true, ManifestError: null, Baseline: lastGood);
        }
        // A mid-edit folder manifest can fail validation (AppManifestException) or be unreadable
        // (raw IO/permission/JSON errors from the file read) — either way it is a transient operator
        // edit, so fall back to the last-good copy and surface the error rather than failing the start
        // (R13). OperationCanceledException is intentionally not caught so cancellation propagates.
        catch (Exception ex) when (ex is AppManifestException or AppLifecycleException
            or IOException or UnauthorizedAccessException or JsonException)
        {
            return new AppSelectionLoad(lastGood, LiveReconciled: false, ManifestError: ex.Message);
        }
    }

    // Adopt a live source folder manifest into the persisted record at start, with no reviewed-update
    // ceremony (2b/R5): the contract (version, capabilities, endpoints, mount slots, settings schema,
    // dependencies, UI, runtime profiles) tracks the live folder while operator state (settings values,
    // mount bindings, autostart, runtime state) is preserved. The change list vs the last-good baseline
    // is recorded for awareness (R11), and the last-good copy is freshened so the fallback and the next
    // diff track "since last start" (R10). Mount handling is non-destructive: a removed slot keeps its
    // binding (orphaned, inert) via PreserveMounts (R7).
    internal async Task<AppRecord> ReconcileLiveContractAsync(AppRecord app, AppSelectionLoad load, CancellationToken cancellationToken)
    {
        var selection = load.Selection;
        IReadOnlyList<string> changes = load.Baseline is null
            ? []
            : BuildUpdateChanges(app, load.Baseline, selection);

        await manifests.SaveManifestCopyAsync(selection, GetAppRoot(app.Id), cancellationToken);
        await manifests.VendorDisplayAssetsAsync(selection, GetAppRoot(app.Id), cancellationToken);

        // Build the reconciled contract from the fresh `current` record inside the update lambda, not
        // the stale `app` captured before the lock, so a setting/mount change applied concurrently
        // (ConfigureAsync / ConfigureMountsAsync) is carried forward by BuildAppRecord instead of being
        // overwritten with stale operator state. The lambda is pure and may re-run on a write conflict.
        var updated = await apps.UpdateAppAsync(app.Id, current =>
        {
            var reconciled = BuildAppRecord(selection, current.ManifestPath!, manifestUrl: current.ManifestUrl, system: current.System, existing: current);
            return current with
            {
                Version = reconciled.Version,
                DisplayName = reconciled.DisplayName,
                Description = reconciled.Description,
                Source = reconciled.Source,
                Capabilities = reconciled.Capabilities,
                Settings = reconciled.Settings,
                StorageMappings = reconciled.StorageMappings,
                Dependencies = reconciled.Dependencies,
                Endpoints = reconciled.Endpoints,
                MountSlots = reconciled.MountSlots,
                Mounts = reconciled.Mounts,
                Ui = reconciled.Ui,
                CatalogMetadata = reconciled.CatalogMetadata,
                RuntimeProfiles = reconciled.RuntimeProfiles,
                SourceState = reconciled.SourceState,
                // Record this start's adopted deltas; null when nothing changed so clients show no badge.
                LiveChanges = changes.Count > 0 ? changes : null,
            };
        }, cancellationToken);
        return updated.App;
    }

    // True when the app's selected runtime is a live source artifact owned by the operator: a
    // development runtime (localCommand + development: true) whose source Core re-reads live from the
    // operator's own folder — an explicit source-override (which supersedes a URL/publisher install),
    // else the original folder install of a non-URL install. For these the contract tracks the folder
    // and is adopted on restart, so the reviewed-update flow does not apply - clients mark the runtime
    // "Live" and hide the Update affordance, and CreateUpdatePlanAsync refuses with a clear error
    // (runtime-app-marketplace.md, "Live source"). ResolveLiveSourcePath is the single source of truth
    // for both liveness (this flag) and the folder the live manifest is re-read from, so the two can
    // never disagree.
    private bool IsLiveSourceApp(AppRecord app, IReadOnlyList<AppRuntimeProfileSummary>? profiles = null)
        => ResolveLiveSourcePath(app, profiles) is not null;

    // The operator-owned source folder a live source app both runs from AND re-reads its manifest from —
    // a source-override folder, else the original external folder install — or null when the app is not a
    // live source app. The single source of truth for liveness: it feeds the `Live` flag, the summary's
    // SourceLivePath (badge tooltip), the live-manifest reconcile (LoadSelectionWithStatusAsync), and the
    // update-plan guard, so they can never disagree. Gated on the selected runtime declaring
    // development: true (a build-to-production source runtime is locked/reviewed, never live).
    private string? ResolveLiveSourcePath(AppRecord app, IReadOnlyList<AppRuntimeProfileSummary>? profiles = null)
    {
        // Only a source (localCommand) runtime whose effective Development Mode is ON runs live from an
        // operator folder — the operator's per-runtime toggle, defaulting to the manifest `development`
        // flag. OFF (or a non-source runtime) is locked/reviewed, so it is not "live".
        var selectedProfile = ((profiles ?? app.RuntimeProfiles) ?? [])
            .FirstOrDefault(profile => string.Equals(profile.Key, app.SelectedRuntime, StringComparison.Ordinal));
        if (selectedProfile is null || !AppSummary.ResolveDevelopmentMode(app, selectedProfile))
        {
            return null;
        }

        // An explicit operator source override is a deliberate local-dev choice that supersedes a
        // URL/publisher install's reviewed contract, so the override folder is the live source even for
        // a URL install.
        var overridePath = app.SourceState?.LocalOverridePath;
        if (!string.IsNullOrWhiteSpace(overridePath) && Directory.Exists(overridePath))
        {
            return overridePath;
        }

        // A development runtime with a materialized managed checkout runs live from that clone (Q2): the
        // operator's own git working tree, which they can edit and re-adopt on restart. The checkout is
        // cloned lazily at start (EnsureLocalCommandSourceReadyAsync); before it exists the app falls
        // back to the reviewed copy (identical to the just-cloned HEAD), so there is no first-start skew.
        var checkoutPath = app.SourceState?.ManagedCheckoutPath;
        if (!string.IsNullOrWhiteSpace(checkoutPath)
            && Directory.Exists(Path.Combine(checkoutPath, ".git")))
        {
            return checkoutPath;
        }

        // A URL/publisher install with no override and no materialized checkout crosses a trust
        // boundary: its contract is reviewed even when the code runs live, so it is not "live source".
        if (!string.IsNullOrWhiteSpace(app.ManifestUrl))
        {
            return null;
        }

        if (!string.IsNullOrWhiteSpace(app.InstallManifestPath)
            && !IsInternalAppPath(app.Id, app.InstallManifestPath)
            && (File.Exists(app.InstallManifestPath) || Directory.Exists(app.InstallManifestPath)))
        {
            return app.InstallManifestPath;
        }

        return null;
    }

    // Update source for a local install: prefer the operator's original folder/file so a folder
    // install picks up manifest edits. Falls back to the internal copy (app.ManifestPath) when the
    // original source is gone or was never captured, so "Recheck" never breaks — it just reports no
    // changes, and the plan's SourceConfigured flag tells callers the comparison was against Core's
    // own copy. An InstallManifestPath that points inside the app root is itself the internal copy
    // (legacy/corrupted capture) and is ignored here.
    private string? ResolveLocalUpdateManifestPath(AppRecord app)
    {
        if (!string.IsNullOrWhiteSpace(app.InstallManifestPath) &&
            !IsInternalAppPath(app.Id, app.InstallManifestPath) &&
            (File.Exists(app.InstallManifestPath) || Directory.Exists(app.InstallManifestPath)))
        {
            return app.InstallManifestPath;
        }

        return app.ManifestPath;
    }

    // An update has a real external source when the caller supplies a manifest path, the app was
    // installed from a URL, or it still retains a usable operator folder. Without one, "Recheck"
    // can only read Core's own internal copy and will always report no changes — the plan flags
    // this so the UI/CLI can prompt for a source instead of implying the app is up to date.
    private bool HasExternalUpdateSource(AppRecord app, string? requestedManifestPath)
        => (!string.IsNullOrWhiteSpace(requestedManifestPath)
                // A requested path that points back into Core's own copy is not an external source.
                && !IsInternalAppPath(app.Id, requestedManifestPath))
            || !string.IsNullOrWhiteSpace(app.ManifestUrl)
            || (!string.IsNullOrWhiteSpace(app.InstallManifestPath)
                && !IsInternalAppPath(app.Id, app.InstallManifestPath)
                && (File.Exists(app.InstallManifestPath) || Directory.Exists(app.InstallManifestPath)));

    // True when the path resolves inside the app's Core-managed root (e.g. the internal manifest
    // copy under {AppsRoot}/{id}). Such a path is never a real external source. Reuses
    // PathEqualsOrWithin so casing/trailing-separator handling matches the OS (case-insensitive on
    // Windows) and stays consistent with the rest of the path-containment checks in this file.
    private bool IsInternalAppPath(string appId, string? path)
        => !string.IsNullOrWhiteSpace(path) && PathEqualsOrWithin(GetAppRoot(appId), path);

    private IAppRuntimeAdapter ResolveAdapter(string? runtimeType)
        => adapters.FirstOrDefault(adapter => string.Equals(adapter.Type, runtimeType, StringComparison.Ordinal))
            ?? throw new AppLifecycleException("runtime_adapter_missing", $"Runtime adapter '{runtimeType}' is not available.");

    private string GetAppRoot(string appId)
        => CoreDataPaths.ResolveContainedPath(paths.AppsRoot, appId);

    private string GetAppDataPath(string appId)
        => Path.Combine(GetAppRoot(appId), "data");

    // Writes a Core-owned file into a system app's data dir, which the runtime mounts into the
    // container (see RuntimeAppDataTarget). Used by the collector bootstrap to deliver the
    // authoritative otelcol config before the container starts. Idempotent: overwrites each call so
    // a config template change ships on the next Core start. The file name is constrained to a plain
    // file name (no separators) so it cannot escape the data dir.
    internal async Task WriteSystemAppDataFileAsync(string appId, string fileName, string content, CancellationToken cancellationToken)
    {
        if (fileName.Contains(Path.DirectorySeparatorChar) || fileName.Contains(Path.AltDirectorySeparatorChar) || fileName.Contains("..", StringComparison.Ordinal))
        {
            throw new ArgumentException("System app data file name must be a plain file name.", nameof(fileName));
        }

        var dataPath = GetAppDataPath(appId);
        Directory.CreateDirectory(dataPath);
        await File.WriteAllTextAsync(Path.Combine(dataPath, fileName), content, cancellationToken);
    }

    // Creates a Core-owned subdirectory inside a system app's data dir, world-writable on Unix so a
    // container running as a non-root UID (e.g. the distroless OTel collector's 10001) can create and
    // rotate files there through the bind mount, which Core then reads back from the host side (the P4
    // OTLP-logs sink). Idempotent. The relative dir is constrained to a plain name so it cannot escape
    // the data dir. The contents are non-secret telemetry the host already trusts.
    internal string EnsureSystemAppDataSubdirectory(string appId, string relativeDir)
    {
        if (string.IsNullOrWhiteSpace(relativeDir) || relativeDir is "." or ".." ||
            relativeDir.Contains(Path.DirectorySeparatorChar) || relativeDir.Contains(Path.AltDirectorySeparatorChar) || relativeDir.Contains("..", StringComparison.Ordinal))
        {
            throw new ArgumentException("System app data subdirectory must be a plain, non-empty directory name.", nameof(relativeDir));
        }

        var path = Path.Combine(GetAppDataPath(appId), relativeDir);
        Directory.CreateDirectory(path);
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(
                path,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute |
                UnixFileMode.GroupRead | UnixFileMode.GroupWrite | UnixFileMode.GroupExecute |
                UnixFileMode.OtherRead | UnixFileMode.OtherWrite | UnixFileMode.OtherExecute);
        }

        return path;
    }

    private string GetRetainedConfigPath(string appId)
        => Path.Combine(GetAppRoot(appId), "retained-config.json");

    private async Task WriteRetainedConfigAsync(AppRecord app, CancellationToken cancellationToken)
        => await JsonStorage.WriteAsync(
            GetRetainedConfigPath(app.Id),
            new RetainedAppConfig(1, app.Settings, app.Mounts ?? [], app.Autostart),
            // Holds secret setting values, so keep it owner-only on Unix like other secret stores.
            restrictToOwner: true,
            cancellationToken);

    private async Task<RetainedAppConfig?> TryReadRetainedConfigAsync(string appId, CancellationToken cancellationToken)
    {
        try
        {
            return await JsonStorage.ReadAsync<RetainedAppConfig>(GetRetainedConfigPath(appId), cancellationToken);
        }
        catch (Exception ex) when (ex is IOException or JsonException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    // Overlays retained setting values onto the freshly built (manifest-default) settings, keeping
    // only keys the new manifest still declares. The retained value wins whenever the key was held
    // — including an operator's intentional clear (empty/null) — so a reinstall faithfully restores
    // the last configuration instead of silently reverting to a non-empty manifest default. Guards
    // against a corrupt/legacy snapshot whose map deserialized as null (or empty): nothing to apply.
    private static IReadOnlyDictionary<string, AppSettingValue> OverlayRetainedSettings(
        IReadOnlyDictionary<string, AppSettingValue> current,
        IReadOnlyDictionary<string, AppSettingValue>? retained)
    {
        if (retained is null || retained.Count == 0)
        {
            return current;
        }

        return current.ToDictionary(
            pair => pair.Key,
            pair => retained.TryGetValue(pair.Key, out var value)
                ? pair.Value with { Value = value.Value }
                : pair.Value,
            StringComparer.Ordinal);
    }

    private AppFeedService RequireFeedService()
        => feedService ?? throw new AppLifecycleException("app_feeds_unavailable", "The runtime-app feed service is not available.");

    private static void RequireFeedAppMatch(AppRecord app, string feedAppId)
    {
        if (!string.Equals(app.Id, feedAppId, StringComparison.Ordinal))
        {
            throw new AppLifecycleException(
                "app_feeds_app_mismatch",
                $"Feed document appId '{feedAppId}' does not match installed app '{app.Id}'.");
        }
    }

    private static string HashPlanSeed<T>(T seed)
    {
        var json = JsonSerializer.Serialize(seed, CoreJson.TypeInfo<T>());
        return Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(json))).ToLowerInvariant();
    }

    private IReadOnlyList<string> BuildUpdateChanges(
        AppRecord app,
        RuntimeAppManifestSelection currentSelection,
        RuntimeAppManifestSelection targetSelection)
    {
        var changes = new List<string>();
        if (!string.Equals(app.Version, targetSelection.Manifest.Version, StringComparison.Ordinal))
        {
            changes.Add($"version:{app.Version}->{targetSelection.Manifest.Version}");
        }

        if (!string.Equals(app.SelectedRuntime, targetSelection.RuntimeProfile.Key, StringComparison.Ordinal))
        {
            changes.Add($"runtime:{app.SelectedRuntime}->{targetSelection.RuntimeProfile.Key}");
        }

        // A manifest that newly declares role: system escalates the app to a system app. Listing it
        // here is what makes the escalation operator-approved: the entry folds into the reviewed plan
        // digest. The reverse direction never appears because System is sticky across updates.
        if (!app.System && IsSystemManifest(targetSelection.Manifest))
        {
            changes.Add("role:runtime->system");
        }

        AddUpdateServiceChanges(changes, currentSelection, targetSelection);
        AddSettingChanges(changes, app.Settings, BuildSettingDefinitions(targetSelection));
        AddDependencyChanges(changes, app.Dependencies, targetSelection.Manifest.Dependencies);
        AddEndpointChanges(changes, app.Endpoints, BuildEndpointContracts(targetSelection));
        AddUpdateDataTargetChanges(changes, app, targetSelection);
        AddCapabilityChanges(changes, app.Capabilities, ResolveCapabilities(targetSelection.Manifest));

        if (changes.Count == 0 &&
            !string.Equals(currentSelection.ManifestDigest, targetSelection.ManifestDigest, StringComparison.Ordinal))
        {
            changes.Add("manifest");
        }

        return changes;
    }

    // Compares each compiled (docker image) service's currently-locked digest against the target
    // tag's remotely-resolved digest, producing `artifact:{service}:{current}->{target}` change
    // entries. A re-pushed tag (identical manifest) therefore still shows up as a pending change.
    // If the registry is unreachable the target is "unknown" (do not fail the plan, A4): surfaced
    // only when a current lock exists, signalling the artifact will be re-pulled at apply.
    private async Task<IReadOnlyList<string>> BuildArtifactDigestChangesAsync(
        AppRecord app,
        RuntimeAppManifestSelection targetSelection,
        CancellationToken cancellationToken)
    {
        var resolver = adapters.OfType<IImageDigestResolver>().FirstOrDefault();
        var changes = new List<string>();
        foreach (var service in targetSelection.Services
            .Where(service => service.Image is not null)
            .OrderBy(service => service.Key, StringComparer.Ordinal))
        {
            var currentDigest = app.ArtifactLocks?.GetValueOrDefault(service.Key)?.ImageDigest;
            var targetDigest = resolver is null
                ? null
                : await resolver.ResolveRemoteDigestAsync(service.Image!, cancellationToken);

            if (string.IsNullOrWhiteSpace(targetDigest))
            {
                if (!string.IsNullOrWhiteSpace(currentDigest))
                {
                    changes.Add($"artifact:{service.Key}:{currentDigest}->unknown");
                }

                continue;
            }

            if (!string.Equals(currentDigest, targetDigest, StringComparison.Ordinal))
            {
                changes.Add($"artifact:{service.Key}:{currentDigest ?? "none"}->{targetDigest}");
            }
        }

        return changes;
    }

    private static void AddUpdateServiceChanges(
        List<string> changes,
        RuntimeAppManifestSelection currentSelection,
        RuntimeAppManifestSelection targetSelection)
    {
        var currentServices = currentSelection.Services.ToDictionary(service => service.Key, StringComparer.Ordinal);
        var targetServices = targetSelection.Services.ToDictionary(service => service.Key, StringComparer.Ordinal);
        foreach (var key in currentServices.Keys.Concat(targetServices.Keys).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            var hasCurrent = currentServices.TryGetValue(key, out var current);
            var hasTarget = targetServices.TryGetValue(key, out var target);
            if (!hasCurrent)
            {
                changes.Add($"service:{key}:added:{target!.Runtime.Type}");
                continue;
            }

            if (!hasTarget)
            {
                changes.Add($"service:{key}:removed:{current!.Runtime.Type}");
                continue;
            }

            if (!string.Equals(current!.Runtime.Type, target!.Runtime.Type, StringComparison.Ordinal))
            {
                changes.Add($"service:{key}:runtimeType:{current.Runtime.Type}->{target.Runtime.Type}");
            }

            AddImageChange(changes, key, current, target);
            AddCommandChanges(changes, key, current, target);
            AddNetworkChange(changes, key, current, target);
            AddServicePrivilegedChanges(changes, key, current, target);
            AddPortChanges(changes, key, current.Runtime.Ports, target.Runtime.Ports);
            AddEnvironmentChanges(changes, key, current.Runtime.Environment, target.Runtime.Environment);
        }
    }

    private IReadOnlyList<string> BuildRuntimeSwitchChanges(
        AppRecord app,
        RuntimeAppManifestSelection currentSelection,
        RuntimeAppManifestSelection targetSelection)
    {
        var changes = new List<string>
        {
            $"runtime:{app.SelectedRuntime}->{targetSelection.RuntimeProfile.Key}",
        };

        changes.Add(string.Equals(currentSelection.RuntimeProfile.Type, targetSelection.RuntimeProfile.Type, StringComparison.Ordinal)
            ? $"runtimeType:{targetSelection.RuntimeProfile.Type}"
            : $"runtimeType:{currentSelection.RuntimeProfile.Type}->{targetSelection.RuntimeProfile.Type}");

        AddServiceChanges(changes, app.Id, currentSelection, targetSelection);
        AddSettingChanges(changes, app.Settings, BuildSettingDefinitions(targetSelection));
        AddDependencyChanges(changes, app.Dependencies, targetSelection.Manifest.Dependencies);
        AddEndpointChanges(changes, app.Endpoints, BuildEndpointContracts(targetSelection));
        AddDataTargetChanges(changes, app, targetSelection);

        return changes;
    }

    private static void AddServiceChanges(
        List<string> changes,
        string appId,
        RuntimeAppManifestSelection currentSelection,
        RuntimeAppManifestSelection targetSelection)
    {
        var currentServices = currentSelection.Services.ToDictionary(service => service.Key, StringComparer.Ordinal);
        var targetServices = targetSelection.Services.ToDictionary(service => service.Key, StringComparer.Ordinal);
        foreach (var key in currentServices.Keys.Concat(targetServices.Keys).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            var hasCurrent = currentServices.TryGetValue(key, out var current);
            var hasTarget = targetServices.TryGetValue(key, out var target);
            if (!hasCurrent)
            {
                changes.Add($"service:{key}:added:{target!.Runtime.Type}");
            }
            else if (!hasTarget)
            {
                changes.Add($"service:{key}:removed:{current!.Runtime.Type}");
            }
            else
            {
                AddImageChange(changes, key, current!, target!);
                AddCommandChanges(changes, key, current!, target!);
                AddNetworkChange(changes, key, current!, target!);
                AddServicePrivilegedChanges(changes, key, current!, target!);
                AddPortChanges(changes, key, current!.Runtime.Ports, target!.Runtime.Ports);
                AddEnvironmentChanges(changes, key, current.Runtime.Environment, target.Runtime.Environment);
            }

            AddContainerNameChanges(changes, appId, key, current, target);
        }
    }

    private static void AddImageChange(
        List<string> changes,
        string serviceKey,
        RuntimeSelectedService current,
        RuntimeSelectedService target)
    {
        var currentImage = current.Image?.Reference;
        var targetImage = target.Image?.Reference;
        if (!string.Equals(currentImage, targetImage, StringComparison.Ordinal))
        {
            changes.Add($"image:{serviceKey}:{currentImage ?? "none"}->{targetImage ?? "none"}");
        }
    }

    private static void AddCommandChanges(
        List<string> changes,
        string serviceKey,
        RuntimeSelectedService current,
        RuntimeSelectedService target)
    {
        if (!string.Equals(current.Runtime.Command, target.Runtime.Command, StringComparison.Ordinal))
        {
            changes.Add($"command:{serviceKey}:changed");
        }

        if (!string.Equals(current.Runtime.WorkingDirectory, target.Runtime.WorkingDirectory, StringComparison.Ordinal))
        {
            changes.Add($"workingDirectory:{serviceKey}:{current.Runtime.WorkingDirectory ?? "."}->{target.Runtime.WorkingDirectory ?? "."}");
        }
    }

    private static void AddNetworkChange(
        List<string> changes,
        string serviceKey,
        RuntimeSelectedService current,
        RuntimeSelectedService target)
    {
        // Toggling the docker network mode (bridge<->host) changes how the container is launched
        // (`--network host` vs the user/bridge network and `-p` publishing), so it must trigger a
        // restart. null/empty normalizes to "bridge" so declaring the default explicitly is inert.
        var currentNetwork = NormalizeNetwork(current.Runtime.Network);
        var targetNetwork = NormalizeNetwork(target.Runtime.Network);
        if (!string.Equals(currentNetwork, targetNetwork, StringComparison.Ordinal))
        {
            changes.Add($"network:{serviceKey}:{currentNetwork}->{targetNetwork}");
        }
    }

    private static string NormalizeNetwork(string? network)
        => string.IsNullOrWhiteSpace(network) ? "bridge" : network.ToLowerInvariant();

    // Detects changes to a service's privileged docker extras — Linux capabilities (`--cap-add`)
    // and host devices (`--device`). Named distinctly from the app-level AddCapabilityChanges
    // (open/update/restart permissions) to avoid confusing the two.
    private static void AddServicePrivilegedChanges(
        List<string> changes,
        string serviceKey,
        RuntimeSelectedService current,
        RuntimeSelectedService target)
    {
        // Capabilities (`--cap-add`) and devices (`--device`) are container launch args, so adding or
        // removing any must trigger a restart. Compare order-insensitively on the normalized set.
        var currentCaps = NormalizeList(current.Runtime.Capabilities, LinuxCapabilities.Normalize);
        var targetCaps = NormalizeList(target.Runtime.Capabilities, LinuxCapabilities.Normalize);
        if (!string.Equals(currentCaps, targetCaps, StringComparison.Ordinal))
        {
            changes.Add($"capabilities:{serviceKey}:{currentCaps}->{targetCaps}");
        }

        var currentDevices = NormalizeList(current.Runtime.Devices, device => device.Trim());
        var targetDevices = NormalizeList(target.Runtime.Devices, device => device.Trim());
        if (!string.Equals(currentDevices, targetDevices, StringComparison.Ordinal))
        {
            changes.Add($"devices:{serviceKey}:{currentDevices}->{targetDevices}");
        }
    }

    private static string NormalizeList(IReadOnlyList<string> values, Func<string, string> normalize)
    {
        var joined = string.Join(",", values.Select(normalize).Order(StringComparer.Ordinal));
        return joined.Length == 0 ? "none" : joined;
    }

    private static void AddPortChanges(
        List<string> changes,
        string serviceKey,
        IReadOnlyList<RuntimePortManifest> currentPorts,
        IReadOnlyList<RuntimePortManifest> targetPorts)
    {
        var current = BuildPortMap(currentPorts);
        var target = BuildPortMap(targetPorts);
        foreach (var key in current.Keys.Concat(target.Keys).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            var hasCurrent = current.TryGetValue(key, out var currentSignature);
            var hasTarget = target.TryGetValue(key, out var targetSignature);
            if (!hasCurrent)
            {
                changes.Add($"port:{serviceKey}.{key}:added:{targetSignature}");
            }
            else if (!hasTarget)
            {
                changes.Add($"port:{serviceKey}.{key}:removed:{currentSignature}");
            }
            else if (!string.Equals(currentSignature, targetSignature, StringComparison.Ordinal))
            {
                changes.Add($"port:{serviceKey}.{key}:{currentSignature}->{targetSignature}");
            }
        }
    }

    private static void AddEnvironmentChanges(
        List<string> changes,
        string serviceKey,
        IReadOnlyDictionary<string, string> current,
        IReadOnlyDictionary<string, string> target)
    {
        foreach (var key in current.Keys.Concat(target.Keys).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            var hasCurrent = current.ContainsKey(key);
            var hasTarget = target.ContainsKey(key);
            if (!hasCurrent)
            {
                changes.Add($"environment:{serviceKey}.{key}:added");
            }
            else if (!hasTarget)
            {
                changes.Add($"environment:{serviceKey}.{key}:removed");
            }
            else if (!string.Equals(current[key], target[key], StringComparison.Ordinal))
            {
                changes.Add($"environment:{serviceKey}.{key}:changed");
            }
        }
    }

    private static void AddContainerNameChanges(
        List<string> changes,
        string appId,
        string serviceKey,
        RuntimeSelectedService? current,
        RuntimeSelectedService? target)
    {
        var currentIsDocker = string.Equals(current?.Runtime.Type, "docker", StringComparison.Ordinal);
        var targetIsDocker = string.Equals(target?.Runtime.Type, "docker", StringComparison.Ordinal);
        if (!currentIsDocker && !targetIsDocker)
        {
            return;
        }

        var containerName = DockerRuntimeAdapter.BuildContainerName(appId, serviceKey);
        if (currentIsDocker && targetIsDocker)
        {
            changes.Add($"container:{serviceKey}:preserved:{containerName}");
        }
        else if (targetIsDocker)
        {
            changes.Add($"container:{serviceKey}:added:{containerName}");
        }
        else
        {
            changes.Add($"container:{serviceKey}:removed:{containerName}");
        }
    }

    private static void AddSettingChanges(
        List<string> changes,
        IReadOnlyDictionary<string, AppSettingValue> currentSettings,
        IReadOnlyList<RuntimeAppSettingManifest> targetSettings)
    {
        var targetByKey = targetSettings.ToDictionary(setting => setting.Key, StringComparer.Ordinal);
        foreach (var key in currentSettings.Keys.Concat(targetByKey.Keys).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            var hasCurrent = currentSettings.TryGetValue(key, out var current);
            var hasTarget = targetByKey.TryGetValue(key, out var target);
            if (!hasCurrent)
            {
                changes.Add($"setting:{key}:added");
            }
            else if (!hasTarget)
            {
                changes.Add($"setting:{key}:removed");
            }
            else
            {
                if (!string.Equals(current!.Type, target!.Type, StringComparison.Ordinal))
                {
                    changes.Add($"setting:{key}:type:{current.Type}->{target.Type}");
                }

                if (current.Secret != target.Secret)
                {
                    changes.Add($"setting:{key}:secret:{current.Secret}->{target.Secret}");
                }
            }
        }
    }

    private static void AddDependencyChanges(
        List<string> changes,
        IReadOnlyList<AppDependencyContract> currentDependencies,
        IReadOnlyList<RuntimeAppDependencyManifest> targetDependencies)
    {
        var current = (currentDependencies ?? []).ToDictionary(dependency => dependency.AppId, StringComparer.Ordinal);
        var target = targetDependencies
            .Select(ToDependencyContract)
            .ToDictionary(dependency => dependency.AppId, StringComparer.Ordinal);
        foreach (var key in current.Keys.Concat(target.Keys).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            var hasCurrent = current.TryGetValue(key, out var currentDependency);
            var hasTarget = target.TryGetValue(key, out var targetDependency);
            if (!hasCurrent)
            {
                changes.Add($"dependency:{key}:added");
            }
            else if (!hasTarget)
            {
                changes.Add($"dependency:{key}:removed");
            }
            else if (!string.Equals(DependencySignature(currentDependency!), DependencySignature(targetDependency!), StringComparison.Ordinal))
            {
                changes.Add($"dependency:{key}:{DependencySignature(currentDependency!)}->{DependencySignature(targetDependency!)}");
            }
        }
    }

    private static void AddEndpointChanges(
        List<string> changes,
        IReadOnlyList<AppEndpointContract> currentEndpoints,
        IReadOnlyList<AppEndpointContract> targetEndpoints)
    {
        var current = currentEndpoints.ToDictionary(endpoint => endpoint.Key, StringComparer.Ordinal);
        var target = targetEndpoints.ToDictionary(endpoint => endpoint.Key, StringComparer.Ordinal);
        foreach (var key in current.Keys.Concat(target.Keys).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            var hasCurrent = current.TryGetValue(key, out var currentEndpoint);
            var hasTarget = target.TryGetValue(key, out var targetEndpoint);
            if (!hasCurrent)
            {
                changes.Add($"endpoint:{key}:added:{EndpointSignature(targetEndpoint!)}");
            }
            else if (!hasTarget)
            {
                changes.Add($"endpoint:{key}:removed:{EndpointSignature(currentEndpoint!)}");
            }
            else if (!string.Equals(EndpointSignature(currentEndpoint!), EndpointSignature(targetEndpoint!), StringComparison.Ordinal))
            {
                changes.Add($"endpoint:{key}:{EndpointSignature(currentEndpoint!)}->{EndpointSignature(targetEndpoint!)}");
            }
        }
    }

    private void AddDataTargetChanges(List<string> changes, AppRecord app, RuntimeAppManifestSelection targetSelection)
    {
        var currentData = app.StorageMappings.FirstOrDefault(mapping => string.Equals(mapping.Key, "data", StringComparison.Ordinal));
        var targetPath = targetSelection.DataTarget is null
            ? null
            : targetSelection.DataTarget.ContainerPath ?? GetAppDataPath(app.Id);
        if (currentData is null && targetPath is null)
        {
            return;
        }

        if (currentData is null)
        {
            changes.Add($"data:added:{targetPath}");
        }
        else if (targetPath is null)
        {
            changes.Add($"data:removed:{currentData.TargetPath}");
        }
        else if (!string.Equals(currentData.TargetPath, targetPath, StringComparison.Ordinal))
        {
            changes.Add($"data:target:{currentData.TargetPath}->{targetPath}");
        }
        else
        {
            changes.Add("data:compatible");
        }
    }

    private void AddUpdateDataTargetChanges(List<string> changes, AppRecord app, RuntimeAppManifestSelection targetSelection)
    {
        var currentData = app.StorageMappings.FirstOrDefault(mapping => string.Equals(mapping.Key, "data", StringComparison.Ordinal));
        var targetPath = targetSelection.DataTarget is null
            ? null
            : targetSelection.DataTarget.ContainerPath ?? GetAppDataPath(app.Id);
        if (currentData is null && targetPath is null)
        {
            return;
        }

        if (currentData is null)
        {
            changes.Add($"data:added:{targetPath}");
        }
        else if (targetPath is null)
        {
            changes.Add($"data:removed:{currentData.TargetPath}");
        }
        else if (!string.Equals(currentData.TargetPath, targetPath, StringComparison.Ordinal))
        {
            changes.Add($"data:target:{currentData.TargetPath}->{targetPath}");
        }
    }

    private static void AddCapabilityChanges(List<string> changes, IReadOnlyList<string> currentCapabilities, IReadOnlyList<string> targetCapabilities)
    {
        var current = currentCapabilities.ToHashSet(StringComparer.Ordinal);
        var target = targetCapabilities.ToHashSet(StringComparer.Ordinal);
        foreach (var key in current.Concat(target).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            var hasCurrent = current.Contains(key);
            var hasTarget = target.Contains(key);
            if (!hasCurrent)
            {
                changes.Add($"capability:{key}:added");
            }
            else if (!hasTarget)
            {
                changes.Add($"capability:{key}:removed");
            }
        }
    }

    private static IReadOnlyList<string> ResolveCapabilities(RuntimeAppManifest manifest)
        => manifest.Capabilities.Count == 0 ? DefaultCapabilities : manifest.Capabilities;

    private static IReadOnlyDictionary<string, string> BuildPortMap(IReadOnlyList<RuntimePortManifest> ports)
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var index = 0; index < ports.Count; index++)
        {
            var port = ports[index];
            var key = port.Key ??
                port.ContainerPort?.ToString(System.Globalization.CultureInfo.InvariantCulture) ??
                $"index-{index}";
            map[key] = PortSignature(port);
        }

        return map;
    }

    private static string PortSignature(RuntimePortManifest port)
    {
        var protocol = string.IsNullOrWhiteSpace(port.Protocol) ? "http" : port.Protocol;
        var containerPort = port.ContainerPort?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "none";
        var hostPort = port.LocalPort ?? port.HostPort;
        var host = hostPort?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "auto";
        var isPublic = port.Public ?? false;
        var expose = string.IsNullOrWhiteSpace(port.Expose) ? "loopback" : port.Expose.ToLowerInvariant();
        var transport = port.Transport is { Count: > 0 } transports
            ? string.Join("+", transports.Select(value => value.ToLowerInvariant()).OrderBy(value => value, StringComparer.Ordinal))
            : "tcp";
        return $"{protocol}:{host}->{containerPort}:public={isPublic}:expose={expose}:transport={transport}";
    }

    private static string EndpointSignature(AppEndpointContract endpoint)
    {
        var service = string.IsNullOrWhiteSpace(endpoint.Service) ? "none" : endpoint.Service;
        var port = string.IsNullOrWhiteSpace(endpoint.Port) ? "none" : endpoint.Port;
        return $"{endpoint.Protocol}:public={endpoint.Public}:service={service}:port={port}";
    }

    private static AppDependencyContract ToDependencyContract(RuntimeAppDependencyManifest dependency)
        => new(
            dependency.Id,
            dependency.Version,
            dependency.RequiredOrDefault,
            dependency.Endpoints
                .Select(endpoint => new AppDependencyEndpointContract(endpoint.Key, endpoint.Alias))
                .ToArray());

    private static string DependencySignature(AppDependencyContract dependency)
    {
        var endpoints = string.Join(",", (dependency.Endpoints ?? [])
            .Select(endpoint => $"{endpoint.EndpointKey}={endpoint.Alias}")
            .Order(StringComparer.Ordinal));
        return $"{dependency.AppId}:{dependency.Version ?? "*"}:required={dependency.Required}:{endpoints}";
    }

    private static IReadOnlyList<AppEndpointContract> BuildEndpointContracts(RuntimeAppManifestSelection selection)
    {
        if (selection.Manifest.Endpoints.Count > 0)
        {
            return selection.Manifest.Endpoints.Select(endpoint => new AppEndpointContract(
                Key: endpoint.Key,
                Protocol: endpoint.Protocol ?? "http",
                Url: null,
                Public: endpoint.Public,
                Service: endpoint.Service,
                Port: endpoint.Port)).ToArray();
        }

        return selection.Services.SelectMany(service => service.Runtime.Ports.Select(port => new AppEndpointContract(
            Key: $"{service.Key}.{port.Key ?? port.ContainerPort?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "port"}",
            Protocol: string.IsNullOrWhiteSpace(port.Protocol) ? "http" : port.Protocol,
            Url: null,
            Public: port.Public ?? false,
            Service: service.Key,
            Port: port.Key ?? port.ContainerPort?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "port"))).ToArray();
    }

    // When an ingress provider manages public origins (e.g. cloudflared), persist the derived
    // HOSTY_PUBLIC_ORIGIN_<endpoint> values before start so the existing settings->env pipeline
    // injects them. The host is deterministic, so this runs before the runtime port is known.
    private async Task<AppRecord> EnsureIngressPublicOriginsAsync(
        AppRecord app,
        RuntimeAppManifestSelection selection,
        CancellationToken cancellationToken)
    {
        if (!ingress.ManagesPublicOrigins)
        {
            return app;
        }

        var publicEndpointKeys = BuildEndpointContracts(selection)
            .Where(endpoint => endpoint.Public && !string.IsNullOrWhiteSpace(endpoint.Key))
            .Select(endpoint => endpoint.Key)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        if (publicEndpointKeys.Length == 0)
        {
            return app;
        }

        var subdomainOverride = app.Settings.TryGetValue(CloudflaredIngressPlanner.SubdomainSettingKey, out var subdomain)
            ? subdomain.Value
            : null;
        var desired = ingress.ResolvePublicOrigins(app.Id, subdomainOverride, publicEndpointKeys);
        var changed = desired.Any(entry =>
            !app.Settings.TryGetValue(entry.Key, out var current) ||
            !string.Equals(current.Value, entry.Value, StringComparison.Ordinal));
        if (!changed)
        {
            return app;
        }

        var updated = await apps.UpdateAppAsync(app.Id, current =>
        {
            var settings = new Dictionary<string, AppSettingValue>(current.Settings, StringComparer.Ordinal);
            foreach (var entry in desired)
            {
                settings[entry.Key] = new AppSettingValue(entry.Key, "url", entry.Value, Secret: false);
            }

            return current with { Settings = settings };
        }, cancellationToken);
        return updated.App;
    }

    // Re-render the ingress provider's config from the current set of apps. Best-effort: an ingress
    // failure must never fail the lifecycle operation that triggered it.
    public async Task ReconcileIngressAsync(CancellationToken cancellationToken = default)
    {
        try
        {
            var records = await apps.ListAppRecordsAsync(cancellationToken);
            await ingress.ReconcileAsync(records, cancellationToken);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            // Best-effort: ingress reconciliation runs on the startup BackgroundService path too,
            // so it must never throw (an unhandled exception there would crash the host). Log for
            // visibility rather than swallowing silently.
            logger.LogWarning(ex, "Hosty ingress reconciliation did not complete.");
        }
    }

    private static IReadOnlyList<RuntimeAppSettingManifest> BuildSettingDefinitions(RuntimeAppManifestSelection selection)
    {
        var settings = selection.Manifest.Settings
            .Where(setting => !PublicOriginSettings.IsSettingKey(setting.Key))
            .ToDictionary(setting => setting.Key, StringComparer.Ordinal);
        foreach (var endpoint in BuildEndpointContracts(selection).Where(endpoint => endpoint.Public))
        {
            var key = PublicOriginSettings.BuildSettingKey(endpoint.Key);
            settings.TryAdd(key, new RuntimeAppSettingManifest
            {
                Key = key,
                Type = "url",
                Default = null,
                Secret = false,
            });
        }

        return settings.Values.ToArray();
    }

    private static IReadOnlyDictionary<string, AppSettingValue> MergeSettings(
        IReadOnlyDictionary<string, AppSettingValue> current,
        IReadOnlyDictionary<string, string?> incoming)
    {
        var settings = current.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        foreach (var (key, value) in incoming)
        {
            if (settings.TryGetValue(key, out var existing))
            {
                settings[key] = existing with { Value = value };
            }
            else
            {
                settings[key] = new AppSettingValue(key, PublicOriginSettings.IsSettingKey(key) ? "url" : "string", value, Secret: false);
            }
        }

        return settings;
    }

    private static void ValidatePublicOriginSettings(IReadOnlyDictionary<string, string?>? settings)
    {
        if (settings is null)
        {
            return;
        }

        foreach (var (key, value) in settings)
        {
            if (!PublicOriginSettings.IsSettingKey(key) ||
                string.IsNullOrWhiteSpace(value))
            {
                continue;
            }

            if (!PublicOriginSettings.TryNormalizeOrigin(value, out _))
            {
                throw new AppLifecycleException(
                    "public_origin_invalid",
                    $"Setting '{key}' must be an absolute http(s) origin without a path, query, or fragment.");
            }
        }
    }

    private static string? ResolveDefaultRuntime(RuntimeAppManifest manifest)
        => string.IsNullOrWhiteSpace(manifest.DefaultRuntime)
            ? manifest.RuntimeProfiles.FirstOrDefault(profile => profile.Default)?.Key ?? manifest.RuntimeProfiles.FirstOrDefault()?.Key
            : manifest.DefaultRuntime;

    private static IReadOnlyList<AppRuntimeProfileSummary> BuildRuntimeProfileSummaries(RuntimeAppManifest manifest)
    {
        var defaultRuntime = ResolveDefaultRuntime(manifest);
        return manifest.RuntimeProfiles
            .Select(profile => new AppRuntimeProfileSummary(
                profile.Key,
                profile.Type,
                string.Equals(profile.Key, defaultRuntime, StringComparison.Ordinal),
                profile.Development))
            .ToArray();
    }

    private async Task<AppRecord> ReconcileRuntimeStateForSummaryAsync(AppRecord app, CancellationToken cancellationToken)
    {
        if (!string.Equals(app.Kind, "runtime", StringComparison.Ordinal) ||
            !string.Equals(app.RuntimeState, "running", StringComparison.Ordinal) ||
            string.IsNullOrWhiteSpace(app.ManifestPath))
        {
            return app;
        }

        RuntimeAppManifestSelection selection;
        try
        {
            selection = await LoadSelectionForAppAsync(app, cancellationToken);
        }
        catch (Exception ex) when (ex is AppManifestException or IOException or UnauthorizedAccessException or JsonException)
        {
            return app;
        }

        if (!string.Equals(selection.RuntimeProfile.Type, "localCommand", StringComparison.Ordinal))
        {
            return app;
        }

        AppRuntimeHealthResult health;
        try
        {
            health = await ResolveAdapter(selection.RuntimeProfile.Type).GetHealthAsync(
                await CreateRuntimeContextAsync(app, selection, cancellationToken),
                cancellationToken);
        }
        catch (Exception ex) when (ex is AppLifecycleException or IOException or UnauthorizedAccessException)
        {
            return app;
        }

        var observedRuntimeState = ResolveRuntimeStateFromHealth(health);
        if (observedRuntimeState is null ||
            string.Equals(observedRuntimeState, app.RuntimeState, StringComparison.Ordinal))
        {
            return app;
        }

        var updated = await apps.UpdateAppAsync(app.Id, current => current with
        {
            RuntimeState = observedRuntimeState,
        }, cancellationToken);
        return updated.App;
    }

    // Maps an aggregate health status to the coarse persisted RuntimeState. "degraded"/"starting" are
    // still live (the container is up), so they reconcile to "running"; "unhealthy" (a partial outage)
    // is ambiguous and maps to "unknown"; anything unrecognized leaves the state untouched.
    internal static string? ResolveRuntimeStateFromHealth(AppRuntimeHealthResult health)
        => health.Status switch
        {
            "healthy" or "degraded" or "starting" => "running",
            "stopped" => "stopped",
            "unhealthy" => "unknown",
            _ => null,
        };

    // Phase 1 supervision read: observe each relevant runtime app's current health across BOTH
    // runtimes (the summary-path reconcile above stays localCommand-only so listing never fans out to
    // docker), reconcile the persisted RuntimeState from what is actually observed, and return the
    // per-app aggregate health so the supervisor can detect transitions and notify. `supervisedAppIds`
    // are apps the supervisor is actively retrying after a crash: their persisted state may already be
    // "stopped" during restart backoff, but they must keep being observed so retries and give-up still
    // fire across ticks. Best-effort: a failure to observe one app is logged and skipped, never
    // failing the whole pass and starving the other apps of supervision.
    public async Task<IReadOnlyList<AppHealthObservation>> ObserveRuntimeHealthAsync(
        IReadOnlySet<string> supervisedAppIds, CancellationToken cancellationToken = default)
    {
        var records = await apps.ListAppRecordsAsync(cancellationToken);
        var observations = new List<AppHealthObservation>();
        foreach (var app in records)
        {
            try
            {
                var observation = await ObserveRuntimeHealthForAppAsync(app, supervisedAppIds.Contains(app.Id), cancellationToken);
                if (observation is not null)
                {
                    observations.Add(observation);
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(ex, "Failed to observe runtime health for app '{AppId}'.", app.Id);
            }
        }

        await ReconcileStoppedButRunningDockerAppsAsync(records, cancellationToken);
        return observations;
    }

    // The per-app observation above only probes apps Core already believes running, so it cannot catch the
    // inverse drift: a docker container still running while the record says stopped (a failed/racing stop,
    // or a container revived out-of-band). One `docker ps --filter label=hosty.app.id` per tick discovers
    // the truth and reconciles those records back to "running" so the next tick observes them (C-M1).
    private async Task ReconcileStoppedButRunningDockerAppsAsync(IReadOnlyList<AppRecord> records, CancellationToken cancellationToken)
    {
        var probe = adapters.OfType<IRunningContainerProbe>().FirstOrDefault();
        if (probe is null)
        {
            return;
        }

        IReadOnlySet<string> runningAppIds;
        try
        {
            runningAppIds = await probe.ListRunningAppIdsAsync(cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "Failed to probe running docker containers for state reconciliation.");
            return;
        }

        foreach (var app in records)
        {
            if (!string.Equals(app.Kind, "runtime", StringComparison.Ordinal) ||
                string.Equals(app.RuntimeState, "running", StringComparison.Ordinal) ||
                !runningAppIds.Contains(app.Id))
            {
                continue;
            }

            // Take the per-app operation lock non-blockingly: if a lifecycle verb is mid-flight (e.g.
            // StopAsync tearing the container down), skip this app and let a later tick reconcile it —
            // otherwise the sweep could overwrite that verb's "stopped" back to "running" (the very drift
            // this sweep exists to remove). A record that is still genuinely stopped-but-running is caught
            // next tick; a wrongly-set "running" self-heals via ObserveRuntimeHealthForAppAsync.
            var mutex = operationLocks.GetOrAdd(app.Id, _ => new SemaphoreSlim(1, 1));
            if (!await mutex.WaitAsync(0, cancellationToken))
            {
                continue;
            }

            try
            {
                _ = await apps.UpdateAppAsync(app.Id, current => current with { RuntimeState = "running" }, cancellationToken);
            }
            finally
            {
                mutex.Release();
            }
        }
    }

    private async Task<AppHealthObservation?> ObserveRuntimeHealthForAppAsync(AppRecord app, bool supervised, CancellationToken cancellationToken)
    {
        // Probe apps the operator expects up: those Core still believes are running, plus any the
        // supervisor is actively retrying after a crash. The latter keep being observed even though
        // their reconciled state is already "stopped" during backoff, so the crash-loop gate continues
        // to advance instead of the app silently falling out of supervision after one tick.
        if (!string.Equals(app.Kind, "runtime", StringComparison.Ordinal) ||
            string.IsNullOrWhiteSpace(app.ManifestPath) ||
            (!string.Equals(app.RuntimeState, "running", StringComparison.Ordinal) && !supervised))
        {
            return null;
        }

        RuntimeAppManifestSelection selection;
        try
        {
            selection = await LoadSelectionForAppAsync(app, cancellationToken);
        }
        catch (Exception ex) when (ex is AppManifestException or IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }

        AppRuntimeHealthResult health;
        try
        {
            health = await ResolveAdapter(selection.RuntimeProfile.Type).GetHealthAsync(
                await CreateRuntimeContextAsync(app, selection, cancellationToken),
                cancellationToken);
        }
        catch (Exception ex) when (ex is AppLifecycleException or IOException or UnauthorizedAccessException)
        {
            return null;
        }

        var observedRuntimeState = ResolveRuntimeStateFromHealth(health);
        if (observedRuntimeState is not null &&
            !string.Equals(observedRuntimeState, app.RuntimeState, StringComparison.Ordinal))
        {
            _ = await apps.UpdateAppAsync(app.Id, current => current with
            {
                RuntimeState = observedRuntimeState,
            }, cancellationToken);
        }

        return new AppHealthObservation(app.Id, health.Status, RuntimeRestartPolicy.FromManifest(selection.Manifest.RestartPolicy));
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }

    private static void TryDeleteDirectory(string path)
    {
        try
        {
            if (Directory.Exists(path))
            {
                Directory.Delete(path, recursive: true);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }

    private static void TryDeleteDirectoryIfEmpty(string path)
    {
        try
        {
            if (Directory.Exists(path) && !Directory.EnumerateFileSystemEntries(path).Any())
            {
                Directory.Delete(path);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
        }
    }

    private static readonly string[] DefaultCapabilities = ["open", "update", "restart", "stop", "remove", "backup", "restore", "logs"];
}

internal sealed record AppUpdatePlanDigestSeed(
    string AppId,
    string CurrentVersion,
    string? TargetVersion,
    string? CurrentRuntime,
    string TargetRuntime,
    string? CurrentManifestDigest,
    string TargetManifestDigest,
    string TargetManifestPath,
    string? FeedsUrl,
    string? FeedId,
    string? FeedDocumentDigest,
    bool WillCreateBackup,
    IReadOnlyList<string> Changes);

internal sealed record AppRuntimeSwitchDigestSeed(
    string AppId,
    string? CurrentRuntime,
    string TargetRuntime,
    string Version,
    string ManifestDigest,
    bool AutomaticBackup,
    IReadOnlyList<string> Changes);

internal sealed record AppInstallPlanRequest(
    string ManifestPath,
    string? SelectedRuntime = null,
    bool System = false,
    bool? Autostart = null);

internal sealed record AppInstallRequest(
    string ManifestPath,
    string? SelectedRuntime = null,
    bool System = false,
    IReadOnlyDictionary<string, string?>? Settings = null,
    bool? Autostart = null,
    // Whether to start the app immediately after installing, when Autostart is enabled. Only an explicit
    // true starts it (null and false both mean "don't start now"): the interactive install endpoints coerce
    // a client's absent value to true, while internal boot bootstraps (shell/collector) pass false so the
    // boot reconciliation starts them once, in the right order (StartAutostartAppsAsync). See InstallCoreAsync.
    bool? StartOnInstall = null,
    // Generic app-owned feed state. Only the digest-bound feed install path populates these; direct
    // browser/control installs clear them.
    string? FeedsUrl = null,
    string? FeedId = null);

internal sealed record AppFeedInstallPlanRequest(
    string FeedsUrl,
    string? FeedId = null,
    string? SelectedRuntime = null,
    bool? Autostart = null);

internal sealed record AppFeedInstallApplyRequest(
    string FeedsUrl,
    string? FeedId,
    string? SelectedRuntime,
    IReadOnlyDictionary<string, string?>? Settings,
    bool? Autostart,
    string PlanDigest,
    bool? StartOnInstall = null);

// Selects an entry from the installed app's stored app-owned feeds document. Null/blank FeedId clears
// the followed feed while preserving the last resolved ManifestUrl.
internal sealed record AppFeedRequest(string? FeedId = null);

internal sealed record AppConfigureRequest(
    IReadOnlyDictionary<string, string?>? Settings = null,
    bool? Autostart = null,
    // "pinned" | "rolling"; null leaves the current policy unchanged. The authoritative pull/lock
    // policy for compiled artifacts (replaces the removed manifest pullPolicy).
    string? UpdatePolicy = null);

internal sealed record AppAutostartRequest(bool Autostart);

internal sealed record AppDevelopmentModeRequest(string Runtime, bool Enabled);

internal sealed record AppMountsRequest(IReadOnlyList<AppMountBindingInput>? Mounts = null);

// A global binding sends Key + GlobalMountName (Label/HostPath are derived from the library entry);
// a local binding sends Key + Label + HostPath. See CoreLifecycleService.ValidateMountBindings.
internal sealed record AppMountBindingInput(string Key, string? Label = null, string? HostPath = null, string? GlobalMountName = null);

internal sealed record AppUpdatePlanRequest(
    string? ManifestPath = null,
    string? SelectedRuntime = null);

internal sealed record AppUpdateApplyRequest(
    string PlanDigest,
    string? ManifestPath = null,
    string? SelectedRuntime = null);

internal sealed record AppRemoveRequest(
    bool DeleteRuntimeState = true,
    bool DeleteData = false,
    bool DeleteBackups = false,
    bool DeleteSource = false,
    bool IgnoreRuntimeErrors = false);

internal sealed record AppManualBackupRequest(string? Reason = null);

internal sealed record AppRestoreBackupRequest(bool CreatePreRestoreBackup = false);

internal sealed record AppRuntimeSwitchPlanRequest(string TargetRuntime);

internal sealed record AppRuntimeSwitchApplyRequest(string TargetRuntime, string PlanDigest);

internal sealed record AppBackgroundLifecycleResult(
    string AppId,
    string Operation,
    bool Succeeded,
    string? ErrorCode,
    string? Message);

internal sealed record AppLifecycleResponse(
    AppSummary? App,
    AppBackupRecord? Backup,
    string Status,
    // Set only on a Development-Mode *disable* that looks risky: the app ran a different version live
    // than the reviewed baseline, so its data may have been migrated one-way. Carries the pre-dev-mode
    // backup to offer for rollback. The app is left stopped in this case so the operator can restore
    // before the reviewed version boots onto migrated data. Null on every other lifecycle response.
    AppDevelopmentModeRestoreHint? DevelopmentModeRestore = null);

internal sealed record AppDevelopmentModeRestoreHint(
    bool Recommended,
    string Runtime,
    string? BackupId,
    string BaselineVersion,
    string CurrentVersion);

internal sealed record AppInstallPlan(
    string AppId,
    string DisplayName,
    string? Description,
    string Action,
    string? CurrentVersion,
    string TargetVersion,
    string? CurrentRuntime,
    string TargetRuntime,
    string TargetRuntimeType,
    string ManifestPath,
    string? CurrentManifestDigest,
    string TargetManifestDigest,
    bool DefaultAutostart,
    // True when this install produces a system app (manifest role: system or an internal bootstrap
    // request), so review UIs can surface the escalation before the operator confirms.
    bool System,
    IReadOnlyList<AppRuntimeProfileSummary> RuntimeProfiles,
    IReadOnlyList<AppInstallSetting> Settings);

internal sealed record AppFeedInstallPlan(
    AppInstallPlan Install,
    string FeedsUrl,
    string FeedId,
    string ManifestUrl,
    string FeedDocumentDigest,
    string PlanDigest);

internal sealed record AppFeedInstallPlanDigestSeed(
    string FeedsUrl,
    string FeedDocumentDigest,
    string FeedId,
    string ManifestUrl,
    string AppId,
    string? CurrentVersion,
    string? CurrentRuntime,
    string? CurrentManifestDigest,
    string TargetManifestDigest,
    string TargetRuntime,
    bool Autostart);

internal sealed record AppInstallSetting(string Key, string Type, string? DefaultValue, bool Secret, bool Required = false, string? Label = null, string? Description = null);

internal sealed record AppUpdatePlan(
    string AppId,
    string CurrentVersion,
    string TargetVersion,
    string? CurrentRuntime,
    string TargetRuntime,
    string ManifestPath,
    string ManifestDigest,
    string PlanDigest,
    bool WillCreatePreUpdateBackup,
    IReadOnlyList<string> Changes,
    // False when no external source is configured and Recheck could only read Core's internal copy,
    // so an empty Changes list does not mean the app is up to date. Excluded from the plan digest
    // (informational only). Defaulted so older callers/payloads stay compatible.
    bool SourceConfigured = true);

internal sealed record AppRuntimeSwitchPlan(
    string AppId,
    string? CurrentRuntime,
    string TargetRuntime,
    string TargetRuntimeType,
    string PlanDigest,
    bool AutomaticBackup,
    IReadOnlyList<string> Changes);

internal sealed record AppBackupsResponse(IReadOnlyList<AppBackupRecord> Backups);

internal sealed record AppBackupResponse(AppBackupRecord? Backup);

internal sealed record AppBackupDeleteResponse(bool Deleted);

internal sealed record AppLogsResponse(string AppId, string Text, IReadOnlyList<AppLogsServiceSegment> Services);

internal sealed record AppLogsServiceSegment(string Service, string Text);

internal sealed record AppRuntimeHealthResponse(
    string AppId,
    string Runtime,
    string RuntimeType,
    string Status,
    IReadOnlyList<AppRuntimeServiceHealth> Services);

// One supervision observation: an app's aggregate health status at a point in time plus its resolved
// restart policy, used by the supervisor to reconcile state, detect transitions, and restart crashes.
// Not serialized — internal supervision only.
internal sealed record AppHealthObservation(string AppId, string Status, RuntimeRestartPolicy RestartPolicy);

// Read-only update-available report for a runtime app (see GetUpdateStatusAsync). `UpdateAvailable`
// aggregates feed-manifest and compiled-service movement; `UpdatePolicy` is "pinned"/"rolling".
internal sealed record AppUpdateStatusResponse(
    string AppId,
    string Runtime,
    string RuntimeType,
    string UpdatePolicy,
    bool UpdateAvailable,
    IReadOnlyList<AppServiceUpdateStatus> Services,
    bool ManifestUpdateAvailable = false,
    bool ManifestUnknown = false);

// Per-service update status: the currently-locked digest, the remotely-resolved candidate digest, and
// whether the candidate is a new build (lock present and differs). `Unknown` = the registry could not
// be reached so no candidate could be resolved.
internal sealed record AppServiceUpdateStatus(
    string Service,
    string? LockedDigest,
    string? CandidateDigest,
    bool UpdateAvailable,
    bool Unknown);
