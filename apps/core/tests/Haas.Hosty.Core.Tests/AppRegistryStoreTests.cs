using System.Text.Json;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class AppRegistryStoreTests
{
    [Fact]
    public async Task ListAppsAsync_ReadsAppNativeRecordsWithoutLegacyModules()
    {
        var root = await CreateTempRootAsync();
        await File.WriteAllTextAsync(Path.Combine(root, "modules.json"), """{"modules":[{"id":"legacy.module"}]}""");
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
