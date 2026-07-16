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
    // during reconciliation — the normal case for every entry, since the runtime profile is a per-app
    // choice (manifest default, then whatever the operator switched to). Only a source tree or
    // air-gapped fork pins a non-null profile through the ambient dev/fork override env.
    string? Runtime,
    // Null uses the normal install default and preserves the operator's installed value later.
    bool? Autostart,
    // Core-owned bootstrap settings passed at install and re-applied on every boot so operator
    // configuration (e.g. the Shell port) follows the current Core config.
    IReadOnlyDictionary<string, string?>? Settings = null,
    // Setting keys the bootstrap once stamped and no longer owns. Dropped from the record on boot:
    // ConfigureAsync can only null a value, not remove the key, so without this a retired Core-owned
    // setting lingers forever in the app's settings UI as an editable no-op.
    IReadOnlyList<string>? RetiredSettings = null,
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
                    // Null unless the ambient dev/fork override is set: manifest default on first
                    // install (docker), operator's switch-runtime choice preserved on later boots.
                    Runtime: config.ShellBootstrapRuntime,
                    Autostart: config.ShellAutostart,
                    RetiredSettings: ShellBootstrap.RetiredSettings,
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
    // 7171 and the configured origin, now genuinely theirs and editable. Nothing is retired — unlike
    // HOSTNAME these are real settings an operator may want; RetiredSettings would delete them on every
    // boot and make them impossible to set.
    // HOSTNAME used to be stamped here from the Shell public origin's host. It never did anything: the
    // manifest declares HOSTNAME=0.0.0.0 as the Next.js bind address, and a service's manifest
    // environment is appended *after* the settings in the docker run args, so docker's last-wins
    // handling of a duplicated `-e` meant the bind address always won. All the setting achieved was a
    // row in the app's settings that looked like it controlled the public origin — it did not; Core's
    // own HOSTY_SHELL_PUBLIC_ORIGIN drives that — while colliding with a variable that means something
    // else entirely. Retired here so records that still carry it are cleaned up on boot.
    public static readonly IReadOnlyList<string> RetiredSettings = ["HOSTNAME"];
}
