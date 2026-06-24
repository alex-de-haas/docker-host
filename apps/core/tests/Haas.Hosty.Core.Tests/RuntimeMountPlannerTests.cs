using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class RuntimeMountPlannerTests
{
    private static readonly IReadOnlyList<AppMountSlot> CatalogSlots =
    [
        new("catalogRoots", "rw", Multiple: true, Required: true, Service: "api"),
    ];

    [Fact]
    public void Resolve_BuildsLabelStableContainerPathsSortedByLabel()
    {
        var bindings = new AppMountBinding[]
        {
            new("catalogRoots", "movies-4k", "/srv/movies"),
            new("catalogRoots", "anime", "/srv/anime"),
        };

        var mounts = RuntimeMountPlanner.Resolve(CatalogSlots, bindings);

        Assert.Collection(
            mounts,
            mount =>
            {
                Assert.Equal("anime", mount.Label);
                Assert.Equal("/mnt/catalogRoots/anime", mount.ContainerPath);
                Assert.Equal("/srv/anime", mount.HostPath);
                Assert.False(mount.ReadOnly);
                Assert.Equal("api", mount.Service);
            },
            mount =>
            {
                Assert.Equal("movies-4k", mount.Label);
                Assert.Equal("/mnt/catalogRoots/movies-4k", mount.ContainerPath);
            });
    }

    [Fact]
    public void Resolve_MarksReadOnlyFromSlotMode()
    {
        IReadOnlyList<AppMountSlot> slots = [new("config", "ro", Multiple: false, Required: false, Service: null)];
        var bindings = new AppMountBinding[] { new("config", "shared", "/srv/config") };

        var mount = Assert.Single(RuntimeMountPlanner.Resolve(slots, bindings));

        Assert.True(mount.ReadOnly);
    }

    [Fact]
    public void Resolve_IgnoresBindingsForUndeclaredSlots()
    {
        var bindings = new AppMountBinding[]
        {
            new("catalogRoots", "movies", "/srv/movies"),
            new("removed-slot", "orphan", "/srv/orphan"),
        };

        var mounts = RuntimeMountPlanner.Resolve(CatalogSlots, bindings);

        var mount = Assert.Single(mounts);
        Assert.Equal("catalogRoots", mount.Key);
    }

    [Fact]
    public void BuildMountEnvironment_DockerUsesContainerPathsLocalUsesHostPaths()
    {
        var bindings = new AppMountBinding[]
        {
            new("catalogRoots", "anime", "/srv/anime"),
            new("catalogRoots", "movies", "/srv/movies"),
        };
        var mounts = RuntimeMountPlanner.Resolve(CatalogSlots, bindings);

        var docker = RuntimeMountPlanner.BuildMountEnvironment(mounts, useContainerPath: true);
        var local = RuntimeMountPlanner.BuildMountEnvironment(mounts, useContainerPath: false);

        Assert.Equal("anime=/mnt/catalogRoots/anime,movies=/mnt/catalogRoots/movies", docker["HOSTY_MOUNT_CATALOGROOTS"]);
        Assert.Equal("anime=/srv/anime,movies=/srv/movies", local["HOSTY_MOUNT_CATALOGROOTS"]);
    }

    [Fact]
    public void BuildDockerVolumeArguments_EmitsReadOnlySuffixOnlyForReadOnlyMounts()
    {
        IReadOnlyList<AppMountSlot> slots =
        [
            new("media", "rw", Multiple: true, Required: false, Service: null),
            new("config", "ro", Multiple: false, Required: false, Service: null),
        ];
        var bindings = new AppMountBinding[]
        {
            new("config", "shared", "/srv/config"),
            new("media", "movies", "/srv/movies"),
        };
        var mounts = RuntimeMountPlanner.Resolve(slots, bindings);

        var args = RuntimeMountPlanner.BuildDockerVolumeArguments(mounts);

        // Sorted by (key, label): config first, then media.
        Assert.Equal(
            ["-v", "/srv/config:/mnt/config/shared:ro", "-v", "/srv/movies:/mnt/media/movies"],
            args);
    }

    [Fact]
    public void ForService_FiltersByDeclaredServiceAndIncludesUnscopedSlots()
    {
        IReadOnlyList<AppMountSlot> slots =
        [
            new("apiRoots", "rw", Multiple: true, Required: false, Service: "api"),
            new("shared", "rw", Multiple: false, Required: false, Service: null),
        ];
        var bindings = new AppMountBinding[]
        {
            new("apiRoots", "data", "/srv/api"),
            new("shared", "common", "/srv/shared"),
        };
        var mounts = RuntimeMountPlanner.Resolve(slots, bindings);

        var apiMounts = RuntimeMountPlanner.ForService(mounts, "api");
        var workerMounts = RuntimeMountPlanner.ForService(mounts, "worker");

        Assert.Equal(["apiRoots", "shared"], apiMounts.Select(mount => mount.Key).OrderBy(key => key));
        Assert.Equal(["shared"], workerMounts.Select(mount => mount.Key));
    }

    [Fact]
    public void EnsureRequiredConfigured_ThrowsWhenRequiredSlotHasNoBindings()
    {
        var error = Assert.Throws<AppLifecycleException>(
            () => RuntimeMountPlanner.EnsureRequiredConfigured(CatalogSlots, []));

        Assert.Equal("app_mount_required_unconfigured", error.Code);
    }

    [Fact]
    public void EnsureRequiredConfigured_PassesWhenRequiredSlotConfiguredAndOptionalEmpty()
    {
        IReadOnlyList<AppMountSlot> slots =
        [
            new("catalogRoots", "rw", Multiple: true, Required: true, Service: null),
            new("optional", "rw", Multiple: false, Required: false, Service: null),
        ];
        var bindings = new AppMountBinding[] { new("catalogRoots", "movies", "/srv/movies") };

        RuntimeMountPlanner.EnsureRequiredConfigured(slots, bindings);
    }
}
