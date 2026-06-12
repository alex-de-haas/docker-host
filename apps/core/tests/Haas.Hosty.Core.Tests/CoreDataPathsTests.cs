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
}
