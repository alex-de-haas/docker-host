namespace Haas.Hosty.Core;

// A distribution-catalog app, resolved into everything an install needs. Descriptors are
// data-driven: the release-owned distribution list (DistributionApps) produces one per entry —
// adding a first-party app is a list entry, not a code path.
internal sealed record SystemAppBootstrapDescriptor(
    string AppId,
    // Human-readable handle used in log messages.
    string DisplayName,
    // Whether a fresh host seeds this entry. Irrelevant to an explicit install, which is intent in
    // its own right (see SystemAppBootstrapService.InstallAsync).
    bool Enabled,
    // Fully resolved manifest path/URL from the distribution list (or a deprecated legacy env
    // override); a blank value skips the bootstrap with a warning.
    string? ManifestPath,
    // Null lets the manifest default choose on first install and preserves the installed selection
    // during reconciliation — the normal case for every entry, since the runtime profile is a per-app
    // choice (manifest default, then whatever the operator switched to). Only a source tree or
    // air-gapped fork pins a non-null profile through the ambient dev/fork override env.
    string? Runtime,
    // Null uses the normal install default and preserves the operator's installed value later.
    bool? Autostart,
    // Core-owned settings passed at install. Empty for every entry today — the platform owns no app
    // setting anymore; each app declares its own in its manifest.
    IReadOnlyDictionary<string, string?>? Settings = null,
    // Optional local source override for development installs (development Shell workflow).
    string? SourceOverridePath = null,
    // When set, the first install goes through the digest-bound feed path so the record follows the
    // feed for updates like any other app. Reconciliation of an already feed-bound app is left to the
    // normal update flow.
    string? FeedsUrl = null);

// Raw legacy bootstrap environment, captured verbatim (no default substitution) so the distribution
// merge can tell "operator/CLI explicitly set this" from "unset". Honored for one release with
// deprecation warnings; drops together with the CLI's per-app launch settings (Phase 2).
internal sealed record LegacyBootstrapEnv(
    string? ShellManifestPath = null,
    bool? ShellBootstrapEnabled = null,
    string? CollectorManifestPath = null,
    bool? ObservabilityEnabled = null,
    string? MarketplaceManifestPath = null,
    // The marketplace variable distinguishes present-but-empty (explicit disable, per the pivot's
    // contract) from absent, so presence is tracked separately from the normalized value.
    bool MarketplaceManifestPathConfigured = false)
{
    public static readonly LegacyBootstrapEnv Empty = new();
}

// The resolved catalog: one descriptor per entry plus human-readable warnings (deprecated overrides)
// for the caller to log.
internal sealed record SystemAppBootstrapPlan(
    IReadOnlyList<SystemAppBootstrapDescriptor> Descriptors,
    IReadOnlyList<string> Warnings);

internal static class SystemAppBootstraps
{
    // Seed order is the distribution-list order; start order is governed by StartPriority in the
    // autostart reconciliation instead.
    public static SystemAppBootstrapPlan FromDistribution(
        IReadOnlyList<DistributionAppEntry> entries,
        HostyCoreRuntimeConfig config)
    {
        var warnings = new List<string>();
        var descriptors = new List<SystemAppBootstrapDescriptor>(entries.Count);
        var legacy = config.Legacy ?? LegacyBootstrapEnv.Empty;

        foreach (var entry in entries)
        {
            var enabled = LegacyEnabled(entry.Id, legacy) ?? entry.DefaultEnabled;
            var manifestPath = ApplyLegacyManifestOverride(entry, legacy, warnings);
            descriptors.Add(entry.Id switch
            {
                ShellBootstrap.AppId => new SystemAppBootstrapDescriptor(
                    entry.Id,
                    DisplayName: entry.Title,
                    Enabled: enabled,
                    ManifestPath: manifestPath,
                    // Null unless the ambient dev/fork override is set: manifest default on first
                    // install (docker), operator's switch-runtime choice preserved on later boots.
                    Runtime: config.ShellBootstrapRuntime,
                    Autostart: config.ShellAutostart,
                    SourceOverridePath: config.ShellSourceOverridePath,
                    FeedsUrl: entry.FeedsUrl),
                CollectorBootstrap.AppId => new SystemAppBootstrapDescriptor(
                    entry.Id,
                    DisplayName: entry.Title,
                    Enabled: enabled,
                    ManifestPath: manifestPath,
                    // Runtime and autostart are both normal per-app settings: manifest default on first
                    // install, the operator's later choice preserved. HOSTY_COLLECTOR_AUTOSTART is gone;
                    // HOSTY_COLLECTOR_BOOTSTRAP_RUNTIME survives only as an ambient dev/fork override
                    // (null when unset). Config + sink-dir provisioning is no longer wired here — it
                    // runs on the start path keyed by the manifest's `provides: [otlp-collector]`
                    // (see PlatformCapabilities).
                    Runtime: config.CollectorBootstrapRuntime,
                    Autostart: null,
                    FeedsUrl: entry.FeedsUrl),
                _ => new SystemAppBootstrapDescriptor(
                    entry.Id,
                    DisplayName: entry.Title,
                    Enabled: enabled,
                    ManifestPath: manifestPath,
                    Runtime: null,
                    Autostart: null,
                    FeedsUrl: entry.FeedsUrl),
            });
        }

        return new SystemAppBootstrapPlan(descriptors, warnings);
    }

    // Explicit legacy env values override the release default for what a fresh host seeds. Only
    // deviations matter: shell defaulted to enabled and observability to disabled, so the absent-var
    // case falls through to the distribution default either way.
    private static bool? LegacyEnabled(string appId, LegacyBootstrapEnv legacy) => appId switch
    {
        ShellBootstrap.AppId => legacy.ShellBootstrapEnabled,
        CollectorBootstrap.AppId => legacy.ObservabilityEnabled,
        MarketplaceBootstrap.AppId when legacy.MarketplaceManifestPathConfigured =>
            !string.IsNullOrWhiteSpace(legacy.MarketplaceManifestPath),
        _ => null,
    };

    private static string? ApplyLegacyManifestOverride(
        DistributionAppEntry entry,
        LegacyBootstrapEnv legacy,
        List<string> warnings)
    {
        var (legacyRef, variable) = entry.Id switch
        {
            ShellBootstrap.AppId => (legacy.ShellManifestPath, "HOSTY_SHELL_MANIFEST_PATH"),
            CollectorBootstrap.AppId => (legacy.CollectorManifestPath, "HOSTY_COLLECTOR_MANIFEST_PATH"),
            MarketplaceBootstrap.AppId => (legacy.MarketplaceManifestPath, "HOSTY_MARKETPLACE_MANIFEST_PATH"),
            _ => (null, null),
        };

        if (string.IsNullOrWhiteSpace(legacyRef) || string.Equals(legacyRef, entry.ManifestRef, StringComparison.Ordinal))
        {
            // The CLI still injects its default manifest URLs until Phase 2; an override that matches
            // the distribution entry is not operator intent, so it neither warns nor overrides.
            return entry.ManifestRef;
        }

        warnings.Add(
            $"{variable} overrides the distribution-list manifest reference for '{entry.Id}' " +
            $"('{legacyRef}' instead of '{entry.ManifestRef}'). This variable is deprecated; the override will stop working in a future release.");
        return legacyRef;
    }
}

// Stable app id for the marketplace entry. Policy-free: Core owns no runtime or autostart choice for
// it — first install follows the manifest defaults and later boots preserve the operator's installed
// choices.
internal static class MarketplaceBootstrap
{
    public const string AppId = "hosty.marketplace";
}

// Bootstrap identity and Core-owned install settings for the Hosty Shell system app.
internal static class ShellBootstrap
{
    public const string AppId = "hosty.shell";

    // The endpoint Shell publishes. Named here because ShellPublicOriginResolver resolves against this
    // endpoint's public-origin setting specifically, rather than whichever public endpoint sorts first.
    public const string WebEndpointKey = "web";

    // No Core-owned settings left. HOSTY_PORT_HTTP used to be stamped from HOSTY_SHELL_PORT, which made
    // Core impersonate an operator port override (RuntimePortAllocator classifies the setting as
    // AppPortSources.Operator) and left Shell's own manifest claiming a port it never ran on. The port is
    // declared in that manifest now, like any app's. HOSTY_PUBLIC_ORIGIN_WEB was stamped from
    // HOSTY_SHELL_PUBLIC_ORIGIN as the transition that moved the origin into the record; the record owns
    // it from here, so an operator's edit finally sticks instead of being overwritten every boot.
    //
    // Records installed before this keep whichever values they were stamped, which is exactly right:
    // 7171 and the configured origin, now genuinely theirs and editable.
    //
    // A boot-time cleanup of the long-retired HOSTNAME setting used to live here. It is gone with the
    // rest of the per-boot reconcile: boot no longer edits an installed app's record at all. Hosts
    // that still carry the key see one inert row in the app's settings, which the operator can clear.
}
