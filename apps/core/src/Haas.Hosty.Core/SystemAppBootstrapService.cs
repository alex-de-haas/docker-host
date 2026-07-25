namespace Haas.Hosty.Core;

// One row of the distribution catalog: what the release offers, and whether this host has it
// installed right now. There is no third state — enablement intent no longer exists.
internal sealed record SystemAppBootstrapStatus(
    DistributionAppEntry Entry,
    AppRecord? Installed);

internal sealed record SystemAppBootstrapState(
    string Source,
    IReadOnlyList<string> Problems,
    bool Seeded,
    IReadOnlyList<SystemAppBootstrapStatus> Apps);

// Owns the distribution catalog: seeding a brand-new host once, and installing a catalog entry on
// demand for `hosty setup`. After the seed pass the list is nothing but a catalog — boot installs
// nothing, so an app the operator removed stays removed no matter which surface removed it.
// See docs/features/removable-system-apps/.
internal sealed class SystemAppBootstrapService(
    HostyCoreRuntimeConfig config,
    AppRegistryStore apps,
    CoreLifecycleService lifecycle,
    AppSourceService sources,
    DistributionAppsProvider distribution,
    DistributionSeedStore seed,
    ILogger<SystemAppBootstrapService> logger)
{
    // Boot entry point. On a host that has never been seeded, installs the distribution entries the
    // release enables by default; on every other boot this is a no-op beyond adopting the marker and
    // re-applying ambient development overrides. Loud but non-fatal throughout — a broken list or a
    // failed install must never take Core down, since Core is how the operator fixes it.
    public async Task SeedBootAsync(CancellationToken cancellationToken)
    {
        try
        {
            var list = await distribution.LoadAsync(cancellationToken);
            distribution.LogProblems(list);
            logger.LogInformation(
                "Distribution list ({Source}) offers {Count} app(s): {Ids}.",
                list.Source,
                list.Apps.Count,
                string.Join(", ", list.Apps.Select(entry => entry.Id)));

            var plan = SystemAppBootstraps.FromDistribution(list.Apps, config);
            foreach (var warning in plan.Warnings)
            {
                logger.LogWarning("Distribution: {Warning}", warning);
            }

            if (await IsSeededAsync(cancellationToken))
            {
                // Adopts pre-seeding hosts: the marker is written without installing anything, so the
                // apps they already chose (and the ones they removed) are left exactly as they are.
                if (await seed.MarkSeededAsync(plan.Descriptors.Select(d => d.AppId).ToArray(), cancellationToken))
                {
                    logger.LogInformation("Existing host adopted as seeded; the distribution list is a catalog from here on.");
                }
            }
            else
            {
                await SeedFreshHostAsync(plan, cancellationToken);
            }

            await ApplyDevelopmentOverridesAsync(plan.Descriptors, cancellationToken);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogError(ex, "Distribution seeding failed; no first-party apps were installed this boot. Core remains available through CLI and control APIs.");
        }
    }

    // A host counts as seeded when it carries the marker, the pre-seeding choices file, or any
    // installed app at all. The last check is what keeps an upgrade from re-installing a first-party
    // app the operator had already removed under the old boot-reconcile model.
    private async Task<bool> IsSeededAsync(CancellationToken cancellationToken)
        => seed.Exists ||
            seed.HasLegacyChoices ||
            (await apps.ListAppRecordsAsync(cancellationToken)).Count > 0;

    private async Task SeedFreshHostAsync(SystemAppBootstrapPlan plan, CancellationToken cancellationToken)
    {
        var enabled = plan.Descriptors.Where(descriptor => descriptor.Enabled).ToArray();
        logger.LogInformation(
            "Seeding a new host with {Count} first-party app(s): {Ids}.",
            enabled.Length,
            enabled.Length == 0 ? "(none)" : string.Join(", ", enabled.Select(descriptor => descriptor.AppId)));

        var complete = true;
        foreach (var descriptor in enabled)
        {
            complete &= await TryEnsureInstalledAsync(descriptor, cancellationToken);
        }

        if (!complete)
        {
            // The marker is withheld so the next boot retries. Retrying is safe: seeding installs only
            // what is absent, and a host that has anything installed is already treated as seeded —
            // which is why the retry window closes as soon as the first app lands.
            logger.LogWarning("Seeding did not install every default app; the seed marker is withheld so the next boot retries.");
            return;
        }

        await seed.MarkSeededAsync(plan.Descriptors.Select(descriptor => descriptor.AppId).ToArray(), cancellationToken);
    }

    // Snapshot for the bootstrap endpoints and `hosty setup`: every catalog entry with its live
    // installed record.
    public async Task<SystemAppBootstrapState> GetStateAsync(CancellationToken cancellationToken)
    {
        var list = await distribution.LoadAsync(cancellationToken);
        var statuses = new List<SystemAppBootstrapStatus>(list.Apps.Count);
        foreach (var entry in list.Apps)
        {
            statuses.Add(new SystemAppBootstrapStatus(entry, await apps.GetAppAsync(entry.Id, cancellationToken)));
        }

        return new SystemAppBootstrapState(list.Source, list.Problems, seed.Exists, statuses);
    }

    // Installs one catalog entry on demand and starts it — the operation behind `hosty setup --with`
    // and the recovery path for an app the operator removed. Explicit intent overrides the release's
    // defaultEnabled: asking for an entry by id is the decision. Already installed is a no-op beyond
    // the start.
    public async Task InstallAsync(string appId, CancellationToken cancellationToken)
    {
        var list = await distribution.LoadAsync(cancellationToken);
        var entry = list.Apps.FirstOrDefault(candidate => string.Equals(candidate.Id, appId, StringComparison.Ordinal))
            ?? throw new AppLifecycleException(
                "bootstrap_app_unknown",
                $"App id '{appId}' is not part of this release's distribution list.");

        var descriptor = SystemAppBootstraps.FromDistribution([entry], config).Descriptors
                .FirstOrDefault(candidate => string.Equals(candidate.AppId, entry.Id, StringComparison.Ordinal))
            ?? throw new AppLifecycleException(
                "bootstrap_plan_failed",
                $"'{entry.Id}' could not be resolved from the distribution list.");

        await EnsureInstalledAsync(descriptor with { Enabled = true }, cancellationToken);
        var app = await apps.GetAppAsync(entry.Id, cancellationToken)
            ?? throw new AppLifecycleException("bootstrap_install_failed", $"'{entry.Id}' was not installed.");
        if (!string.Equals(app.RuntimeState, "running", StringComparison.Ordinal))
        {
            await lifecycle.StartAsync(entry.Id, cancellationToken);
        }
    }

    private async Task<bool> TryEnsureInstalledAsync(SystemAppBootstrapDescriptor descriptor, CancellationToken cancellationToken)
    {
        try
        {
            await EnsureInstalledAsync(descriptor, cancellationToken);
            return true;
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "{DisplayName} was not installed; Core remains available through CLI and control APIs.", descriptor.DisplayName);
            return false;
        }
    }

    private async Task EnsureInstalledAsync(SystemAppBootstrapDescriptor descriptor, CancellationToken cancellationToken)
    {
        if (!descriptor.Enabled)
        {
            return;
        }

        if (string.IsNullOrWhiteSpace(descriptor.ManifestPath) && string.IsNullOrWhiteSpace(descriptor.FeedsUrl))
        {
            throw new AppLifecycleException(
                "bootstrap_manifest_missing",
                $"'{descriptor.AppId}' has no manifest reference or feed in the distribution list.");
        }

        if (await apps.GetAppAsync(descriptor.AppId, cancellationToken) is null)
        {
            await InstallDistributionAppAsync(descriptor, cancellationToken);
        }

        // Provenance only. Whether the app is a *system* app is decided by its manifest role on the
        // normal install path, exactly as for any other install — membership in the distribution list
        // confers no privilege of its own.
        if (await apps.GetAppAsync(descriptor.AppId, cancellationToken) is { } app &&
            !string.Equals(app.InstallOrigin, AppInstallOrigins.Distribution, StringComparison.Ordinal))
        {
            await apps.UpdateAppAsync(
                descriptor.AppId,
                record => record with { InstallOrigin = AppInstallOrigins.Distribution },
                cancellationToken);
        }
    }

    // Entries carrying a feedsUrl go through the digest-bound feed path (plan + immediate apply) so
    // the record follows the feed and gets the standard update affordance; entries without one
    // install directly from the resolved manifest ref.
    private async Task InstallDistributionAppAsync(SystemAppBootstrapDescriptor descriptor, CancellationToken cancellationToken)
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
            // The manifest's role decides, like every other install path.
            System: false,
            Settings: descriptor.Settings,
            Autostart: descriptor.Autostart,
            // Started by the boot reconciliation (StartAutostartAppsAsync) in priority order — not
            // inline here, which would double-start and race the other seeded apps.
            StartOnInstall: false), cancellationToken);
    }

    // The one thing boot still applies to an already-installed app, and only in a source tree: the
    // ambient development source override (HOSTY_SHELL_SOURCE_OVERRIDE_PATH and friends). It is a
    // pointer to the developer's own checkout, not app content, and is unset on every real host.
    private async Task ApplyDevelopmentOverridesAsync(
        IReadOnlyList<SystemAppBootstrapDescriptor> descriptors,
        CancellationToken cancellationToken)
    {
        foreach (var descriptor in descriptors.Where(descriptor => !string.IsNullOrWhiteSpace(descriptor.SourceOverridePath)))
        {
            if (await apps.GetAppAsync(descriptor.AppId, cancellationToken) is null)
            {
                continue;
            }

            try
            {
                await sources.SetLocalOverrideAsync(
                    descriptor.AppId,
                    new AppSourceOverrideRequest(descriptor.SourceOverridePath!),
                    cancellationToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(ex, "Could not apply the development source override for {AppId}.", descriptor.AppId);
            }
        }
    }
}
