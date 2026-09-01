using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class CoreInstanceIdTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"hosty-instance-id-tests-{Guid.NewGuid():N}");

    [Fact]
    public void IsDefaultDataRoot_MatchesTheUserProfileHostyFolderOnly()
    {
        var defaultRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".hosty");

        Assert.True(CoreInstanceId.IsDefaultDataRoot(defaultRoot));
        Assert.True(CoreInstanceId.IsDefaultDataRoot(defaultRoot + Path.DirectorySeparatorChar));
        Assert.False(CoreInstanceId.IsDefaultDataRoot(root));
    }

    [Fact]
    public void LoadOrCreate_DefaultRoot_UsesTheReservedEmptyId()
    {
        // The reserved empty id is what keeps the default root's container names and filters
        // byte-for-byte today's — zero-churn migration for existing hosts. No file is written.
        var defaultRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".hosty");

        Assert.Equal(string.Empty, CoreInstanceId.LoadOrCreate(defaultRoot));
    }

    [Fact]
    public void LoadOrCreate_NonDefaultRoot_GeneratesOnceAndThenStaysStable()
    {
        var first = CoreInstanceId.LoadOrCreate(root);

        Assert.Equal(32, first.Length);
        Assert.True(File.Exists(CoreInstanceId.BuildPath(root)));
        Assert.Equal(first, CoreInstanceId.LoadOrCreate(root));
    }

    [Fact]
    public void LoadOrCreate_ReadsAStoredIdBack()
    {
        // A folder move carries the file with it — identity follows the root, not the path.
        var path = CoreInstanceId.BuildPath(root);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, "abc123stored\n");

        Assert.Equal("abc123stored", CoreInstanceId.LoadOrCreate(root));
    }

    public void Dispose()
    {
        if (Directory.Exists(root))
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
