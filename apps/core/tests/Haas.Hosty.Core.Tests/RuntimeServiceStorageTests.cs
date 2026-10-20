using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class RuntimeServiceStorageTests
{
    private static RuntimeAppManifestSelection Selection(RuntimeAppDataManifest data, RuntimeAppDataManifest? cache = null)
        => new(new RuntimeAppManifest { Data = data, Cache = cache }, "", "", new RuntimeProfileManifest { Key = "production", Type = "docker" }, [], null, "", null);
    private static RuntimeSelectedService Service(string key) => new(key, [], new RuntimeServiceProfileManifest { Type = "docker" }, null, "image");

    [Fact]
    public void ImplicitDockerStoragePreservesFirstServiceScope()
    {
        var selection = Selection(new RuntimeAppDataManifest { Enabled = true });
        var manifest = new RuntimeAppManifest
        {
            Data = selection.Manifest.Data,
            Services = [new() { Key = "web", Runtimes = new Dictionary<string, RuntimeServiceProfileManifest> { ["production"] = new() { Type = "docker" } } },
                new() { Key = "processor", Runtimes = new Dictionary<string, RuntimeServiceProfileManifest> { ["production"] = new() { Type = "docker" } } }],
        };
        selection = selection with { Manifest = manifest };
        Assert.Single(RuntimeServiceStorage.Resolve(selection, Service("web")));
        Assert.Empty(RuntimeServiceStorage.Resolve(selection, Service("processor")));
    }

    [Theory]
    [InlineData(@"C:\Projects\Space ü\trees", "/run/desktop/mnt/host/c/Projects/Space ü/trees", true)]
    [InlineData(@"D:\Projects\trees", "/host_mnt/d/Projects/trees", true)]
    [InlineData(@"D:\Projects\trees", "/host_mnt/c/Projects/trees", false)]
    [InlineData("/srv/trees", "/srv/trees-other", false)]
    [InlineData("/Users/test/trees", "/host_mnt/Users/test/trees", true)]
    public void DesktopMountPaths_KeepDriveAndDirectoryIdentity(string expected, string actual, bool equivalent)
        => Assert.Equal(equivalent, DockerMountPaths.Equivalent(actual, expected, macDesktop: true));

    [Fact]
    public void DockerMountOverlapKeepsIndividualWorkspaceConsumersAndLinuxPathsDistinct()
    {
        Assert.True(DockerMountPaths.Overlaps("/run/desktop/mnt/host/c/Core/trees/id/child", @"C:\Core\trees\id"));
        Assert.True(DockerMountPaths.Overlaps("/host_mnt/c/Core/trees", @"C:\Core\trees\id"));
        Assert.False(DockerMountPaths.Overlaps("/host_mnt/c/Core/trees/id-other", @"C:\Core\trees\id"));
        Assert.False(DockerMountPaths.Equivalent("/host_mnt/data", "/data", macDesktop: false));
    }

    [Fact]
    public void MultipleTargets_StayScopedAndProfileOverridesOnlyMatchingEnvironment()
    {
        var selection = Selection(new RuntimeAppDataManifest { Enabled = true, Targets = [
            new() { Runtime = "docker", Service = "api", ContainerPath = "/api" },
            new() { Runtime = "docker", Service = "processor", SubPath = "state", ContainerPath = "/state" },
            new() { Runtime = "docker", Service = "processor", SubPath = "auth", ContainerPath = "/auth", Environment = "SERVICE_AUTH", Mode = "ro" },
            new() { Runtime = "production", Service = "processor", SubPath = "custom", ContainerPath = "/custom" },
        ] });
        var bindings = RuntimeServiceStorage.Resolve(selection, Service("processor"));
        Assert.Equal(2, bindings.Count);
        Assert.Contains(bindings, b => b.Target.SubPath == "custom" && b.Environment == "HOSTY_APP_DATA_DIR");
        Assert.Contains(bindings, b => b.Target.SubPath == "auth" && b.Target.Mode == "ro");
        Assert.Empty(RuntimeServiceStorage.Resolve(selection, Service("unrelated")));
    }

    [Theory]
    [InlineData("../escape")]
    [InlineData("a/../b")]
    [InlineData("C:/data")]
    [InlineData("a\\b")]
    [InlineData("a//b")]
    [InlineData("/absolute")]
    public void StorageRejectsNonContainedNames(string subPath)
        => Assert.False(RuntimeServiceStorage.ValidSubPath(subPath));

    [Fact]
    public void StorageRejectsLinkEscapeAndPreservesSiblingData()
    {
        var root = Path.Combine(Path.GetTempPath(), "hosty-storage-" + Guid.NewGuid().ToString("N"));
        try
        {
            var data = Path.Combine(root, "data");
            var other = Path.Combine(root, "other");
            Directory.CreateDirectory(data);
            Directory.CreateDirectory(other);
            File.WriteAllText(Path.Combine(other, "keep"), "existing");
            Directory.CreateSymbolicLink(Path.Combine(data, "link"), other);
            Assert.Throws<AppLifecycleException>(() => RuntimeServiceStorage.PreparePath(data, "link/child"));
            Assert.Equal("existing", File.ReadAllText(Path.Combine(other, "keep")));
            Assert.False(Directory.Exists(Path.Combine(other, "child")));
        }
        finally { Directory.Delete(root, true); }
    }

    [Fact]
    public void ValidationRejectsOverlappingDestinationsAndDuplicateVariables()
    {
        var selection = Selection(new RuntimeAppDataManifest { Enabled = true, Targets = [
            new() { Runtime = "production", ContainerPath = "/state" },
            new() { Runtime = "production", ContainerPath = "/state/auth" },
        ] });
        var errors = new List<AppManifestValidationError>();
        RuntimeServiceStorage.Validate(selection.Manifest, selection.RuntimeProfile, [Service("processor")], errors);
        Assert.Contains(errors, e => e.Code == "app_manifest_storage_environment_invalid");
        Assert.Contains(errors, e => e.Code == "app_manifest_storage_destination_invalid");
    }

    [Fact]
    public void ManagedCollectionBindingsCannotBeReplacedByOperatorPaths()
    {
        var slots = new AppMountSlot[] { new("development", "rw", true, true, "processor", "managed-workspaces") };
        var bindings = new AppMountBinding[] { new("development", "trees", "/unrelated") };
        Assert.Empty(RuntimeMountPlanner.Resolve(slots, bindings));
    }
}
