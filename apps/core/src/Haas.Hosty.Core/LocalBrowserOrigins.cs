namespace Haas.Hosty.Core;

// Browser names are independent of the URLs used to probe or dial local processes. Do not persist
// these defaults as public-origin settings: an operator must still be able to distinguish publication.
internal static class LocalBrowserOrigins
{
    public static string Site(string instanceId = "")
        => string.IsNullOrEmpty(instanceId) ? "hosty.localhost" : $"i-{instanceId}.hosty.localhost";

    public static string AppHost(string appId, string instanceId = "")
    {
        // Escape the escape character first. Unlike punctuation replacement this is injective for
        // manifest IDs, including IDs differing only by '.', '_' or '-'. Labels stay below 63 bytes.
        var encoded = appId.Replace("-", "-h", StringComparison.Ordinal)
            .Replace(".", "-d", StringComparison.Ordinal).Replace("_", "-u", StringComparison.Ordinal);
        var labels = Enumerable.Range(0, (encoded.Length + 49) / 50)
            .Select(i => "a" + encoded.Substring(i * 50, Math.Min(50, encoded.Length - i * 50)) + "z");
        return $"{string.Join('.', labels)}.{Site(instanceId)}";
    }

    public static bool IsPlainLoopback(Uri uri)
        => uri.Scheme == "http" && uri.Host is "localhost" or "127.0.0.1" or "[::1]";

    public static string Core(string origin, string instanceId = "")
        => Uri.TryCreate(origin, UriKind.Absolute, out var uri) && IsPlainLoopback(uri)
            ? WithHost(uri, $"core.{Site(instanceId)}") : origin;

    public static string? App(AppRecord app, AppEndpointContract endpoint)
    {
        if (endpoint.Public && app.Settings.TryGetValue(PublicOriginSettings.BuildSettingKey(endpoint.Key), out var setting)
            && PublicOriginSettings.TryNormalizeOrigin(setting.Value, out var configured)) return configured;
        if (!Uri.TryCreate(endpoint.Url, UriKind.Absolute, out var uri)) return endpoint.Url;
        return endpoint.Public && IsPlainLoopback(uri)
            ? WithHost(uri, AppHost(app.Id, app.BrowserOriginScope)) : endpoint.Url;
    }

    public static IReadOnlyDictionary<string, string> Environment(AppRecord app, IEnumerable<AppEndpointContract> endpoints)
        => endpoints.Where(e => e.Public).Select(e => (Key: PublicOriginSettings.BuildSettingKey(e.Key), Origin: App(app, e)))
            .Where(e => e.Origin is not null).ToDictionary(e => e.Key, e => e.Origin!, StringComparer.Ordinal);

    private static string WithHost(Uri uri, string host)
        => new UriBuilder(uri) { Host = host }.Uri.GetLeftPart(UriPartial.Authority);

    public static bool SameHost(string? left, string? right)
        => Uri.TryCreate(left, UriKind.Absolute, out var a) && Uri.TryCreate(right, UriKind.Absolute, out var b)
            && string.Equals(a.IdnHost.TrimEnd('.'), b.IdnHost.TrimEnd('.'), StringComparison.OrdinalIgnoreCase);

    public static async Task ValidateCoreAsync(string origin, AppRegistryStore apps, CancellationToken ct)
    {
        foreach (var app in await apps.ListAppRecordsAsync(ct))
            foreach (var endpoint in app.Endpoints.Where(e => e.Public))
                if (SameHost(origin, App(app, endpoint)) || SameHost(origin, endpoint.Url))
                    throw new AppLifecycleException("origin_host_conflict", "Core needs a hostname that no runtime app uses. Choose a separate hostname.");
    }

    public static async Task ValidateAppAsync(AppRecord candidate, string coreOrigin, AppRegistryStore apps, CancellationToken ct)
    {
        var others = await apps.ListAppRecordsAsync(ct);
        foreach (var endpoint in candidate.Endpoints.Where(e => e.Public))
        {
            var origin = App(candidate, endpoint) ?? $"http://{AppHost(candidate.Id, candidate.BrowserOriginScope)}";
            if (SameHost(origin, coreOrigin) || SameHost(origin, $"http://core.{Site(candidate.BrowserOriginScope)}"))
                throw new AppLifecycleException("origin_host_conflict", "This hostname belongs to Core. Choose a separate app hostname.");
            foreach (var other in others.Where(a => a.Id != candidate.Id))
                foreach (var otherEndpoint in other.Endpoints.Where(e => e.Public))
                    if (SameHost(origin, App(other, otherEndpoint)) || SameHost(origin, $"http://{AppHost(other.Id, other.BrowserOriginScope)}"))
                        throw new AppLifecycleException("origin_host_conflict", $"This hostname belongs to '{other.Id}'. Choose a separate app hostname.");
        }
    }
}
