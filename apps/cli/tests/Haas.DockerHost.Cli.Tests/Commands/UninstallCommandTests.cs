using Haas.DockerHost.Cli;
using Haas.DockerHost.Cli.Commands;
using Haas.DockerHost.Cli.Configuration;

namespace Haas.DockerHost.Cli.Tests.Commands;

public sealed class UninstallCommandTests : IDisposable
{
    private const string RootVariable = "DOCKER_HOST_HOME";
    private readonly string? previousRoot;
    private readonly string rootDirectory;

    public UninstallCommandTests()
    {
        previousRoot = Environment.GetEnvironmentVariable(RootVariable);
        rootDirectory = Path.Combine(Path.GetTempPath(), $"docker-host-uninstall-tests-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable(RootVariable, rootDirectory);
    }

    [Fact]
    public async Task RunAsync_UninstallWithArguments_ReturnsUsageError()
    {
        var exitCode = await CommandLine.RunAsync(["uninstall", "--delete-data"]);

        Assert.Equal(2, exitCode);
    }

    [Fact]
    public void Delete_DefaultRoot_RemovesHostFilesAndPreservesCliBin()
    {
        var environment = DockerHostEnvironment.Current();
        Directory.CreateDirectory(environment.BinDirectory);
        Directory.CreateDirectory(environment.ConfigDirectory);
        Directory.CreateDirectory(environment.ModulesDirectory);
        File.WriteAllText(Path.Combine(environment.BinDirectory, "docker-host"), "binary");
        File.WriteAllText(environment.LaunchConfigPath, "HOST_UI_PORT=3000");
        File.WriteAllText(Path.Combine(environment.RootDirectory, "modules.json"), "{}");
        File.WriteAllText(Path.Combine(environment.RootDirectory, "host-cache.txt"), "cache");

        var result = HostUninstallFileCleanup.Delete(environment, environment.RootDirectory);

        Assert.Contains(Path.Combine(environment.RootDirectory, "modules.json"), result.DeletedPaths);
        Assert.True(File.Exists(Path.Combine(environment.BinDirectory, "docker-host")));
        Assert.False(Directory.Exists(environment.ConfigDirectory));
        Assert.False(Directory.Exists(environment.ModulesDirectory));
        Assert.False(File.Exists(Path.Combine(environment.RootDirectory, "host-cache.txt")));
    }

    [Fact]
    public void Delete_ExternalDataRoot_RemovesKnownHostStateOnly()
    {
        var environment = DockerHostEnvironment.Current();
        var externalDataRoot = Path.Combine(Path.GetTempPath(), $"docker-host-data-{Guid.NewGuid():N}");
        Directory.CreateDirectory(environment.BinDirectory);
        Directory.CreateDirectory(environment.ConfigDirectory);
        Directory.CreateDirectory(environment.ModulesDirectory);
        Directory.CreateDirectory(Path.Combine(externalDataRoot, "modules"));
        File.WriteAllText(Path.Combine(environment.BinDirectory, "docker-host"), "binary");
        File.WriteAllText(environment.LaunchConfigPath, "HOST_DATA_ROOT_HOST=/custom");
        File.WriteAllText(Path.Combine(externalDataRoot, "modules.json"), "{}");
        File.WriteAllText(Path.Combine(externalDataRoot, "keep.txt"), "not owned by docker-host");

        try
        {
            HostUninstallFileCleanup.Delete(environment, externalDataRoot);

            Assert.True(File.Exists(Path.Combine(environment.BinDirectory, "docker-host")));
            Assert.False(Directory.Exists(environment.ConfigDirectory));
            Assert.False(Directory.Exists(environment.ModulesDirectory));
            Assert.False(File.Exists(Path.Combine(externalDataRoot, "modules.json")));
            Assert.False(Directory.Exists(Path.Combine(externalDataRoot, "modules")));
            Assert.True(File.Exists(Path.Combine(externalDataRoot, "keep.txt")));
        }
        finally
        {
            if (Directory.Exists(externalDataRoot))
            {
                Directory.Delete(externalDataRoot, recursive: true);
            }
        }
    }

    [Fact]
    public void LoadFromDataRoot_ModulesJsonContainsInstalledModules_ReturnsCleanupRecords()
    {
        Directory.CreateDirectory(rootDirectory);
        File.WriteAllText(
            Path.Combine(rootDirectory, "modules.json"),
            """
            {
              "modules": [
                {
                  "id": "com.acme.reports",
                  "containerName": "custom-reports",
                  "image": {
                    "reference": "ghcr.io/acme/reports:1.0.0"
                  }
                },
                {
                  "id": "com.acme.Identity",
                  "image": {
                    "repository": "ghcr.io/acme/identity",
                    "tag": "2.0.0"
                  }
                }
              ]
            }
            """);

        var result = ModuleCleanupRecord.LoadFromDataRoot(rootDirectory);

        Assert.Null(result.Error);
        Assert.Collection(
            result.Modules,
            module =>
            {
                Assert.Equal("com.acme.reports", module.Id);
                Assert.Equal("custom-reports", module.ContainerName);
                Assert.Equal("ghcr.io/acme/reports:1.0.0", module.ImageReference);
            },
            module =>
            {
                Assert.Equal("com.acme.Identity", module.Id);
                Assert.Equal("mod-com-acme-identity", module.ContainerName);
                Assert.Equal("ghcr.io/acme/identity:2.0.0", module.ImageReference);
            });
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable(RootVariable, previousRoot);

        if (Directory.Exists(rootDirectory))
        {
            Directory.Delete(rootDirectory, recursive: true);
        }
    }
}
