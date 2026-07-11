using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Haas.Hosty.Core;

internal static class AppFeedsSchema
{
    public const string Version = "app-feeds.0.1";
    public const int MaxFeedIdLength = 128;
}

internal sealed class AppFeedsDocument
{
    public string? SchemaVersion { get; init; }
    public string? AppId { get; init; }
    public IReadOnlyList<AppFeedEntry> Feeds { get => field ?? []; init; } = [];
}

internal sealed class AppFeedEntry
{
    public string? Id { get; init; }
    public string? ManifestRef { get; init; }
    public bool? Default { get; init; }
}

internal sealed record AppFeed(string Id, string ManifestRef, bool Default);

internal sealed record AppFeedsSnapshot(
    string FeedsUrl,
    string AppId,
    IReadOnlyList<AppFeed> Feeds,
    string DocumentDigest);

internal sealed record AppFeedResolution(
    string FeedsUrl,
    string AppId,
    AppFeed Feed,
    string DocumentDigest);

internal sealed record AppFeedsResponse(
    string FeedsUrl,
    string? FollowedFeedId,
    IReadOnlyList<AppFeed> Feeds);

// Loads and validates the generic runtime-app feed document. The feed is untrusted lifecycle input:
// reads are HTTP(S)-only, bounded before and while streaming, and every field used by lifecycle is
// normalized before it leaves this service. Marketplace/catalog identity never participates here.
internal sealed class AppFeedService(HttpClient client)
{
    internal const int MaxFeedBytes = 1024 * 1024;

    private static readonly Regex AppIdPattern = new("^[a-z0-9][a-z0-9._-]{0,62}$", RegexOptions.Compiled);

    public async Task<AppFeedsSnapshot> LoadAsync(string? feedsUrl, CancellationToken cancellationToken = default)
    {
        var uri = ParseRemoteUrl(feedsUrl, "app_feeds_url_invalid", "Feed URL");
        string json;
        string digest;
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, uri);
            request.Headers.Accept.ParseAdd("application/json");
            using var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            if (!response.IsSuccessStatusCode)
            {
                throw new AppLifecycleException(
                    "app_feeds_fetch_failed",
                    $"Feed URL returned HTTP {(int)response.StatusCode}.");
            }

            if (response.Content.Headers.ContentLength is > MaxFeedBytes)
            {
                throw TooLarge();
            }

            await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
            var payload = await ReadCappedAndHashAsync(stream, cancellationToken) ?? throw TooLarge();
            json = payload.Json;
            digest = payload.Digest;
        }
        catch (AppLifecycleException)
        {
            throw;
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new AppLifecycleException("app_feeds_fetch_failed", $"Feed URL '{uri.AbsoluteUri}' timed out.");
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or InvalidOperationException)
        {
            throw new AppLifecycleException("app_feeds_fetch_failed", $"Feed URL '{uri.AbsoluteUri}' could not be read: {ex.Message}");
        }

        AppFeedsDocument document;
        try
        {
            document = JsonSerializer.Deserialize(json, CoreJsonSerializerContext.Default.AppFeedsDocument)
                ?? throw new JsonException("The document is null.");
        }
        catch (JsonException ex)
        {
            throw new AppLifecycleException("app_feeds_json_invalid", $"Feed document is not valid JSON: {ex.Message}");
        }

        if (!string.Equals(document.SchemaVersion, AppFeedsSchema.Version, StringComparison.Ordinal))
        {
            throw new AppLifecycleException(
                "app_feeds_schema_unsupported",
                $"Feed document schemaVersion must be '{AppFeedsSchema.Version}'.");
        }

        var appId = document.AppId?.Trim() ?? string.Empty;
        if (!AppIdPattern.IsMatch(appId))
        {
            throw new AppLifecycleException(
                "app_feeds_app_id_invalid",
                "Feed document appId must match ^[a-z0-9][a-z0-9._-]{0,62}$.");
        }

        if (document.Feeds.Count == 0)
        {
            throw new AppLifecycleException("app_feeds_empty", "Feed document must declare at least one feed.");
        }

        var ids = new HashSet<string>(StringComparer.Ordinal);
        var normalized = new List<AppFeed>(document.Feeds.Count);
        var defaultCount = 0;
        foreach (var candidate in document.Feeds)
        {
            if (candidate is null)
            {
                throw new AppLifecycleException("app_feed_id_invalid", "Feed id must be non-empty.");
            }

            var id = candidate.Id?.Trim() ?? string.Empty;
            if (id.Length == 0)
            {
                throw new AppLifecycleException("app_feed_id_invalid", "Feed id must be non-empty.");
            }

            if (id.Length > AppFeedsSchema.MaxFeedIdLength)
            {
                throw FeedIdTooLong();
            }

            if (!ids.Add(id))
            {
                throw new AppLifecycleException("app_feed_id_duplicate", $"Feed id '{id}' is declared more than once.");
            }

            var manifestUri = ParseRemoteUrl(candidate.ManifestRef, "app_feed_manifest_ref_invalid", $"Feed '{id}' manifestRef");
            var isDefault = candidate.Default == true;
            if (isDefault && ++defaultCount > 1)
            {
                throw new AppLifecycleException("app_feed_default_duplicate", "Feed document may declare at most one default feed.");
            }

            normalized.Add(new AppFeed(id, manifestUri.AbsoluteUri, isDefault));
        }

        if (normalized.Count == 1 && !normalized[0].Default)
        {
            normalized[0] = normalized[0] with { Default = true };
        }

        return new AppFeedsSnapshot(uri.AbsoluteUri, appId, normalized, digest);
    }

    public async Task<AppFeedResolution> ResolveAsync(
        string? feedsUrl,
        string? requestedFeedId,
        CancellationToken cancellationToken = default)
    {
        var requested = requestedFeedId?.Trim();
        if (requested?.Length > AppFeedsSchema.MaxFeedIdLength)
        {
            throw FeedIdTooLong();
        }

        var snapshot = await LoadAsync(feedsUrl, cancellationToken);
        AppFeed? selected;
        if (!string.IsNullOrWhiteSpace(requested))
        {
            selected = snapshot.Feeds.FirstOrDefault(feed => string.Equals(feed.Id, requested, StringComparison.Ordinal));
            if (selected is null)
            {
                throw new AppLifecycleException(
                    "app_feed_not_found",
                    $"Feed '{requested}' is not declared for '{snapshot.AppId}'. Available feeds: {string.Join(", ", snapshot.Feeds.Select(feed => feed.Id))}.");
            }
        }
        else
        {
            selected = snapshot.Feeds.FirstOrDefault(feed => feed.Default);
            if (selected is null)
            {
                throw new AppLifecycleException(
                    "app_feed_selection_required",
                    $"Feed document for '{snapshot.AppId}' declares several feeds without a default; select one explicitly.");
            }
        }

        return new AppFeedResolution(snapshot.FeedsUrl, snapshot.AppId, selected, snapshot.DocumentDigest);
    }

    private static Uri ParseRemoteUrl(string? value, string code, string label)
    {
        var trimmed = value?.Trim() ?? string.Empty;
        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) ||
            !string.IsNullOrWhiteSpace(uri.UserInfo))
        {
            throw new AppLifecycleException(code, $"{label} must be an absolute HTTP(S) URL without credentials.");
        }

        // SSRF guard: the feed document and its manifestRef are untrusted (catalog-sourced). Reject a
        // literal loopback/private/link-local/multicast IP host so a feed cannot point Core at an
        // internal address. Hostname-based resolution is deliberately not done here: the same manifest
        // fetch primitive already serves operator-chosen local URLs for direct installs, and the
        // in-memory feed test suite uses stub hosts — a full DNS-resolving policy is a broader,
        // separate decision. Combined with AllowAutoRedirect=false on the feed HttpClient, this closes
        // the direct literal-IP vector.
        if (IPAddress.TryParse(uri.Host, out var address) && IsPrivateAddress(address))
        {
            throw new AppLifecycleException(code, $"{label} must not resolve to a private, loopback, or link-local address.");
        }

        return uri;
    }

    // Loopback, private, link-local (incl. 169.254.169.254 metadata), CGNAT, unspecified, multicast,
    // and reserved ranges — plus the IPv4-mapped IPv6 forms of those. Mirrors the Marketplace app's
    // literal checks so both fetch layers reject the same hosts.
    private static bool IsPrivateAddress(IPAddress address)
    {
        if (address.IsIPv4MappedToIPv6)
        {
            address = address.MapToIPv4();
        }

        if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
        {
            var b = address.GetAddressBytes();
            return b[0] is 0 or 10 or 127 ||
                (b[0] == 169 && b[1] == 254) ||
                (b[0] == 172 && b[1] >= 16 && b[1] <= 31) ||
                (b[0] == 192 && b[1] == 168) ||
                (b[0] == 100 && b[1] >= 64 && b[1] <= 127) ||
                b[0] >= 224; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
        }

        if (address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6)
        {
            if (address.IsIPv6LinkLocal || address.IsIPv6SiteLocal || address.IsIPv6Multicast ||
                IPAddress.IsLoopback(address) || address.Equals(IPAddress.IPv6Any))
            {
                return true;
            }

            // fc00::/7 unique local.
            return (address.GetAddressBytes()[0] & 0xfe) == 0xfc;
        }

        return true;
    }

    private static AppLifecycleException TooLarge()
        => new("app_feeds_too_large", $"Feed document exceeds the {MaxFeedBytes} byte limit.");

    private static AppLifecycleException FeedIdTooLong()
        => new("app_feed_id_too_long", $"Feed id cannot exceed {AppFeedsSchema.MaxFeedIdLength} characters.");

    // Reads the response under the byte cap and hashes the raw bytes in one pass — the digest is over
    // exactly what was received, and the JSON string is decoded from the same buffer without a second
    // UTF-8 round-trip. Returns null when the cap is exceeded.
    private static async Task<(string Json, string Digest)?> ReadCappedAndHashAsync(Stream stream, CancellationToken cancellationToken)
    {
        using var buffer = new MemoryStream();
        var chunk = new byte[8192];
        int read;
        while ((read = await stream.ReadAsync(chunk, cancellationToken)) > 0)
        {
            if (buffer.Length + read > MaxFeedBytes)
            {
                return null;
            }

            buffer.Write(chunk, 0, read);
        }

        var bytes = buffer.GetBuffer().AsSpan(0, (int)buffer.Length);
        var digest = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        return (Encoding.UTF8.GetString(bytes), digest);
    }
}
