using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed class BootstrapChoicesStoreTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"hosty-choices-tests-{Guid.NewGuid():N}");

    [Fact]
    public async Task LoadAsync_MissingFile_ReturnsNullAndExistsIsFalse()
    {
        var store = CreateStore();

        Assert.False(store.Exists);
        Assert.Null(await store.LoadAsync());
    }

    [Fact]
    public async Task SetEnabledAsync_RoundTripsAndPersists()
    {
        var store = CreateStore();

        await store.SetEnabledAsync("hosty.telemetry", enabled: true);
        await store.SetEnabledAsync("hosty.marketplace", enabled: false);

        var reread = await CreateStore().LoadAsync();
        Assert.NotNull(reread);
        Assert.Equal(BootstrapChoicesSchema.Version, reread!.SchemaVersion);
        Assert.True(reread.EnabledFor("hosty.telemetry"));
        Assert.False(reread.EnabledFor("hosty.marketplace"));
        Assert.Null(reread.EnabledFor("hosty.shell"));
    }

    [Fact]
    public async Task SetEnabledAsync_OverwritesExistingChoice()
    {
        var store = CreateStore();
        await store.SetEnabledAsync("hosty.telemetry", enabled: true);

        await store.SetEnabledAsync("hosty.telemetry", enabled: false);

        Assert.False((await CreateStore().LoadAsync())!.EnabledFor("hosty.telemetry"));
    }

    [Fact]
    public async Task SeedIfAbsentAsync_WritesOnlyWhenNoFileExists()
    {
        var store = CreateStore();
        var seed = new BootstrapChoicesDocument
        {
            Apps = new Dictionary<string, BootstrapChoiceEntry>(StringComparer.Ordinal)
            {
                ["hosty.shell"] = new() { Enabled = true },
            },
        };

        Assert.True(await store.SeedIfAbsentAsync(seed));
        Assert.False(await store.SeedIfAbsentAsync(new BootstrapChoicesDocument()));

        var reread = await CreateStore().LoadAsync();
        Assert.True(reread!.EnabledFor("hosty.shell"));
    }

    [Fact]
    public async Task CorruptedFile_LoadsAsNullButStillCountsAsPresent()
    {
        var path = Path.Combine(root, "core", BootstrapChoicesSchema.FileName);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await File.WriteAllTextAsync(path, "{ not json");
        var store = CreateStore();

        // Loud-but-non-fatal parse failure boots on defaults, while Exists stays true so the boot
        // migration can never clobber the operator's (broken) file with synthesized pins.
        Assert.Null(await store.LoadAsync());
        Assert.True(store.Exists);
        Assert.False(await store.SeedIfAbsentAsync(new BootstrapChoicesDocument()));
    }

    [Fact]
    public async Task WrongSchemaVersion_LoadsAsNull()
    {
        var path = Path.Combine(root, "core", BootstrapChoicesSchema.FileName);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await File.WriteAllTextAsync(path, """{ "schemaVersion": "bootstrap-choices.9.9", "apps": {} }""");

        Assert.Null(await CreateStore().LoadAsync());
    }

    private BootstrapChoicesStore CreateStore()
    {
        var paths = new CoreDataPaths(
            DataRoot: root,
            CoreRoot: Path.Combine(root, "core"),
            AppsRoot: Path.Combine(root, "apps"),
            BackupsRoot: Path.Combine(root, "backups"),
            SourcesRoot: Path.Combine(root, "sources"),
            AuthRoot: Path.Combine(root, "core", "auth"),
            AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));
        return new BootstrapChoicesStore(paths, NullLogger<BootstrapChoicesStore>.Instance);
    }

    public void Dispose()
    {
        if (Directory.Exists(root))
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
