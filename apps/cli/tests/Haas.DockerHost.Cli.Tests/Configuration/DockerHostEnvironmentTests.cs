using Haas.DockerHost.Cli.Configuration;

namespace Haas.DockerHost.Cli.Tests.Configuration;

public sealed class DockerHostEnvironmentTests
{
    [Fact]
    public void ResolveDefaultRootDirectory_WhenNeitherRootExists_ReturnsPreferredHostyRoot()
    {
        var root = Path.Combine(Path.GetTempPath(), $"hosty-root-test-{Guid.NewGuid():N}");
        var preferred = Path.Combine(root, ".hosty");
        var legacy = Path.Combine(root, ".docker-host");

        var resolved = DockerHostEnvironment.ResolveDefaultRootDirectory(preferred, legacy);

        Assert.Equal(preferred, resolved);
    }

    [Fact]
    public void ResolveDefaultRootDirectory_WhenOnlyLegacyRootExists_ReturnsLegacyRoot()
    {
        var root = Path.Combine(Path.GetTempPath(), $"hosty-root-test-{Guid.NewGuid():N}");
        var preferred = Path.Combine(root, ".hosty");
        var legacy = Path.Combine(root, ".docker-host");
        Directory.CreateDirectory(legacy);

        try
        {
            var resolved = DockerHostEnvironment.ResolveDefaultRootDirectory(preferred, legacy);

            Assert.Equal(legacy, resolved);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void ResolveDefaultRootDirectory_WhenBothRootsExist_ReturnsPreferredHostyRoot()
    {
        var root = Path.Combine(Path.GetTempPath(), $"hosty-root-test-{Guid.NewGuid():N}");
        var preferred = Path.Combine(root, ".hosty");
        var legacy = Path.Combine(root, ".docker-host");
        Directory.CreateDirectory(preferred);
        Directory.CreateDirectory(legacy);

        try
        {
            var resolved = DockerHostEnvironment.ResolveDefaultRootDirectory(preferred, legacy);

            Assert.Equal(preferred, resolved);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
