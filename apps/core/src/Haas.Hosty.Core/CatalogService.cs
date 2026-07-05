using System.Collections.Concurrent;
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
internal sealed class HttpCatalogDocumentFetcher : ICatalogDocumentFetcher, IDisposable
{
    private const int MaxBytes = 4 * 1024 * 1024;

    private readonly HttpClient client = new() { Timeout = TimeSpan.FromSeconds(15) };
    private readonly ConcurrentDictionary<string, CacheEntry> cache = new(StringComparer.Ordinal);
    private readonly IClock clock;
    private readonly TimeSpan ttl;

    public HttpCatalogDocumentFetcher(IClock clock, TimeSpan? ttl = null)
    {
        this.clock = clock;
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
                if (!response.IsSuccessStatusCode || response.Content.Headers.ContentLength > MaxBytes)
                {
                    return null;
                }

                // Stream and enforce the cap while reading: a source that omits Content-Length (or uses
                // chunked encoding) would otherwise let ReadAsStringAsync buffer an unbounded body (DoS).
                await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
                return await ReadCappedTextAsync(stream, cancellationToken);
            }

            var path = uri is { IsFile: true } ? uri.LocalPath : source;
            if (!File.Exists(path))
            {
                return null;
            }

            var info = new FileInfo(path);
            return info.Length > MaxBytes ? null : await File.ReadAllTextAsync(path, cancellationToken);
        }
        catch (Exception ex) when (
            ex is HttpRequestException or IOException or UnauthorizedAccessException or UriFormatException or InvalidOperationException ||
            (ex is TaskCanceledException && !cancellationToken.IsCancellationRequested))
        {
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
// existing transport: it never installs anything — clients take a version's `manifestRef` and drive the
// existing reviewed install/update. Sources are merged by priority (first configured source wins an id
// conflict), and each entry is joined with Core's registry so cards show install/update state. Optional
// and non-intrusive: no sources configured => an empty catalog, and installed apps need not belong to one.
// See docs/features/runtime-app-marketplace.md (B2, and the optionality invariant).
internal sealed class CatalogService(
    HostyCoreRuntimeConfig config,
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

        var installed = await LoadInstalledVersionsAsync(cancellationToken);
        var summaries = new List<CatalogAppSummary>(entries.Count);
        foreach (var located in entries.Values)
        {
            var entry = located.Entry;
            var id = entry.Id!;
            installed.TryGetValue(id, out var installedVersion);
            summaries.Add(new CatalogAppSummary(
                Id: id,
                Name: ResolveName(entry),
                Summary: NullIfBlank(entry.Display?.Summary),
                Category: NullIfBlank(entry.Category),
                Tags: NormalizeList(entry.Tags),
                Icon: NullIfBlank(entry.Display?.Icon),
                Publisher: NormalizePublisher(entry.Publisher),
                SourceName: located.SourceName,
                Installed: installedVersion is not null,
                InstalledVersion: installedVersion));
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
        var feed = await LoadFeedAsync(entry.ReleasesUrl, cancellationToken);
        var versions = ResolveVersions(feed);
        var stable = NullIfBlank(feed?.Tags?.Stable);
        var beta = NullIfBlank(feed?.Tags?.Beta);

        var installed = await LoadInstalledVersionsAsync(cancellationToken);
        installed.TryGetValue(entry.Id!, out var installedVersion);
        var updateAvailable = installedVersion is not null
            && stable is not null
            && !string.Equals(stable, installedVersion, StringComparison.Ordinal);

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
            ReleasesUrl: NullIfBlank(entry.ReleasesUrl),
            Versions: versions,
            StableVersion: stable,
            BetaVersion: beta,
            Installed: installedVersion is not null,
            InstalledVersion: installedVersion,
            UpdateAvailable: updateAvailable);
    }

    // Merge every configured source's index into an id-keyed map, first source wins an id conflict.
    private async Task<(IReadOnlyDictionary<string, LocatedEntry> Entries, int SourceCount)> LoadMergedEntriesAsync(
        CancellationToken cancellationToken)
    {
        // App ids are lowercase by contract, but match case-insensitively so a catalog entry authored with
        // different casing still de-dupes across sources and joins with the installed registry.
        var merged = new Dictionary<string, LocatedEntry>(StringComparer.OrdinalIgnoreCase);
        var sources = config.EffectiveCatalogSources;
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

    private async Task<VersionFeed?> LoadFeedAsync(string? releasesUrl, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(releasesUrl))
        {
            return null;
        }

        var raw = await fetcher.FetchAsync(releasesUrl, cancellationToken);
        if (raw is null)
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize(raw, CoreJsonSerializerContext.Default.VersionFeed);
        }
        catch (JsonException ex)
        {
            logger.LogWarning("Catalog version feed '{Feed}' returned invalid JSON: {Message}", releasesUrl, ex.Message);
            return null;
        }
    }

    private static IReadOnlyList<CatalogAppVersion> ResolveVersions(VersionFeed? feed)
    {
        if (feed is null || feed.Versions.Count == 0)
        {
            return [];
        }

        var result = new List<CatalogAppVersion>(feed.Versions.Count);
        foreach (var version in feed.Versions)
        {
            var number = NullIfBlank(version.Version);
            var manifestRef = NullIfBlank(version.ManifestRef);
            if (number is null || manifestRef is null)
            {
                continue;
            }

            result.Add(new CatalogAppVersion(number, manifestRef, version.Artifact));
        }

        return result;
    }

    private async Task<Dictionary<string, string>> LoadInstalledVersionsAsync(CancellationToken cancellationToken)
    {
        var installed = await apps.ListAppsAsync(cancellationToken);
        // Case-insensitive so a catalog entry id joins the installed record regardless of authored casing.
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var app in installed)
        {
            map[app.Id] = app.Version;
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
    // path -> its file name. Cosmetic source label for federation legibility.
    private static string DeriveSourceName(string source)
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
