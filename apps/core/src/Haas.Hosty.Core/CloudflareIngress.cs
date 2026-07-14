using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;

namespace Haas.Hosty.Core;

// Ingress turns a runtime app's loopback ports into externally reachable, TLS-terminated URLs.
// Core does not run a reverse proxy itself; the cloudflared provider drives an operator-run
// Cloudflare Tunnel by writing its config file and auto-deriving HOSTY_PUBLIC_ORIGIN_* values.
// The provider and its identity are live settings (CoreSettingsService.Ingress): provider "none"
// (the default) leaves exposure and origins to the operator; the single controller reads the current
// value each call, so a platform-panel edit takes effect without a restart.
internal interface IIngressController
{
    // True when Core derives HOSTY_PUBLIC_ORIGIN_* itself; false when the operator owns them.
    bool ManagesPublicOrigins { get; }

    // Desired HOSTY_PUBLIC_ORIGIN_<endpoint> settings for an app's public endpoints. The host
    // is deterministic (subdomain + base domain), so this is known before the app starts.
    IReadOnlyDictionary<string, string> ResolvePublicOrigins(
        string appId,
        string? subdomainOverride,
        IReadOnlyList<string> publicEndpointKeys);

    // Re-render the whole tunnel config from the set of running apps. Declarative and idempotent;
    // best-effort (never throws into a lifecycle operation).
    Task ReconcileAsync(IReadOnlyList<AppRecord> apps, CancellationToken cancellationToken = default);
}

// The one ingress controller. It reads the live ingress config from CoreSettingsService and no-ops when
// the provider is "none", so there is no separate "none" implementation to swap in at startup — the
// provider is an operator setting, not a DI-time choice.
internal sealed class CloudflaredIngressController(
    CoreSettingsService settings,
    HostyCoreRuntimeConfig config,
    ILogger<CloudflaredIngressController> logger) : IIngressController
{
    private static readonly IReadOnlyDictionary<string, string> Empty =
        new Dictionary<string, string>(StringComparer.Ordinal);

    public bool ManagesPublicOrigins => settings.Ingress.ManagesPublicOrigins;

    public IReadOnlyDictionary<string, string> ResolvePublicOrigins(
        string appId,
        string? subdomainOverride,
        IReadOnlyList<string> publicEndpointKeys)
    {
        var ingress = settings.Ingress;
        if (!ingress.ManagesPublicOrigins || string.IsNullOrWhiteSpace(ingress.BaseDomain) || publicEndpointKeys.Count == 0)
        {
            return Empty;
        }

        var subdomain = CloudflaredIngressPlanner.ResolveSubdomain(appId, subdomainOverride);
        return CloudflaredIngressPlanner.ResolveOrigins(ingress.BaseDomain, subdomain, publicEndpointKeys);
    }

    public async Task ReconcileAsync(IReadOnlyList<AppRecord> apps, CancellationToken cancellationToken = default)
    {
        var ingress = settings.Ingress;
        // Provider "none" or missing identity/domain: do not write a half-formed config that cloudflared
        // would reject. Incomplete cloudflared config is surfaced via /api/core/status warnings. Remove a
        // config we previously wrote so an operator-run cloudflared stops serving the stale routes — the
        // live toggle must actually disable ingress, not just stop updating it.
        if (!ingress.ManagesPublicOrigins ||
            string.IsNullOrWhiteSpace(ingress.BaseDomain) ||
            string.IsNullOrWhiteSpace(ingress.TunnelId) ||
            string.IsNullOrWhiteSpace(ingress.CredentialsFile))
        {
            RemoveManagedConfig();
            return;
        }

        var path = config.EffectiveIngressConfigPath;
        try
        {
            var ingressApps = apps
                .Where(app => string.Equals(app.RuntimeState, "running", StringComparison.Ordinal))
                .Select(app => new IngressApp(
                    CloudflaredIngressPlanner.ResolveSubdomain(app.Id, ReadSubdomainOverride(app)),
                    (app.Endpoints ?? [])
                        .Where(endpoint => endpoint.Public && !string.IsNullOrWhiteSpace(endpoint.Url))
                        .Select(endpoint => new IngressEndpoint(endpoint.Key, endpoint.Url!))
                        .ToArray()))
                .Where(app => app.Endpoints.Count > 0)
                .ToArray();

            var routes = CloudflaredIngressPlanner.BuildRoutes(ingress.BaseDomain, config.CorePort, ingressApps);
            var yaml = CloudflaredIngressPlanner.RenderConfig(ingress.TunnelId, ingress.CredentialsFile, routes);

            var directory = Path.GetDirectoryName(path);
            if (!string.IsNullOrWhiteSpace(directory))
            {
                SecureFileSystem.EnsurePrivateDirectory(directory);
            }

            // Atomic temp+rename (the parent dir is already ensured private above): a partial write here
            // would feed cloudflared a truncated config on its next reload.
            await JsonStorage.WriteTextAsync(path, yaml, cancellationToken);
            logger.LogInformation("Hosty ingress config written to {Path} with {RouteCount} route(s).", path, routes.Count);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            // ArgumentException/NotSupportedException guard against a malformed configured path
            // (Path.GetDirectoryName / File.WriteAllTextAsync) escaping the best-effort boundary.
            logger.LogWarning(ex, "Hosty ingress config could not be written to {Path}.", path);
        }
    }

    private static string? ReadSubdomainOverride(AppRecord app)
        => app.Settings.TryGetValue(CloudflaredIngressPlanner.SubdomainSettingKey, out var setting)
            ? setting.Value
            : null;

    // Best-effort removal of a config we own. Guarded on the managed header so a custom
    // HOSTY_INGRESS_CONFIG_PATH aimed at an operator-authored file is never deleted when ingress is
    // disabled; a missing file is a no-op.
    private void RemoveManagedConfig()
    {
        var path = config.EffectiveIngressConfigPath;
        try
        {
            if (!File.Exists(path) || !IsManagedConfig(path))
            {
                return;
            }

            File.Delete(path);
            logger.LogInformation("Hosty ingress disabled; removed managed tunnel config at {Path}.", path);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            logger.LogWarning(ex, "Hosty ingress config at {Path} could not be removed.", path);
        }
    }

    private static bool IsManagedConfig(string path)
    {
        foreach (var line in File.ReadLines(path))
        {
            return line.StartsWith(CloudflaredIngressPlanner.ManagedHeaderPrefix, StringComparison.Ordinal);
        }

        return false;
    }
}

// Pure helpers for hostname/origin derivation and cloudflared config rendering, so the lifecycle
// integration stays thin and the routing logic is unit-tested without touching the filesystem.
internal static class CloudflaredIngressPlanner
{
    // Per-app operator override for the auto-derived subdomain (e.g. "pm" -> pm.example.com).
    public const string SubdomainSettingKey = "HOSTY_INGRESS_SUBDOMAIN";

    // Core's own UI/API is seeded under this subdomain so apps can reach it via the tunnel too.
    public const string CoreSubdomain = "core";

    // Stamped as the first line of every generated config so the controller can recognise (and safely
    // remove) a file it owns when ingress is disabled.
    public const string ManagedHeaderPrefix = "# Managed by Hosty Core";

    private static readonly Regex HostLabelPattern =
        new("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", RegexOptions.Compiled);

    // Single-level subdomains keep everything under one wildcard CNAME (`*.example.com`), which
    // Cloudflare Universal SSL covers; two-level names would need a per-host certificate.
    public static string Hostname(string subdomain, string baseDomain, string? endpointLabel)
        => endpointLabel is null
            ? $"{subdomain}.{baseDomain}"
            : $"{subdomain}-{endpointLabel}.{baseDomain}";

    public static string ResolveSubdomain(string appId, string? overrideValue)
        => string.IsNullOrWhiteSpace(overrideValue)
            ? ToLabel(appId, "app")
            : ToLabel(overrideValue, ToLabel(appId, "app"));

    public static bool IsValidHostname(string hostname)
        => hostname.Length <= 253 &&
            hostname.Split('.').All(label => HostLabelPattern.IsMatch(label));

    public static IReadOnlyDictionary<string, string> ResolveOrigins(
        string baseDomain,
        string subdomain,
        IReadOnlyList<string> publicEndpointKeys)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        var single = publicEndpointKeys.Count == 1;
        foreach (var key in publicEndpointKeys)
        {
            var hostname = Hostname(subdomain, baseDomain, single ? null : ToLabel(key, "endpoint"));
            if (IsValidHostname(hostname))
            {
                result[PublicOriginSettings.BuildSettingKey(key)] = $"https://{hostname}";
            }
        }

        return result;
    }

    public static IReadOnlyList<CloudflaredRoute> BuildRoutes(
        string baseDomain,
        int corePort,
        IReadOnlyList<IngressApp> apps)
    {
        var routes = new List<CloudflaredRoute>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        void Add(string hostname, string service)
        {
            if (IsValidHostname(hostname) && seen.Add(hostname))
            {
                routes.Add(new CloudflaredRoute(hostname, service));
            }
        }

        Add($"{CoreSubdomain}.{baseDomain}", $"http://localhost:{corePort.ToString(CultureInfo.InvariantCulture)}");

        foreach (var app in apps.OrderBy(app => app.Subdomain, StringComparer.Ordinal))
        {
            var single = app.Endpoints.Count == 1;
            foreach (var endpoint in app.Endpoints.OrderBy(endpoint => endpoint.Key, StringComparer.Ordinal))
            {
                Add(Hostname(app.Subdomain, baseDomain, single ? null : ToLabel(endpoint.Key, "endpoint")), endpoint.ServiceUrl);
            }
        }

        return routes;
    }

    public static string RenderConfig(
        string tunnelId,
        string credentialsFile,
        IReadOnlyList<CloudflaredRoute> routes)
    {
        var builder = new StringBuilder();
        builder.AppendLine($"{ManagedHeaderPrefix} - do not edit. Regenerated on runtime app lifecycle changes.");
        builder.AppendLine($"tunnel: {YamlQuote(tunnelId)}");
        builder.AppendLine($"credentials-file: {YamlQuote(credentialsFile)}");
        builder.AppendLine("ingress:");
        foreach (var route in routes)
        {
            // Hostnames are validated to a strict DNS-label charset, so they are safe unquoted;
            // operator-supplied paths and service URLs are quoted to avoid YAML scalar edge cases.
            builder.AppendLine($"  - hostname: {route.Hostname}");
            builder.AppendLine($"    service: {YamlQuote(route.Service)}");
        }

        // cloudflared requires a catch-all rule as the final ingress entry.
        builder.AppendLine("  - service: http_status:404");
        return builder.ToString();
    }

    // Double-quoted YAML scalar with the minimal escaping double-quoted style requires.
    private static string YamlQuote(string value)
        => $"\"{value.Replace("\\", "\\\\", StringComparison.Ordinal).Replace("\"", "\\\"", StringComparison.Ordinal)}\"";

    // Lowercase, collapse non-alphanumerics to single hyphens, trim to a valid DNS label.
    public static string ToLabel(string value, string fallback)
    {
        var lowered = value.Trim().ToLowerInvariant();
        var builder = new StringBuilder(lowered.Length);
        var lastWasHyphen = false;
        foreach (var character in lowered)
        {
            if (char.IsAsciiLetterOrDigit(character))
            {
                builder.Append(character);
                lastWasHyphen = false;
            }
            else if (!lastWasHyphen)
            {
                builder.Append('-');
                lastWasHyphen = true;
            }
        }

        var label = builder.ToString().Trim('-');
        if (label.Length > 63)
        {
            label = label[..63].Trim('-');
        }

        return string.IsNullOrEmpty(label) ? fallback : label;
    }
}

internal sealed record CloudflaredRoute(string Hostname, string Service);

internal sealed record IngressEndpoint(string Key, string ServiceUrl);

internal sealed record IngressApp(string Subdomain, IReadOnlyList<IngressEndpoint> Endpoints);
