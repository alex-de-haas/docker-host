using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class RuntimeAppManifestRepositoryTests
{
    [Fact]
    public async Task ShellManifest_DeclaresDockerAndLocalCommandRuntimeProfiles()
    {
        var manifestPath = Path.Combine(FindRepositoryRoot(), "apps", "shell", "manifest.json");
        var service = new AppManifestService();

        var docker = await service.LoadAsync(manifestPath, "docker");
        var dev = await service.LoadAsync(manifestPath, "dev");

        Assert.Equal("hosty.shell", docker.Manifest.Id);
        Assert.Equal("docker", docker.RuntimeProfile.Type);
        Assert.Equal("dev", dev.RuntimeProfile.Key);
        Assert.Equal("localCommand", dev.RuntimeProfile.Type);
        Assert.Equal("apps/shell", Assert.Single(dev.Services).Runtime.WorkingDirectory);
    }

    private static string FindRepositoryRoot()
    {
        var directory = new DirectoryInfo(Directory.GetCurrentDirectory());
        while (directory is not null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "apps", "shell", "manifest.json")))
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        throw new InvalidOperationException("Unable to locate repository root.");
    }
}
