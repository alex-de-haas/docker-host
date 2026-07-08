using Haas.Hosty.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed class CatalogServiceTests
{
    private const string IndexUrl = "https://catalog.example/catalog.json";
    private const string SecondIndexUrl = "https://other.example/catalog.json";
    private const string FeedUrl = "https://feeds.example/notes.json";

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
            installed: [("com.example.notes", "1.2.0")]);

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
            installed: [("com.example.notes", "1.0.0")]);

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
    public async Task GetAppAsync_ResolvesFeedVersionsAndTags()
    {
        var fetcher = new FakeFetcher
        {
            [IndexUrl] = Index(Entry("com.example.notes", "Notes", releasesUrl: FeedUrl)),
            [FeedUrl] = """
                {
                  "versions": [
                    { "version": "0.3.0", "manifestRef": "https://a/0.3.0/manifest.json", "artifact": { "kind": "image", "imageDigest": "sha256:aaa" } },
                    { "version": "0.3.1", "manifestRef": "https://a/0.3.1/manifest.json", "artifact": { "kind": "image", "imageDigest": "sha256:bbb" } }
                  ],
                  "tags": { "stable": "0.3.1", "beta": "0.4.0-rc1" }
                }
                """,
        };
        var service = await CreateServiceAsync(fetcher, sources: [IndexUrl]);

        var detail = await service.GetAppAsync("com.example.notes", CancellationToken.None);

        Assert.NotNull(detail);
        Assert.Equal("0.3.1", detail!.StableVersion);
        Assert.Equal("0.4.0-rc1", detail.BetaVersion);
        Assert.Equal("https://cdn.example.test/com.example.notes/store.md", detail.DescriptionUrl);
        Assert.Collection(
            detail.Versions,
            version =>
            {
                Assert.Equal("0.3.0", version.Version);
                Assert.Equal("https://a/0.3.0/manifest.json", version.ManifestRef);
                Assert.Equal("image", version.Artifact!.Kind);
                Assert.Equal("sha256:aaa", version.Artifact.ImageDigest);
            },
            version => Assert.Equal("0.3.1", version.Version));
        Assert.False(detail.UpdateAvailable); // not installed
    }

    [Fact]
    public async Task GetAppAsync_ArtifactAgnosticFeed_KeepsSourceCommit()
    {
        // A localCommand/source app carries a source commit, not an image digest — the feed must not assume image.
        var fetcher = new FakeFetcher
        {
            [IndexUrl] = Index(Entry("com.example.transcode", "Transcode", releasesUrl: FeedUrl)),
            [FeedUrl] = """
                {
                  "versions": [
                    { "version": "1.4.0", "manifestRef": "https://a/manifest.json", "artifact": { "kind": "source", "commit": "abc123", "ref": "refs/tags/v1.4.0" } }
                  ],
                  "tags": { "stable": "1.4.0" }
                }
                """,
        };
        var service = await CreateServiceAsync(fetcher, sources: [IndexUrl]);

        var detail = await service.GetAppAsync("com.example.transcode", CancellationToken.None);

        var version = Assert.Single(detail!.Versions);
        Assert.Equal("source", version.Artifact!.Kind);
        Assert.Equal("abc123", version.Artifact.Commit);
        Assert.Equal("refs/tags/v1.4.0", version.Artifact.Ref);
        Assert.Null(version.Artifact.ImageDigest);
    }

    [Fact]
    public async Task GetAppAsync_UpdateAvailable_WhenInstalledDiffersFromStable()
    {
        var fetcher = new FakeFetcher
        {
            [IndexUrl] = Index(Entry("com.example.notes", "Notes", releasesUrl: FeedUrl)),
            [FeedUrl] = """
                { "versions": [ { "version": "0.3.1", "manifestRef": "https://a/manifest.json" } ], "tags": { "stable": "0.3.1" } }
                """,
        };
        var service = await CreateServiceAsync(
            fetcher,
            sources: [IndexUrl],
            installed: [("com.example.notes", "0.3.0")]);

        var detail = await service.GetAppAsync("com.example.notes", CancellationToken.None);

        Assert.True(detail!.Installed);
        Assert.Equal("0.3.0", detail.InstalledVersion);
        Assert.True(detail.UpdateAvailable);
    }

    [Fact]
    public async Task GetAppAsync_NoUpdate_WhenInstalledMatchesStable()
    {
        var fetcher = new FakeFetcher
        {
            [IndexUrl] = Index(Entry("com.example.notes", "Notes", releasesUrl: FeedUrl)),
            [FeedUrl] = """
                { "versions": [ { "version": "0.3.1", "manifestRef": "https://a/manifest.json" } ], "tags": { "stable": "0.3.1" } }
                """,
        };
        var service = await CreateServiceAsync(
            fetcher,
            sources: [IndexUrl],
            installed: [("com.example.notes", "0.3.1")]);

        var detail = await service.GetAppAsync("com.example.notes", CancellationToken.None);

        Assert.False(detail!.UpdateAvailable);
    }

    // ---- helpers ----------------------------------------------------------------------------------

    private static string Index(params string[] entries)
        => $$"""
            { "schemaVersion": "marketplace.0.1", "source": { "name": "Test Source" }, "apps": [ {{string.Join(",", entries)}} ] }
            """;

    private static string Entry(string id, string name, string? releasesUrl = null)
    {
        var releases = releasesUrl is null ? "" : $$""", "releasesUrl": "{{releasesUrl}}" """;
        return $$"""
            { "id": "{{id}}", "name": "{{name}}", "category": "Productivity", "tags": ["a", "b"], "display": { "summary": "{{name}} summary", "icon": "icon.png", "descriptionUrl": "https://cdn.example.test/{{id}}/store.md" }, "publisher": { "name": "Example Co" }{{releases}} }
            """;
    }

    private static async Task<CatalogService> CreateServiceAsync(
        ICatalogDocumentFetcher fetcher,
        IReadOnlyList<string> sources,
        IReadOnlyList<(string Id, string Version)>? installed = null)
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
        foreach (var (id, version) in installed ?? [])
        {
            await store.UpsertAppAsync(CreateApp(id, version));
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

    private static AppRecord CreateApp(string id, string version)
        => new(
            Id: id,
            DisplayName: id,
            Description: null,
            Version: version,
            Kind: "runtime",
            System: false,
            Source: "installed",
            ManifestPath: null,
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
            UpdatedAt: DateTimeOffset.UtcNow);

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
