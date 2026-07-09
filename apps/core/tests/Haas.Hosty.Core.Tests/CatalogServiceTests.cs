using Haas.Hosty.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed class CatalogServiceTests
{
    private const string IndexUrl = "https://catalog.example/catalog.json";
    private const string SecondIndexUrl = "https://other.example/catalog.json";
    private const string FeedManifestUrl = "https://raw.example/notes/main/manifest.json";

    [Fact]
    public async Task GetAppsAsync_NoSourcesConfigured_ReturnsEmpty()
    {
        var service = await CreateServiceAsync(new FakeFetcher(), sources: []);

        var response = await service.GetAppsAsync(CancellationToken.None);

        Assert.Empty(response.Apps);
    }

    [Fact]
    public async Task GetAppsAsync_ReturnsEntriesSortedByName()
    {
        var fetcher = new FakeFetcher
        {
            [IndexUrl] = Index(
                Entry("com.example.zed", "Zed"),
                Entry("com.example.apple", "Apple")),
        };
        var service = await CreateServiceAsync(fetcher, sources: [IndexUrl]);

        var response = await service.GetAppsAsync(CancellationToken.None);

        Assert.Collection(
            response.Apps,
            app => Assert.Equal("Apple", app.Name),
            app => Assert.Equal("Zed", app.Name));
        Assert.All(response.Apps, app => Assert.False(app.Installed));
    }

    [Fact]
    public async Task GetAppsAsync_MergesSources_FirstSourceWinsOnIdConflict()
    {
        var fetcher = new FakeFetcher
        {
            [IndexUrl] = Index(Entry("com.example.notes", "Notes (Official)")),
            [SecondIndexUrl] = Index(Entry("com.example.notes", "Notes (Other)")),
        };
        var service = await CreateServiceAsync(fetcher, sources: [IndexUrl, SecondIndexUrl]);

        var response = await service.GetAppsAsync(CancellationToken.None);

        var app = Assert.Single(response.Apps);
        Assert.Equal("Notes (Official)", app.Name); // higher-priority (first) source wins
    }

    [Fact]
    public async Task GetAppsAsync_JoinsInstalledStateFromRegistry()
    {
        var fetcher = new FakeFetcher
        {
            [IndexUrl] = Index(Entry("com.example.notes", "Notes"), Entry("com.example.other", "Other")),
        };
        var service = await CreateServiceAsync(
            fetcher,
            sources: [IndexUrl],
            installed: [("com.example.notes", "1.2.0", null, null)]);

        var response = await service.GetAppsAsync(CancellationToken.None);

        var notes = Assert.Single(response.Apps, app => app.Id == "com.example.notes");
        Assert.True(notes.Installed);
        Assert.Equal("1.2.0", notes.InstalledVersion);
        var other = Assert.Single(response.Apps, app => app.Id == "com.example.other");
        Assert.False(other.Installed);
        Assert.Null(other.InstalledVersion);
    }

    [Fact]
    public async Task GetAppsAsync_UnreachableSource_DegradesToEmpty()
    {
        // The fetcher returns null (transport failure) for every URL — never throws, yields an empty catalog.
        var service = await CreateServiceAsync(new FakeFetcher(), sources: [IndexUrl]);

        var response = await service.GetAppsAsync(CancellationToken.None);

        Assert.Empty(response.Apps);
    }

    [Fact]
    public async Task GetAppsAsync_MalformedIndexJson_IsSkipped()
    {
        var fetcher = new FakeFetcher { [IndexUrl] = "{ not json" };
        var service = await CreateServiceAsync(fetcher, sources: [IndexUrl]);

        var response = await service.GetAppsAsync(CancellationToken.None);

        Assert.Empty(response.Apps);
    }

    [Fact]
    public async Task GetAppsAsync_UnsupportedSchemaVersion_IsSkipped()
    {
        var fetcher = new FakeFetcher
        {
            [IndexUrl] = """
                { "schemaVersion": "marketplace.9.9", "apps": [ { "id": "com.example.notes", "name": "Notes" } ] }
                """,
        };
        var service = await CreateServiceAsync(fetcher, sources: [IndexUrl]);

        var response = await service.GetAppsAsync(CancellationToken.None);

        Assert.Empty(response.Apps);
    }

    [Fact]
    public async Task GetAppsAsync_JoinsInstalledState_CaseInsensitively()
    {
        // App ids are lowercase by contract, but a catalog entry authored with different casing must still
        // join the installed record.
        var fetcher = new FakeFetcher { [IndexUrl] = Index(Entry("Com.Example.Notes", "Notes")) };
        var service = await CreateServiceAsync(
            fetcher,
            sources: [IndexUrl],
            installed: [("com.example.notes", "1.0.0", null, null)]);

        var app = Assert.Single((await service.GetAppsAsync(CancellationToken.None)).Apps);
        Assert.True(app.Installed);
        Assert.Equal("1.0.0", app.InstalledVersion);
    }

    [Fact]
    public async Task GetAppAsync_UnknownId_ReturnsNull()
    {
        var fetcher = new FakeFetcher { [IndexUrl] = Index(Entry("com.example.notes", "Notes")) };
        var service = await CreateServiceAsync(fetcher, sources: [IndexUrl]);

        Assert.Null(await service.GetAppAsync("com.example.missing", CancellationToken.None));
    }

    [Fact]
    public async Task GetAppAsync_ResolvesFeeds_SoleFeedIsDefault()
    {
        var fetcher = new FakeFetcher
        {
            [IndexUrl] = Index(Entry("com.example.notes", "Notes", feeds: $$"""[ { "id": "main", "manifestRef": "{{FeedManifestUrl}}" } ]""")),
        };
        var service = await CreateServiceAsync(fetcher, sources: [IndexUrl]);

        var detail = await service.GetAppAsync("com.example.notes", CancellationToken.None);

        Assert.NotNull(detail);
        Assert.Equal("https://cdn.example.test/com.example.notes/store.md", detail!.DescriptionUrl);
        var feed = Assert.Single(detail.Feeds);
        Assert.Equal("main", feed.Id);
        Assert.Equal(FeedManifestUrl, feed.ManifestRef);
        Assert.True(feed.Default); // a sole feed is the de-facto default even without the flag
        Assert.False(detail.UpdateAvailable); // not installed
        Assert.Null(detail.FollowedFeedId);
    }

    [Fact]
    public async Task GetAppAsync_ResolvesFeeds_ExplicitDefaultWinsRegardlessOfOrder()
    {
        var fetcher = new FakeFetcher
        {
            [IndexUrl] = Index(Entry(
                "com.example.notes",
                "Notes",
                feeds: """[ { "id": "beta", "manifestRef": "https://raw.example/notes/develop/manifest.json" }, { "id": "main", "manifestRef": "https://raw.example/notes/main/manifest.json", "default": true } ]""")),
        };
        var service = await CreateServiceAsync(fetcher, sources: [IndexUrl]);

        var detail = await service.GetAppAsync("com.example.notes", CancellationToken.None);

        Assert.Equal(2, detail!.Feeds.Count);
        Assert.False(detail.Feeds[0].Default);
        Assert.True(detail.Feeds[1].Default);
        Assert.Equal("main", detail.Feeds[1].Id);
    }

    [Fact]
    public async Task GetAppAsync_UpdateAvailable_WhenFeedHeadContentDiffers_EvenAtSameVersion()
    {
        // The regression this design fixes: content moved under an unchanged version string. Detection
        // is a digest compare of the feed head vs the installed copy — the version field is irrelevant.
        var fetcher = new FakeFetcher
        {
            [IndexUrl] = Index(Entry("com.example.notes", "Notes", feeds: $$"""[ { "id": "main", "manifestRef": "{{FeedManifestUrl}}" } ]""")),
            [FeedManifestUrl] = """{ "schemaVersion": "app.0.1", "id": "com.example.notes", "version": "0.3.1", "ui": { "navigation": [ { "label": "Home", "path": "/", "iconAsset": "assets/nav/home.svg" } ] } }""",
        };
        var service = await CreateServiceAsync(
            fetcher,
            sources: [IndexUrl],
            installed: [("com.example.notes", "0.3.1", """{ "schemaVersion": "app.0.1", "id": "com.example.notes", "version": "0.3.1" }""", "main")]);

        var detail = await service.GetAppAsync("com.example.notes", CancellationToken.None);

        Assert.True(detail!.Installed);
        Assert.Equal("main", detail.FollowedFeedId);
        Assert.True(detail.UpdateAvailable);
    }

    [Fact]
    public async Task GetAppAsync_NoUpdate_WhenFeedHeadMatchesInstalledCopy()
    {
        const string manifest = """{ "schemaVersion": "app.0.1", "id": "com.example.notes", "version": "0.3.1" }""";
        var fetcher = new FakeFetcher
        {
            [IndexUrl] = Index(Entry("com.example.notes", "Notes", feeds: $$"""[ { "id": "main", "manifestRef": "{{FeedManifestUrl}}" } ]""")),
            [FeedManifestUrl] = manifest,
        };
        var service = await CreateServiceAsync(
            fetcher,
            sources: [IndexUrl],
            installed: [("com.example.notes", "0.3.1", manifest, "main")]);

        var detail = await service.GetAppAsync("com.example.notes", CancellationToken.None);

        Assert.False(detail!.UpdateAvailable);
    }

    [Fact]
    public async Task GetAppAsync_NoUpdate_WhenNoFeedIsFollowed()
    {
        // A pre-feeds install (or a cleared feed) never gets a phantom badge: no followed feed means
        // clients surface choose-a-feed guidance instead (catalog-hosted-app-feeds.md A3).
        var fetcher = new FakeFetcher
        {
            [IndexUrl] = Index(Entry("com.example.notes", "Notes", feeds: $$"""[ { "id": "main", "manifestRef": "{{FeedManifestUrl}}" } ]""")),
            [FeedManifestUrl] = """{ "schemaVersion": "app.0.1", "id": "com.example.notes", "version": "9.9.9" }""",
        };
        var service = await CreateServiceAsync(
            fetcher,
            sources: [IndexUrl],
            installed: [("com.example.notes", "0.3.1", """{ "schemaVersion": "app.0.1", "id": "com.example.notes", "version": "0.3.1" }""", null)]);

        var detail = await service.GetAppAsync("com.example.notes", CancellationToken.None);

        Assert.True(detail!.Installed);
        Assert.Null(detail.FollowedFeedId);
        Assert.False(detail.UpdateAvailable);
    }

    [Fact]
    public async Task GetAppAsync_NoUpdate_WhenFollowedFeedNoLongerExists()
    {
        // The recorded feed id is still reported (so clients can show "feed missing — choose another"),
        // but a feed the entry no longer declares never produces an update badge.
        var fetcher = new FakeFetcher
        {
            [IndexUrl] = Index(Entry("com.example.notes", "Notes", feeds: $$"""[ { "id": "main", "manifestRef": "{{FeedManifestUrl}}" } ]""")),
            [FeedManifestUrl] = """{ "schemaVersion": "app.0.1", "id": "com.example.notes", "version": "9.9.9" }""",
        };
        var service = await CreateServiceAsync(
            fetcher,
            sources: [IndexUrl],
            installed: [("com.example.notes", "0.3.1", """{ "schemaVersion": "app.0.1", "id": "com.example.notes", "version": "0.3.1" }""", "renamed-away")]);

        var detail = await service.GetAppAsync("com.example.notes", CancellationToken.None);

        Assert.Equal("renamed-away", detail!.FollowedFeedId);
        Assert.False(detail.UpdateAvailable);
    }

    [Fact]
    public async Task GetAppAsync_NoUpdate_WhenFeedHeadIsUnreachable()
    {
        // Catalog reads are best-effort: an unreachable head degrades to "no badge", never an error.
        var fetcher = new FakeFetcher
        {
            [IndexUrl] = Index(Entry("com.example.notes", "Notes", feeds: $$"""[ { "id": "main", "manifestRef": "{{FeedManifestUrl}}" } ]""")),
        };
        var service = await CreateServiceAsync(
            fetcher,
            sources: [IndexUrl],
            installed: [("com.example.notes", "0.3.1", """{ "schemaVersion": "app.0.1", "id": "com.example.notes", "version": "0.3.1" }""", "main")]);

        var detail = await service.GetAppAsync("com.example.notes", CancellationToken.None);

        Assert.False(detail!.UpdateAvailable);
    }

    // ---- helpers ----------------------------------------------------------------------------------

    private static string Index(params string[] entries)
        => $$"""
            { "schemaVersion": "marketplace.0.1", "source": { "name": "Test Source" }, "apps": [ {{string.Join(",", entries)}} ] }
            """;

    private static string Entry(string id, string name, string? feeds = null)
    {
        var feedsJson = feeds is null ? "" : $$""", "feeds": {{feeds}} """;
        return $$"""
            { "id": "{{id}}", "name": "{{name}}", "category": "Productivity", "tags": ["a", "b"], "display": { "summary": "{{name}} summary", "icon": "icon.png", "descriptionUrl": "https://cdn.example.test/{{id}}/store.md" }, "publisher": { "name": "Example Co" }{{feedsJson}} }
            """;
    }

    private static async Task<CatalogService> CreateServiceAsync(
        ICatalogDocumentFetcher fetcher,
        IReadOnlyList<string> sources,
        // InstalledManifestJson (when non-null) is written to a real file under the test root and its
        // path recorded on the app — the digest compare reads the installed copy straight from disk
        // (bypassing the fetcher cache), so the fixture must be a file, not a FakeFetcher entry.
        IReadOnlyList<(string Id, string Version, string? InstalledManifestJson, string? FollowedFeedId)>? installed = null)
    {
        var root = Path.Combine(Path.GetTempPath(), $"hosty-catalog-tests-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        var paths = new CoreDataPaths(
            DataRoot: root,
            CoreRoot: Path.Combine(root, "core"),
            AppsRoot: Path.Combine(root, "apps"),
            BackupsRoot: Path.Combine(root, "backups"),
            SourcesRoot: Path.Combine(root, "sources"),
            AuthRoot: Path.Combine(root, "core", "auth"),
            AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));
        var store = new AppRegistryStore(paths);
        foreach (var (id, version, installedManifestJson, followedFeedId) in installed ?? [])
        {
            string? manifestPath = null;
            if (installedManifestJson is not null)
            {
                manifestPath = Path.Combine(root, "installed", id, "manifest.json");
                Directory.CreateDirectory(Path.GetDirectoryName(manifestPath)!);
                await File.WriteAllTextAsync(manifestPath, installedManifestJson);
            }

            await store.UpsertAppAsync(CreateApp(id, version, manifestPath, followedFeedId));
        }

        var config = CreateConfig(root, sources);
        // No catalog-sources.json is written, so the source service falls back to the env-seeded
        // config.EffectiveCatalogSources — behaviour identical to reading the sources directly.
        var sourceService = new CatalogSourceService(new CatalogSourceStore(paths), config);
        return new CatalogService(sourceService, store, fetcher, NullLogger<CatalogService>.Instance);
    }

    private static HostyCoreRuntimeConfig CreateConfig(string root, IReadOnlyList<string> sources)
        => new(
            DataRoot: root,
            RunDirectory: Path.Combine(root, "core", "run"),
            ControlDiscoveryPath: Path.Combine(root, "core", "run", "control.json"),
            CorePort: 7070,
            ShellPort: 7171,
            ListenUrl: "http://127.0.0.1:7070",
            CorePublicOrigin: null,
            ShellPublicOrigin: null,
            RuntimePublicHost: "127.0.0.1",
            ShellManifestPath: null,
            ShellBootstrapRuntime: "docker",
            ShellSourceOverridePath: null,
            ShellBootstrapEnabled: false,
            ShellAutostart: false,
            CatalogSources: sources);

    private static AppRecord CreateApp(string id, string version, string? manifestPath = null, string? followedFeedId = null)
        => new(
            Id: id,
            DisplayName: id,
            Description: null,
            Version: version,
            Kind: "runtime",
            System: false,
            Source: "installed",
            ManifestPath: manifestPath,
            ManifestUrl: null,
            SelectedRuntime: "docker",
            OperationStatus: "installed",
            RuntimeState: "stopped",
            LastOperation: null,
            LastError: null,
            Capabilities: [],
            Settings: new Dictionary<string, AppSettingValue>(),
            StorageMappings: [],
            Dependencies: [],
            Endpoints: [],
            InstalledAt: DateTimeOffset.UtcNow,
            UpdatedAt: DateTimeOffset.UtcNow,
            FollowedFeedId: followedFeedId);

    private sealed class FakeFetcher : Dictionary<string, string?>, ICatalogDocumentFetcher
    {
        public FakeFetcher()
            : base(StringComparer.Ordinal)
        {
        }

        public Task<string?> FetchAsync(string source, CancellationToken cancellationToken)
            => Task.FromResult(TryGetValue(source, out var document) ? document : null);
    }
}
