namespace Haas.Hosty.Core;

// One snapshot row of the bootstrap state: a distribution entry merged with the operator's choice
// and the installed record, for the bootstrap endpoints and the Shell Extensions panel.
internal sealed record SystemAppBootstrapStatus(
    DistributionAppEntry Entry,
    bool Enabled,
    bool? Choice,
    AppRecord? Installed);

internal sealed record SystemAppBootstrapState(
    string Source,
    IReadOnlyList<string> Problems,
    IReadOnlyList<SystemAppBootstrapStatus> Apps);

// Owns the generic bootstrap flow: resolving the distribution list + operator choices into
// descriptors, installing/reconciling them, and flipping choices at runtime. Shared by the boot
// supervisor (RuntimeAppSupervisorService) and the host-admin bootstrap endpoints so a live toggle
// takes exactly the boot path. See docs/ideas/generic-bootstrap.md (Phases 1 and 3).
internal sealed class SystemAppBootstrapService(
    HostyCoreRuntimeConfig config,
    AppRegistryStore apps,
    CoreLifecycleService lifecycle,
    AppSourceService sources,
    DistributionAppsProvider distribution,
    BootstrapChoicesStore bootstrapChoices,
    ILogger<SystemAppBootstrapService> logger)
{
    // Resolves the boot bootstrap set: the release-owned distribution list merged with the
    // operator's bootstrap choices (and, transitionally, the deprecated legacy env overrides).
    // Loud but non-fatal throughout — a broken list or choices file boots Core on the embedded
    // defaults rather than taking the host down. Runs the one-time upgrade migration first, so it
    // belongs to the boot path; the endpoints use PlanAsync/GetStateAsync instead.
    public async Task<IReadOnlyList<SystemAppBootstrapDescriptor>> PlanBootAsync(CancellationToken cancellationToken)
    {
        try
        {
            var list = await distribution.LoadAsync(cancellationToken);
            distribution.LogProblems(list);
            logger.LogInformation(
                "Distribution list ({Source}) declares {Count} app(s): {Ids}.",
                list.Source,
                list.Apps.Count,
                string.Join(", ", list.Apps.Select(entry => entry.Id)));

            await MigrateBootstrapChoicesAsync(list, cancellationToken);

            return await PlanAsync(list, cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogError(ex, "System app bootstrap planning failed; no system apps will be reconciled this boot. Core remains available through CLI and control APIs.");
            return [];
        }
    }

    private async Task<IReadOnlyList<SystemAppBootstrapDescriptor>> PlanAsync(
        DistributionAppsResult list,
        CancellationToken cancellationToken)
    {
        var plan = SystemAppBootstraps.FromDistribution(list.Apps, await bootstrapChoices.LoadAsync(cancellationToken), config);
        foreach (var warning in plan.Warnings)
        {
            logger.LogWarning("Bootstrap: {Warning}", warning);
        }

        return plan.Descriptors;
    }

    // Snapshot for the bootstrap endpoints: every distribution entry with its effective enablement,
    // the operator's explicit choice (if any), and the installed record.
    public async Task<SystemAppBootstrapState> GetStateAsync(CancellationToken cancellationToken)
    {
        var list = await distribution.LoadAsync(cancellationToken);
        var choices = await bootstrapChoices.LoadAsync(cancellationToken);
        var descriptors = SystemAppBootstraps.FromDistribution(list.Apps, choices, config).Descriptors
            .ToDictionary(descriptor => descriptor.AppId, StringComparer.Ordinal);

        var statuses = new List<SystemAppBootstrapStatus>(list.Apps.Count);
        foreach (var entry in list.Apps)
        {
            // One descriptor per entry is guaranteed by FromDistribution's construction; the guard
            // only keeps a future planner change from turning into a 500 here.
            statuses.Add(new SystemAppBootstrapStatus(
                entry,
                descriptors.TryGetValue(entry.Id, out var descriptor) && descriptor.Enabled,
                choices?.EnabledFor(entry.Id),
                await apps.GetAppAsync(entry.Id, cancellationToken)));
        }

        return new SystemAppBootstrapState(list.Source, list.Problems, statuses);
    }

    // Flips one choice at runtime. Enabling reconciles the entry immediately (the exact boot path:
    // install, provenance, settings, provisioning) and returns an action error when that failed —
    // the choice itself is still persisted, matching setup's persist-intent semantics. Disabling
    // only stops future reconciles; the installed app keeps running until explicitly uninstalled.
    public async Task<string?> SetChoiceAsync(string appId, bool enabled, CancellationToken cancellationToken)
    {
        var list = await distribution.LoadAsync(cancellationToken);
        var entry = list.Apps.FirstOrDefault(candidate => string.Equals(candidate.Id, appId, StringComparison.Ordinal))
            ?? throw new AppLifecycleException(
                "bootstrap_app_unknown",
                $"App id '{appId}' is not part of this release's distribution list.");

        await bootstrapChoices.SetEnabledAsync(entry.Id, enabled, cancellationToken);
        if (!enabled)
        {
            return null;
        }

        var descriptor = (await PlanAsync(list, cancellationToken))
                .FirstOrDefault(candidate => string.Equals(candidate.AppId, entry.Id, StringComparison.Ordinal))
            ?? throw new AppLifecycleException(
                "bootstrap_plan_failed",
                $"'{entry.Id}' could not be planned from the distribution list.");
        try
        {
            await EnsureInstalledCoreAsync(descriptor, cancellationToken);
            var app = await apps.GetAppAsync(entry.Id, cancellationToken)
                ?? throw new AppLifecycleException("bootstrap_install_failed", $"'{entry.Id}' was not installed.");
            if (!string.Equals(app.RuntimeState, "running", StringComparison.Ordinal))
            {
                await lifecycle.StartAsync(entry.Id, cancellationToken);
            }

            return null;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "Live bootstrap enable for {AppId} did not complete; the choice is saved and the boot reconcile will retry.", appId);
            return ex is AppLifecycleException lifecycleError ? lifecycleError.Message : ex.Message;
        }
    }

    // One-time upgrade migration: a host that already has apps installed but no choices file gets its
    // current effective state pinned as explicit choices. Without this, a distribution default that
    // differs from the legacy behavior (e.g. marketplace defaultEnabled) would silently change an
    // existing install on the first boot after the upgrade. Fresh installs (empty registry) write
    // nothing and follow the release defaults. A failed install attempt on a fresh host is safe: the
    // registry only gains records on successful installs, so the entry retries next boot.
    private async Task MigrateBootstrapChoicesAsync(DistributionAppsResult list, CancellationToken cancellationToken)
    {
        try
        {
            if (bootstrapChoices.Exists)
            {
                return;
            }

            var installed = await apps.ListAppRecordsAsync(cancellationToken);
            if (installed.Count == 0)
            {
                return;
            }

            var legacy = config.Legacy ?? LegacyBootstrapEnv.Empty;
            var installedIds = installed.Select(app => app.Id).ToHashSet(StringComparer.Ordinal);
            var pins = new Dictionary<string, BootstrapChoiceEntry>(StringComparer.Ordinal);
            foreach (var entry in list.Apps)
            {
                var legacyEnabled = entry.Id switch
                {
                    ShellBootstrap.AppId => legacy.ShellBootstrapEnabled,
                    CollectorBootstrap.AppId => legacy.ObservabilityEnabled,
                    MarketplaceBootstrap.AppId when legacy.MarketplaceManifestPathConfigured =>
                        !string.IsNullOrWhiteSpace(legacy.MarketplaceManifestPath),
                    _ => null,
                };
                pins[entry.Id] = new BootstrapChoiceEntry
                {
                    Enabled = installedIds.Contains(entry.Id) || legacyEnabled == true,
                };
            }

            if (await bootstrapChoices.SeedIfAbsentAsync(new BootstrapChoicesDocument { Apps = pins }, cancellationToken))
            {
                logger.LogInformation(
                    "Migrated bootstrap choices from the installed state: {Choices}.",
                    string.Join(", ", pins.Select(pair => $"{pair.Key}={(pair.Value.Enabled == true ? "enabled" : "disabled")}")));
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            // Non-fatal: this boot runs on the synthesized-in-memory equivalent of the defaults; the
            // migration retries on the next boot.
            logger.LogWarning(ex, "Bootstrap choices migration did not complete; continuing with release defaults for this boot.");
        }
    }

    // Generic install-or-reconcile for a distribution-list descriptor. Best-effort by design: a
    // failure here must never crash the supervisor — Core stays fully usable through CLI and control
    // APIs, just without the optional system app. The live-enable path (SetChoiceAsync) uses the
    // throwing core so the caller can surface the error.
    public async Task EnsureInstalledAsync(SystemAppBootstrapDescriptor descriptor, CancellationToken cancellationToken)
    {
        try
        {
            await EnsureInstalledCoreAsync(descriptor, cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "{DisplayName} bootstrap did not complete; Core remains available through CLI and control APIs.", descriptor.DisplayName);
        }
    }

    private async Task EnsureInstalledCoreAsync(SystemAppBootstrapDescriptor descriptor, CancellationToken cancellationToken)
    {
        if (!descriptor.Enabled)
        {
            return;
        }

        if (string.IsNullOrWhiteSpace(descriptor.ManifestPath))
        {
            logger.LogWarning("{DisplayName} bootstrap skipped because no manifest path or URL was configured.", descriptor.DisplayName);
            return;
        }

        var app = await apps.GetAppAsync(descriptor.AppId, cancellationToken);
        if (app is null)
        {
            await InstallSystemAppAsync(descriptor, cancellationToken);
            app = await apps.GetAppAsync(descriptor.AppId, cancellationToken);
        }
        else
        {
            app = await ReconcileSystemAppManifestAsync(descriptor, app, cancellationToken);
        }

        // Provenance + system flag: the app is installed (or adopted) by the distribution
        // bootstrap. Stamped after install/reconcile so it covers pre-existing records from
        // earlier Core versions too; uninstalling a distribution-origin app then records
        // enabled=false in choices so the next boot does not resurrect it. The system flag is
        // normalized alongside because the feed install path passes System=false and relies on
        // the manifest role — which a distribution app is not required to declare.
        if (app is not null &&
            (!string.Equals(app.InstallOrigin, AppInstallOrigins.Distribution, StringComparison.Ordinal) || !app.System))
        {
            await apps.UpdateAppAsync(
                descriptor.AppId,
                record => record with { InstallOrigin = AppInstallOrigins.Distribution, System = true },
                cancellationToken);
        }

        if (app is not null && descriptor.Settings is { Count: > 0 })
        {
            await lifecycle.ConfigureAsync(descriptor.AppId, new AppConfigureRequest(descriptor.Settings), cancellationToken);
        }

        if (app is not null && descriptor.Autostart is bool configuredAutostart && app.Autostart != configuredAutostart)
        {
            await lifecycle.ConfigureAutostartAsync(descriptor.AppId, new AppAutostartRequest(configuredAutostart), cancellationToken);
        }

        if (app is not null && !string.IsNullOrWhiteSpace(descriptor.SourceOverridePath))
        {
            await sources.SetLocalOverrideAsync(
                descriptor.AppId,
                new AppSourceOverrideRequest(descriptor.SourceOverridePath),
                cancellationToken);
        }

        if (app is not null && descriptor.ProvisionAsync is not null)
        {
            await descriptor.ProvisionAsync(lifecycle, cancellationToken);
        }
    }

    // First install of a distribution entry. Entries carrying a feedsUrl go through the digest-bound
    // feed path (plan + immediate apply) so the record follows the feed and gets the standard update
    // affordance; entries without one install directly from the resolved manifest ref, as before.
    private async Task InstallSystemAppAsync(SystemAppBootstrapDescriptor descriptor, CancellationToken cancellationToken)
    {
        if (!string.IsNullOrWhiteSpace(descriptor.FeedsUrl))
        {
            var plan = await lifecycle.CreateFeedInstallPlanAsync(
                new AppFeedInstallPlanRequest(descriptor.FeedsUrl, FeedId: null, descriptor.Runtime, descriptor.Autostart),
                cancellationToken);
            await lifecycle.ApplyFeedInstallAsync(
                new AppFeedInstallApplyRequest(
                    descriptor.FeedsUrl,
                    plan.FeedId,
                    descriptor.Runtime,
                    descriptor.Settings,
                    descriptor.Autostart,
                    plan.PlanDigest,
                    // Started by the boot reconciliation (StartAutostartAppsAsync) in priority order.
                    StartOnInstall: false),
                cancellationToken);
            return;
        }

        await lifecycle.InstallAsync(new AppInstallRequest(
            ManifestPath: descriptor.ManifestPath!,
            SelectedRuntime: descriptor.Runtime,
            System: true,
            Settings: descriptor.Settings,
            Autostart: descriptor.Autostart,
            // Started by the boot reconciliation (StartAutostartAppsAsync) in priority order —
            // not inline here, which would double-start and race other system-app bootstraps.
            StartOnInstall: false), cancellationToken);
    }

    private async Task<AppRecord?> ReconcileSystemAppManifestAsync(
        SystemAppBootstrapDescriptor descriptor,
        AppRecord app,
        CancellationToken cancellationToken)
    {
        // A feed-bound record updates through the normal digest-bound feed update flow (update-status,
        // reviewed apply); a boot-time manifest reconcile would bypass that review and strip the feed
        // state, so it is deliberately skipped.
        if (!string.IsNullOrWhiteSpace(app.FeedsUrl))
        {
            return app;
        }

        if (descriptor.Runtime is not null &&
            !string.Equals(app.SelectedRuntime ?? descriptor.Runtime, descriptor.Runtime, StringComparison.Ordinal))
        {
            logger.LogInformation(
                "{DisplayName} bootstrap reconciliation skipped because installed runtime {InstalledRuntime} differs from configured runtime {ConfiguredRuntime}.",
                descriptor.DisplayName,
                app.SelectedRuntime,
                descriptor.Runtime);
            return app;
        }

        var plan = await lifecycle.CreateUpdatePlanAsync(
            descriptor.AppId,
            new AppUpdatePlanRequest(descriptor.ManifestPath, descriptor.Runtime ?? app.SelectedRuntime),
            cancellationToken);

        // Reconcile also when the configured manifest reference itself moved (e.g. a renamed raw URL
        // or a switch between remote and local), even with zero content changes — otherwise the
        // record keeps updating from a stale source forever.
        if (plan.Changes.Count == 0 && !HasManifestReferenceChanged(descriptor, app))
        {
            return app;
        }

        logger.LogInformation(
            "{DisplayName} bootstrap applying manifest reconciliation with {ChangeCount} reported changes.",
            descriptor.DisplayName,
            plan.Changes.Count);
        await lifecycle.ApplyUpdateAsync(
            descriptor.AppId,
            new AppUpdateApplyRequest(
                PlanDigest: plan.PlanDigest,
                ManifestPath: descriptor.ManifestPath,
                SelectedRuntime: descriptor.Runtime ?? app.SelectedRuntime),
            cancellationToken);
        return await apps.GetAppAsync(descriptor.AppId, cancellationToken);
    }

    private static bool IsHttpManifestReference(string? manifestPath)
        => Uri.TryCreate(manifestPath, UriKind.Absolute, out var uri) &&
            (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps);

    private static bool HasManifestReferenceChanged(SystemAppBootstrapDescriptor descriptor, AppRecord app)
    {
        if (IsHttpManifestReference(descriptor.ManifestPath))
        {
            return !string.Equals(app.ManifestUrl, descriptor.ManifestPath, StringComparison.Ordinal);
        }

        return !string.IsNullOrWhiteSpace(app.ManifestUrl);
    }
}
