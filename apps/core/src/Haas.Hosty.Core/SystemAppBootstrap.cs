namespace Haas.Hosty.Core;

// A distribution-list app that the runtime supervisor installs and reconciles at boot. Descriptors
// are data-driven: the release-owned distribution list (DistributionApps) merged with the operator's
// bootstrap choices produces one descriptor per entry — adding a first-party app is a list entry,
// not a code path. App-specific behavior (the Shell settings map, the collector's provisioning) still
// attaches by app id here; replacing that with capability-based hooks is Phase 4 of
// docs/ideas/generic-bootstrap.md.
internal sealed record SystemAppBootstrapDescriptor(
    string AppId,
    // Human-readable handle used in bootstrap log messages.
    string DisplayName,
    // A disabled descriptor is skipped entirely (e.g. telemetry disabled means no collector install).
    bool Enabled,
    // Fully resolved manifest path/URL from the distribution list (or a deprecated legacy env
    // override); a blank value skips the bootstrap with a warning.
    string? ManifestPath,
    // Null lets the manifest default choose on first install and preserves the installed selection
    // during reconciliation (the default for policy-free entries such as Marketplace).
    string? Runtime,
    // Null uses the normal install default and preserves the operator's installed value later.
    bool? Autostart,
    // Core-owned bootstrap settings passed at install and re-applied on every boot so operator
    // configuration (e.g. the Shell port) follows the current Core config.
    IReadOnlyDictionary<string, string?>? Settings = null,
    // Optional local source override for development installs (development Shell workflow).
    string? SourceOverridePath = null,
    // App-specific provisioning that must run after install/reconcile and before the app starts
    // (e.g. the collector's Core-owned config.yaml and sink directories).
    Func<CoreLifecycleService, CancellationToken, Task>? ProvisionAsync = null,
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

// The merge result: descriptors to reconcile plus human-readable warnings (deprecated overrides,
// inert choices) for the supervisor to log.
internal sealed record SystemAppBootstrapPlan(
    IReadOnlyList<SystemAppBootstrapDescriptor> Descriptors,
    IReadOnlyList<string> Warnings);

internal static class SystemAppBootstraps
{
    // Bootstrap order is the distribution-list order (install/reconcile order); start order is
    // governed by StartPriority in the autostart reconciliation instead.
    public static SystemAppBootstrapPlan FromDistribution(
        IReadOnlyList<DistributionAppEntry> entries,
        BootstrapChoicesDocument? choices,
        HostyCoreRuntimeConfig config)
    {
        var warnings = new List<string>();
        var descriptors = new List<SystemAppBootstrapDescriptor>(entries.Count);
        var legacy = config.Legacy ?? LegacyBootstrapEnv.Empty;

        foreach (var entry in entries)
        {
            var enabled = choices?.EnabledFor(entry.Id) ?? LegacyEnabled(entry.Id, legacy) ?? entry.DefaultEnabled;
            var manifestPath = ApplyLegacyManifestOverride(entry, legacy, warnings);
            descriptors.Add(entry.Id switch
            {
                ShellBootstrap.AppId => new SystemAppBootstrapDescriptor(
                    entry.Id,
                    DisplayName: entry.Title,
                    Enabled: enabled,
                    ManifestPath: manifestPath,
                    Runtime: config.ShellBootstrapRuntime,
                    Autostart: config.ShellAutostart,
                    Settings: ShellBootstrap.BuildBootstrapSettings(config),
                    SourceOverridePath: config.ShellSourceOverridePath,
                    FeedsUrl: entry.FeedsUrl),
                CollectorBootstrap.AppId => new SystemAppBootstrapDescriptor(
                    entry.Id,
                    DisplayName: entry.Title,
                    Enabled: enabled,
                    ManifestPath: manifestPath,
                    Runtime: config.CollectorBootstrapRuntime,
                    // Autostart is a normal per-app setting: install default on first install, the
                    // operator's later choice preserved (HOSTY_COLLECTOR_AUTOSTART is gone).
                    Autostart: null,
                    ProvisionAsync: CollectorBootstrap.ProvisionAsync,
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

        if (choices is not null)
        {
            var known = entries.Select(entry => entry.Id).ToHashSet(StringComparer.Ordinal);
            foreach (var id in choices.Apps.Keys.Where(id => !known.Contains(id)).OrderBy(id => id, StringComparer.Ordinal))
            {
                // Kept in the file (a future release may re-add the entry), reported as inert.
                warnings.Add($"Bootstrap choice for '{id}' matches no distribution-list entry and is inert.");
            }
        }

        return new SystemAppBootstrapPlan(descriptors, warnings);
    }

    // Explicit legacy env values sit between operator choices (which win) and release defaults.
    // Only deviations matter: shell defaulted to enabled and observability to disabled, so the
    // absent-var case falls through to the distribution default either way.
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

    // Autostart ordering across apps: higher starts earlier. Static (not descriptor-driven) because
    // ordering must not depend on which descriptors are currently enabled — an installed collector
    // still starts before OTLP-consuming apps even if telemetry was later disabled. Capability-based
    // ordering from the manifest is Phase 4.
    public static int StartPriority(string appId) => appId switch
    {
        // The collector starts first so its OTLP endpoint resolves before other apps come up.
        CollectorBootstrap.AppId => 100,
        _ => 0,
    };
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

    public static IReadOnlyDictionary<string, string?> BuildBootstrapSettings(HostyCoreRuntimeConfig config)
    {
        var shellPort = config.ShellPort.ToString(System.Globalization.CultureInfo.InvariantCulture);
        var settings = new Dictionary<string, string?>(StringComparer.Ordinal)
        {
            ["HOSTY_PORT_HTTP"] = shellPort,
        };

        if (Uri.TryCreate(config.EffectiveShellPublicOrigin, UriKind.Absolute, out var shellOrigin))
        {
            if (!string.IsNullOrWhiteSpace(shellOrigin.Host))
            {
                settings["HOSTNAME"] = shellOrigin.Host;
            }
        }

        return settings;
    }
}
