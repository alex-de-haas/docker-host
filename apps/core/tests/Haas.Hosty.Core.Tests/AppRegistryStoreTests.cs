using System.Text.Json;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class AppRegistryStoreTests
{
    [Fact]
    public async Task ListAppsAsync_ReadsAppNativeRecords()
    {
        var root = await CreateTempRootAsync();
        var paths = CreatePaths(root);
        var store = new AppRegistryStore(paths);
        await store.UpsertAppAsync(CreateApp("com.example.notes"));

        var apps = await store.ListAppsAsync();

        var app = Assert.Single(apps);
        Assert.Equal("com.example.notes", app.Id);
        Assert.Equal("Notes", app.DisplayName);
        Assert.Equal("docker", app.SelectedRuntime);
    }

    [Fact]
    public async Task ListAppsAsync_HydratesUiNavigationFromInstalledManifest()
    {
        var root = await CreateTempRootAsync();
        var paths = CreatePaths(root);
        var appRoot = Path.Combine(paths.AppsRoot, "com.example.notes");
        Directory.CreateDirectory(appRoot);
        await File.WriteAllTextAsync(Path.Combine(appRoot, "manifest.json"), """
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.notes",
              "name": "Notes",
              "version": "1.0.0",
              "runtimeProfiles": [{ "key": "docker", "type": "docker", "default": true }],
              "services": [{
                "key": "app",
                "runtimes": {
                  "docker": {
                    "type": "docker",
                    "image": "ghcr.io/example/notes:1.0.0"
                  }
                }
              }],
              "endpoints": [{ "key": "http", "service": "app", "port": "http", "protocol": "http", "public": true }],
              "ui": {
                "entrypoint": { "endpoint": "http", "path": "/" },
                "navigation": [
                  { "label": "Notes", "path": "/" },
                  { "label": "Settings", "path": "/settings" }
                ]
              }
            }
            """);
        var store = new AppRegistryStore(paths);
        await store.UpsertAppAsync(CreateApp("com.example.notes") with
        {
            ManifestPath = Path.Combine(appRoot, "manifest.json"),
            Endpoints =
            [
                new AppEndpointContract("http", "http", "http://app.localhost:3100", Public: true),
            ],
        });

        var apps = await store.ListAppsAsync();

        var app = Assert.Single(apps);
        Assert.Equal("/", app.EntryPath);
        Assert.Equal("http://app.localhost:3100/", app.EmbeddedUrl);
        Assert.Collection(
            app.Navigation,
            item =>
            {
                Assert.Equal("Notes", item.Label);
                Assert.Equal("http://app.localhost:3100/", item.EmbeddedUrl);
            },
            item =>
            {
                Assert.Equal("Settings", item.Label);
                Assert.Equal("/settings", item.Path);
                Assert.Equal("http://app.localhost:3100/settings", item.EmbeddedUrl);
            });
    }

    [Fact]
    public async Task ListAppsAsync_SkipsInvalidAppDirectories()
    {
        var root = await CreateTempRootAsync();
        var paths = CreatePaths(root);
        Directory.CreateDirectory(Path.Combine(paths.AppsRoot, "broken"));
        await File.WriteAllTextAsync(Path.Combine(paths.AppsRoot, "broken", "state.json"), "{}");

        var apps = await new AppRegistryStore(paths).ListAppsAsync();

        Assert.Empty(apps);
    }

    [Fact]
    public async Task ListAppsAsync_SkipsCorruptedStateAndContinuesListingHealthyApps()
    {
        var root = await CreateTempRootAsync();
        var paths = CreatePaths(root);
        var store = new AppRegistryStore(paths);
        await store.UpsertAppAsync(CreateApp("com.example.notes"));
        var brokenRoot = Path.Combine(paths.AppsRoot, "broken");
        Directory.CreateDirectory(brokenRoot);
        await File.WriteAllTextAsync(Path.Combine(brokenRoot, "state.json"), "{not-json");

        var apps = await store.ListAppsAsync();

        var app = Assert.Single(apps);
        Assert.Equal("com.example.notes", app.Id);
    }

    [Fact]
    public async Task UserDirectoryStore_ReadAsync_ReturnsEmptyFinalStateWhenMissing()
    {
        var root = await CreateTempRootAsync();
        var store = new UserDirectoryStore(CreatePaths(root));

        var state = await store.ReadAsync();

        Assert.Equal(1, state.SchemaVersion);
        Assert.Empty(state.Users);
        Assert.Empty(state.Invitations);
        Assert.Empty(state.Assignments);
        Assert.Empty(state.Sessions);
    }

    private static AppRecord CreateApp(string id)
        => new(
            Id: id,
            DisplayName: "Notes",
            Description: "Personal notes app.",
            Version: "1.0.0",
            Kind: "runtime",
            System: false,
            Source: "installed",
            ManifestPath: "apps/com.example.notes/manifest.json",
            ManifestUrl: null,
            SelectedChannel: "main",
            SelectedRuntime: "docker",
            OperationStatus: "installed",
            RuntimeState: "stopped",
            LastOperation: null,
            LastError: null,
            Capabilities: ["open", "update", "restart", "stop", "remove"],
            Settings: new Dictionary<string, AppSettingValue>(),
            StorageMappings: [],
            Dependencies: [],
            Endpoints: [],
            InstalledAt: DateTimeOffset.UtcNow,
            UpdatedAt: DateTimeOffset.UtcNow);

    private static CoreDataPaths CreatePaths(string root)
        => new(
            DataRoot: root,
            CoreRoot: Path.Combine(root, "core"),
            AppsRoot: Path.Combine(root, "apps"),
            BackupsRoot: Path.Combine(root, "backups"),
            SourcesRoot: Path.Combine(root, "sources"),
            AuthRoot: Path.Combine(root, "core", "auth"),
            AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));

    private static async Task<string> CreateTempRootAsync()
    {
        var root = Path.Combine(Path.GetTempPath(), $"hosty-core-tests-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        await File.WriteAllTextAsync(Path.Combine(root, ".keep"), JsonSerializer.Serialize(new { created = DateTimeOffset.UtcNow }));
        return root;
    }
}
