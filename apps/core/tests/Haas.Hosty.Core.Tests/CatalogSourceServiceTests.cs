using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class CatalogSourceServiceTests
{
    private const string Official = "https://alex-de-haas.github.io/hosty-catalog/catalog.json";
    private const string Private = "https://catalog.example/catalog.json";

    [Fact]
    public async Task ListAsync_NoStoreFile_ReturnsEnvSeed_NotManaged()
    {
        var (service, _) = CreateService([Official]);

        var response = await service.ListAsync(CancellationToken.None);

        Assert.False(response.Managed);
        var source = Assert.Single(response.Sources);
        Assert.Equal(Official, source.Url);
        Assert.Equal("alex-de-haas.github.io", source.Name);
    }

    [Fact]
    public async Task GetEffectiveSourcesAsync_NoStoreFile_ReturnsEnvSeed()
    {
        var (service, _) = CreateService([Official, Private]);

        var sources = await service.GetEffectiveSourcesAsync(CancellationToken.None);

        Assert.Equal([Official, Private], sources);
    }

    [Fact]
    public async Task AddAsync_FirstAdd_SeedsFromEnv_PersistsAndBecomesManaged()
    {
        var (service, paths) = CreateService([Official]);

        var response = await service.AddAsync(Private, CancellationToken.None);

        Assert.True(response.Managed);
        Assert.Equal([Official, Private], response.Sources.Select(source => source.Url));

        // A fresh service over the same store sees the persisted list (env default preserved).
        var reopened = new CatalogSourceService(new CatalogSourceStore(paths), CreateConfig(paths, [Official]));
        Assert.Equal([Official, Private], await reopened.GetEffectiveSourcesAsync(CancellationToken.None));
    }

    [Fact]
    public async Task AddAsync_Duplicate_ThrowsExists()
    {
        var (service, _) = CreateService([Official]);

        var ex = await Assert.ThrowsAsync<AppLifecycleException>(
            () => service.AddAsync(Official, CancellationToken.None));
        Assert.Equal("catalog_source_exists", ex.Code);
    }

    [Fact]
    public async Task AddAsync_HostCaseInsensitiveDuplicate_ThrowsExists()
    {
        // http(s) sources compare as URIs, so a host/scheme-cased variant is the same source.
        var (service, _) = CreateService([Official]);

        var ex = await Assert.ThrowsAsync<AppLifecycleException>(
            () => service.AddAsync("https://Alex-De-Haas.GitHub.io/hosty-catalog/catalog.json", CancellationToken.None));
        Assert.Equal("catalog_source_exists", ex.Code);
    }

    [Theory]
    [InlineData("")]
    [InlineData("ftp://example/catalog.json")]
    [InlineData("relative/catalog.json")]
    [InlineData("https://user:pass@example/catalog.json")]
    public async Task AddAsync_InvalidSource_ThrowsInvalid(string url)
    {
        var (service, _) = CreateService([]);

        var ex = await Assert.ThrowsAsync<AppLifecycleException>(
            () => service.AddAsync(url, CancellationToken.None));
        Assert.Equal("catalog_source_invalid", ex.Code);
    }

    [Fact]
    public async Task AddAsync_AllowsAbsoluteLocalPath()
    {
        var (service, _) = CreateService([]);
        var path = Path.Combine(Path.GetTempPath(), "catalog.json");

        var response = await service.AddAsync(path, CancellationToken.None);

        Assert.Equal(path, Assert.Single(response.Sources).Url);
    }

    [Fact]
    public async Task RemoveAsync_RemovesEnvDefault_MaterializesEmpty()
    {
        var (service, _) = CreateService([Official]);

        var response = await service.RemoveAsync(Official, CancellationToken.None);

        Assert.True(response.Managed);
        Assert.Empty(response.Sources);
        // The default is now gone for good — the store is materialized as an empty list, not re-seeded.
        Assert.Empty(await service.GetEffectiveSourcesAsync(CancellationToken.None));
    }

    [Fact]
    public async Task RemoveAsync_NotConfigured_ThrowsNotFound()
    {
        var (service, _) = CreateService([Official]);

        var ex = await Assert.ThrowsAsync<AppLifecycleException>(
            () => service.RemoveAsync(Private, CancellationToken.None));
        Assert.Equal("catalog_source_not_found", ex.Code);
    }

    [Fact]
    public async Task AddThenRemove_ReturnsToEnvDefaultContents_ButStaysManaged()
    {
        var (service, _) = CreateService([Official]);

        await service.AddAsync(Private, CancellationToken.None);
        var response = await service.RemoveAsync(Private, CancellationToken.None);

        Assert.True(response.Managed); // still operator-managed once materialized
        Assert.Equal([Official], response.Sources.Select(source => source.Url));
    }

    // ---- helpers ----------------------------------------------------------------------------------

    private static (CatalogSourceService Service, CoreDataPaths Paths) CreateService(IReadOnlyList<string> envSources)
    {
        var root = Path.Combine(Path.GetTempPath(), $"hosty-catalog-sources-tests-{Guid.NewGuid():N}");
        Directory.CreateDirectory(Path.Combine(root, "core"));
        var paths = new CoreDataPaths(
            DataRoot: root,
            CoreRoot: Path.Combine(root, "core"),
            AppsRoot: Path.Combine(root, "apps"),
            BackupsRoot: Path.Combine(root, "backups"),
            SourcesRoot: Path.Combine(root, "sources"),
            AuthRoot: Path.Combine(root, "core", "auth"),
            AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));
        return (new CatalogSourceService(new CatalogSourceStore(paths), CreateConfig(paths, envSources)), paths);
    }

    private static HostyCoreRuntimeConfig CreateConfig(CoreDataPaths paths, IReadOnlyList<string> sources)
        => new(
            DataRoot: paths.DataRoot,
            RunDirectory: Path.Combine(paths.CoreRoot, "run"),
            ControlDiscoveryPath: Path.Combine(paths.CoreRoot, "run", "control.json"),
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
}
