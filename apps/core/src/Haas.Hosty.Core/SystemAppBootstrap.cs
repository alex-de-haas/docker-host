namespace Haas.Hosty.Core;

// A Core-bundled optional system app that the runtime supervisor installs and reconciles at boot.
// Descriptors replace the earlier per-app bootstrap branches (Shell, telemetry collector): adding
// the next first-party system app (e.g. a marketplace) means adding a descriptor to
// SystemAppBootstraps.FromConfig, not another code path. See docs/ideas/marketplace-system-app.md
// (Phase 0, generic optional-system-app bootstrap).
internal sealed record SystemAppBootstrapDescriptor(
    string AppId,
    // Human-readable handle used in bootstrap log messages.
    string DisplayName,
    // A disabled descriptor is skipped entirely (e.g. observability off means no collector install).
    bool Enabled,
    // Env-resolved or bundled manifest path/URL; a blank value skips the bootstrap with a warning.
    string? ManifestPath,
    // Null lets the manifest default choose on first install and preserves the installed selection
    // during reconciliation (used by Marketplace).
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
    Func<CoreLifecycleService, CancellationToken, Task>? ProvisionAsync = null);

internal static class SystemAppBootstraps
{
    // Bootstrap order is the install/reconcile order; start order is governed by StartPriority in
    // the autostart reconciliation instead.
    public static IReadOnlyList<SystemAppBootstrapDescriptor> FromConfig(HostyCoreRuntimeConfig config) =>
    [
        ShellBootstrap.CreateDescriptor(config),
        CollectorBootstrap.CreateDescriptor(config),
        MarketplaceBootstrap.CreateDescriptor(config),
    ];

    // Autostart ordering across apps: higher starts earlier. Static (not descriptor-driven) because
    // ordering must not depend on which descriptors are currently enabled — an installed collector
    // still starts before OTLP-consuming apps even if observability was later disabled.
    public static int StartPriority(string appId) => appId switch
    {
        // The collector starts first so its OTLP endpoint resolves before other apps come up.
        CollectorBootstrap.AppId => 100,
        _ => 0,
    };
}

// Marketplace is enabled only by an explicit manifest path. Unlike Shell/collector, Core owns no
// runtime or autostart policy for it: first install follows the manifest defaults and later boots
// preserve the operator's installed choices.
internal static class MarketplaceBootstrap
{
    public const string AppId = "hosty.marketplace";

    public static SystemAppBootstrapDescriptor CreateDescriptor(HostyCoreRuntimeConfig config)
        => new(
            AppId,
            DisplayName: "Hosty Marketplace",
            Enabled: !string.IsNullOrWhiteSpace(config.MarketplaceManifestPath),
            ManifestPath: config.MarketplaceManifestPath,
            Runtime: null,
            Autostart: null);
}

// Bootstrap identity and Core-owned install settings for the Hosty Shell system app.
internal static class ShellBootstrap
{
    public const string AppId = "hosty.shell";

    public static SystemAppBootstrapDescriptor CreateDescriptor(HostyCoreRuntimeConfig config)
        => new(
            AppId,
            DisplayName: "Hosty Shell",
            Enabled: config.ShellBootstrapEnabled,
            ManifestPath: config.ShellManifestPath,
            Runtime: config.ShellBootstrapRuntime,
            Autostart: config.ShellAutostart,
            Settings: BuildBootstrapSettings(config),
            SourceOverridePath: config.ShellSourceOverridePath);

    private static IReadOnlyDictionary<string, string?> BuildBootstrapSettings(HostyCoreRuntimeConfig config)
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
