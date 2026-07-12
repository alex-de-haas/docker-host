using System.Text.Json;
using System.Text.RegularExpressions;

namespace Haas.Hosty.Core;

// The release-owned distribution list: which first-party apps this build can preinstall, with their
// manifest locations and default enablement. Boot config, not a catalog — display-rich discovery
// belongs to the marketplace app. Locations are resolved from this list at every boot (never
// persisted), so a release update moves every ref atomically; the operator's own intent lives in
// the separate bootstrap-choices file. See docs/ideas/generic-bootstrap.md.
internal static class DistributionAppsSchema
{
    public const string Version = "distribution-apps.0.1";
    public const string FileName = "distribution-apps.json";
    // Ambient-env-only override for dev trees, tests, and custom distribution builds. Deliberately
    // not a CLI launch setting (mirrors HOSTY_COLLECTOR_BOOTSTRAP_RUNTIME): persisting a location is
    // exactly the stale-pinned-path failure mode this design removes.
    public const string PathEnvVar = "HOSTY_DISTRIBUTION_APPS_PATH";
}

internal sealed class DistributionAppsDocument
{
    public string? SchemaVersion { get; init; }
    public IReadOnlyList<DistributionAppEntryDocument> Apps { get => field ?? []; init; } = [];
}

internal sealed class DistributionAppEntryDocument
{
    public string? Id { get; init; }
    public string? Title { get; init; }
    public string? Description { get; init; }
    public string? ManifestRef { get; init; }
    public string? FeedsUrl { get; init; }
    public bool? DefaultEnabled { get; init; }
}

// A validated entry. ManifestRef is fully resolved: an absolute http(s) URL, or an absolute local
// path (relative refs in the file resolve against the list file's own directory).
internal sealed record DistributionAppEntry(
    string Id,
    string Title,
    string? Description,
    string ManifestRef,
    string? FeedsUrl,
    bool DefaultEnabled);

// Load outcome. Problems are loud-but-non-fatal by design: they are reported at error level and
// (Phase 3) surfaced through the bootstrap endpoint, while Core itself still boots — a malformed
// list must never take the host down with it.
internal sealed record DistributionAppsResult(
    IReadOnlyList<DistributionAppEntry> Apps,
    string Source,
    IReadOnlyList<string> Problems);

// Resolves and loads the distribution list once per process. Resolution order:
//   1. HOSTY_DISTRIBUTION_APPS_PATH (ambient override; a broken override is a problem, then falls
//      through so the host still boots the official set),
//   2. a distribution-apps.json found by walking up from the working dir / binary dir (the source
//      tree layout — the repo root carries the dev list with relative manifest refs),
//   3. the embedded default (the release binary is a single self-contained file with nothing next
//      to it, so the official list ships inside it — same pattern as the collector's embedded
//      config template).
internal sealed class DistributionAppsProvider(
    ILogger<DistributionAppsProvider> logger,
    string? explicitPathOverride = null,
    IReadOnlyList<string>? walkRoots = null)
{
    // Official distribution for standalone binary installs. Refs are remote because the installed
    // artifact has no repo layout on disk; a source tree wins via the walked file with local refs.
    internal const string EmbeddedDefaultJson = /*lang=json,strict*/ """
        {
          "schemaVersion": "distribution-apps.0.1",
          "apps": [
            {
              "id": "hosty.shell",
              "title": "Hosty Shell",
              "description": "Web UI client for this host.",
              "manifestRef": "https://raw.githubusercontent.com/alex-de-haas/docker-host/main/apps/shell/manifest.json",
              "defaultEnabled": true
            },
            {
              "id": "hosty.telemetry",
              "title": "Telemetry",
              "description": "OpenTelemetry collector and observability backend.",
              "manifestRef": "https://raw.githubusercontent.com/alex-de-haas/docker-host/main/apps/telemetry/manifest.json",
              "defaultEnabled": false
            },
            {
              "id": "hosty.marketplace",
              "title": "Marketplace",
              "description": "App discovery storefront.",
              "manifestRef": "https://raw.githubusercontent.com/alex-de-haas/docker-host/main/apps/marketplace/manifest.json",
              "defaultEnabled": true
            }
          ]
        }
        """;

    private static readonly Regex AppIdPattern = new("^[a-z0-9][a-z0-9._-]{0,62}$", RegexOptions.Compiled);

    private readonly SemaphoreSlim gate = new(1, 1);
    private DistributionAppsResult? cached;

    public async Task<DistributionAppsResult> LoadAsync(CancellationToken cancellationToken = default)
    {
        if (cached is not null)
        {
            return cached;
        }

        await gate.WaitAsync(cancellationToken);
        try
        {
            cached ??= await LoadCoreAsync(cancellationToken);
            return cached;
        }
        finally
        {
            gate.Release();
        }
    }

    private async Task<DistributionAppsResult> LoadCoreAsync(CancellationToken cancellationToken)
    {
        var problems = new List<string>();

        var overridePath = explicitPathOverride ?? NormalizeOptional(Environment.GetEnvironmentVariable(DistributionAppsSchema.PathEnvVar));
        if (overridePath is not null)
        {
            var fromOverride = await TryLoadFileAsync(overridePath, $"{DistributionAppsSchema.PathEnvVar} override", problems, cancellationToken);
            if (fromOverride is not null)
            {
                return fromOverride with { Problems = problems };
            }
        }

        if (ResolveWalkedPath() is { } walkedPath)
        {
            var fromWalk = await TryLoadFileAsync(walkedPath, walkedPath, problems, cancellationToken);
            if (fromWalk is not null)
            {
                return fromWalk with { Problems = problems };
            }
        }

        var embedded = Parse(EmbeddedDefaultJson, baseDirectory: null, "embedded default", problems);
        return new DistributionAppsResult(embedded, "embedded default", problems);
    }

    private async Task<DistributionAppsResult?> TryLoadFileAsync(
        string path,
        string sourceDescription,
        List<string> problems,
        CancellationToken cancellationToken)
    {
        string json;
        try
        {
            json = await File.ReadAllTextAsync(path, cancellationToken);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            problems.Add($"Distribution list at '{path}' ({sourceDescription}) could not be read: {ex.Message}. The next available list is used instead.");
            return null;
        }

        var localProblems = new List<string>();
        var entries = Parse(json, Path.GetDirectoryName(Path.GetFullPath(path)), sourceDescription, localProblems);
        if (entries.Count == 0 && localProblems.Count > 0)
        {
            // A file that yields nothing usable is treated as absent (loudly): silently booting with
            // an empty preinstall set would look like data loss, while the embedded default is this
            // release's own official truth.
            problems.AddRange(localProblems);
            problems.Add($"Distribution list at '{path}' produced no usable entries. The next available list is used instead.");
            return null;
        }

        problems.AddRange(localProblems);
        return new DistributionAppsResult(entries, sourceDescription, problems);
    }

    private IReadOnlyList<DistributionAppEntry> Parse(
        string json,
        string? baseDirectory,
        string sourceDescription,
        List<string> problems)
    {
        DistributionAppsDocument? document;
        try
        {
            document = JsonSerializer.Deserialize(json, CoreJsonSerializerContext.Default.DistributionAppsDocument);
        }
        catch (JsonException ex)
        {
            problems.Add($"Distribution list ({sourceDescription}) is not valid JSON: {ex.Message}");
            return [];
        }

        if (document is null)
        {
            problems.Add($"Distribution list ({sourceDescription}) is empty.");
            return [];
        }

        if (!string.Equals(document.SchemaVersion, DistributionAppsSchema.Version, StringComparison.Ordinal))
        {
            problems.Add(
                $"Distribution list ({sourceDescription}) declares schemaVersion '{document.SchemaVersion}' but this Core understands '{DistributionAppsSchema.Version}'.");
            return [];
        }

        var entries = new List<DistributionAppEntry>();
        var seenIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var entry in document.Apps)
        {
            var id = entry.Id?.Trim();
            if (string.IsNullOrWhiteSpace(id) || !AppIdPattern.IsMatch(id))
            {
                problems.Add($"Distribution list ({sourceDescription}) entry with id '{entry.Id}' has a missing or invalid app id; the entry was skipped.");
                continue;
            }

            if (!seenIds.Add(id))
            {
                problems.Add($"Distribution list ({sourceDescription}) declares app id '{id}' more than once; the duplicate entry was skipped.");
                continue;
            }

            var manifestRef = ResolveManifestRef(entry.ManifestRef, baseDirectory, sourceDescription, id, problems);
            if (manifestRef is null)
            {
                continue;
            }

            var feedsUrl = NormalizeOptional(entry.FeedsUrl);
            if (feedsUrl is not null && !IsHttpUrl(feedsUrl))
            {
                problems.Add($"Distribution list ({sourceDescription}) entry '{id}' has a non-http(s) feedsUrl '{feedsUrl}'; the feed reference was ignored.");
                feedsUrl = null;
            }

            entries.Add(new DistributionAppEntry(
                id,
                NormalizeOptional(entry.Title) ?? id,
                NormalizeOptional(entry.Description),
                manifestRef,
                feedsUrl,
                entry.DefaultEnabled ?? false));
        }

        return entries;
    }

    private static string? ResolveManifestRef(
        string? manifestRef,
        string? baseDirectory,
        string sourceDescription,
        string id,
        List<string> problems)
    {
        var value = NormalizeOptional(manifestRef);
        if (value is null)
        {
            problems.Add($"Distribution list ({sourceDescription}) entry '{id}' has no manifestRef; the entry was skipped.");
            return null;
        }

        if (IsHttpUrl(value))
        {
            return value;
        }

        if (Path.IsPathFullyQualified(value))
        {
            return Path.GetFullPath(value);
        }

        if (baseDirectory is null)
        {
            problems.Add($"Distribution list ({sourceDescription}) entry '{id}' uses relative manifestRef '{value}' but the list has no on-disk location to resolve it against; the entry was skipped.");
            return null;
        }

        // Ordinal path semantics: the ref is combined and normalized, never case-folded — Unix file
        // systems are case-sensitive and folding could alias two distinct paths.
        return Path.GetFullPath(Path.Combine(baseDirectory, value));
    }

    private string? ResolveWalkedPath()
    {
        foreach (var start in walkRoots ?? [Directory.GetCurrentDirectory(), AppContext.BaseDirectory])
        {
            // AppContext.BaseDirectory can be empty under custom hosts; DirectoryInfo would throw.
            if (string.IsNullOrWhiteSpace(start))
            {
                continue;
            }

            var directory = new DirectoryInfo(start);
            while (directory is not null)
            {
                var candidate = Path.Combine(directory.FullName, DistributionAppsSchema.FileName);
                if (File.Exists(candidate))
                {
                    return candidate;
                }

                directory = directory.Parent;
            }
        }

        return null;
    }

    public void LogProblems(DistributionAppsResult result)
    {
        foreach (var problem in result.Problems)
        {
            logger.LogError("Distribution list problem: {Problem}", problem);
        }
    }

    private static bool IsHttpUrl(string value)
        => Uri.TryCreate(value, UriKind.Absolute, out var uri) &&
            (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps);

    private static string? NormalizeOptional(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
