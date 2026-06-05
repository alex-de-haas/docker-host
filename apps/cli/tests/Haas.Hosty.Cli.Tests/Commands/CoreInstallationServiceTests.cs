using Haas.Hosty.Cli.Commands;
using Haas.Hosty.Cli.Configuration;

namespace Haas.Hosty.Cli.Tests.Commands;

public sealed class CoreInstallationServiceTests : IDisposable
{
    private const string RootVariable = "HOSTY_HOME";
    private readonly string? previousRoot;
    private readonly string rootDirectory;

    public CoreInstallationServiceTests()
    {
        previousRoot = Environment.GetEnvironmentVariable(RootVariable);
        rootDirectory = Path.Combine(Path.GetTempPath(), $"hosty-core-install-tests-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable(RootVariable, rootDirectory);
    }

    [Fact]
    public void GetInstalledExecutablePath_UsesCoreBinDirectory()
    {
        var environment = HostyEnvironment.Current();

        var executablePath = CoreInstallationService.GetInstalledExecutablePath(environment);

        Assert.Equal(
            Path.Combine(environment.RootDirectory, "core", "bin", ReleaseArtifactNames.GetInstalledCoreExecutableName()),
            executablePath);
        Assert.False(executablePath.StartsWith(
            environment.BinDirectory + Path.DirectorySeparatorChar,
            StringComparison.Ordinal));
    }

    [Fact]
    public void GetCoreArtifactName_UsesHostyCorePrefix()
    {
        var artifactName = ReleaseArtifactNames.GetCoreArtifactName();

        Assert.StartsWith("hosty-core-", artifactName, StringComparison.Ordinal);
        if (OperatingSystem.IsWindows())
        {
            Assert.EndsWith(".exe", artifactName, StringComparison.OrdinalIgnoreCase);
        }
        else
        {
            Assert.False(artifactName.EndsWith(".exe", StringComparison.OrdinalIgnoreCase));
        }
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
