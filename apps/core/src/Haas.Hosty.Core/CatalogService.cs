using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace Haas.Hosty.Core;

// Fetches a catalog document (index or feed) by URL or local path, returning its raw JSON or null on any
// failure. Abstracted so CatalogService's parse/merge/enrich logic is unit-tested without network or disk.
internal interface ICatalogDocumentFetcher
{
    Task<string?> FetchAsync(string source, CancellationToken cancellationToken);
}

// Real fetcher: http/https GET or local-file read, size-capped, with a small per-URL TTL cache so a
// storefront list does not re-fetch the index (and every feed) on each request. Best-effort — any
// transport/format failure yields null so an unreachable source degrades to "no data", never an error.
// Every failure is logged (the null cache bounds that to once per TTL per URL): an empty marketplace
// must stay diagnosable, since the storefront itself surfaces nothing.
internal sealed class HttpCatalogDocumentFetcher : ICatalogDocumentFetcher, IDisposable
{
    private const int MaxBytes = 4 * 1024 * 1024;

    private readonly HttpClient client = new() { Timeout = TimeSpan.FromSeconds(15) };
    private readonly ConcurrentDictionary<string, CacheEntry> cache = new(StringComparer.Ordinal);
    private readonly IClock clock;
    private readonly ILogger<HttpCatalogDocumentFetcher> logger;
    private readonly TimeSpan ttl;

    public HttpCatalogDocumentFetcher(IClock clock, ILogger<HttpCatalogDocumentFetcher> logger, TimeSpan? ttl = null)
    {
        this.clock = clock;
        this.logger = logger;
        this.ttl = ttl ?? TimeSpan.FromSeconds(60);
    }

    public async Task<string?> FetchAsync(string source, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(source))
        {
            return null;
        }

        // Normalize once so the cache lookup, the fetch, and the cache store all key on the same string
        // (otherwise the same URL with stray whitespace produces duplicate entries / spurious misses).
        source = source.Trim();
        var now = clock.UtcNow;
        if (cache.TryGetValue(source, out var cached) && cached.Expiry > now)
        {
            return cached.Document;
        }

        var document = await FetchRawAsync(source, cancellationToken);
        cache[source] = new CacheEntry(document, now + ttl);
        return document;
    }

    private async Task<string?> FetchRawAsync(string source, CancellationToken cancellationToken)
    {
        try
        {
            if (Uri.TryCreate(source, UriKind.Absolute, out var uri) &&
                (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps))
            {
                using var response = await client.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
                if (!response.IsSuccessStatusCode)
                {
                    logger.LogWarning("Catalog document fetch for '{Source}' returned HTTP {StatusCode}.", source, (int)response.StatusCode);
                    return null;
                }

                if (response.Content.Headers.ContentLength > MaxBytes)
                {
                    logger.LogWarning("Catalog document at '{Source}' exceeds the {MaxBytes}-byte cap.", source, MaxBytes);
                    return null;
                }

                // Stream and enforce the cap while reading: a source that omits Content-Length (or uses
                // chunked encoding) would otherwise let ReadAsStringAsync buffer an unbounded body (DoS).
                await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
                var text = await ReadCappedTextAsync(stream, cancellationToken);
                if (text is null)
                {
                    logger.LogWarning("Catalog document at '{Source}' exceeds the {MaxBytes}-byte cap.", source, MaxBytes);
                }

                return text;
            }

            var path = uri is { IsFile: true } ? uri.LocalPath : source;
            if (!File.Exists(path))
            {
                logger.LogWarning("Catalog document was not found at '{Source}'.", source);
                return null;
            }

            var info = new FileInfo(path);
            if (info.Length > MaxBytes)
            {
                logger.LogWarning("Catalog document at '{Source}' exceeds the {MaxBytes}-byte cap.", source, MaxBytes);
                return null;
            }

            return await File.ReadAllTextAsync(path, cancellationToken);
        }
        catch (Exception ex) when (
            ex is HttpRequestException or IOException or UnauthorizedAccessException or UriFormatException or InvalidOperationException ||
            (ex is TaskCanceledException && !cancellationToken.IsCancellationRequested))
        {
            // The message matters here: transport failures include host-level causes an operator can't
            // otherwise see (DNS, TLS, EMFILE fd exhaustion — the latter observed live rendering the
            // marketplace silently empty).
            logger.LogWarning(ex, "Catalog document fetch for '{Source}' failed: {Message}", source, ex.Message);
            return null;
        }
    }

    // Reads a stream into text, returning null as soon as it would exceed MaxBytes so an unbounded or
    // Content-Length-less response cannot exhaust memory.
    private static async Task<string?> ReadCappedTextAsync(Stream stream, CancellationToken cancellationToken)
    {
        using var buffer = new MemoryStream();
        var chunk = new byte[8192];
        int read;
        while ((read = await stream.ReadAsync(chunk, cancellationToken)) > 0)
        {
            if (buffer.Length + read > MaxBytes)
            {
                return null;
            }

            buffer.Write(chunk, 0, read);
        }

        return Encoding.UTF8.GetString(buffer.GetBuffer(), 0, (int)buffer.Length);
    }

    private readonly record struct CacheEntry(string? Document, DateTimeOffset Expiry);

    public void Dispose() => client.Dispose();
}

// Reads the configured catalog sources and serves the Shell/CLI storefront. A discovery/trust index over
// existing transport: it never installs anything — clients take a feed's `manifestRef` and drive the
// existing reviewed install/update. Sources are merged by priority (first configured source wins an id
// conflict), and each entry is joined with Core's registry so cards show install/update state. Optional
// and non-intrusive: no sources configured => an empty catalog, and installed apps need not belong to one.
// See docs/features/runtime-app-marketplace.md (B2, and the optionality invariant) and
// docs/features/catalog-hosted-app-feeds.md (feeds + digest-aware update detection).
internal sealed class CatalogService(
    CatalogSourceService sourceService,
    AppRegistryStore apps,
    ICatalogDocumentFetcher fetcher,
    ILogger<CatalogService> logger)
{
    public async Task<CatalogAppsResponse> GetAppsAsync(CancellationToken cancellationToken)
    {
        var (entries, _) = await LoadMergedEntriesAsync(cancellationToken);
        if (entries.Count == 0)
        {
            return new CatalogAppsResponse([]);
        }

        var installed = await LoadInstalledAppsAsync(cancellationToken);
        var summaries = new List<CatalogAppSummary>(entries.Count);
        foreach (var located in entries.Values)
        {
            var entry = located.Entry;
            var id = entry.Id!;
            installed.TryGetValue(id, out var installedApp);
            summaries.Add(new CatalogAppSummary(
                Id: id,
                Name: ResolveName(entry),
                Summary: NullIfBlank(entry.Display?.Summary),
                Category: NullIfBlank(entry.Category),
                Tags: NormalizeList(entry.Tags),
                Icon: NullIfBlank(entry.Display?.Icon),
                Publisher: NormalizePublisher(entry.Publisher),
                SourceName: located.SourceName,
                Installed: installedApp is not null,
                InstalledVersion: installedApp?.Version));
        }

        summaries.Sort((left, right) => string.Compare(left.Name, right.Name, StringComparison.OrdinalIgnoreCase));
        return new CatalogAppsResponse(summaries);
    }

    // Returns the detail for one catalog app, or null when no configured source lists that id (404).
    public async Task<CatalogAppDetailResponse?> GetAppAsync(string id, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(id))
        {
            return null;
        }

        var (entries, _) = await LoadMergedEntriesAsync(cancellationToken);
        if (!entries.TryGetValue(id.Trim(), out var located))
        {
            return null;
        }

        var entry = located.Entry;
        var feeds = ResolveFeeds(entry);

        var installed = await LoadInstalledAppsAsync(cancellationToken);
        installed.TryGetValue(entry.Id!, out var installedApp);
        var followedFeedId = NullIfBlank(installedApp?.FollowedFeedId);
        var followedFeed = followedFeedId is null
            ? null
            : feeds.FirstOrDefault(feed => string.Equals(feed.Id, followedFeedId, StringComparison.Ordinal));
        var updateAvailable = installedApp is not null
            && followedFeed is not null
            && await IsFeedHeadNewerAsync(installedApp, followedFeed, cancellationToken);

        return new CatalogAppDetailResponse(
            Id: entry.Id!,
            Name: ResolveName(entry),
            Summary: NullIfBlank(entry.Display?.Summary),
            Category: NullIfBlank(entry.Category),
            Tags: NormalizeList(entry.Tags),
            Icon: NullIfBlank(entry.Display?.Icon),
            Screenshots: NormalizeList(entry.Display?.Screenshots),
            Publisher: NormalizePublisher(entry.Publisher),
            SourceName: located.SourceName,
            SignerIdentity: NullIfBlank(entry.SignerIdentity),
            Feeds: feeds,
            Installed: installedApp is not null,
            InstalledVersion: installedApp?.Version,
            FollowedFeedId: followedFeedId,
            UpdateAvailable: updateAvailable,
            DescriptionUrl: NullIfBlank(entry.Display?.DescriptionUrl));
    }

    // Merge every configured source's index into an id-keyed map, first source wins an id conflict.
    private async Task<(IReadOnlyDictionary<string, LocatedEntry> Entries, int SourceCount)> LoadMergedEntriesAsync(
        CancellationToken cancellationToken)
    {
        // App ids are lowercase by contract, but match case-insensitively so a catalog entry authored with
        // different casing still de-dupes across sources and joins with the installed registry.
        var merged = new Dictionary<string, LocatedEntry>(StringComparer.OrdinalIgnoreCase);
        var sources = await sourceService.GetEffectiveSourcesAsync(cancellationToken);
        foreach (var source in sources)
        {
            var index = await LoadIndexAsync(source, cancellationToken);
            if (index is null)
            {
                continue;
            }

            var sourceName = NullIfBlank(index.Source?.Name) ?? DeriveSourceName(source);
            foreach (var entry in index.Apps)
            {
                var id = NullIfBlank(entry.Id);
                if (id is null)
                {
                    continue;
                }

                if (!merged.TryAdd(id, new LocatedEntry(entry, sourceName)))
                {
                    logger.LogWarning(
                        "Catalog id conflict: '{Id}' from source '{Source}' is shadowed by a higher-priority source.",
                        id,
                        sourceName);
                }
            }
        }

        return (merged, sources.Count);
    }

    private async Task<CatalogIndex?> LoadIndexAsync(string source, CancellationToken cancellationToken)
    {
        var raw = await fetcher.FetchAsync(source, cancellationToken);
        if (raw is null)
        {
            return null;
        }

        CatalogIndex? index;
        try
        {
            index = JsonSerializer.Deserialize(raw, CoreJsonSerializerContext.Default.CatalogIndex);
        }
        catch (JsonException ex)
        {
            logger.LogWarning("Catalog source '{Source}' returned invalid JSON: {Message}", source, ex.Message);
            return null;
        }

        if (index is null)
        {
            return null;
        }

        // Reject an unsupported/absent schema version rather than silently accept a document of an
        // unknown shape (parity with the app manifest loader's strict schemaVersion check).
        if (!string.Equals(index.SchemaVersion, CatalogSchema.Version, StringComparison.Ordinal))
        {
            logger.LogWarning(
                "Catalog source '{Source}' declares unsupported schemaVersion '{Version}'; expected '{Expected}'.",
                source,
                index.SchemaVersion ?? "(none)",
                CatalogSchema.Version);
            return null;
        }

        return index;
    }

    // Normalizes an entry's declared feeds for the detail response: blank ids/refs are dropped, and
    // `Default` is resolved to what A4 quick-install needs — the explicitly flagged feed, or the sole
    // one. Publish-time validation enforces "at most one default", but a hand-crafted index could still
    // flag several; normalization keeps the first and logs, mirroring the id-conflict handling.
    private IReadOnlyList<CatalogAppFeed> ResolveFeeds(CatalogAppEntry entry)
    {
        if (entry.Feeds.Count == 0)
        {
            return [];
        }

        var result = new List<CatalogAppFeed>(entry.Feeds.Count);
        var sawDefault = false;
        foreach (var feed in entry.Feeds)
        {
            var id = NullIfBlank(feed.Id);
            var manifestRef = NullIfBlank(feed.ManifestRef);
            if (id is null || manifestRef is null)
            {
                continue;
            }

            var isDefault = feed.Default == true;
            if (isDefault && sawDefault)
            {
                logger.LogWarning(
                    "Catalog entry '{Id}' flags more than one default feed; keeping the first.",
                    entry.Id);
                isDefault = false;
            }

            sawDefault |= isDefault;
            result.Add(new CatalogAppFeed(id, manifestRef, isDefault));
        }

        // A sole feed is the de-facto default even without the flag, so clients need no special case.
        if (result.Count == 1 && !result[0].Default)
        {
            result[0] = result[0] with { Default = true };
        }

        return result;
    }

    // Digest-aware update detection (catalog-hosted-app-feeds.md A2): the feed head's manifest content
    // vs the installed internal copy — SaveManifestCopyAsync writes the fetched text byte-identically,
    // so equal digests mean "already at the head". Best-effort like every catalog read: an unreachable
    // head or missing local copy yields false (no update badge), never an error.
    private async Task<bool> IsFeedHeadNewerAsync(AppRecord app, CatalogAppFeed feed, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(app.ManifestPath))
        {
            return false;
        }

        var head = await fetcher.FetchAsync(feed.ManifestRef, cancellationToken);
        if (head is null)
        {
            return false;
        }

        // The installed copy is read directly, not through the fetcher: the TTL cache is right for the
        // remote head (a storefront render fans out repeated fetches) but would keep serving the
        // pre-update copy for up to the TTL right after an applied update, flashing a phantom badge.
        // A local file read is cheap enough to skip caching.
        string installedCopy;
        try
        {
            installedCopy = await File.ReadAllTextAsync(app.ManifestPath, cancellationToken);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            return false;
        }

        return !string.Equals(ManifestDigest(head), ManifestDigest(installedCopy), StringComparison.Ordinal);
    }

    // Same digest recipe as the manifest loader (RuntimeAppManifest): SHA-256 hex of the raw JSON text.
    private static string ManifestDigest(string json)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(json))).ToLowerInvariant();

    private async Task<Dictionary<string, AppRecord>> LoadInstalledAppsAsync(CancellationToken cancellationToken)
    {
        var installed = await apps.ListAppRecordsAsync(cancellationToken);
        // Case-insensitive so a catalog entry id joins the installed record regardless of authored casing.
        var map = new Dictionary<string, AppRecord>(StringComparer.OrdinalIgnoreCase);
        foreach (var app in installed)
        {
            map[app.Id] = app;
        }

        return map;
    }

    private static string ResolveName(CatalogAppEntry entry)
        => NullIfBlank(entry.Name) ?? entry.Id!;

    private static CatalogPublisher? NormalizePublisher(CatalogPublisher? publisher)
    {
        if (publisher is null)
        {
            return null;
        }

        var name = NullIfBlank(publisher.Name);
        var url = NullIfBlank(publisher.Url);
        var email = NullIfBlank(publisher.Email);
        return name is null && url is null && email is null
            ? null
            : new CatalogPublisher { Name = name, Url = url, Email = email };
    }

    // "https://raw.githubusercontent.com/org/hosty-catalog/…" -> "raw.githubusercontent.com"; a local
    // path -> its file name. Cosmetic source label for federation legibility. Shared with
    // CatalogSourceService so the sources list and the storefront cards derive the same name.
    internal static string DeriveSourceName(string source)
    {
        if (Uri.TryCreate(source, UriKind.Absolute, out var uri) && !uri.IsFile)
        {
            return uri.Host;
        }

        try
        {
            return Path.GetFileName(source.TrimEnd('/', '\\')) is { Length: > 0 } name ? name : source;
        }
        catch (ArgumentException)
        {
            return source;
        }
    }

    private static string? NullIfBlank(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static IReadOnlyList<string> NormalizeList(IReadOnlyList<string>? values)
    {
        if (values is null || values.Count == 0)
        {
            return [];
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        var result = new List<string>(values.Count);
        foreach (var value in values)
        {
            var trimmed = NullIfBlank(value);
            if (trimmed is not null && seen.Add(trimmed))
            {
                result.Add(trimmed);
            }
        }

        return result;
    }

    private readonly record struct LocatedEntry(CatalogAppEntry Entry, string SourceName);
}
