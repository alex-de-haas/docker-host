using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class GlobalMountServiceTests
{
    private static (GlobalMountService Service, CoreDataPaths Paths) Create()
    {
        var root = Path.Combine(Path.GetTempPath(), $"hosty-global-mount-tests-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        var paths = new CoreDataPaths(
            DataRoot: root,
            CoreRoot: Path.Combine(root, "core"),
            AppsRoot: Path.Combine(root, "apps"),
            BackupsRoot: Path.Combine(root, "backups"),
            SourcesRoot: Path.Combine(root, "sources"),
            AuthRoot: Path.Combine(root, "core", "auth"),
            AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));
        var apps = new AppRegistryStore(paths);
        return (new GlobalMountService(new GlobalMountStore(paths), apps, new MountPathPolicy(paths)), paths);
    }

    private static string ExternalDirectory()
    {
        var path = Path.Combine(Path.GetTempPath(), $"hosty-global-mount-src-{Guid.NewGuid():N}");
        Directory.CreateDirectory(path);
        return path;
    }

    [Fact]
    public async Task UpsertAsync_NormalizesAndDefaultsMode()
    {
        var (service, _) = Create();
        var host = ExternalDirectory();

        var mounts = await service.UpsertAsync(new GlobalMountUpsertRequest("media", host, Description: " Catalog "));

        var entry = Assert.Single(mounts);
        Assert.Equal("media", entry.Name);
        Assert.Equal(Path.GetFullPath(host), entry.HostPath);
        Assert.Equal("rw", entry.Mode);
        Assert.Equal("Catalog", entry.Description);
        Assert.Equal(0, entry.UsedBy);
    }

    [Fact]
    public async Task UpsertAsync_ReplacesExistingByName()
    {
        var (service, _) = Create();
        await service.UpsertAsync(new GlobalMountUpsertRequest("media", ExternalDirectory(), "rw"));

        var second = ExternalDirectory();
        var mounts = await service.UpsertAsync(new GlobalMountUpsertRequest("media", second, "ro"));

        var entry = Assert.Single(mounts);
        Assert.Equal(Path.GetFullPath(second), entry.HostPath);
        Assert.Equal("ro", entry.Mode);
    }

    [Theory]
    [InlineData("Bad Name", "global_mount_name_invalid")]
    [InlineData("", "global_mount_name_invalid")]
    public async Task UpsertAsync_RejectsInvalidName(string name, string expectedCode)
    {
        var (service, _) = Create();

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            service.UpsertAsync(new GlobalMountUpsertRequest(name, ExternalDirectory())));

        Assert.Equal(expectedCode, error.Code);
    }

    [Fact]
    public async Task UpsertAsync_RejectsInvalidMode()
    {
        var (service, _) = Create();

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            service.UpsertAsync(new GlobalMountUpsertRequest("media", ExternalDirectory(), "append")));

        Assert.Equal("global_mount_mode_invalid", error.Code);
    }

    [Fact]
    public async Task UpsertAsync_RejectsHostPathInsideDataRoot()
    {
        var (service, paths) = Create();
        var inside = Path.Combine(paths.DataRoot, "stolen");
        Directory.CreateDirectory(inside);

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            service.UpsertAsync(new GlobalMountUpsertRequest("media", inside)));

        Assert.Equal("app_mount_path_in_data_root", error.Code);
    }

    [Fact]
    public async Task DeleteAsync_ThrowsWhenMissing()
    {
        var (service, _) = Create();

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            service.DeleteAsync("ghost", force: false));

        Assert.Equal("global_mount_not_found", error.Code);
    }
}
