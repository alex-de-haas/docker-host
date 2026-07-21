using System.Text.Json;
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
    public async Task UpsertAsync_AcceptsMissingHostPathButReportsItAsNotPresent()
    {
        var (service, _) = Create();
        // Never created: stands in for a drive that is not attached yet — and for a typo'd path.
        var missing = Path.Combine(Path.GetTempPath(), $"hosty-global-mount-absent-{Guid.NewGuid():N}");

        var mounts = await service.UpsertAsync(new GlobalMountUpsertRequest("media", missing));

        // Registration must still succeed (network/removable drives), but the entry is flagged so the
        // CLI and Shell can warn instead of letting the typo surface only when an app fails to start.
        var entry = Assert.Single(mounts);
        Assert.Equal(Path.GetFullPath(missing), entry.HostPath);
        Assert.False(entry.HostPathExists);
    }

    [Fact]
    public async Task ListAsync_ReportsHostPathPresence()
    {
        var (service, _) = Create();
        var present = ExternalDirectory();
        var missing = Path.Combine(Path.GetTempPath(), $"hosty-global-mount-absent-{Guid.NewGuid():N}");
        await service.UpsertAsync(new GlobalMountUpsertRequest("present", present));
        await service.UpsertAsync(new GlobalMountUpsertRequest("missing", missing));

        var mounts = await service.ListAsync();

        Assert.True(Assert.Single(mounts, mount => mount.Name == "present").HostPathExists);
        Assert.False(Assert.Single(mounts, mount => mount.Name == "missing").HostPathExists);
    }

    [Fact]
    public async Task ListAsync_ReportsAPathThatDisappearedAfterRegistration()
    {
        var (service, _) = Create();
        var host = ExternalDirectory();
        await service.UpsertAsync(new GlobalMountUpsertRequest("media", host));
        Assert.True(Assert.Single(await service.ListAsync()).HostPathExists);

        // Presence is resolved per read, not cached at registration: a detached drive shows up as missing.
        Directory.Delete(host);

        Assert.False(Assert.Single(await service.ListAsync()).HostPathExists);
    }

    [Fact]
    public async Task GlobalMountListResponse_SerializesHostPathPresenceForClients()
    {
        var (service, _) = Create();
        var missing = Path.Combine(Path.GetTempPath(), $"hosty-global-mount-absent-{Guid.NewGuid():N}");
        await service.UpsertAsync(new GlobalMountUpsertRequest("media", missing));

        // Source-generated, trim/AOT-safe serialization: assert the field actually reaches the wire under
        // the camelCase name the CLI and Shell read, not just that the service computed it.
        var json = JsonSerializer.Serialize(
            new GlobalMountListResponse(await service.ListAsync()),
            CoreJsonSerializerContext.Default.GlobalMountListResponse);

        using var document = JsonDocument.Parse(json);
        var entry = Assert.Single(document.RootElement.GetProperty("mounts").EnumerateArray());
        Assert.False(entry.GetProperty("hostPathExists").GetBoolean());
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
