using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class PrebuiltArtifactStoreTests
{
    [Fact]
    public void HashDirectory_IsStableForSameContent_AndChangesWithContent()
    {
        var a = CreateTree(("app/server.js", "console.log(1)"), ("public/index.html", "<html>"));
        var b = CreateTree(("app/server.js", "console.log(1)"), ("public/index.html", "<html>"));
        var c = CreateTree(("app/server.js", "console.log(2)"), ("public/index.html", "<html>"));
        try
        {
            Assert.Equal(PrebuiltArtifactStore.HashDirectory(a), PrebuiltArtifactStore.HashDirectory(b));
            Assert.NotEqual(PrebuiltArtifactStore.HashDirectory(a), PrebuiltArtifactStore.HashDirectory(c));
        }
        finally
        {
            Delete(a); Delete(b); Delete(c);
        }
    }

    [Fact]
    public void Resolve_MaterializesDeliveryUnderContentAddressedStore()
    {
        var appRoot = CreateDir();
        var source = CreateTree(("dist/server.js", "run"));
        try
        {
            var (artifactRoot, lockRecord) = PrebuiltArtifactStore.Resolve(
                appRoot, "release", source, new RuntimePrebuiltDeliveryManifest { Type = "folder", Path = "dist" },
                existingLock: null, policy: "pinned");

            Assert.Equal("prebuilt", lockRecord.Kind);
            Assert.False(string.IsNullOrWhiteSpace(lockRecord.BundleHash));
            Assert.Equal(Path.Combine(appRoot, "runtimes", "release", "artifact", lockRecord.BundleHash!), artifactRoot);
            Assert.True(File.Exists(Path.Combine(artifactRoot, "server.js")));
        }
        finally
        {
            Delete(appRoot); Delete(source);
        }
    }

    [Fact]
    public void Resolve_Pinned_RerunsLockedCopy_EvenWhenDeliveryChanges()
    {
        var appRoot = CreateDir();
        var source = CreateTree(("dist/server.js", "v1"));
        try
        {
            var (_, first) = PrebuiltArtifactStore.Resolve(
                appRoot, "release", source, new RuntimePrebuiltDeliveryManifest { Type = "folder", Path = "dist" },
                existingLock: null, policy: "pinned");

            // Change the delivery, then resolve pinned with the recorded lock: the locked copy re-runs.
            File.WriteAllText(Path.Combine(source, "dist", "server.js"), "v2");
            var (pinnedRoot, pinned) = PrebuiltArtifactStore.Resolve(
                appRoot, "release", source, new RuntimePrebuiltDeliveryManifest { Type = "folder", Path = "dist" },
                existingLock: first, policy: "pinned");

            Assert.Equal(first.BundleHash, pinned.BundleHash);
            Assert.Equal("v1", File.ReadAllText(Path.Combine(pinnedRoot, "server.js")));
        }
        finally
        {
            Delete(appRoot); Delete(source);
        }
    }

    [Fact]
    public void Resolve_Rolling_AdoptsChangedDelivery()
    {
        var appRoot = CreateDir();
        var source = CreateTree(("dist/server.js", "v1"));
        try
        {
            var (_, first) = PrebuiltArtifactStore.Resolve(
                appRoot, "release", source, new RuntimePrebuiltDeliveryManifest { Type = "folder", Path = "dist" },
                existingLock: null, policy: "rolling");

            File.WriteAllText(Path.Combine(source, "dist", "server.js"), "v2");
            var (rollingRoot, rolling) = PrebuiltArtifactStore.Resolve(
                appRoot, "release", source, new RuntimePrebuiltDeliveryManifest { Type = "folder", Path = "dist" },
                existingLock: first, policy: "rolling");

            Assert.NotEqual(first.BundleHash, rolling.BundleHash);
            Assert.Equal("v2", File.ReadAllText(Path.Combine(rollingRoot, "server.js")));
        }
        finally
        {
            Delete(appRoot); Delete(source);
        }
    }

    [Fact]
    public void Resolve_Throws_WhenDeliveryFolderMissing()
    {
        var appRoot = CreateDir();
        var source = CreateDir();
        try
        {
            var error = Assert.Throws<AppLifecycleException>(() => PrebuiltArtifactStore.Resolve(
                appRoot, "release", source, new RuntimePrebuiltDeliveryManifest { Type = "folder", Path = "dist" },
                existingLock: null, policy: "pinned"));
            Assert.Equal("prebuilt_delivery_not_found", error.Code);
        }
        finally
        {
            Delete(appRoot); Delete(source);
        }
    }

    private static string CreateDir()
    {
        var path = Path.Combine(Path.GetTempPath(), $"hosty-prebuilt-tests-{Guid.NewGuid():N}");
        Directory.CreateDirectory(path);
        return path;
    }

    private static string CreateTree(params (string RelativePath, string Content)[] files)
    {
        var root = CreateDir();
        foreach (var (relativePath, content) in files)
        {
            var full = Path.Combine(root, relativePath);
            Directory.CreateDirectory(Path.GetDirectoryName(full)!);
            File.WriteAllText(full, content);
        }

        return root;
    }

    private static void Delete(string path)
    {
        try
        {
            Directory.Delete(path, recursive: true);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}
