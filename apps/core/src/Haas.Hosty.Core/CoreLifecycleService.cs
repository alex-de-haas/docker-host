using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Hosting;
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
    AppFeedService? feedService = null,
    // App secrets keychain, deleted with app data on removal. Optional only for unit fixtures;
    // production DI always supplies it. The fallback shares the same AppRegistryStore instance, so
    // the per-app lock still fences removal against in-flight secret writes.
    AppSecretsStore? appSecrets = null,
    // Install-time port-reservation coordinator. Optional only for unit fixtures that do not exercise
    // allocation; production DI always supplies it. When absent, install skips reservation and ports are
    // resolved at first start as before. See RuntimePortAllocator.
    RuntimePortAllocator? portAllocator = null,
    // Application lifetime for detaching background update applies from the triggering HTTP request
    // (a page reload must not abort a half-done apply). Optional only for unit fixtures; production
    // DI always supplies it. When absent, background applies run unlinked from any token.
    IHostApplicationLifetime? hostLifetime = null,
    // How long the start half of a stop->start pair waits for the app's own host port to come back before
    // starting anyway. Overridable only so tests can reach the give-up path without a real 15s wait;
    // production DI never passes it.
    TimeSpan? selfRestartPortReleaseTimeout = null,
    // Live-event hub for the update-availability projection (record commits publish from
    // AppRegistryStore itself). Optional only for unit fixtures; production DI always supplies it.
    CoreEventHub? events = null,
    // Who owns each HOSTY_PUBLIC_ORIGIN_* value under the active ingress provider, which decides whether
    // `configure` may write one. Optional only for unit fixtures that do not exercise ingress ownership;
    // production DI always supplies it, and CoreHttpHarness covers the wired path.
    PublicOriginOwnership? publicOrigins = null,
    // Cloudflare publications, so an app's lifecycle can clean up the hostnames it published and clear the
    // pending-restart flag when it starts. Optional only for unit fixtures; production DI supplies it.
    // Every use is best-effort: an unreachable Cloudflare must never fail a start, an update, or a removal.
    CloudflarePublicationService? cloudflarePublications = null)
{
    private static readonly Regex BackupReasonPattern = new("^[a-z0-9][a-z0-9-]{0,30}$", RegexOptions.Compiled);
    private static readonly Regex MountLabelPattern = new("^[a-z0-9][a-z0-9._-]{0,62}$", RegexOptions.Compiled);

    // Optional in tests (which exercise lifecycle, not telemetry); DI always supplies the singletons.
    private readonly IClock clock = clock ?? new SystemClock();
    // Host-level shared-mounts library and the shared host-path policy. Default-constructed in tests
    // (both only need CoreDataPaths); DI supplies the singletons.
    private readonly GlobalMountStore globalMounts = globalMounts ?? new GlobalMountStore(paths);
    private readonly MountPathPolicy mountPathPolicy = mountPathPolicy ?? new MountPathPolicy(paths);
    private readonly AppSecretsStore appSecrets = appSecrets ?? new AppSecretsStore(apps, paths);
    private readonly TimeSpan selfRestartPortReleaseTimeout = selfRestartPortReleaseTimeout ?? SelfRestartLoopbackReleaseTimeout;

    // Per-app operation lock. AppRegistryStore.appLocks only serializes a single record write (and,
    // shared with AppSecretsStore, secrets mutations and the subtree delete); a whole
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
        // Reconcile the whole set BEFORE building any summary. Dependency state is resolved against
        // this snapshot, so a provider that reconciles running -> stopped has to be stopped for its
        // consumers too — otherwise one response could report the provider itself stopped while its
        // consumer still reads dependencies[].running: true, hiding the client's error icon until a
        // later request.
        var reconciled = new List<AppRecord>(records.Count);
        foreach (var app in records)
        {
            reconciled.Add(await ReconcileRuntimeStateForSummaryAsync(app, cancellationToken));
        }

        var summaries = new List<AppSummary>(reconciled.Count);
        foreach (var app in reconciled)
        {
            summaries.Add(await BuildAppSummaryAsync(app, cancellationToken, reconciled));
        }

        return summaries;
    }

    public async Task<AppInstallPlan> CreateInstallPlanAsync(AppInstallPlanRequest request, CancellationToken cancellationToken = default)
    {
        var selection = await manifests.LoadAsync(request.ManifestPath, request.SelectedRuntime, cancellationToken);
        // Resolve each image service's tag to its current remote digest at plan time: what the plan
        // shows is what the bound apply pins (C-CR1 Fix B). An unresolvable candidate (offline
        // registry, local-only image) stays null — that service surfaces without a digest and
        // TOFU-backfills at first start, as before.
        var probes = await ProbeServiceArtifactsAsync(
            selection.Manifest.Id!,
            currentLocks: null,
            selection,
            cancellationToken);
        var plan = await BuildInstallPlanAsync(request, selection, cancellationToken) with
        {
            PlanId = $"instp_{Convert.ToHexString(System.Security.Cryptography.RandomNumberGenerator.GetBytes(16)).ToLowerInvariant()}",
            ArtifactDigests = probes,
        };

        // The apply path consumes this cached selection verbatim instead of re-fetching the manifest,
        // so the fetch that produced the reviewed digest is the fetch that installs — a source that
        // answers the plan and the apply differently gains nothing (C-CR1). The TTL is enforced on
        // consume; the sweep here is best-effort cleanup of abandoned entries, and the hard cap
        // below bounds the cache even under a burst of plan requests within one TTL window.
        foreach (var entry in reviewedInstallPlans.Where(entry => clock.UtcNow - entry.Value.CreatedAt > ReviewedInstallPlanTtl))
        {
            reviewedInstallPlans.TryRemove(entry);
        }

        while (reviewedInstallPlans.Count >= MaxPendingInstallPlans)
        {
            // Evict the oldest pending plan rather than rejecting the new one: the operator asking
            // now is the active one, and whoever held the evicted plan just re-reviews.
            var oldest = reviewedInstallPlans.MinBy(entry => entry.Value.CreatedAt);
            if (!reviewedInstallPlans.TryRemove(oldest))
            {
                break;
            }
        }

        reviewedInstallPlans[plan.PlanId!] = new CachedInstallPlan(plan, selection, probes, clock.UtcNow);
        return plan;
    }

    // Reviewed install plans awaiting apply, keyed by the random single-use plan id (an install has no
    // app record yet, so unlike update plans the app id cannot key this). Same TTL rationale as
    // ReviewedUpdatePlanTtl: a stale plan means the operator wandered off and should re-review.
    private readonly ConcurrentDictionary<string, CachedInstallPlan> reviewedInstallPlans = new(StringComparer.Ordinal);

    private static readonly TimeSpan ReviewedInstallPlanTtl = TimeSpan.FromHours(1);

    // Hard bound on pending install plans. Far above any interactive use (a plan per open dialog),
    // low enough that runaway automation cannot grow Core's memory with cached manifest selections.
    private const int MaxPendingInstallPlans = 64;

    private sealed record CachedInstallPlan(AppInstallPlan Plan, RuntimeAppManifestSelection Selection, IReadOnlyList<AppServiceArtifactProbe> Probes, DateTimeOffset CreatedAt);

    // Digest probes → run-locks: only services whose candidate resolved at plan time get one; the
    // lock records the digest the operator reviewed and the tag it was resolved from.
    private IReadOnlyDictionary<string, ArtifactLock>? BuildReviewedArtifactLocks(
        RuntimeAppManifestSelection selection,
        IReadOnlyList<AppServiceArtifactProbe> probes)
    {
        var locks = new Dictionary<string, ArtifactLock>(StringComparer.Ordinal);
        foreach (var probe in probes)
        {
            if (string.IsNullOrWhiteSpace(probe.CandidateDigest))
            {
                continue;
            }

            var service = selection.Services.FirstOrDefault(candidate => string.Equals(candidate.Key, probe.Service, StringComparison.Ordinal));
            if (service?.Image is null)
            {
                continue;
            }

            locks[probe.Service] = new ArtifactLock("image", probe.CandidateDigest, service.Image.TagReference, null, null, clock.UtcNow);
        }

        return locks.Count > 0 ? locks : null;
    }

    // Single-use, consume-on-attempt: the TryRemove is the atomic claim, so two applies echoing the
    // same plan id cannot both run — the loser gets the same error as an expired plan and re-reviews.
    private CachedInstallPlan ConsumeReviewedInstallPlan(string planId)
    {
        if (!reviewedInstallPlans.TryRemove(planId, out var cached) ||
            clock.UtcNow - cached.CreatedAt > ReviewedInstallPlanTtl)
        {
            throw new AppLifecycleException(
                "install_plan_expired",
                "Install plan was not found or has expired. Request a new plan and review it again.");
        }

        return cached;
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
            // Minted (and cached) only by CreateInstallPlanAsync; the feed flow binds by digest.
            PlanId: null,
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
        // Plan-bound path (every HTTP install): apply exactly the selection the reviewed plan was
        // built from. What was reviewed is binding — the manifest bytes, the runtime, and the
        // system-ness all come from the plan; only post-review operator inputs (settings values,
        // autostart, start-on-install) are read from this request.
        if (!string.IsNullOrWhiteSpace(request.PlanId))
        {
            var reviewed = ConsumeReviewedInstallPlan(request.PlanId!);
            var bound = request with
            {
                ManifestPath = reviewed.Selection.ManifestPath,
                SelectedRuntime = reviewed.Selection.RuntimeProfile.Key,
                System = reviewed.Plan.System,
            };
            return await WithAppLockAsync(
                reviewed.Selection.Manifest.Id!,
                () => InstallCoreAsync(bound, reviewed.Selection, cancellationToken, reviewed.Probes),
                cancellationToken);
        }

        // Unbound path: in-process callers only (the boot bootstrap installs from trusted local
        // distribution manifests). The HTTP endpoints require a plan id, so no network caller can
        // reach an apply-time fetch.
        var selection = await manifests.LoadAsync(request.ManifestPath, request.SelectedRuntime, cancellationToken);
        return await WithAppLockAsync(selection.Manifest.Id!, () => InstallCoreAsync(request, selection, cancellationToken), cancellationToken);
    }

    private async Task<AppLifecycleResponse> InstallCoreAsync(AppInstallRequest request, RuntimeAppManifestSelection selection, CancellationToken cancellationToken, IReadOnlyList<AppServiceArtifactProbe>? reviewedArtifacts = null)
    {
        // Planning reports an existing record as "already-installed"; this is the enforcement. Without
        // it, apply rebuilt the record with existing: null — resetting settings, mounts, source state,
        // artifact locks and port reservations while the old runtime kept running (and kept its ports).
        // Checked first, before the manifest copy and asset vendoring touch the app root. Both callers
        // hold this app's operation lock. Changing an installed app is the update flow's job: it stops
        // the runtime, takes a pre-update backup, and diffs the manifest for review.
        var alreadyInstalled = await apps.GetAppAsync(selection.Manifest.Id!, cancellationToken);
        if (alreadyInstalled is not null)
        {
            throw new AppLifecycleException(
                "already_installed",
                $"App '{selection.Manifest.Id}' is already installed (version {alreadyInstalled.Version}). Apply an update to change it, or remove it first.");
        }

        var appRoot = GetAppRoot(selection.Manifest.Id!);
        var manifestCopyPath = Path.Combine(appRoot, "manifest.json");

        await manifests.SaveManifestCopyAsync(selection, appRoot, cancellationToken);
        await manifests.VendorDisplayAssetsAsync(selection, appRoot, cancellationToken);
        if (selection.Manifest.Data?.Enabled == true)
        {
            Directory.CreateDirectory(GetAppDataPath(selection.Manifest.Id!));
        }

        if (selection.Manifest.Cache?.Enabled == true)
        {
            Directory.CreateDirectory(GetAppCachePath(selection.Manifest.Id!));
        }

        var record = BuildAppRecord(
            selection,
            manifestCopyPath,
            manifestUrl: selection.ManifestUrl,
            system: request.System || IsSystemManifest(selection.Manifest),
            existing: null) with
        {
            // The digests the reviewed plan displayed become the initial run-locks, so the first
            // start pulls repository@sha256 from the review instead of whatever the tag means by
            // then. Null on the unbound bootstrap path and for plan-time-unresolvable services —
            // those TOFU-backfill at first start.
            ArtifactLocks = reviewedArtifacts is null ? null : BuildReviewedArtifactLocks(selection, reviewedArtifacts),
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

        // Reserve host ports now — after settings (including any HOSTY_PORT_* overrides) are final — so a
        // stopped app carries durable endpoint URLs before its first start, and its ports are excluded
        // from every other app's allocation. The exclusion-view read, the assignment, and the upsert run
        // as one critical section under the allocator's gate, so two concurrent installs of different apps
        // cannot allocate against a stale snapshot. Skipped only in unit fixtures without the coordinator,
        // where ports resolve at first start as before.
        var document = portAllocator is not null && string.Equals(record.Kind, "runtime", StringComparison.Ordinal)
            ? await portAllocator.AssignAndPersistAsync(
                record,
                selection,
                apps.ListAppRecordsAsync,
                apps.UpsertAppAsync,
                cancellationToken)
            : await apps.UpsertAppAsync(record, cancellationToken);
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
                await StartCoreAsync(installed.Id, afterOwnStop: false, cancellationToken);
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
        // Resolved before the record mutation because it reads the publication store; the comparison
        // itself happens inside the mutator, against the record being committed.
        var managedOrigins = publicOrigins is null
            ? []
            : await publicOrigins.FindManagedKeysAsync(appId, request.Settings?.Keys, cancellationToken);
        var document = await apps.UpdateAppAsync(appId, app =>
        {
            ValidatePublicOriginSettings(request.Settings);
            RequireUnmanagedPublicOrigins(app, request.Settings, managedOrigins);
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

        // A public-origin or subdomain edit is a routing change, so materialize it now rather than leaving
        // it for whatever start, stop or settings save happens next: the whole point of the unified
        // control is that saving it takes effect. Scoped to those keys so an ordinary settings write does
        // not pay for a reconcile, and cheap when it does fire — the local provider re-renders a file and
        // the API one diffs two strings before deciding whether to call Cloudflare at all.
        if (TouchesRouting(request.Settings))
        {
            await ReconcileIngressAsync(cancellationToken);
        }

        return new AppLifecycleResponse(await BuildAppSummaryAsync(document.App, cancellationToken), null, "configured");
    }

    // True when a configure write changes where an app is reachable from: its public origin, or the
    // subdomain the local provider derives every one of its hostnames from.
    private static bool TouchesRouting(IReadOnlyDictionary<string, string?>? settings)
        => settings is { Count: > 0 } &&
            settings.Keys.Any(key =>
                PublicOriginSettings.IsSettingKey(key) ||
                string.Equals(key, CloudflaredIngressPlanner.SubdomainSettingKey, StringComparison.Ordinal));

    // Validates an operator-supplied update policy. null leaves the policy unchanged; the only valid
    // value is "pinned" (case-insensitive), normalized to lowercase for storage. "rolling" — which
    // re-resolved the mutable tag on every start — was removed: every artifact advance goes through a
    // reviewed update, so start-time drift cannot bypass the review boundary. It is rejected rather
    // than silently coerced so a caller that still asks for it learns the semantics are gone.
    private static string? NormalizeConfiguredUpdatePolicy(string? policy)
    {
        if (string.IsNullOrWhiteSpace(policy))
        {
            return null;
        }

        var trimmed = policy.Trim();
        if (!string.Equals(trimmed, "pinned", StringComparison.OrdinalIgnoreCase))
        {
            throw new AppLifecycleException("app_update_policy_invalid", $"Update policy '{policy}' must be 'pinned'. The 'rolling' policy was removed; artifact changes arrive through reviewed updates.");
        }

        return trimmed.ToLowerInvariant();
    }

    /// <summary>
    /// Returns one setting's stored value, secrets included. Admin-only at the edge; exists so the
    /// operator can verify what is actually stored instead of guessing behind an "Unchanged" mask —
    /// they own these values and can already read them off the container env, so hiding them here
    /// only obscures misconfiguration (a wrong paste stays invisible until something downstream 403s).
    /// </summary>
    public async Task<AppSettingValueResponse> GetSettingValueAsync(
        string appId, string settingKey, CancellationToken cancellationToken = default)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        if (!app.Settings.TryGetValue(settingKey, out var setting))
        {
            throw new AppLifecycleException("app_setting_unknown", $"Runtime app '{appId}' has no setting '{settingKey}'.");
        }

        return new AppSettingValueResponse(setting.Key, setting.Value);
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
        // System apps (e.g. the Shell) are never stopped/snapshotted/restarted from here: silently
        // cycling the app that is serving this very call is worse than deferring. Their toggle just
        // flips the flag and takes effect on their next start — which the operator can trigger from
        // the Shell's lifecycle controls, available for system apps like for any other runtime app.
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
        var wasRunning = targetsSelected && manageLifecycle && changing && AppRuntimeStates.IsUp(app.RuntimeState);
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
                var restarted = await StartCoreAsync(appId, afterOwnStop: wasRunning, cancellationToken);
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
                _ = await StartCoreAsync(appId, afterOwnStop: true, CancellationToken.None);
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
        => WithAppLockAsync(appId, () => StartCoreAsync(appId, afterOwnStop: false, cancellationToken), cancellationToken);

    // `afterOwnStop` marks the start half of a stop->start pair this same operation performed (update
    // apply, runtime switch, dev-mode toggle, operator backup) — as opposed to a cold start, where the app
    // was already down when we were called. It only governs the port preflight below.
    private async Task<AppLifecycleResponse> StartCoreAsync(string appId, bool afterOwnStop, CancellationToken cancellationToken)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        // Captured BEFORE the stamp below, because the stamp destroys the evidence: an app whose runtime
        // is already up (a Core restart that kept its containers, a repeated start) legitimately holds
        // its own reserved ports, and the port preflight must keep exempting them.
        var wasUp = AppRuntimeStates.IsUp(app.RuntimeState);
        IAppRuntimeAdapter? adapter = null;
        RuntimeLifecycleContext? context = null;
        var runtimeStarted = false;
        try
        {
            // Stamp before the preamble, not just before adapter.StartAsync: everything below — the
            // port-release wait (up to 15s after this app's own stop), the source checkout, mount
            // preparation, capability provisioning, an image pull — is the slow part an operator is
            // staring at. The registry write choke point publishes app.changed, so every other client
            // sees the transition without any new transport.
            app = (await apps.UpdateAppAsync(appId, current => current with
            {
                RuntimeState = AppRuntimeStates.Starting,
            }, cancellationToken)).App;

            var load = await LoadSelectionWithStatusAsync(app, cancellationToken);
            var selection = load.Selection;
            // Adopt a live source folder edit before the gates below so they see the live contract
            // (e.g. a newly-required setting blocks start, R8; a new required mount slot is enforced).
            if (load.LiveReconciled)
            {
                app = await ReconcileLiveContractAsync(app, load, cancellationToken);
            }

            await EnsureRequiredSettingsConfiguredAsync(app, cancellationToken);
            // A reserved port that is still busy means two different things, and treating them alike was
            // the defect. On a cold start nothing of ours holds it, so it is a genuine conflict and the
            // structured, reassign-able error is exactly right. On the start half of a stop->start pair it
            // is almost always the app's *own* port still being torn down: docker frees a published host
            // port a beat after the container exits, and Docker Desktop's forwarder regularly outlives it
            // by longer than the 5s a cold start is willing to give. Waiting is still the right move — the
            // adapter would only hit its own bind failure otherwise — but *failing* on expiry was not: it
            // turned a slow teardown into "update failed: port already in use" and stranded the app
            // stopped, which is why the operator's Restart button then fixed it (by then the port was long
            // free, and RestartCoreAsync runs no preflight of its own anyway). So wait longer here, and on
            // expiry start regardless: the runtime's real bind is a better arbiter than our probe, and a
            // start that does fail reports the runtime's own error instead of a preflight guess.
            if (afterOwnStop)
            {
                var lingering = await PollLoopbackAssignmentsReleaseAsync(app, selfRestartPortReleaseTimeout, wasUp, cancellationToken);
                if (lingering.Count > 0)
                {
                    logger.LogWarning(
                        "App {AppId} still holds host port(s) {Ports} {Seconds}s after its own stop; starting anyway and letting the runtime decide.",
                        appId,
                        string.Join(", ", lingering.Select(assignment => assignment.HostPort)),
                        selfRestartPortReleaseTimeout.TotalSeconds);
                }
            }
            else
            {
                await WaitForLoopbackAssignmentsReleasedAsync(app, LoopbackReleaseTimeout, cancellationToken, wasUp);
            }
            app = await EnsureLocalCommandSourceReadyAsync(app, selection, cancellationToken);
            app = await EnsureIngressPublicOriginsAsync(app, selection, cancellationToken);
            // The process about to start reads the current HOSTY_PUBLIC_ORIGIN_* values, which is exactly
            // what a pending-restart flag was waiting for. Best-effort: this is bookkeeping, not a start
            // precondition.
            if (cloudflarePublications is not null)
            {
                try
                {
                    await cloudflarePublications.ClearPendingRestartAsync(app.Id, cancellationToken);
                }
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    logger.LogWarning(ex, "Could not clear the Cloudflare pending-restart flag for {AppId}.", app.Id);
                }
            }
            adapter = ResolveAdapter(selection.RuntimeProfile.Type);
            context = await CreateRuntimeContextAsync(app, selection, cancellationToken);
            context = EnsureMountsReadyForStart(context);
            // Core-owned provisioning for the platform capability slots this app provides (e.g. the
            // OTLP collector's config + sink dirs), run before the services launch. Keyed by the
            // manifest's `provides`, not the app id or install path, so a marketplace/direct install
            // is provisioned exactly like a bootstrap install. See PlatformCapabilities.
            await PlatformCapabilities.ProvisionAsync(this, app.Id, app.Provides, cancellationToken);
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
                // Persist the run-locks the adapter resolved (TOFU backfill);
                // a runtime with nothing to pin returns null, leaving any existing locks intact.
                ArtifactLocks = result.ArtifactLocks ?? current.ArtifactLocks,
                // A live source app records the last invalid-folder error (null clears it once the
                // operator's edit validates again); non-source apps always clear it (2b/R14).
                ManifestError = load.ManifestError,
            }, cancellationToken);

            await ReconcileIngressAsync(cancellationToken);
            return new AppLifecycleResponse(await BuildAppSummaryAsync(updated.App, cancellationToken), null, "started");
        }
        catch (OperationCanceledException)
        {
            // The caller went away (client disconnect, host shutdown) after the record was stamped
            // `starting`. Without this the stamp outlives the operation: the lock is released, no
            // reconciler observes a non-IsUp record, and the app sits `starting` until the next boot
            // sweep. Settle it on a token of our own — the request's is already cancelled — and stay
            // honest about what a half-run start left behind.
            await SettleTransitionalStateAsync(appId, CancellationToken.None);
            throw;
        }
        catch (Exception ex) when (IsRecordableLifecycleFailure(ex))
        {
            if (runtimeStarted && adapter is not null && context is not null)
            {
                await TryStopRuntimeAsync(adapter, context);
            }

            await RecordForegroundLifecycleFailureAsync(appId, "start", AppRuntimeStates.Stopped, ex.Message, cancellationToken);
            throw;
        }
    }

    public Task<AppLifecycleResponse> StopAsync(string appId, CancellationToken cancellationToken = default)
        => WithAppLockAsync(appId, () => StopCoreAsync(appId, cancellationToken), cancellationToken);

    private async Task<AppLifecycleResponse> StopCoreAsync(string appId, CancellationToken cancellationToken)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        try
        {
            // A docker stop can outlive its SIGTERM grace and a localCommand process tree can take a
            // while to wind down, so the record says `stopping` for the duration.
            app = (await apps.UpdateAppAsync(appId, current => current with
            {
                RuntimeState = AppRuntimeStates.Stopping,
            }, cancellationToken)).App;

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
        catch (OperationCanceledException)
        {
            await SettleTransitionalStateAsync(appId, CancellationToken.None);
            throw;
        }
        catch (Exception ex) when (IsRecordableLifecycleFailure(ex))
        {
            // Stop needed no failure path before the transitional states existed: a throw simply left
            // the record on its previous value. Now it would strand the record on `stopping` forever —
            // no reconciler observes a non-IsUp record, so nothing would ever correct it. `unknown` is
            // the honest terminal value: the stop failed, so whether anything is still running is
            // precisely what we do not know. The docker sweep raises it back to running if it finds a
            // live container, and the operator can retry either way.
            await RecordForegroundLifecycleFailureAsync(appId, "stop", AppRuntimeStates.Unknown, ex.Message, cancellationToken);
            throw;
        }
    }

    // Preview reassigning one host port: reports the current port/URL, whether that port is an operator pin,
    // the installed apps that depend on this app (whose injected local URL would go stale), whether each is
    // running, and a digest binding a later apply to this structural state. Read-only. An already-pinned
    // port is included so the operator can re-pin it or hand it back to automatic — a manifest/host-network
    // port stays fixed and is rejected here.
    public async Task<ReassignPortPlan> ReassignPortPlanAsync(string appId, string service, string portKey, CancellationToken cancellationToken = default)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        var assignment = RequireRemappableAssignment(app, service, portKey, allowOperatorPinned: true);
        var dependents = FindDependents(await apps.ListAppRecordsAsync(cancellationToken), appId);
        return new ReassignPortPlan(
            appId,
            service,
            portKey,
            assignment.HostPort,
            FindEndpointUrl(app, service, portKey),
            AppRuntimeStates.IsUp(app.RuntimeState),
            dependents,
            string.Equals(assignment.Source, AppPortSources.Operator, StringComparison.Ordinal),
            RuntimePortAllocator.MinManualPort,
            ComputeReassignDigest(app, assignment, dependents));
    }

    public Task<ReassignPortResult> ReassignPortAsync(string appId, ReassignPortRequest request, CancellationToken cancellationToken = default)
        => WithAppLockAsync(appId, () => ReassignPortCoreAsync(appId, request, cancellationToken), cancellationToken);

    private async Task<ReassignPortResult> ReassignPortCoreAsync(string appId, ReassignPortRequest request, CancellationToken cancellationToken)
    {
        if (portAllocator is null)
        {
            throw new AppLifecycleException("reassign_unavailable", "Port reassignment requires the allocation coordinator.");
        }

        request.Validate();
        var app = await RequireAppAsync(appId, cancellationToken);
        // Any explicitly-moded request may touch an already-pinned port: manual re-pins it, automatic hands
        // it back to Core. Gating this on IsManual alone made pinning a one-way door — the un-pin path the
        // allocator implements and the dialog offers was unreachable. A legacy request (no mode) still
        // cannot move a deliberate pin: that client has no UI to express the choice, so a blind re-roll
        // there would be the silent move this guard exists to prevent.
        var assignment = RequireRemappableAssignment(app, request.Service, request.PortKey, allowOperatorPinned: request.HasExplicitMode);
        var dependents = FindDependents(await apps.ListAppRecordsAsync(cancellationToken), appId);
        // Bind apply to the state the plan was computed against: a changed assignment or dependency graph
        // (e.g. a runtime switch moved the port, or a dependency was added/removed) fails rather than
        // acting on a stale plan. Dependents' running state is UX-only and deliberately not in the digest,
        // so a dependent starting/stopping does not invalidate an otherwise-valid reassignment.
        if (!string.Equals(ComputeReassignDigest(app, assignment, dependents), request.Digest, StringComparison.Ordinal))
        {
            throw new AppLifecycleException(
                "reassign_state_changed",
                "The app or its dependencies changed since the plan was computed. Re-open the plan and try again.");
        }

        var (updated, oldPort, newPort) = await portAllocator.ReassignAsync(
            app,
            request.Service,
            request.PortKey,
            apps.ListAppRecordsAsync,
            async (record, ct) => (await apps.UpsertAppAsync(record, ct)).App,
            request.DesiredPort,
            cancellationToken);

        // Reassignment never restarts anything as a side effect. The owning app, if running, still binds
        // the old port until restarted; running dependents still hold the old injected local URL.
        var restartRequired = new List<string>();
        if (AppRuntimeStates.IsUp(updated.RuntimeState))
        {
            restartRequired.Add(appId);
        }

        restartRequired.AddRange(dependents.Where(dependent => dependent.Running).Select(dependent => dependent.AppId));
        await ReconcileIngressAsync(cancellationToken);
        return new ReassignPortResult(
            appId,
            request.Service,
            request.PortKey,
            oldPort,
            newPort,
            FindEndpointUrl(updated, request.Service, request.PortKey),
            restartRequired);
    }

    private const int LoopbackReleasePollMs = 250;

    // How long a *cold* start waits for a reserved loopback port to become bindable before failing with
    // the structured conflict error — see WaitForLoopbackAssignmentsReleasedAsync.
    private static readonly TimeSpan LoopbackReleaseTimeout = TimeSpan.FromSeconds(5);

    // The same wait on the start half of a stop->start pair, where the port is almost certainly our own
    // still being torn down. Longer because it costs nothing to be patient here: the window expiring no
    // longer fails the operation, it just stops waiting (see the branch in StartCoreAsync). Docker Desktop
    // routinely keeps a published host port forwarded for several seconds after `docker stop` returns —
    // well past the 5s a cold start is willing to give it.
    private static readonly TimeSpan SelfRestartLoopbackReleaseTimeout = TimeSpan.FromSeconds(15);

    // Reserved loopback ports that are not currently bindable. Empty when the app is already running (a
    // restart or docker adoption legitimately holds its own ports, and this must never flag them as
    // stolen). Host-network ports bind a fixed container port outside the loopback pool, so they are not
    // probed; an unset/invalid reservation is skipped too (the adapter's start-time resolver falls back to
    // a fresh automatic allocation for it, see ResolveHostPort).
    // `ownsItsPorts` says the app is already holding its own reserved ports, so a busy port is its own
    // and not a conflict. It is an explicit ARGUMENT rather than a re-read of app.RuntimeState because
    // the start path stamps `starting` on the record before reaching here: deriving it again would drop
    // the exemption exactly when it matters most — a Core that restarted while the app's container kept
    // running (keep-apps light restart, docker adoption) would flag the app's own ports as stolen and
    // fail its own autostart with runtime_port_unavailable. The caller captures it before stamping.
    //
    // Deliberately NOT satisfied by IsBusy: an app mid-`starting` that was down before has bound nothing
    // yet — this preflight runs before the adapter starts — so exempting it would blind the cold-start
    // conflict check and turn the structured error back into a generic bind failure.
    private static IReadOnlyList<AppPortAssignment> FindUnavailableLoopbackAssignments(AppRecord app, bool ownsItsPorts)
    {
        if (ownsItsPorts)
        {
            return [];
        }

        return (app.PortAssignments ?? [])
            .Where(assignment =>
                string.Equals(assignment.BindScope, AppPortBindScopes.Loopback, StringComparison.Ordinal) &&
                assignment.HostPort is > 0 and <= 65535 &&
                !RuntimePortHelper.IsLoopbackTcpPortAvailable(assignment.HostPort))
            .OrderBy(assignment => assignment.Service, StringComparer.Ordinal)
            .ThenBy(assignment => assignment.PortKey, StringComparer.Ordinal)
            .ToArray();
    }

    private static AppLifecycleException PortsUnavailable(AppRecord app, IReadOnlyList<AppPortAssignment> conflicts)
    {
        var detail = string.Join(", ", conflicts.Select(assignment => $"{assignment.Service}.{assignment.PortKey} → {assignment.HostPort}"));
        return new AppLifecycleException(
            "runtime_port_unavailable",
            $"App '{app.Id}' cannot start: assigned host port(s) already in use: {detail}. " +
            "Free the conflicting port(s), or reassign an automatically-assigned one, then retry.");
    }

    // Point-in-time check: a stopped app's reserved loopback port taken by an unrelated process fails the
    // start with a structured runtime_port_unavailable naming the endpoints, instead of a generic adapter
    // bind error. No wait — used where an immediate verdict is wanted (and by the tests).
    internal static void PreflightLoopbackAssignments(AppRecord app)
    {
        var conflicts = FindUnavailableLoopbackAssignments(app, AppRuntimeStates.IsUp(app.RuntimeState));
        if (conflicts.Count > 0)
        {
            throw PortsUnavailable(app, conflicts);
        }
    }

    // Polls until every reserved loopback port is bindable, returning whatever is still held when the
    // window expires (empty on success). Deliberately returns rather than throws: what an expired window
    // *means* depends on whether we just stopped this app ourselves, and only the caller knows that — see
    // the two wrappers below. The common no-conflict case does a single probe and returns immediately.
    private static async Task<IReadOnlyList<AppPortAssignment>> PollLoopbackAssignmentsReleaseAsync(
        AppRecord app,
        TimeSpan timeout,
        bool ownsItsPorts,
        CancellationToken cancellationToken)
    {
        var conflicts = FindUnavailableLoopbackAssignments(app, ownsItsPorts);
        if (conflicts.Count == 0)
        {
            return conflicts;
        }

        // Track the deadline rather than counting fixed-length polls: a poll count truncates a timeout
        // that is not a multiple of the interval, and would sleep a whole interval even for a zero one.
        var poll = TimeSpan.FromMilliseconds(LoopbackReleasePollMs);
        var start = System.Diagnostics.Stopwatch.GetTimestamp();
        for (var remaining = timeout; remaining > TimeSpan.Zero; remaining = timeout - System.Diagnostics.Stopwatch.GetElapsedTime(start))
        {
            await Task.Delay(remaining < poll ? remaining : poll, cancellationToken);
            conflicts = FindUnavailableLoopbackAssignments(app, ownsItsPorts);
            if (conflicts.Count == 0)
            {
                return conflicts;
            }
        }

        return conflicts;
    }

    // Strict wait, for a *cold* start (install, operator Start, autostart): nothing of ours was just
    // stopped, so a reserved port still held after the window is a genuine conflict — an unrelated process
    // took it. Fail with the structured, reassign-able error naming the endpoints instead of letting the
    // adapter hit a generic bind failure.
    internal static async Task WaitForLoopbackAssignmentsReleasedAsync(
        AppRecord app,
        TimeSpan timeout,
        CancellationToken cancellationToken,
        bool ownsItsPorts = false)
    {
        var conflicts = await PollLoopbackAssignmentsReleaseAsync(app, timeout, ownsItsPorts, cancellationToken);
        if (conflicts.Count > 0)
        {
            throw PortsUnavailable(app, conflicts);
        }
    }

    // `allowOperatorPinned` admits a port the operator already pinned. Without it a manual pin would be a
    // one-way door: the assignment stops being Automatic the moment it is pinned, so every later edit — and
    // even loading the plan to un-pin it — would be refused. Manifest and host-network ports stay fixed in
    // both modes; only an *automatic move* of a deliberate choice remains forbidden.
    private static AppPortAssignment RequireRemappableAssignment(AppRecord app, string service, string portKey, bool allowOperatorPinned = false)
    {
        var assignment = (app.PortAssignments ?? []).FirstOrDefault(assignment =>
            string.Equals(assignment.Service, service, StringComparison.Ordinal) &&
            string.Equals(assignment.PortKey, portKey, StringComparison.Ordinal))
            ?? throw new AppLifecycleException(
                "reassign_not_found",
                $"App '{app.Id}' has no port assignment for service '{service}' key '{portKey}'.");
        if (allowOperatorPinned && string.Equals(assignment.Source, AppPortSources.Operator, StringComparison.Ordinal))
        {
            return assignment;
        }

        if (!assignment.Remappable || !string.Equals(assignment.Source, AppPortSources.Automatic, StringComparison.Ordinal))
        {
            throw new AppLifecycleException(
                "reassign_not_remappable",
                $"The port for service '{service}' key '{portKey}' is {assignment.Source}-assigned and cannot be automatically reassigned.");
        }

        return assignment;
    }

    private static IReadOnlyList<ReassignDependentImpact> FindDependents(IReadOnlyList<AppRecord> installed, string appId)
        => installed
            .Where(candidate => !string.Equals(candidate.Id, appId, StringComparison.Ordinal) &&
                (candidate.Dependencies ?? []).Any(dependency => string.Equals(dependency.AppId, appId, StringComparison.Ordinal)))
            .OrderBy(candidate => candidate.Id, StringComparer.Ordinal)
            .Select(candidate => new ReassignDependentImpact(
                candidate.Id,
                AppRuntimeStates.IsUp(candidate.RuntimeState)))
            .ToArray();

    private static string? FindEndpointUrl(AppRecord app, string service, string portKey)
        => (app.Endpoints ?? []).FirstOrDefault(endpoint =>
            string.Equals(endpoint.Service, service, StringComparison.Ordinal) &&
            string.Equals(endpoint.Port, portKey, StringComparison.Ordinal))?.Url;

    // Structural digest (app id, service, port key, current port, sorted dependent ids). Dependents'
    // running state is intentionally excluded — it is reported for UX but must not invalidate an apply.
    private static string ComputeReassignDigest(AppRecord app, AppPortAssignment assignment, IReadOnlyList<ReassignDependentImpact> dependents)
    {
        var seed = string.Join(
            "\n",
            app.Id,
            assignment.Service,
            assignment.PortKey,
            assignment.HostPort.ToString(System.Globalization.CultureInfo.InvariantCulture),
            string.Join(",", dependents.Select(dependent => dependent.AppId).OrderBy(id => id, StringComparer.Ordinal)));
        return Convert.ToHexString(SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(seed))).ToLowerInvariant();
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
            context = EnsureMountsReadyForStart(context);
            // A restart reports its two halves instead of a single `restarting`: both are IsBusy, so
            // clients behave identically either way, and the operator gets to see which half is slow.
            _ = await apps.UpdateAppAsync(appId, current => current with
            {
                RuntimeState = AppRuntimeStates.Stopping,
            }, cancellationToken);
            _ = await stopAdapter.StopAsync(stopContext, cancellationToken);
            _ = await apps.UpdateAppAsync(appId, current => current with
            {
                RuntimeState = AppRuntimeStates.Starting,
            }, cancellationToken);
            // Re-run capability provisioning on restart too, so a config-template change ships forward
            // and the app comes back with fresh Core-owned files (see PlatformCapabilities). Ordered
            // after the stop so it never races the old container still holding the provisioned files
            // (config, OTLP sink files, SQLite store), and before the new one starts.
            await PlatformCapabilities.ProvisionAsync(this, app.Id, app.Provides, cancellationToken);
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
        catch (OperationCanceledException)
        {
            await SettleTransitionalStateAsync(appId, CancellationToken.None);
            throw;
        }
        catch (Exception ex) when (IsRecordableLifecycleFailure(ex))
        {
            if (runtimeStarted && adapter is not null && context is not null)
            {
                await TryStopRuntimeAsync(adapter, context);
            }

            await RecordForegroundLifecycleFailureAsync(appId, "restart", AppRuntimeStates.Stopped, ex.Message, cancellationToken);
            throw;
        }
    }

    // Replace a transitional state left behind by an abandoned verb with an honest terminal one. Used
    // on cancellation, where — unlike a failure — we have no error to record and no idea how far the
    // runtime got: `unknown` says exactly that, and the docker sweep raises it back to running if it
    // finds a live container. Runs on a caller-supplied token because the request's is already
    // cancelled. A record that is no longer transitional (the verb committed before cancellation
    // landed) is left untouched. Best-effort: nothing useful remains to do if this write also fails.
    private async Task SettleTransitionalStateAsync(string appId, CancellationToken cancellationToken)
    {
        try
        {
            await apps.UpdateAppAsync(
                appId,
                current => AppRuntimeStates.IsBusy(current.RuntimeState)
                    ? current with { RuntimeState = AppRuntimeStates.Unknown }
                    : current,
                cancellationToken);
        }
        catch (Exception ex) when (ex is InvalidOperationException or IOException or UnauthorizedAccessException or JsonException)
        {
            logger.LogWarning(ex, "Could not settle the transitional runtime state for app {AppId} after cancellation.", appId);
        }
    }

    public async Task<AppUpdatePlan> CreateUpdatePlanAsync(string appId, AppUpdatePlanRequest request, CancellationToken cancellationToken = default)
        => (await CreateUpdatePlanCoreAsync(appId, request, cancellationToken)).Plan;

    // Builds, classifies, and caches the reviewed-update plan; returns the cache entry so in-process
    // callers (the update-status projection) can reach the structured artifact probes that ride along
    // with the wire-shaped plan.
    private async Task<CachedUpdatePlan> CreateUpdatePlanCoreAsync(string appId, AppUpdatePlanRequest request, CancellationToken cancellationToken)
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
        var artifactProbeTask = ProbeServiceArtifactsAsync(app, selection, cancellationToken);
        // The source-artifact counterpart of the registry probe: a source app's "artifact" is the
        // commit its manifest ref points at, so a moved branch tip must show up in the reviewed plan
        // (and fold into its digest) the same way image digest movement does.
        //
        // Started before the registry probe is awaited: the two hit different remotes (a registry and
        // a git host) and neither reads the other's result, so running them back to back only added
        // one round-trip to every source app's check. Appending stays ordered — artifact entries, then
        // the source entry — because the change list feeds the plan digest the operator confirms.
        var sourceProbeTask = ProbeSourceCommitAsync(app, selection, cancellationToken);
        // WhenAll rather than awaiting each in turn: on cancellation the first await would abandon the
        // other probe's exception unobserved.
        await Task.WhenAll(artifactProbeTask, sourceProbeTask);
        var artifactProbes = await artifactProbeTask;
        var (resolvedSourceCommit, sourceChange) = await sourceProbeTask;
        changes.AddRange(BuildArtifactDigestChanges(artifactProbes));
        if (sourceChange is not null)
        {
            changes.Add(sourceChange);
        }

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
        var plan = new AppUpdatePlan(
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
            SourceConfigured: sourceConfigured,
            RequiresReview: PlanRequiresReview(changes));

        // Retain the fully-resolved plan so apply can use exactly what the operator confirmed instead of
        // rebuilding it. The rebuild was never reproducible across the plan->apply gap: it re-resolved the
        // feed (and apply passed a resolved manifestPath, so a feed app took the non-feed branch and lost
        // the feed seed fields, mismatching every time) and re-hit the registry (a blip flipped an
        // artifact digest to "unknown", mismatching the rest). currentSelection.ManifestDigest rides along
        // for the base-state guard in apply. Overwrites any prior pending plan for this app.
        var cached = new CachedUpdatePlan(plan, selection, currentSelection.ManifestDigest, artifactProbes, resolvedSourceCommit, clock.UtcNow);
        reviewedUpdatePlans[appId] = cached;
        // Every successful plan build — sweep, dialog open, status probe — refreshes the app's
        // availability projection, so the apps-list verdict and the plan cache never disagree.
        SetUpdateAvailability(appId, new AppUpdateAvailability(
            UpdateAvailable: PlanIndicatesUpdateAvailable(changes),
            RequiresReview: plan.RequiresReview,
            PlanDigest: plan.PlanDigest,
            CheckedAt: clock.UtcNow,
            Error: null));
        return cached;
    }

    public Task<AppLifecycleResponse> ApplyUpdateAsync(string appId, AppUpdateApplyRequest request, CancellationToken cancellationToken = default)
        => WithAppLockAsync(appId, () => ApplyUpdateCoreAsync(appId, request, cancellationToken), cancellationToken);

    // Enqueue-and-return apply (plan-first updates phase 3), the browser surface's path: validate
    // fast and locally so a stale click still gets its error in the response, persist the
    // `"updating"` marker so every client renders progress from the record, then run the real apply
    // detached on the application lifetime token — a page reload or Shell self-update must never
    // abort a half-done apply (the request-scoped token did exactly that). The CLI control plane
    // keeps the synchronous ApplyUpdateAsync. Completion flips the record (existing apply path),
    // publishes a notification, and re-plans the app so its row settles without waiting for the
    // next sweep. See docs/planning/plan-first-app-updates.md.
    public async Task<AppLifecycleResponse> EnqueueUpdateAsync(string appId, AppUpdateApplyRequest request, CancellationToken cancellationToken = default)
    {
        // Advisory pre-checks — the background run re-validates both under the app lock. Cheap and
        // local (no network): the confirmed plan must exist and match, and the base must not have
        // moved since it was reviewed.
        var confirmed = ResolveConfirmedUpdatePlan(appId, request.PlanDigest);
        var app = await RequireAppAsync(appId, cancellationToken);
        var currentSelection = await LoadSelectionForAppAsync(app, cancellationToken);
        if (!string.Equals(app.Version, confirmed.Plan.CurrentVersion, StringComparison.Ordinal) ||
            !string.Equals(app.SelectedRuntime, confirmed.Plan.CurrentRuntime, StringComparison.Ordinal) ||
            !string.Equals(currentSelection.ManifestDigest, confirmed.CurrentManifestDigest, StringComparison.Ordinal))
        {
            EvictReviewedPlan(appId, confirmed);
            throw new AppLifecycleException(
                "update_plan_stale",
                "The app changed since this update was reviewed. Reopen the update to review the current plan, then apply.");
        }

        // Atomic single-flight per app: the in-memory slot is the authority (the persisted
        // `"updating"` marker is display state — it can be stale across a restart until the boot
        // sweep flips it, and a retry then must not be blocked by it).
        if (!runningBackgroundUpdates.TryAdd(appId, Task.CompletedTask))
        {
            throw new AppLifecycleException(
                "update_in_progress",
                "An update is already being applied to this app.");
        }

        AppStateDocument document;
        try
        {
            document = await apps.UpdateAppAsync(appId, current => current with
            {
                OperationStatus = "updating",
                LastOperation = "update",
                LastError = null,
            }, cancellationToken);
        }
        catch
        {
            runningBackgroundUpdates.TryRemove(appId, out _);
            throw;
        }

        var run = ExecuteBackgroundUpdateAsync(appId, request, hostLifetime?.ApplicationStopping ?? CancellationToken.None);
        runningBackgroundUpdates[appId] = run;
        _ = RemoveWhenCompleteAsync(appId, run);

        return new AppLifecycleResponse(await BuildAppSummaryAsync(document.App, cancellationToken), null, "updating");
    }

    // In-flight background update applies, keyed by app id. TryAdd in EnqueueUpdateAsync is the
    // atomic `update_in_progress` guard; the stored task lets tests await completion.
    private readonly ConcurrentDictionary<string, Task> runningBackgroundUpdates = new(StringComparer.Ordinal);

    // Test seam: the in-flight background apply for this app, or null when none is running.
    internal Task? TryGetRunningBackgroundUpdate(string appId)
        => runningBackgroundUpdates.GetValueOrDefault(appId);

    private async Task RemoveWhenCompleteAsync(string appId, Task run)
    {
        try
        {
            await run;
        }
        finally
        {
            // Compare-and-remove: only clear the slot while it still holds this run, so a follow-up
            // enqueue that raced in is never evicted.
            runningBackgroundUpdates.TryRemove(new KeyValuePair<string, Task>(appId, run));
        }
    }

    // The detached apply body. Exception-total: every outcome lands on the record, because there is
    // no request left to surface it to. Deliberately silent in the notification inbox — an update is
    // always something the operator just asked for, and its outcome is already on the app row.
    private async Task ExecuteBackgroundUpdateAsync(string appId, AppUpdateApplyRequest request, CancellationToken cancellationToken)
    {
        try
        {
            await ApplyUpdateAsync(appId, request, cancellationToken);
            await RebuildPlanAfterApplyAsync(appId, cancellationToken);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            // Core is shutting down mid-apply. The record stays "updating" and the boot sweep flips
            // it to failed/interrupted on the next start (RecoverInterruptedUpdatesAsync).
            logger.LogWarning("Background update for app {AppId} was cancelled by shutdown; the boot sweep will mark it interrupted.", appId);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Background update for app {AppId} failed.", appId);
            await RecordBackgroundLifecycleFailureAsync(appId, "update", ex.Message, CancellationToken.None);
        }
    }

    // Post-apply single-app re-plan: re-establishes the availability verdict against the new base
    // (normally "up to date") so the row settles immediately instead of waiting for the next sweep.
    // Best-effort — the apply already succeeded; a dark feed here just leaves the verdict cleared.
    private async Task RebuildPlanAfterApplyAsync(string appId, CancellationToken cancellationToken)
    {
        try
        {
            _ = await CreateUpdatePlanAsync(appId, new AppUpdatePlanRequest(), cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogDebug(ex, "Post-apply re-plan failed for app {AppId}; the verdict stays cleared until the next check.", appId);
        }
    }

    // Boot sweep for transitional runtime states. A record left on `starting`/`stopping` means the
    // previous Core process died mid-verb: the settling write never happened, and because every
    // reconciler and the supervisor only observe IsUp records, nothing downstream would ever correct
    // it — the app would sit "starting" forever and fall out of supervision entirely. `unknown` is the
    // honest replacement (we genuinely do not know what the dead process left behind); the docker sweep
    // raises it to running when it finds a live container, autostart starts it when it should be up,
    // and a localCommand app the operator starts by hand settles it. Must run BEFORE autostart
    // reconciliation, which is why its caller sequences it there. Returns the number recovered.
    public async Task<int> RecoverStrandedLifecycleStatesAsync(CancellationToken cancellationToken = default)
    {
        var recovered = 0;
        foreach (var app in await apps.ListAppRecordsAsync(cancellationToken))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!AppRuntimeStates.IsBusy(app.RuntimeState))
            {
                continue;
            }

            // Re-check under the record lock, and take the per-app operation lock non-blockingly first:
            // a verb that is legitimately in flight right now (Core is already serving while this sweep
            // runs) holds it, and stamping over that app's `starting` would be exactly the corruption
            // this sweep exists to remove. Skipping is safe — that verb writes its own terminal state.
            var mutex = operationLocks.GetOrAdd(app.Id, _ => new SemaphoreSlim(1, 1));
            if (!await mutex.WaitAsync(0, cancellationToken))
            {
                continue;
            }

            try
            {
                var flipped = false;
                await apps.UpdateAppAsync(
                    app.Id,
                    current =>
                    {
                        if (!AppRuntimeStates.IsBusy(current.RuntimeState))
                        {
                            return current;
                        }

                        flipped = true;
                        return current with { RuntimeState = AppRuntimeStates.Unknown };
                    },
                    cancellationToken);
                if (flipped)
                {
                    logger.LogWarning(
                        "App {AppId} was mid-{State} when Core stopped; its runtime state was reset to unknown.",
                        app.Id,
                        app.RuntimeState);
                    recovered++;
                }
            }
            finally
            {
                mutex.Release();
            }
        }

        return recovered;
    }

    // Boot sweep (plan-first updates phase 3): a record still marked "updating" at startup means a
    // background apply was cut down mid-flight by a Core stop or crash — the completion write never
    // happened (a successful apply flips the record to "updated" atomically). Flip it to failed with
    // an actionable error so the operator re-reviews on the app row. Returns the number of records
    // recovered.
    public async Task<int> RecoverInterruptedUpdatesAsync(CancellationToken cancellationToken = default)
    {
        var recovered = 0;
        var records = await apps.ListAppRecordsAsync(cancellationToken);
        foreach (var app in records.Where(app => string.Equals(app.OperationStatus, "updating", StringComparison.Ordinal)))
        {
            cancellationToken.ThrowIfCancellationRequested();
            const string message = "The update was interrupted by a Core restart. Review the update and apply it again.";
            // The mapper runs under the record lock. A record is flipped only while it is still
            // "updating" AND no background apply is in flight for it: a fresh enqueue registers its
            // single-flight slot before persisting the marker (also under the record lock), so a
            // legitimate in-flight update racing this sweep always has its slot visible here and is
            // left alone. `flipped` gates the count, so a record that moved on between the list
            // snapshot and this write is not reported as interrupted.
            var flipped = false;
            await apps.UpdateAppAsync(
                app.Id,
                current =>
                {
                    if (!string.Equals(current.OperationStatus, "updating", StringComparison.Ordinal) ||
                        runningBackgroundUpdates.ContainsKey(app.Id))
                    {
                        return current;
                    }

                    flipped = true;
                    return current with { OperationStatus = "failed", LastOperation = "update", LastError = message };
                },
                cancellationToken);
            if (!flipped)
            {
                continue;
            }

            logger.LogWarning("App {AppId} was mid-update when Core stopped; marked failed for re-review.", app.Id);
            recovered++;
        }

        return recovered;
    }

    // Reviewed update plans awaiting apply, keyed by app id (one pending plan per app). See the write in
    // CreateUpdatePlanAsync for why apply consumes this rather than rebuilding.
    private readonly ConcurrentDictionary<string, CachedUpdatePlan> reviewedUpdatePlans = new(StringComparer.Ordinal);

    // Last-known update-availability verdict per app (plan-first updates phase 2), projected into the
    // app summaries so clients render Update/Review affordances straight from the list. Written on
    // every successful plan build, by the sweep on per-app failures, and reset by a successful apply.
    // In-memory by design: after a Core restart the post-boot sweep repopulates it (see the resolved
    // questions in docs/planning/plan-first-app-updates.md).
    private readonly ConcurrentDictionary<string, AppUpdateAvailability> updateAvailability = new(StringComparer.Ordinal);

    // The projection's own choke point. Verdicts never reach AppRecord, so the store's app.changed
    // cannot cover them — every write goes through these two helpers instead, which keeps sweep
    // results, dialog-open re-plans, refresh probes and the post-apply reset publishing uniformly.
    private void SetUpdateAvailability(string appId, AppUpdateAvailability verdict)
    {
        updateAvailability[appId] = verdict;
        events?.PublishAppEvent(CoreEventHub.AppUpdateCheckChanged, appId);
    }

    private void ClearUpdateAvailability(string appId)
    {
        if (updateAvailability.TryRemove(appId, out _))
        {
            events?.PublishAppEvent(CoreEventHub.AppUpdateCheckChanged, appId);
        }
    }

    // Sweep hook: a plan build failed for this app, so its row shows "check failed" instead of a
    // stale verdict. The pending plan slot is deliberately left alone — an earlier plan may still be
    // fresh and applicable even when the latest re-check could not resolve its inputs.
    internal void RecordUpdateCheckFailure(string appId, string message)
        => SetUpdateAvailability(appId, new AppUpdateAvailability(
            UpdateAvailable: false,
            RequiresReview: false,
            PlanDigest: null,
            CheckedAt: clock.UtcNow,
            Error: message));

    // Sweep hook: drop projections for apps that no longer exist (or stopped being sweep targets),
    // so a removed app's verdict does not linger until Core restarts.
    internal void PruneUpdateAvailability(IReadOnlySet<string> keepAppIds)
    {
        // ConcurrentDictionary.Keys is already a snapshot, so removing while iterating it is safe.
        foreach (var appId in updateAvailability.Keys.Where(key => !keepAppIds.Contains(key)))
        {
            ClearUpdateAvailability(appId);
        }
    }

    // A pending plan is discarded after this long. The operator applies from an open dialog, so a stale
    // entry means they wandered off and should re-review against current inputs rather than apply a plan
    // built against possibly-moved ones. Generous enough for a distracted operator; short of "yesterday".
    private static readonly TimeSpan ReviewedUpdatePlanTtl = TimeSpan.FromHours(1);

    private sealed record CachedUpdatePlan(
        AppUpdatePlan Plan,
        RuntimeAppManifestSelection Selection,
        string CurrentManifestDigest,
        // Structured per-service registry probe results from the plan build, so the update-status
        // projection can report per-service digests without re-hitting the registry.
        IReadOnlyList<AppServiceArtifactProbe> ArtifactProbes,
        // The commit the target manifest's source ref resolved to at plan time, for a selection that
        // runs from the managed checkout (see UpdateMovesSourcePin). Apply stamps exactly this commit
        // into SourceState — the operator reviewed this commit, not whatever the branch tip is at
        // apply time. Null when the selection has no managed source or the probe could not resolve
        // one (apply then resolves fresh itself).
        string? ResolvedSourceCommit,
        DateTimeOffset CreatedAt);

    // Non-throwing read of the pending reviewed plan: returns it while fresh, evicts and returns null
    // once expired. The read paths (pending-plan GET, update-status projection) share this;
    // ResolveConfirmedUpdatePlan keeps its own throwing variant with apply-grade error messages.
    private CachedUpdatePlan? TryGetFreshReviewedPlan(string appId)
    {
        if (!reviewedUpdatePlans.TryGetValue(appId, out var cached))
        {
            return null;
        }

        if (clock.UtcNow - cached.CreatedAt > ReviewedUpdatePlanTtl)
        {
            EvictReviewedPlan(appId, cached);
            return null;
        }

        return cached;
    }

    // Read-only view of the pending reviewed plan built by an earlier update check or dialog open. A
    // null plan means nothing is pending (never built, expired, or consumed by an apply) — clients
    // fall back to requesting a fresh plan. See docs/planning/plan-first-app-updates.md.
    public async Task<AppPendingUpdatePlanResponse> GetPendingUpdatePlanAsync(string appId, CancellationToken cancellationToken = default)
    {
        _ = await RequireAppAsync(appId, cancellationToken);
        return new AppPendingUpdatePlanResponse(TryGetFreshReviewedPlan(appId)?.Plan);
    }

    // Compare-and-remove: drop the pending plan only while it is still the entry we read. Apply runs under
    // the app lock but CreateUpdatePlanAsync does not (it resolves feeds and probes the registry, and
    // holding the lock across that would stall start/stop for the duration), so a second operator can
    // review a fresh plan mid-apply. An unconditional TryRemove would evict *their* valid plan and fail
    // their apply with a phantom update_plan_expired. Equality is effectively per-instance here: the
    // records carry collection members, which record equality compares by reference, so two separately
    // built plans never match — and in the degenerate case where they would, both describe the same plan
    // against the same base, so evicting either is the same outcome.
    private void EvictReviewedPlan(string appId, CachedUpdatePlan plan)
        => reviewedUpdatePlans.TryRemove(new KeyValuePair<string, CachedUpdatePlan>(appId, plan));

    // Returns the pending plan the operator confirmed, or throws an actionable "reopen the update" error.
    // Never rebuilds: the point is to apply exactly what was reviewed.
    private CachedUpdatePlan ResolveConfirmedUpdatePlan(string appId, string planDigest)
    {
        if (!reviewedUpdatePlans.TryGetValue(appId, out var cached))
        {
            throw new AppLifecycleException(
                "update_plan_expired",
                "No reviewed update plan is pending for this app. Reopen the update to review it, then apply.");
        }

        if (clock.UtcNow - cached.CreatedAt > ReviewedUpdatePlanTtl)
        {
            EvictReviewedPlan(appId, cached);
            throw new AppLifecycleException(
                "update_plan_expired",
                "The reviewed update plan has expired. Reopen the update to review the current plan, then apply.");
        }

        if (!string.Equals(cached.Plan.PlanDigest, planDigest, StringComparison.Ordinal))
        {
            throw new AppLifecycleException(
                "update_plan_digest_mismatch",
                "Update plan digest does not match the current update plan. Reopen the update to review it, then apply.");
        }

        return cached;
    }

    private async Task<AppLifecycleResponse> ApplyUpdateCoreAsync(string appId, AppUpdateApplyRequest request, CancellationToken cancellationToken)
    {
        // Apply the plan the operator confirmed, verbatim — request.ManifestPath / SelectedRuntime are
        // ignored because the resolved source (feed ref or source override) is already captured in the
        // cached plan. Rebuilding here was the whole defect: it re-resolved the feed and re-hit the
        // registry, so the recomputed digest routinely differed from the one just confirmed.
        var confirmed = ResolveConfirmedUpdatePlan(appId, request.PlanDigest);
        var plan = confirmed.Plan;

        var app = await RequireAppAsync(appId, cancellationToken);
        var currentSelection = await LoadSelectionForAppAsync(app, cancellationToken);

        // Base-state guard, under the app lock: the plan was reviewed against a specific installed
        // version/runtime/manifest. If the app moved since (a concurrent update landed before this apply
        // took the lock, or the plan sat open across one), applying the stale plan could move it somewhere
        // the operator never saw — including a silent downgrade. Cheap and local; no network, no rebuild.
        if (!string.Equals(app.Version, plan.CurrentVersion, StringComparison.Ordinal) ||
            !string.Equals(app.SelectedRuntime, plan.CurrentRuntime, StringComparison.Ordinal) ||
            !string.Equals(currentSelection.ManifestDigest, confirmed.CurrentManifestDigest, StringComparison.Ordinal))
        {
            EvictReviewedPlan(appId, confirmed);
            throw new AppLifecycleException(
                "update_plan_stale",
                "The app changed since this update was reviewed. Reopen the update to review the current plan, then apply.");
        }

        var selection = confirmed.Selection;

        // The ghost-version fix (digest pinning phase 2b): a reviewed update of a source app must move
        // the source pin along with the manifest — BuildSourceState keeps the existing Commit whenever
        // the manifest ref didn't change (a branch staying "main"), so without this the next start
        // force-checkouts the old pin and the app visibly updates while running the old code. Prefer
        // the commit the plan resolved (the operator reviewed exactly that commit; the branch may have
        // moved since), and resolve fresh only when the plan probe could not. Resolved before any
        // teardown so an unreachable repository fails the update while the app is still untouched.
        string? sourcePinCommit = null;
        if (UpdateMovesSourcePin(app, selection))
        {
            sourcePinCommit = confirmed.ResolvedSourceCommit
                ?? await sources.ResolveManifestCommitAsync(selection.Manifest.Source!, cancellationToken);
        }

        var adapter = ResolveAdapter(currentSelection.RuntimeProfile.Type);
        var wasRunning = AppRuntimeStates.IsUp(app.RuntimeState);
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
        if (sourcePinCommit is not null && next.SourceState is not null)
        {
            next = next with
            {
                SourceState = next.SourceState with { Commit = sourcePinCommit, UpdatedAt = clock.UtcNow },
            };
        }

        // The plan surfaced artifact:{svc}:{locked}->{candidate}; the operator confirmed exactly those
        // candidates. Persist them as the run-locks so the next start pulls the reviewed digest — a tag
        // re-pushed between apply and start no longer swaps unreviewed bytes in (C-CR1 Fix B). Services
        // whose candidate was unresolvable at plan time carry no lock and TOFU-backfill at start.
        var reviewedLocks = BuildReviewedArtifactLocks(selection, confirmed.ArtifactProbes);
        if (reviewedLocks is not null)
        {
            next = next with { ArtifactLocks = reviewedLocks };
        }

        var document = await apps.UpsertAppAsync(next, cancellationToken);
        // An endpoint the new manifest dropped (or made private) can never serve its hostname again, so the
        // route and DNS record go with it. Best-effort, and only for endpoints that are actually gone.
        await CleanUpOrphanedPublicationsAsync(appId, next, cancellationToken);
        // Consumed: the app is now at the target, so the pending plan (built against the old base) would
        // only fail the base-state guard from here on. Drop it so a fresh review starts clean.
        EvictReviewedPlan(appId, confirmed);
        // The app just moved to the reviewed target: clear the availability verdict so the row's
        // update affordance disappears immediately instead of pointing at the consumed plan. The
        // next check (row refresh or sweep) re-establishes it against current upstream.
        ClearUpdateAvailability(appId);
        if (wasRunning)
        {
            var restarted = await StartCoreAsync(appId, afterOwnStop: wasRunning, cancellationToken);
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
        var wasRunning = AppRuntimeStates.IsUp(app.RuntimeState);
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
                var restarted = await StartCoreAsync(appId, afterOwnStop: wasRunning, cancellationToken);
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

    // What removing this app would affect. Facts only — this never refuses a removal and never gates
    // one; it exists so the confirmation surface can say what breaks instead of carrying hand-written
    // copy per app. Both sources are structural, so a third-party app that takes over a first-party
    // app's role is described exactly like the app it replaced:
    //   * dependents — apps whose manifest declares a cross-app dependency on this one. A running
    //     dependent keeps its wired HOSTY_DEPENDENCY_* values until it restarts, so the loss lands at
    //     its next start, which is what the surface tells the operator.
    //   * capability consumers — for each platform slot this app provides, the apps that consume it.
    // An app nothing declares against returns an empty impact and gets the ordinary confirmation.
    public async Task<AppRemovalImpact> GetRemovalImpactAsync(string appId, CancellationToken cancellationToken = default)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        var installed = (await apps.ListAppRecordsAsync(cancellationToken))
            .Where(candidate => !string.Equals(candidate.Id, appId, StringComparison.Ordinal))
            .OrderBy(candidate => candidate.Id, StringComparer.Ordinal)
            .ToArray();

        var dependents = installed
            .Select(candidate => (Record: candidate, Declared: (candidate.Dependencies ?? [])
                .Where(dependency => string.Equals(dependency.AppId, appId, StringComparison.Ordinal))
                .ToArray()))
            .Where(candidate => candidate.Declared.Length > 0)
            .Select(candidate => new AppRemovalDependent(
                candidate.Record.Id,
                candidate.Record.DisplayName,
                candidate.Record.RuntimeState,
                candidate.Declared.Any(dependency => dependency.Required),
                candidate.Declared
                    .SelectMany(dependency => dependency.Endpoints ?? [])
                    .Select(endpoint => endpoint.Alias)
                    .Distinct(StringComparer.Ordinal)
                    .OrderBy(alias => alias, StringComparer.Ordinal)
                    .ToArray()))
            .ToArray();

        var capabilities = new List<AppRemovalCapabilityImpact>();
        foreach (var slot in app.Provides ?? [])
        {
            var consumers = await FindCapabilityConsumersAsync(slot, installed, cancellationToken);
            if (consumers.Count > 0)
            {
                capabilities.Add(new AppRemovalCapabilityImpact(slot, consumers));
            }
        }

        // What removing the app takes down publicly. Listed rather than counted: a hostname the operator
        // shared is not something to discover afterwards from a 404.
        var published = cloudflarePublications is null
            ? []
            : (await cloudflarePublications.ListForAppAsync(app.Id, cancellationToken)).Publications
                .Select(publication => new AppRemovalPublicOrigin(
                    publication.EndpointKey,
                    publication.Hostname,
                    publication.OwnershipState))
                .OrderBy(entry => entry.Hostname, StringComparer.Ordinal)
                .ToArray();

        return new AppRemovalImpact(app.Id, app.DisplayName, app.System, dependents, capabilities, published);
    }

    // Consumers are resolved per capability slot, never per app id. Only slots whose consumption is
    // observable from a manifest can be answered; an unknown slot yields no consumers rather than a
    // guess.
    private async Task<IReadOnlyList<AppRemovalConsumer>> FindCapabilityConsumersAsync(
        string slot,
        IReadOnlyList<AppRecord> installed,
        CancellationToken cancellationToken)
    {
        if (!string.Equals(slot, PlatformCapabilities.OtlpCollector, StringComparison.Ordinal))
        {
            return [];
        }

        var consumers = new List<AppRemovalConsumer>();
        foreach (var candidate in installed)
        {
            if (string.IsNullOrWhiteSpace(candidate.ManifestPath))
            {
                continue;
            }

            try
            {
                // The reviewed internal copy, not the live-source reconcile: this is a read-only
                // preview and must not depend on a developer's folder being mid-edit.
                var selection = await manifests.LoadAsync(candidate.ManifestPath, candidate.SelectedRuntime, cancellationToken);
                if (RuntimeTelemetrySettings.FromManifest(selection.Manifest.Telemetry).Enabled)
                {
                    consumers.Add(new AppRemovalConsumer(candidate.Id, candidate.DisplayName, candidate.RuntimeState));
                }
            }
            catch (Exception ex) when (ex is AppLifecycleException or AppManifestException or IOException or JsonException)
            {
                // An unreadable manifest costs one row in an advisory list; it must not fail the
                // preview the operator is waiting on.
                logger.LogDebug(ex, "Could not read the manifest of {AppId} while computing removal impact.", candidate.Id);
            }
        }

        return consumers;
    }

    // Every app removes the same way on every surface. A system app carries no lifecycle immunity —
    // "system" governs who may see and reach it, not whether it can be uninstalled — so the browser
    // and the control plane behave identically here. Consequences are surfaced ahead of the call by
    // GetRemovalImpactAsync, never enforced as a refusal.
    public Task<AppLifecycleResponse> RemoveAsync(string appId, AppRemoveRequest request, CancellationToken cancellationToken = default)
        => WithAppLockAsync(appId, () => RemoveCoreAsync(appId, request, cancellationToken), cancellationToken);

    private async Task<AppLifecycleResponse> RemoveCoreAsync(string appId, AppRemoveRequest request, CancellationToken cancellationToken)
    {
        var app = await apps.GetAppAsync(appId, cancellationToken);
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
            // The cache follows the data directory's fate: it is keyed by identities in the app's own
            // database (which lives in data), so keeping one without the other either forces a full
            // rebuild or retains orphaned bytes. Kept when data is kept, deleted when data is deleted.
            TryDeleteDirectory(GetAppCachePath(appId));
            // Through the store, not TryDelete: its shared per-app lock fences an in-flight secret
            // write, which could otherwise recreate secrets.json after this removal completes. Runs
            // after the state.json deletion above so late writes fail the store's existence check.
            // Best-effort like the sibling deletions, but a failure here retains credentials, so warn.
            try
            {
                await appSecrets.DeleteAllAsync(appId, cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(ex, "Failed to delete stored secrets for app {AppId} during uninstall.", appId);
            }
        }

        if (request.DeleteBackups)
        {
            await backups.DeleteAllBackupsAsync(appId, cancellationToken);
        }

        if (request.DeleteSource)
        {
            // Both locations: the current default inside the app root, and the legacy top-level
            // sources tree that pre-move installs still use (their records were never migrated).
            TryDeleteDirectory(paths.ResolveManagedCheckoutPath(appId));
            TryDeleteDirectory(CoreDataPaths.ResolveContainedPath(paths.SourcesRoot, appId));
        }

        // The hostnames this app published can never serve it again. Best-effort: a publication that cannot
        // be removed keeps its stored entry, which is the only remaining pointer to what is left in
        // Cloudflare, and never blocks the uninstall.
        if (cloudflarePublications is not null)
        {
            try
            {
                await cloudflarePublications.RemoveAllForAppAsync(appId, cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(ex, "Cloudflare publication cleanup for removed app {AppId} did not complete.", appId);
            }
        }

        TryDeleteDirectoryIfEmpty(GetAppRoot(appId));
        // Telemetry now lives in the backend, which ages out an uninstalled app's data via retention
        // (Core no longer holds a per-app store to purge here).
        await ReconcileIngressAsync(cancellationToken);

        // Nothing to record: boot seeds a host once and never reinstalls, so an uninstall is final
        // until the operator asks for the app again (hosty setup, Marketplace).
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
        var wasRunning = AppRuntimeStates.IsUp(app.RuntimeState);
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
                _ = await StartCoreAsync(appId, afterOwnStop: true, CancellationToken.None);
            }
        }
    }

    public Task<AppBackupResponse> RestoreBackupAsync(string appId, string backupId, AppRestoreBackupRequest request, CancellationToken cancellationToken = default)
        => WithAppLockAsync(appId, () => RestoreBackupCoreAsync(appId, backupId, request, cancellationToken), cancellationToken);

    private async Task<AppBackupResponse> RestoreBackupCoreAsync(string appId, string backupId, AppRestoreBackupRequest request, CancellationToken cancellationToken)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        // IsIdle, not !IsUp: restoring over the data directory of an app that is still shutting down
        // (or coming up) races the runtime for those files.
        if (!AppRuntimeStates.IsIdle(app.RuntimeState))
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
    // Read-only update-available report, backed by the cached reviewed-update plan (plan-first
    // updates): a fresh cached plan is projected without touching the network; otherwise a plan is
    // built — and cached, so it is the exact plan a subsequent one-click apply consumes by digest —
    // and projected. `refresh` forces the rebuild. Apps a plan cannot be built for (live source,
    // unreachable manifest URL, a feed binding with no selection) fall back to the legacy live
    // computation, which degrades per-source to "unknown": this report must stay total for every
    // app, never throw for one source being dark. See docs/planning/plan-first-app-updates.md.
    public async Task<AppUpdateStatusResponse> GetUpdateStatusAsync(string appId, bool refresh = false, CancellationToken cancellationToken = default)
    {
        var app = await RequireAppAsync(appId, cancellationToken);
        if (!refresh && TryGetFreshReviewedPlan(appId) is { } cached)
        {
            return ProjectUpdateStatus(app, cached);
        }

        try
        {
            return ProjectUpdateStatus(app, await CreateUpdatePlanCoreAsync(appId, new AppUpdatePlanRequest(), cancellationToken));
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogDebug(ex, "Update-status plan build failed for app {AppId}; falling back to the live probe.", appId);
            return await ComputeLiveUpdateStatusAsync(app, cancellationToken);
        }
    }

    // Projects the status response from a cached plan without any network work. `Unknown` keeps the
    // probe semantics: no lock to compare against, or no resolvable candidate. `UpdateAvailable`
    // counts every plan change except `artifact:...->unknown` — an unresolvable candidate is
    // "cannot tell", not "update available".
    private static AppUpdateStatusResponse ProjectUpdateStatus(AppRecord app, CachedUpdatePlan cached)
        => new(
            AppId: app.Id,
            Runtime: cached.Selection.RuntimeProfile.Key,
            RuntimeType: cached.Selection.RuntimeProfile.Type,
            UpdatePolicy: DockerRuntimeAdapter.ResolveUpdatePolicy(app.UpdatePolicy),
            UpdateAvailable: PlanIndicatesUpdateAvailable(cached.Plan.Changes),
            Services: cached.ArtifactProbes.Select(ToServiceUpdateStatus).ToList(),
            ManifestUpdateAvailable: !string.Equals(cached.CurrentManifestDigest, cached.Plan.ManifestDigest, StringComparison.Ordinal),
            ManifestUnknown: false);

    private static AppServiceUpdateStatus ToServiceUpdateStatus(AppServiceArtifactProbe probe)
        => new(
            Service: probe.Service,
            LockedDigest: probe.LockedDigest,
            CandidateDigest: probe.CandidateDigest,
            UpdateAvailable: !string.IsNullOrWhiteSpace(probe.LockedDigest)
                && !string.IsNullOrWhiteSpace(probe.CandidateDigest)
                && !string.Equals(probe.LockedDigest, probe.CandidateDigest, StringComparison.Ordinal),
            Unknown: string.IsNullOrWhiteSpace(probe.LockedDigest) || string.IsNullOrWhiteSpace(probe.CandidateDigest));

    // Legacy live status computation, kept for the apps the plan path refuses (see
    // GetUpdateStatusAsync): resolves the candidate manifest per source with graceful per-source
    // degradation, then compares locked digests against the registry.
    private async Task<AppUpdateStatusResponse> ComputeLiveUpdateStatusAsync(AppRecord app, CancellationToken cancellationToken)
    {
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
                logger.LogWarning(ex, "Failed to resolve feed update status for app {AppId}.", app.Id);
            }
        }
        else if (!string.IsNullOrWhiteSpace(app.ManifestUrl))
        {
            // URL-installed app without a feed (system apps installed from the distribution list, and
            // ordinary URL installs): refetch the external manifest as the candidate, mirroring the
            // feed branch. Without this, a candidate that moves to new *versioned* image tags is
            // invisible — the artifact loop below would compare the registry against the installed
            // copy's old tags and report "up to date" forever.
            try
            {
                var candidate = await manifests.LoadAsync(app.ManifestUrl, app.SelectedRuntime, cancellationToken);
                if (!string.Equals(candidate.Manifest.Id, app.Id, StringComparison.Ordinal))
                {
                    throw new AppLifecycleException(
                        "manifest_app_mismatch",
                        $"Update manifest app id '{candidate.Manifest.Id}' does not match installed app '{app.Id}'.");
                }

                candidateSelection = candidate;
                manifestUpdateAvailable = !string.Equals(
                    selection.ManifestDigest,
                    candidateSelection.ManifestDigest,
                    StringComparison.Ordinal);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                manifestUnknown = true;
                logger.LogWarning(ex, "Failed to resolve manifest update status for app {AppId} from {ManifestUrl}.", app.Id, app.ManifestUrl);
            }
        }

        var probes = await ProbeServiceArtifactsAsync(app, candidateSelection, cancellationToken);
        var services = probes.Select(ToServiceUpdateStatus).ToList();

        return new AppUpdateStatusResponse(
            AppId: app.Id,
            Runtime: selection.RuntimeProfile.Key,
            RuntimeType: selection.RuntimeProfile.Type,
            UpdatePolicy: DockerRuntimeAdapter.ResolveUpdatePolicy(app.UpdatePolicy),
            UpdateAvailable: manifestUpdateAvailable || services.Any(service => service.UpdateAvailable),
            Services: services,
            ManifestUpdateAvailable: manifestUpdateAvailable,
            ManifestUnknown: manifestUnknown);
    }

    // Install-time port reservations: backfill service-scoped port assignments for existing
    // records from their stored endpoint URLs, once, before autostart reconciliation consumes them.
    // Idempotent — a record whose assignments already cover its started endpoints yields no delta and is
    // skipped without a write, so steady-state boots do not rewrite state.json. Returns the number of
    // records migrated. See PortAssignmentMigration and docs/features/automatic-runtime-app-ports/feature.md.
    public async Task<int> MigratePortAssignmentsAsync(CancellationToken cancellationToken = default)
    {
        var migrated = 0;
        var records = await apps.ListAppRecordsAsync(cancellationToken);
        foreach (var app in records.Where(app => string.Equals(app.Kind, "runtime", StringComparison.Ordinal)))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (PortAssignmentMigration.DeriveAssignments(app) is null)
            {
                continue;
            }

            // Re-derive under the record lock so a concurrent write is not clobbered; the derivation is
            // pure and idempotent, so the committed result reflects the latest persisted endpoints.
            await apps.UpdateAppAsync(
                app.Id,
                current => PortAssignmentMigration.DeriveAssignments(current) ?? current,
                cancellationToken);
            migrated++;
        }

        return migrated;
    }

    // Automatic ports allocated before 0.76.0 came out of the OS dynamic range (a port-0 bind), so they
    // live in the pool the OS also hands to every outbound connection on the host — a durable reservation
    // there is only ever on loan, and the app whose port the OS reclaims fails to start with a raw bind
    // error. The motivating failure is written up on RuntimePortHelper.AutomaticPortRangeStart. This pass
    // rehomes such reservations into the Hosty band, at boot, before autostart reconciliation consumes
    // them, so an existing install is healed without operator action.
    //
    // Only `automatic`, remappable, non-host-network assignments move. An operator pin, a manifest port,
    // and a host-network port are somebody's deliberate choice, and sitting in the dynamic range does not
    // make it Core's to overrule. An app that is already up keeps its port and is retried on a later boot:
    // Core may have adopted a live listener (keep-apps light restart, docker adoption), and moving the
    // record's port would leave it disagreeing with the process actually serving.
    //
    // Each move goes through the allocator, so the new port is chosen under the same gate and against the
    // same exclusion view an operator-driven reassignment uses, and the endpoint URL moves with it. A
    // record is re-read between moves because each one persists a new revision. Failures are logged and
    // skipped rather than thrown: this runs at boot, and one unmovable port must not strand the rest.
    // Returns the number of ports rehomed.
    public async Task<int> RehomeOsAllocatedPortsAsync(CancellationToken cancellationToken = default)
    {
        if (portAllocator is null)
        {
            return 0;
        }

        var rehomed = 0;
        var records = await apps.ListAppRecordsAsync(cancellationToken);
        foreach (var app in records.Where(app => string.Equals(app.Kind, "runtime", StringComparison.Ordinal)))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (FindOsAllocatedAssignments(app).Count == 0)
            {
                continue;
            }

            if (AppRuntimeStates.IsUp(app.RuntimeState))
            {
                logger.LogInformation(
                    "App '{AppId}' holds an OS-allocated automatic port but is running; leaving it in place and retrying at a later boot.",
                    app.Id);
                continue;
            }

            var manifestPinned = await ReadManifestPinnedPortKeysAsync(app, cancellationToken);
            rehomed += await WithAppLockAsync(app.Id, () => RehomeAppPortsAsync(app.Id, manifestPinned, cancellationToken), cancellationToken);
        }

        return rehomed;
    }

    // The (service, port key) pairs the app's manifest pins with an explicit localPort/hostPort, across
    // every runtime profile. The boot backfill cannot see them: it derives assignments from stored
    // endpoint URLs and classifies anything without a matching HOSTY_PORT_* setting as `automatic`
    // (PortAssignmentMigration.ResolveSource), because a URL cannot say whether its port was chosen by
    // Core or written in the manifest. A legacy record whose manifest pins a port in the dynamic range —
    // 51413 and friends — would therefore look remappable and be moved by the pass below, breaking the
    // guarantee that a manifest pin stays put and any firewall rule or router forward aimed at it.
    // Reading the reviewed manifest copy is the only way to tell the two apart.
    //
    // Every profile is consulted rather than the record's selected one: skipping is the safe direction,
    // and a port pinned under a profile the app is not currently running is still a pin. An unreadable or
    // missing copy yields an empty set, which is the pre-existing behavior — the pass is best-effort.
    private async Task<IReadOnlySet<(string Service, string PortKey)>> ReadManifestPinnedPortKeysAsync(
        AppRecord app,
        CancellationToken cancellationToken)
    {
        var pinned = new HashSet<(string, string)>();
        var manifestPath = ResolveStoredManifestPath(app);
        if (manifestPath is null)
        {
            return pinned;
        }

        RuntimeAppManifest? manifest;
        try
        {
            manifest = await JsonStorage.ReadAsync<RuntimeAppManifest>(manifestPath, cancellationToken);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Text.Json.JsonException)
        {
            logger.LogWarning(ex, "Could not read the manifest copy for '{AppId}' while rehoming ports; treating every automatic port as movable.", app.Id);
            return pinned;
        }

        if (manifest is null || !string.Equals(manifest.Id, app.Id, StringComparison.Ordinal))
        {
            return pinned;
        }

        foreach (var service in manifest.Services)
        {
            foreach (var profile in service.Runtimes.Values)
            {
                foreach (var port in profile.Ports)
                {
                    if ((port.LocalPort ?? port.HostPort) is null)
                    {
                        continue;
                    }

                    var key = port.Key ?? port.ContainerPort?.ToString(System.Globalization.CultureInfo.InvariantCulture);
                    if (!string.IsNullOrWhiteSpace(key))
                    {
                        pinned.Add((service.Key, key!));
                    }
                }
            }
        }

        return pinned;
    }

    // Tell the operator once when a port this pass moved sits behind an origin THEY own.
    //
    // A managed origin needs no notice: the active provider re-materializes it, which is the whole point
    // of putting both providers behind IIngressController. An operator-owned one is the opposite — under
    // `none`, or for an unpublished endpoint under the API provider, the stored origin usually reads
    // `https://app.example.com` with no port at all, because it names their own reverse proxy and the
    // upstream lives in that proxy's config. Core neither writes nor can read that file, so it cannot
    // detect staleness and must not pretend to: a standing "broken" badge would assert something unknown.
    // What Core does know is the event, so it reports the event, once, and says what to do with it.
    private async Task NotifyOperatorOwnedOriginMovedAsync(
        AppRecord app,
        AppPortAssignment target,
        int oldPort,
        int newPort,
        CancellationToken cancellationToken)
    {
        if (notifications is null || publicOrigins is null)
        {
            return;
        }

        try
        {
            var endpoint = app.Endpoints.FirstOrDefault(candidate =>
                string.Equals(candidate.Service, target.Service, StringComparison.Ordinal) &&
                string.Equals(candidate.Port, target.PortKey, StringComparison.Ordinal));
            if (endpoint is null)
            {
                return;
            }

            var settingKey = PublicOriginSettings.BuildSettingKey(endpoint.Key);
            if (!app.Settings.TryGetValue(settingKey, out var origin) || string.IsNullOrWhiteSpace(origin.Value))
            {
                return;
            }

            var managed = await publicOrigins.FindManagedKeysAsync(app.Id, [settingKey], cancellationToken);
            if (managed.Contains(settingKey))
            {
                return;
            }

            await notifications.PublishAsync(
                new CoreScope(), NotificationService.BroadcastTarget, NotificationService.AudienceHostAdmin,
                "warning",
                $"'{app.DisplayName}' moved to a new local port",
                $"{endpoint.Key} now listens on {newPort} instead of {oldPort}. {origin.Value} is yours to maintain, so update the upstream wherever it is configured.",
                link: null,
                $"public-origin-port-moved:{app.Id}:{endpoint.Key}:{newPort}",
                cancellationToken);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            logger.LogWarning(exception, "Failed to publish the moved-port notification for {AppId}.", app.Id);
        }
    }

    private async Task<int> RehomeAppPortsAsync(
        string appId,
        IReadOnlySet<(string Service, string PortKey)> manifestPinned,
        CancellationToken cancellationToken)
    {
        var snapshot = await apps.GetAppAsync(appId, cancellationToken);
        if (snapshot is null)
        {
            return 0;
        }

        var rehomed = 0;
        // Iterate a target list captured once, not "whatever still matches" — a saturated band makes the
        // allocator fall back to another OS-range port, which would match the selection again and spin
        // this loop forever. The record is still re-read per target, because each move persists a new
        // revision the next allocation has to be based on.
        foreach (var target in FindOsAllocatedAssignments(snapshot))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (manifestPinned.Contains((target.Service, target.PortKey)))
            {
                logger.LogInformation(
                    "Leaving '{AppId}' {Service}.{PortKey} on {HostPort}: the manifest pins it, and the boot backfill only classified it automatic because a stored endpoint URL cannot say so.",
                    appId,
                    target.Service,
                    target.PortKey,
                    target.HostPort);
                continue;
            }

            var current = await apps.GetAppAsync(appId, cancellationToken);
            if (current is null || AppRuntimeStates.IsUp(current.RuntimeState))
            {
                return rehomed;
            }

            // The assignment may have been moved or dropped since the snapshot; only act on one that is
            // still a target on the persisted record.
            if (!FindOsAllocatedAssignments(current).Any(assignment =>
                    string.Equals(assignment.Service, target.Service, StringComparison.Ordinal) &&
                    string.Equals(assignment.PortKey, target.PortKey, StringComparison.Ordinal)))
            {
                continue;
            }

            try
            {
                var (_, oldPort, newPort) = await portAllocator!.ReassignAsync(
                    current,
                    target.Service,
                    target.PortKey,
                    apps.ListAppRecordsAsync,
                    async (record, ct) => (await apps.UpsertAppAsync(record, ct)).App,
                    desiredPort: null,
                    cancellationToken);
                if (RuntimePortHelper.IsOsDynamicRangePort(newPort))
                {
                    // The band had nothing free, so the allocator fell back to the OS and the port is as
                    // fragile as the one we just replaced. Say so: the next boot will try again, and the
                    // operator's real fix is to free ports in the band or pin this one.
                    logger.LogWarning(
                        "Rehoming '{AppId}' {Service}.{PortKey} landed on {NewPort}, still inside the OS dynamic range; the automatic port band had nothing free.",
                        appId,
                        target.Service,
                        target.PortKey,
                        newPort);
                }
                else
                {
                    logger.LogInformation(
                        "Rehomed '{AppId}' {Service}.{PortKey} off OS-allocated port {OldPort} to {NewPort}.",
                        appId,
                        target.Service,
                        target.PortKey,
                        oldPort,
                        newPort);
                }

                await NotifyOperatorOwnedOriginMovedAsync(current, target, oldPort, newPort, cancellationToken);
                rehomed++;
            }
            // One unmovable port must not skip the app's remaining ones, nor fail the boot pass. The set
            // matches what the boot caller tolerates, plus InvalidOperationException for a record removed
            // between the snapshot and its write — a narrower filter would let a persistence failure
            // abort the whole pass, which is not the best-effort behavior this documents.
            catch (Exception ex) when (ex is AppLifecycleException or IOException or UnauthorizedAccessException
                or System.Text.Json.JsonException or InvalidOperationException)
            {
                logger.LogWarning(
                    ex,
                    "Failed to rehome '{AppId}' {Service}.{PortKey} off OS-allocated port {OldPort}; leaving it in place.",
                    appId,
                    target.Service,
                    target.PortKey,
                    target.HostPort);
            }
        }

        return rehomed;
    }

    // The assignments the rehoming pass moves: automatic, remappable, not host-network, and holding a port
    // an OS may hand out on its own. An assignment carrying a HOSTY_PORT_* override is left alone even when
    // it is still classified `automatic` — the configure path can write one without re-reserving (a known
    // gap), and the override, not the assignment, is what start resolves first.
    internal static IReadOnlyList<AppPortAssignment> FindOsAllocatedAssignments(AppRecord app)
        => (app.PortAssignments ?? [])
            .Where(assignment =>
                string.Equals(assignment.Source, AppPortSources.Automatic, StringComparison.Ordinal) &&
                assignment.Remappable &&
                !string.Equals(assignment.BindScope, AppPortBindScopes.HostNetwork, StringComparison.Ordinal) &&
                RuntimePortHelper.IsOsDynamicRangePort(assignment.HostPort) &&
                !RuntimePortHelper.HasHostPortOverride(app, assignment.Service, assignment.PortKey))
            .OrderBy(assignment => assignment.Service, StringComparer.Ordinal)
            .ThenBy(assignment => assignment.PortKey, StringComparer.Ordinal)
            .ToArray();

    // Records only re-run manifest→record normalization at install/update/switch/live-start, so an app
    // installed under an older Core permanently lacked any manifest section that build did not parse —
    // e.g. `interfaces` was silently dropped for hosty.ai-gateway installed under Core 0.73.x, and Shell's
    // assistant discovery found nothing until a manual same-version reviewed update rebuilt the record.
    // This boot backfill heals such records without operator action: any runtime record whose
    // NormalizedBy stamp differs from the running build gets ApplyManifestProjections re-run from the
    // app's reviewed internal manifest copy (raw read, mirroring the registry's UI hydration — the copy
    // was validated when it was written) and is stamped, so the heal runs once per record per Core
    // build. Operator-owned state (setting values, mount bindings, artifact locks, feeds, port
    // reservations) is untouched by construction. A record whose manifest copy is missing or unreadable
    // is skipped un-stamped, so a later boot retries. Runs at boot before autostart reconciliation
    // because start ordering reads Provides. Returns the number of records healed.
    public async Task<int> BackfillManifestProjectionsAsync(CancellationToken cancellationToken = default)
    {
        var healed = 0;
        foreach (var app in await apps.ListAppRecordsAsync(cancellationToken))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (!string.Equals(app.Kind, "runtime", StringComparison.Ordinal) ||
                string.Equals(app.NormalizedBy, CoreStatusResponse.PlatformVersionString, StringComparison.Ordinal))
            {
                continue;
            }

            var manifestPath = ResolveStoredManifestPath(app);
            if (manifestPath is null)
            {
                continue;
            }

            try
            {
                var manifest = await JsonStorage.ReadAsync<RuntimeAppManifest>(manifestPath, cancellationToken);
                // A copy that no longer describes this app is an on-disk inconsistency, not something to
                // project onto the record — same guard as the live-source reconcile's id check.
                if (manifest is null || !string.Equals(manifest.Id, app.Id, StringComparison.Ordinal))
                {
                    continue;
                }

                // Re-check the stamp inside the record lock: a reviewed update or live adoption that
                // committed between the list snapshot and this write already re-projected from a
                // fresher manifest than the copy read above (every projection writer stamps the running
                // build), and must not be overwritten with stale projections that would then pass every
                // later boot's stamp check.
                var applied = false;
                await apps.UpdateAppAsync(app.Id, current =>
                {
                    if (string.Equals(current.NormalizedBy, CoreStatusResponse.PlatformVersionString, StringComparison.Ordinal))
                    {
                        applied = false;
                        return current;
                    }

                    applied = true;
                    return ApplyManifestProjections(current, manifest);
                }, cancellationToken);
                if (applied)
                {
                    healed++;
                }
            }
            // Per-record isolation, deliberately broad: this is the raw-read path, and a stored copy's
            // sections written under a Core too old to shape-validate them can surprise the projection
            // (not just the read) in ways no exception list anticipates. One malformed legacy copy must
            // skip its own record — left un-stamped so a later boot retries — never abort the boot
            // sequence behind it (port backfill, autostart).
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(ex, "Skipped manifest-projection backfill for app {AppId}.", app.Id);
            }
        }

        return healed;
    }

    // The app's reviewed internal manifest copy: the recorded path when it still exists, else the
    // conventional apps/<id>/manifest.json location (same fallback the registry's UI hydration uses).
    private string? ResolveStoredManifestPath(AppRecord app)
    {
        if (!string.IsNullOrWhiteSpace(app.ManifestPath) && File.Exists(app.ManifestPath))
        {
            return app.ManifestPath;
        }

        var localCopy = Path.Combine(GetAppRoot(app.Id), "manifest.json");
        return File.Exists(localCopy) ? localCopy : null;
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
            .OrderByDescending(app => PlatformCapabilities.StartPriority(app.Provides))
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
        var records = await apps.ListAppRecordsAsync(cancellationToken);
        // Stop every runtime app CONCURRENTLY. Each app owns a separate state.json under its own per-app
        // lock and `docker stop` is an independent process, so parallel stops don't race. Stopping
        // serially summed each app's SIGTERM grace (~10s default): with several apps that blew the
        // caller's 15s shutdown budget after the first one or two, and the rest were abandoned
        // still-running — their published host ports stayed bound by Docker Desktop until a reboot. In
        // parallel the budget covers all apps at once (max grace, not the sum).
        var tasks = records
            .Where(app => string.Equals(app.Kind, "runtime", StringComparison.Ordinal))
            .Select(app => RunBackgroundLifecycleActionAsync(
                app.Id,
                "core-shutdown-stop",
                async () => await StopAsync(app.Id, cancellationToken),
                cancellationToken))
            .ToArray();

        return await Task.WhenAll(tasks);
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
        var storageMappings = new List<AppStorageMapping>();
        if (selection.DataTarget is not null)
        {
            storageMappings.Add(new(
                Key: "data",
                HostPath: GetAppDataPath(manifest.Id!),
                TargetPath: selection.DataTarget.ContainerPath ?? GetAppDataPath(manifest.Id!),
                ReadOnly: false));
        }

        if (EffectiveCacheTargetPath(selection, manifest.Id!) is { } cacheTargetPath)
        {
            storageMappings.Add(new(
                Key: "cache",
                HostPath: GetAppCachePath(manifest.Id!),
                TargetPath: cacheTargetPath,
                ReadOnly: false));
        }
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

        // Manifest-projection sections (capabilities, provides, dependencies, UI, catalog metadata,
        // interfaces, runtime profiles, mount slots) are filled by ApplyManifestProjections below —
        // the ctor passes placeholders for the required positional ones.
        var record = new AppRecord(
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
            Capabilities: [],
            Settings: settings,
            StorageMappings: storageMappings,
            Dependencies: [],
            Endpoints: endpoints,
            InstalledAt: existing?.InstalledAt ?? default,
            UpdatedAt: default,
            SourceState: BuildSourceState(selection, existing),
            Autostart: existing?.Autostart ?? true,
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
            // ArtifactLocks is left null on (re)build; the callers that reviewed digests overlay them
            // afterwards (bound install seeds them from the plan probes, update apply persists the
            // confirmed candidates), so a start runs the reviewed digest. Runtime-switch still drops
            // the lock for a start-time re-resolve of the new profile's target.
            UpdatePolicy: existing?.UpdatePolicy,
            // App-owned feed state is lifecycle bookkeeping, not manifest contract — preserve it
            // across update/switch/reconcile like UpdatePolicy.
            FeedsUrl: existing?.FeedsUrl,
            FollowedFeedId: existing?.FollowedFeedId,
            // Persisted host-port reservations are Core-owned durable state, not manifest contract: carry
            // them across every rebuild so a runtime switch or update keeps an app's assigned ports. A
            // reservation whose service/port key the new manifest no longer declares is inert (nothing
            // resolves or projects it) and is reconciled when install-time allocation is wired into the
            // update/switch apply path.
            PortAssignments: existing?.PortAssignments);

        return ApplyManifestProjections(record, manifest);
    }

    // The single manifest→record projection choke point: every section that is a pure denormalization
    // of the manifest (no operator input, no runtime resolution) is (re)computed here, and the record
    // is stamped with the Core build that ran the normalization. Three paths funnel through it —
    // install/update/switch/rollback (BuildAppRecord), live-source adoption (ReconcileLiveContractAsync),
    // and the boot backfill that heals records written by a different Core build
    // (BackfillManifestProjectionsAsync) — so a future additive manifest section only needs a line here
    // to reach all of them; hand-copied per-path field lists are what silently dropped Interfaces from
    // live adoption. Endpoints, Settings and StorageMappings stay in BuildAppRecord: they need the
    // runtime selection and existing-record carry-forward, not just the manifest.
    private static AppRecord ApplyManifestProjections(AppRecord record, RuntimeAppManifest manifest)
        => record with
        {
            Capabilities = ResolveCapabilities(manifest),
            Provides = manifest.Provides.Count == 0 ? null : manifest.Provides,
            Dependencies = manifest.Dependencies.Select(ToDependencyContract).ToArray(),
            Ui = AppUiContract.FromManifest(manifest.Ui),
            CatalogMetadata = AppCatalogMetadataContract.FromManifest(manifest.CatalogMetadata),
            Interfaces = AppInterfaceContract.FromManifest(manifest.Interfaces),
            RuntimeProfiles = BuildRuntimeProfileSummaries(manifest),
            MountSlots = BuildMountSlots(manifest),
            NormalizedBy = CoreStatusResponse.PlatformVersionString,
        };

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
    // `installed` lets a caller that already holds the full record set (ListAppsAsync) hand it over:
    // the dependency projection below would otherwise re-read every provider's state.json from disk
    // once per consumer, turning one list request into an O(apps x dependencies) file scan. A null
    // snapshot falls back to targeted lookups, which is right for the single-app callers.
    private async Task<AppSummary> BuildAppSummaryAsync(
        AppRecord app,
        CancellationToken cancellationToken,
        IReadOnlyList<AppRecord>? installed = null)
    {
        var profiles = await ResolveRuntimeProfilesAsync(app, cancellationToken);
        var liveSourcePath = ResolveLiveSourcePath(app, profiles);
        var summary = AppSummary.From(app, profiles, liveSourcePath is not null, liveSourcePath);
        // Last-known update verdict (plan-first updates): null until a check has run for this app.
        // Suppressed for a live-source runtime — it has no reviewed-update path, so a verdict from
        // before the app went live must not keep offering an update the plan flow would refuse
        // (sweep pruning alone can't be relied on: the scheduler may be disabled).
        return summary with
        {
            UpdateCheck = summary.Live ? null : updateAvailability.GetValueOrDefault(app.Id),
            Dependencies = await ResolveDependencySummariesAsync(app, installed, cancellationToken),
        };
    }

    // Resolve each declared dependency against the installed set. Reports state only — installed,
    // running, and whether each wired endpoint currently has a URL — and leaves "is that a problem?"
    // to the client, which is what lets one projection serve both the required and optional cases.
    // Replaces the old start-time advisory: a dependency being down is a condition that resolves
    // itself when the operator starts it, not an event worth a durable notification.
    private async Task<IReadOnlyList<AppDependencySummary>?> ResolveDependencySummariesAsync(
        AppRecord app,
        IReadOnlyList<AppRecord>? installed,
        CancellationToken cancellationToken)
    {
        if (app.Dependencies is not { Count: > 0 } dependencies)
        {
            return null;
        }

        var summaries = new List<AppDependencySummary>(dependencies.Count);
        foreach (var dependency in dependencies)
        {
            var provider = installed is null
                ? await apps.GetAppAsync(dependency.AppId, cancellationToken)
                : installed.FirstOrDefault(candidate => string.Equals(candidate.Id, dependency.AppId, StringComparison.Ordinal));
            var endpoints = (dependency.Endpoints ?? [])
                .Select(wired => new AppDependencyEndpointSummary(
                    wired.EndpointKey,
                    wired.Alias,
                    provider is not null && (provider.Endpoints ?? []).Any(endpoint =>
                        string.Equals(endpoint.Key, wired.EndpointKey, StringComparison.Ordinal) &&
                        !string.IsNullOrWhiteSpace(endpoint.Url))))
                .ToArray();
            summaries.Add(new AppDependencySummary(
                dependency.AppId,
                dependency.Version,
                dependency.Required,
                provider is not null,
                provider is not null && AppRuntimeStates.IsUp(provider.RuntimeState),
                endpoints));
        }

        return summaries;
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
                    ManagedCheckoutPath: paths.ResolveManagedCheckoutPath(selection.Manifest.Id!),
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
                ManagedCheckoutPath = existing.SourceState.ManagedCheckoutPath ?? paths.ResolveManagedCheckoutPath(selection.Manifest.Id!),
                LocalOverridePath = existing.SourceState.LocalOverridePath ?? localOverridePath,
                ManifestSubpath = manifestSubpath ?? existing.SourceState.ManifestSubpath,
            };
        }

        return new AppSourceState(
            Type: source.Type,
            Repository: source.Repository,
            ResolvedRef: resolvedRef,
            Commit: source.Commit,
            ManagedCheckoutPath: paths.ResolveManagedCheckoutPath(selection.Manifest.Id!),
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
            ResolveLockedSourceRoot(app, await ResolveRuntimeProfilesAsync(app, cancellationToken)),
            AppCachePath: GetAppCachePath(app.Id));
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
            : paths.ResolveManagedCheckoutPath(app.Id);
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
    // Validates the mounts and returns the context with each mount's HostPath rewritten to its
    // fully-resolved real path, so Docker binds the exact location Core validated rather than a path it
    // would re-traverse through a symlink (C-H3). Callers must use the returned context.
    private RuntimeLifecycleContext EnsureMountsReadyForStart(RuntimeLifecycleContext context)
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

        var canonicalized = new List<RuntimeMount>(context.Mounts.Count);
        foreach (var mount in context.Mounts)
        {
            // Re-check the path and its real target: one validated at config time could have been
            // repointed at a forbidden location since (TOCTOU). EnsureAllowed resolves internally, fails
            // closed on a resolution error, and returns the exact real path it validated so existence
            // and the mount both use that single resolution (no second resolve to race against).
            var realPath = mountPathPolicy.EnsureAllowed(mount.HostPath);
            if (!MountPathPolicy.HostPathExists(realPath))
            {
                throw new AppLifecycleException(
                    "app_mount_source_missing",
                    $"External mount '{mount.Key}/{mount.Label}' host path was not found or is not a directory: {mount.HostPath}");
            }

            // Bind the resolved real path, not the operator's (possibly symlinked) path.
            canonicalized.Add(mount with { HostPath = realPath });
        }

        return context with { Mounts = canonicalized };
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

        var checkoutPath = source?.ManagedCheckoutPath ?? paths.ResolveManagedCheckoutPath(app.Id);
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

    // Host-admin advisory for a start refused by unset required settings: best-effort, never throws so
    // a notification failure cannot mask the start error. Dedupe key is per-app so re-attempts coalesce.
    // Unlike a missing dependency — which is now app state on the summary, not a notification — this
    // one reports a start that actually failed, so it is a genuine event.
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
            // Manifest projections come from the shared choke point rather than a hand-copied field
            // list, so every projected section — including ones added later — reaches a live adoption
            // without this site naming it (Interfaces was silently missing from the old list). The
            // remaining fields are the selection/carry-forward rebuilds only BuildAppRecord can do.
            return ApplyManifestProjections(current, selection.Manifest) with
            {
                Version = reconciled.Version,
                DisplayName = reconciled.DisplayName,
                Description = reconciled.Description,
                Source = reconciled.Source,
                Settings = reconciled.Settings,
                StorageMappings = reconciled.StorageMappings,
                Endpoints = reconciled.Endpoints,
                Mounts = reconciled.Mounts,
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

    // The cache directory is data's disposable sibling. Being a sibling rather than a subdirectory
    // is the whole backup-exclusion mechanism: AppBackupService archives and restores GetAppDataPath
    // only, so neither ever has to know caches exist.
    private string GetAppCachePath(string appId)
        => Path.Combine(GetAppRoot(appId), "cache");

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
        // Both sides are normalized: the stored list may predate the canonical vocabulary (records
        // installed when it still carried `update`/`stop`/`open`/...), and diffing it raw against a
        // normalized target would report those retired tokens as freshly "removed".
        AddCapabilityChanges(changes, NormalizeCapabilities(app.Capabilities), ResolveCapabilities(targetSelection.Manifest));

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
    private static IReadOnlyList<string> BuildArtifactDigestChanges(IReadOnlyList<AppServiceArtifactProbe> probes)
    {
        var changes = new List<string>();
        foreach (var probe in probes)
        {
            if (string.IsNullOrWhiteSpace(probe.CandidateDigest))
            {
                if (!string.IsNullOrWhiteSpace(probe.LockedDigest))
                {
                    changes.Add($"artifact:{probe.Service}:{probe.LockedDigest}->unknown");
                }

                continue;
            }

            if (!string.Equals(probe.LockedDigest, probe.CandidateDigest, StringComparison.Ordinal))
            {
                changes.Add($"artifact:{probe.Service}:{probe.LockedDigest ?? "none"}->{probe.CandidateDigest}");
            }
        }

        return changes;
    }

    // One registry pass over the target selection's compiled services: the locked digest from the app
    // record next to the remotely-resolved candidate. Shared by the update plan (artifact change
    // entries) and the update-status report (per-service digests), so both read the same probe.
    // Lock-less services are still probed: the plan needs the candidate for its `none->{digest}`
    // entries (pre-existing behavior), and forking a skip-when-lockless variant just for the rare
    // status fallback would give the two paths different probe semantics for no real saving.
    // Probes run concurrently under a cap: each spawns a docker CLI process and waits out a registry
    // round-trip, and an app's services are independent — but an unbounded fan-out would burst-spawn
    // processes for image-heavy apps. Task.WhenAll keeps the service-key order.
    //
    // The cap is host-wide (a shared gate, not one per call), which is what lets the fleet sweep check
    // every app at once: registry probes are the only scarce resource in a check, so bounding them
    // directly bounds the whole host, and an app with no compiled services no longer waits behind one
    // that has five. A per-call gate could only ever bound one app, so the sweep had to throttle apps
    // instead — paying that cost even for apps that never touch a registry.
    private Task<IReadOnlyList<AppServiceArtifactProbe>> ProbeServiceArtifactsAsync(
        AppRecord app,
        RuntimeAppManifestSelection targetSelection,
        CancellationToken cancellationToken)
        => ProbeServiceArtifactsAsync(app.Id, app.ArtifactLocks, targetSelection, cancellationToken);

    private async Task<IReadOnlyList<AppServiceArtifactProbe>> ProbeServiceArtifactsAsync(
        string appId,
        IReadOnlyDictionary<string, ArtifactLock>? currentLocks,
        RuntimeAppManifestSelection targetSelection,
        CancellationToken cancellationToken)
    {
        var resolver = adapters.OfType<IImageDigestResolver>().FirstOrDefault();
        return await Task.WhenAll(targetSelection.Services
            .Where(service => service.Image is not null)
            .OrderBy(service => service.Key, StringComparer.Ordinal)
            .Select(async service =>
            {
                var lockedDigest = currentLocks?.GetValueOrDefault(service.Key)?.ImageDigest;
                string? candidateDigest = null;
                if (resolver is not null)
                {
                    await artifactProbeGate.WaitAsync(cancellationToken);
                    try
                    {
                        candidateDigest = await resolver.ResolveRemoteDigestAsync(service.Image!, cancellationToken);
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        // The resolver's contract is "null when unresolvable", but IImageDigestResolver
                        // is an injectable seam — degrade the one service to unknown rather than failing
                        // the whole pass.
                        logger.LogWarning(ex, "Failed to resolve remote image digest for app {AppId} service {Service}.", appId, service.Key);
                    }
                    finally
                    {
                        artifactProbeGate.Release();
                    }
                }

                return new AppServiceArtifactProbe(service.Key, lockedDigest, candidateDigest);
            })
            .ToList());
    }

    // How many registry digest probes may be in flight across the whole host at once. Sized for the
    // docker CLI probe that backs it today: the processes are network-bound rather than CPU-bound, so
    // this is about not burst-spawning them, not about saturating cores.
    private const int MaxConcurrentArtifactProbes = 8;

    private readonly SemaphoreSlim artifactProbeGate = new(MaxConcurrentArtifactProbes, MaxConcurrentArtifactProbes);

    // A reviewed update moves the source pin when the target runs from the managed checkout: a
    // URL/feed install whose selected runtime is localCommand with a declared source repository —
    // the same shape EnsureLocalCommandSourceReadyAsync pins at start. A folder install runs live
    // from the operator's own folder (no pin to move), and a relative repository is rejected at
    // start time, so neither is probed or reconciled here.
    private static bool UpdateMovesSourcePin(AppRecord app, RuntimeAppManifestSelection selection)
        => string.Equals(selection.RuntimeProfile.Type, "localCommand", StringComparison.Ordinal)
            && !string.IsNullOrWhiteSpace(app.ManifestUrl)
            && !string.IsNullOrWhiteSpace(selection.Manifest.Source?.Repository)
            && !IsRelativeSourceRepository(selection.Manifest.Source.Repository);

    // Source-artifact counterpart of ProbeServiceArtifactsAsync: resolves the commit the target
    // manifest's source ref points at now (one `git ls-remote`, nothing materialized on disk — this
    // runs for every eligible app on every sweep) and compares it to the recorded pin, yielding a
    // `source:{current}->{candidate}` change entry when they differ. An unreachable repository
    // degrades to `source:{current}->unknown` (surfaced only when a pin exists) instead of failing
    // the plan, matching the artifact probe's semantics (A4).
    private async Task<(string? ResolvedCommit, string? Change)> ProbeSourceCommitAsync(
        AppRecord app,
        RuntimeAppManifestSelection selection,
        CancellationToken cancellationToken)
    {
        if (!UpdateMovesSourcePin(app, selection))
        {
            return (null, null);
        }

        var current = app.SourceState?.Commit;
        string candidate;
        try
        {
            candidate = await sources.ResolveManifestCommitAsync(selection.Manifest.Source!, cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "Failed to resolve the source commit for app {AppId} from {Repository}.", app.Id, selection.Manifest.Source!.Repository);
            return (null, string.IsNullOrWhiteSpace(current) ? null : $"source:{current}->unknown");
        }

        return (candidate, string.Equals(current, candidate, StringComparison.Ordinal)
            ? null
            : $"source:{current ?? "none"}->{candidate}");
    }

    // Reviewed-update plan classification: a plan whose changes are all routine may be applied without
    // a human reading it (the one-click "Update" path); anything else must go through the review
    // dialog. Routine is an allow-list — a version bump, a manifest-body delta, a compiled artifact
    // moving to a digest that actually resolved, and an image tag advancing inside its own repository
    // (the shape of every ordinary release). Every change kind the list does not recognize
    // (runtime/role/service/setting/dependency/endpoint/data/capability movement, and anything added
    // later) is review-class by default: expanding an app's shape or privileges stays
    // operator-approved (see the `role:runtime->system` note in BuildUpdateChanges), and an
    // `artifact:...->unknown` target means applying would pull an image nobody could resolve even as a
    // digest. See docs/planning/plan-first-app-updates.md.
    internal static bool PlanRequiresReview(IReadOnlyList<string> changes)
        => changes.Any(change => !IsRoutineChange(change));

    // An update exists when the plan carries any change except an unresolved artifact or source
    // target — a `...->unknown` entry is "cannot tell", not "update available".
    internal static bool PlanIndicatesUpdateAvailable(IReadOnlyList<string> changes)
        => changes.Any(change => !IsUnknownArtifactChange(change) && !IsUnknownSourceChange(change));

    private static bool IsRoutineChange(string change)
        => change.StartsWith("version:", StringComparison.Ordinal)
            || string.Equals(change, "manifest", StringComparison.Ordinal)
            || (change.StartsWith("artifact:", StringComparison.Ordinal) && !IsUnknownArtifactChange(change))
            // A source pin advancing to a commit that actually resolved is the source app's shape of
            // an ordinary release, exactly like a compiled artifact moving to a resolved digest.
            || (change.StartsWith("source:", StringComparison.Ordinal) && !IsUnknownSourceChange(change))
            || IsSameRepositoryImageChange(change);

    // `image:{service}:{currentRef}->{targetRef}` moves are routine only while both references point
    // into the same repository: a tag advancing inside the app's own repository is an ordinary
    // release, while a repository change redirects where the bytes come from and must be reviewed
    // even when the target digest resolves. Parses the entry this class itself emits (AddImageChange):
    // service keys cannot contain ':' and docker references cannot contain '>', so the format is
    // unambiguous. Anything that does not parse cleanly is review-class.
    private static bool IsSameRepositoryImageChange(string change)
    {
        const string prefix = "image:";
        if (!change.StartsWith(prefix, StringComparison.Ordinal))
        {
            return false;
        }

        var body = change[prefix.Length..];
        var serviceSeparator = body.IndexOf(':');
        var arrow = body.IndexOf("->", StringComparison.Ordinal);
        if (serviceSeparator < 0 || arrow <= serviceSeparator)
        {
            return false;
        }

        var currentReference = body[(serviceSeparator + 1)..arrow];
        var targetReference = body[(arrow + 2)..];
        if (string.Equals(currentReference, "none", StringComparison.Ordinal) ||
            string.Equals(targetReference, "none", StringComparison.Ordinal))
        {
            return false;
        }

        return string.Equals(ImageRepository(currentReference), ImageRepository(targetReference), StringComparison.Ordinal);
    }

    // Repository part of a docker reference: strips an `@sha256:...` digest pin, then a trailing
    // `:tag` — a colon followed by a '/' belongs to a registry port, not a tag.
    private static string ImageRepository(string reference)
    {
        var digestSeparator = reference.IndexOf('@');
        if (digestSeparator >= 0)
        {
            reference = reference[..digestSeparator];
        }

        var tagSeparator = reference.LastIndexOf(':');
        return tagSeparator >= 0 && reference.IndexOf('/', tagSeparator) < 0
            ? reference[..tagSeparator]
            : reference;
    }

    // An artifact delta whose target digest could not be resolved (registry unreachable at plan time):
    // the artifact would be re-pulled blind at apply.
    private static bool IsUnknownArtifactChange(string change)
        => change.StartsWith("artifact:", StringComparison.Ordinal)
            && change.EndsWith("->unknown", StringComparison.Ordinal);

    // Source counterpart of IsUnknownArtifactChange: the manifest ref could not be resolved to a
    // commit (repository unreachable at plan time), so apply would have to re-resolve blind.
    private static bool IsUnknownSourceChange(string change)
        => change.StartsWith("source:", StringComparison.Ordinal)
            && change.EndsWith("->unknown", StringComparison.Ordinal);

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
                // Core-reserved host-port overrides (HOSTY_PORT_<key>) are not manifest settings and
                // the update deliberately carries them forward (see the BuildAppRecord carry-forward).
                // Reporting one "removed" here made every plan for such an app carry a phantom
                // review-class change that apply could never clear — an endless same-version "Review"
                // loop (seen live on a Shell record still holding its retired HOSTY_PORT_HTTP pin).
                // The skip is prefix-wide on purpose: the carry-forward is prefix-based too, keeping
                // any stored HOSTY_PORT_* key the target does not declare — even one a past manifest
                // declared itself — so this mirrors exactly what apply does.
                if (!key.StartsWith("HOSTY_PORT_", StringComparison.Ordinal))
                {
                    changes.Add($"setting:{key}:removed");
                }
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

    // The cache target path a selection actually produces, regardless of how it was declared.
    // CacheTarget covers docker (explicit or synthesized) and explicitly-targeted profiles; the
    // `enabled`-only localCommand form has no target yet still gets the host-path cache from the
    // adapter, so the record and the plan diffs must see it too — otherwise a runtime switch
    // reports a false cache:removed while the directory keeps existing.
    private string? EffectiveCacheTargetPath(RuntimeAppManifestSelection selection, string appId)
    {
        if (selection.CacheTarget is not null)
        {
            return selection.CacheTarget.ContainerPath ?? GetAppCachePath(appId);
        }

        return selection.Manifest.Cache?.Enabled == true ? GetAppCachePath(appId) : null;
    }

    private void AddDataTargetChanges(List<string> changes, AppRecord app, RuntimeAppManifestSelection targetSelection)
    {
        AddStorageTargetChanges(changes, app, "data", EffectiveDataTargetPath(targetSelection, app.Id), reportCompatible: true);
        AddStorageTargetChanges(changes, app, "cache", EffectiveCacheTargetPath(targetSelection, app.Id), reportCompatible: true);
    }

    private void AddUpdateDataTargetChanges(List<string> changes, AppRecord app, RuntimeAppManifestSelection targetSelection)
    {
        AddStorageTargetChanges(changes, app, "data", EffectiveDataTargetPath(targetSelection, app.Id), reportCompatible: false);
        AddStorageTargetChanges(changes, app, "cache", EffectiveCacheTargetPath(targetSelection, app.Id), reportCompatible: false);
    }

    private string? EffectiveDataTargetPath(RuntimeAppManifestSelection selection, string appId)
        => selection.DataTarget is null ? null : selection.DataTarget.ContainerPath ?? GetAppDataPath(appId);

    // One diff for both storage keys. `reportCompatible` is the switch-plan variant, where an
    // unchanged target is still worth a line; update plans stay silent about it.
    private static void AddStorageTargetChanges(
        List<string> changes,
        AppRecord app,
        string key,
        string? targetPath,
        bool reportCompatible)
    {
        var current = app.StorageMappings.FirstOrDefault(mapping => string.Equals(mapping.Key, key, StringComparison.Ordinal));
        if (current is null && targetPath is null)
        {
            return;
        }

        if (current is null)
        {
            changes.Add($"{key}:added:{targetPath}");
        }
        else if (targetPath is null)
        {
            changes.Add($"{key}:removed:{current.TargetPath}");
        }
        else if (!string.Equals(current.TargetPath, targetPath, StringComparison.Ordinal))
        {
            changes.Add($"{key}:target:{current.TargetPath}->{targetPath}");
        }
        else if (reportCompatible)
        {
            changes.Add($"{key}:compatible");
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

    // Filters a declared list down to the canonical vocabulary, dropping retired lifecycle tokens
    // (`update`, `stop`, ...) and anything unknown. Applied to BOTH sides of an update diff so a
    // record installed under the old vocabulary does not surface a wall of phantom
    // `capability:*:removed` changes on its next update plan.
    //
    // Takes a nullable list because one caller passes AppRecord.Capabilities, a positional record
    // parameter deserialized straight from state.json: nothing enforces the non-null contract at
    // runtime, so a hand-edited or truncated file yields null here. Matches how the registry store
    // already reads its own deserialized collections (`app.PortAssignments ?? []`).
    private static IReadOnlyList<string> NormalizeCapabilities(IReadOnlyList<string>? capabilities)
        => (capabilities ?? []).Where(CanonicalCapabilities.Contains).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();

    // A manifest that declares no capabilities gets the default set; one that declares any list has it
    // normalized (replace, not merge — the author states exactly which optional features they support,
    // and with lifecycle tokens out of the vocabulary a partial list can no longer strip an inherent
    // operation the way it used to).
    private static IReadOnlyList<string> ResolveCapabilities(RuntimeAppManifest manifest)
        => manifest.Capabilities.Count == 0 ? DefaultCapabilities : NormalizeCapabilities(manifest.Capabilities);

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

    // Under the local-config provider, persist the derived HOSTY_PUBLIC_ORIGIN_<endpoint> values before
    // start so the existing settings->env pipeline injects them. The host is deterministic, so this runs
    // before the runtime port is known. No other provider derives: under "cloudflare-remote" an operator
    // label owns the hostname, and re-deriving here is what used to overwrite a published origin on
    // every start.
    private async Task<AppRecord> EnsureIngressPublicOriginsAsync(
        AppRecord app,
        RuntimeAppManifestSelection selection,
        CancellationToken cancellationToken)
    {
        if (!ingress.DerivesPublicOrigins)
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

    // Drops publications whose endpoint the app no longer declares as public. Best-effort by design: this
    // runs inside an update apply that has already committed, so a Cloudflare failure must not turn a
    // successful update into a failed one.
    private async Task CleanUpOrphanedPublicationsAsync(string appId, AppRecord app, CancellationToken cancellationToken)
    {
        if (cloudflarePublications is null)
        {
            return;
        }

        try
        {
            var publicKeys = (app.Endpoints ?? [])
                .Where(endpoint => endpoint.Public && !string.IsNullOrWhiteSpace(endpoint.Key))
                .Select(endpoint => endpoint.Key)
                .ToArray();
            await cloudflarePublications.RemoveOrphanedAsync(appId, publicKeys, cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "Cloudflare publication cleanup for updated app {AppId} did not complete.", appId);
        }
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
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Best-effort: ingress reconciliation runs on the startup BackgroundService path and on the
            // /api/core/settings save path, so it must never throw — an unhandled exception would crash
            // the host on the former and 500 the save on the latter. Catch everything but cancellation
            // (which must propagate) and log for visibility rather than swallowing silently.
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

    // Refuses a `configure` write to a public origin the active ingress provider owns, so the stored
    // value cannot diverge from what the provider will apply. Only a *changed* value is refused: a client
    // that resends the whole settings form unchanged is not trying to take ownership, and failing that
    // would make every unrelated setting on the page unsavable. Clearing counts as a change — a managed
    // origin goes away by unpublishing or by switching provider, not by blanking the field.
    private static void RequireUnmanagedPublicOrigins(
        AppRecord app,
        IReadOnlyDictionary<string, string?>? settings,
        IReadOnlyCollection<string> managedKeys)
    {
        if (settings is null || managedKeys.Count == 0)
        {
            return;
        }

        foreach (var key in managedKeys)
        {
            if (!settings.TryGetValue(key, out var submitted))
            {
                continue;
            }

            var current = app.Settings.TryGetValue(key, out var existing) ? existing.Value : null;
            // Blank and unset are the same value here. The settings form posts "" for a public origin
            // that has none yet — which is every derived origin before the app's first start — and
            // treating that as a change would make the whole form unsavable on a host that has ingress on.
            if (string.Equals(Blank(submitted), Blank(current), StringComparison.Ordinal))
            {
                continue;
            }

            throw new AppLifecycleException(
                "public_origin_managed",
                $"'{key}' is managed by the active ingress provider and cannot be set here. Change it through the provider, or switch the ingress provider to 'none' to own it yourself.");
        }

        static string? Blank(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
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
            !AppRuntimeStates.IsUp(app.RuntimeState) ||
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

    // Maps an aggregate health status to the coarse persisted RuntimeState. Note the two vocabularies
    // overlap by name and not by meaning: the health "starting" here is a CONTAINER whose HEALTHCHECK
    // has not passed yet — the container is already up, so it reconciles to `running`, and it must
    // never be confused with the app-level AppRuntimeStates.Starting ("no container yet"). This mapper
    // therefore only ever returns terminal states; it can never write a transitional one, which is what
    // keeps the supervisor from fighting a lifecycle verb for the record. "unhealthy" (a partial
    // outage) is ambiguous and maps to `unknown`; anything unrecognized leaves the state untouched.
    internal static string? ResolveRuntimeStateFromHealth(AppRuntimeHealthResult health)
        => health.Status switch
        {
            "healthy" or "degraded" or "starting" => AppRuntimeStates.Running,
            "stopped" => AppRuntimeStates.Stopped,
            "unhealthy" => AppRuntimeStates.Unknown,
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
                AppRuntimeStates.IsUp(app.RuntimeState) ||
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
            (!AppRuntimeStates.IsUp(app.RuntimeState) && !supervised))
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

    // The canonical capability vocabulary: optional, app-provided *features* a client may surface —
    // never lifecycle operations. start/stop/restart/update/remove are inherent to Core managing an
    // app and are authorized by the admin session on the endpoint (see LifecycleEndpoints), never by
    // this list: an app must not be able to opt out of being stopped or updated by omitting a token.
    // `open` is derived from the app's endpoints and `restore` lives inside the backup panel, so
    // neither was ever read by a client either. Historic manifests still declare all of the above;
    // NormalizeCapabilities strips them. Defaults coincide with the vocabulary because omitting the
    // field means "whatever optional features this app has". See docs/features/core-app-shell.md.
    private static readonly string[] DefaultCapabilities = ["backup", "logs"];

    private static readonly HashSet<string> CanonicalCapabilities = new(DefaultCapabilities, StringComparer.Ordinal);
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
    // Handle of the reviewed install plan to apply. Required on every HTTP install (the endpoints
    // reject its absence with install_plan_required); when present, ManifestPath/SelectedRuntime/
    // System are taken from the reviewed plan, not from this request. Absent only for in-process
    // callers installing from trusted local manifests (boot bootstrap).
    string? PlanId = null,
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
    // Only "pinned" is accepted; null leaves the current policy unchanged. The authoritative
    // pull/lock policy for compiled artifacts (replaces the removed manifest pullPolicy; the
    // "rolling" opt-out is gone).
    string? UpdatePolicy = null);

internal sealed record AppAutostartRequest(bool Autostart);

/// <summary>One setting's stored value, served only through the admin-gated reveal endpoint.</summary>
internal sealed record AppSettingValueResponse(string Key, string? Value);

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

// Read-only preview of what an uninstall would affect, for the confirmation surfaces (Shell's remove
// panel, `hosty setup`). Advisory by contract: nothing here blocks a removal, and an app that affects
// nothing returns empty collections.
internal sealed record AppRemovalImpact(
    string AppId,
    string DisplayName,
    // Reported so a surface can word the confirmation for an app only administrators can see; it is
    // not a lifecycle restriction.
    bool System,
    IReadOnlyList<AppRemovalDependent> Dependents,
    IReadOnlyList<AppRemovalCapabilityImpact> Capabilities,
    // Hosty-published hostnames that removal takes offline. An "adopted" one keeps its DNS record — Hosty
    // manages it but did not create it — so the two states read differently in the confirmation.
    IReadOnlyList<AppRemovalPublicOrigin> PublicOrigins);

// One published hostname that goes away with the app.
internal sealed record AppRemovalPublicOrigin(string EndpointKey, string Hostname, string OwnershipState);

// An installed app that declares a cross-app dependency on the app being removed. Aliases name the
// HOSTY_DEPENDENCY_{ALIAS}_URL variables that stop resolving; a running dependent keeps its current
// values until it restarts.
internal sealed record AppRemovalDependent(
    string AppId,
    string DisplayName,
    string RuntimeState,
    bool Required,
    IReadOnlyList<string> Aliases);

internal sealed record AppRemovalCapabilityImpact(
    string Slot,
    IReadOnlyList<AppRemovalConsumer> Consumers);

internal sealed record AppRemovalConsumer(string AppId, string DisplayName, string RuntimeState);

internal sealed record AppManualBackupRequest(string? Reason = null);

internal sealed record AppRestoreBackupRequest(bool CreatePreRestoreBackup = false);

internal sealed record AppRuntimeSwitchPlanRequest(string TargetRuntime);

internal sealed record AppRuntimeSwitchApplyRequest(string TargetRuntime, string PlanDigest);

internal sealed record ReassignPortPlanRequest(string Service, string PortKey);

// `Mode` selects how the new port is decided: "automatic" (Core allocates, clearing any operator pin) or
// "manual" (`Port` is validated and pinned). Absent/blank means automatic, so an older Shell's payload keeps
// working unchanged against a newer Core. `Port` is ignored unless the mode is manual.
internal sealed record ReassignPortRequest(string Service, string PortKey, string Digest, string? Mode = null, int? Port = null)
{
    public const string ModeAutomatic = "automatic";
    public const string ModeManual = "manual";

    public bool IsManual => string.Equals(Mode, ModeManual, StringComparison.OrdinalIgnoreCase);

    // True when the caller stated a mode at all. An explicit mode means the operator chose this outcome in
    // a UI that can express both, which is what licenses touching an existing pin — including handing it
    // back to automatic. A legacy request carries no mode and no such intent.
    public bool HasExplicitMode => !string.IsNullOrWhiteSpace(Mode);

    // The operator-chosen port, or null for an automatic allocation. Validated downstream by the allocator
    // against the live exclusion view; this only decides which of the two operations runs.
    public int? DesiredPort => IsManual ? Port : null;

    public void Validate()
    {
        if (!string.IsNullOrWhiteSpace(Mode) &&
            !IsManual &&
            !string.Equals(Mode, ModeAutomatic, StringComparison.OrdinalIgnoreCase))
        {
            throw new AppLifecycleException("reassign_mode_invalid", $"Unknown reassignment mode '{Mode}'. Use '{ModeAutomatic}' or '{ModeManual}'.");
        }

        if (IsManual && Port is null)
        {
            throw new AppLifecycleException("port_required", "Manual reassignment needs a port.");
        }
    }
}

internal sealed record ReassignDependentImpact(string AppId, bool Running);

internal sealed record ReassignPortPlan(
    string AppId,
    string Service,
    string PortKey,
    int CurrentPort,
    string? CurrentUrl,
    bool OwnerRunning,
    IReadOnlyList<ReassignDependentImpact> AffectedDependents,
    // True when the current port is an operator pin rather than an automatic assignment, so the dialog can
    // open in the mode the endpoint is actually in and offer a way back to automatic.
    bool Pinned,
    // Lowest port a manual pin may use — everything below needs privileges Core does not have.
    int MinManualPort,
    // Binds a later apply to this structural state; apply fails with reassign_state_changed on mismatch.
    string Digest);

internal sealed record ReassignPortResult(
    string AppId,
    string Service,
    string PortKey,
    int OldPort,
    int NewPort,
    string? NewUrl,
    // Apps the operator should explicitly restart to pick up the new port: the owning app (if running,
    // it still binds the old port) and any running dependent (still holding the old injected local URL).
    IReadOnlyList<string> RestartRequiredAppIds);

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
    // Random single-use handle the apply echoes back to install exactly the reviewed selection
    // (see reviewedInstallPlans). Null on the plan embedded in a feed-install flow, which binds by
    // plan digest instead.
    string? PlanId,
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
    IReadOnlyList<AppInstallSetting> Settings,
    // Per-service image digests resolved at plan time (C-CR1 Fix B): CandidateDigest is what the
    // bound apply pins as the run-lock; null when unresolvable (offline / local-only image), in
    // which case that service TOFU-backfills at first start. Absent on the feed-embedded plan.
    IReadOnlyList<AppServiceArtifactProbe>? ArtifactDigests = null);

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
    bool SourceConfigured = true,
    // True when the change list carries anything beyond routine version/manifest/resolved-artifact
    // movement, so a client must show the plan to a human instead of applying it silently (see
    // CoreLifecycleService.PlanRequiresReview). Derived from Changes, which the plan digest already
    // covers — excluded from the digest seed. Defaulted so older payloads stay compatible.
    bool RequiresReview = false);

// Pending reviewed-update plan read (see GetPendingUpdatePlanAsync). A null plan means nothing is
// pending for the app: never built, expired, or already consumed by an apply.
internal sealed record AppPendingUpdatePlanResponse(AppUpdatePlan? Plan);

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
// aggregates feed-manifest and compiled-service movement; `UpdatePolicy` is always "pinned".
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
// be reached so no candidate could be resolved, or there is no lock to compare a candidate against.
internal sealed record AppServiceUpdateStatus(
    string Service,
    string? LockedDigest,
    string? CandidateDigest,
    bool UpdateAvailable,
    bool Unknown);

// One shared registry-probe result for a compiled service (see ProbeServiceArtifactsAsync). Rides the
// cached update plan so the status projection reads the plan build's probe instead of re-hitting the
// registry. Not serialized — internal plan/status plumbing only.
internal sealed record AppServiceArtifactProbe(string Service, string? LockedDigest, string? CandidateDigest);
