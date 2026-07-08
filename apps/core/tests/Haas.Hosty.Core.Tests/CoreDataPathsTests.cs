using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class CoreDataPathsTests
{
    [Theory]
    [InlineData("com.example.notes")]
    [InlineData("hosty.shell")]
    [InlineData("app_1-x")]
    public void TryResolveContainedPath_AcceptsPlainSegments(string segment)
    {
        var root = Path.Combine(Path.GetTempPath(), "hosty-core-paths-tests");

        Assert.True(CoreDataPaths.TryResolveContainedPath(root, segment, out var fullPath));
        Assert.Equal(Path.GetFullPath(Path.Combine(root, segment)), fullPath);
    }

    [Theory]
    [InlineData("..")]
    [InlineData(".")]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("../sibling")]
    [InlineData("nested/segment")]
    [InlineData("nested\\segment")]
    public void TryResolveContainedPath_RejectsTraversalSegments(string segment)
    {
        var root = Path.Combine(Path.GetTempPath(), "hosty-core-paths-tests");

        Assert.False(CoreDataPaths.TryResolveContainedPath(root, segment, out _));
    }

    [Fact]
    public void ResolveContainedPath_ThrowsForTraversalSegments()
    {
        var root = Path.Combine(Path.GetTempPath(), "hosty-core-paths-tests");

        var error = Assert.Throws<AppLifecycleException>(() => CoreDataPaths.ResolveContainedPath(root, ".."));

        Assert.Equal("app_id_invalid", error.Code);
    }

    [Theory]
    [InlineData("icon.svg")]
    [InlineData("assets/icon.svg")]
    [InlineData("docs/store.md")]
    [InlineData("a/b/c/d.png")]
    public void TryResolveContainedRelativePath_AcceptsMultiSegmentPaths(string relativePath)
    {
        var root = Path.Combine(Path.GetTempPath(), "hosty-core-assets-tests");

        Assert.True(CoreDataPaths.TryResolveContainedRelativePath(root, relativePath, out var fullPath));
        Assert.Equal(Path.GetFullPath(Path.Combine(root, relativePath.Replace('/', Path.DirectorySeparatorChar))), fullPath);
    }

    [Theory]
    [InlineData("")]
    [InlineData("../secret.png")]
    [InlineData("assets/../../secret.png")]
    [InlineData("docs/./../../secret.md")]
    [InlineData("assets/icon.svg:stream")]
    [InlineData("assets\\icon.svg")]
    [InlineData("/etc/passwd")]
    [InlineData("a//b.png")]
    public void TryResolveContainedRelativePath_RejectsTraversalAndUnsafePaths(string relativePath)
    {
        var root = Path.Combine(Path.GetTempPath(), "hosty-core-assets-tests");

        Assert.False(CoreDataPaths.TryResolveContainedRelativePath(root, relativePath, out _));
    }
}
