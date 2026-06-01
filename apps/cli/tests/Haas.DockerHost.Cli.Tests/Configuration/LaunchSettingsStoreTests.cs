using Haas.DockerHost.Cli.Configuration;

namespace Haas.DockerHost.Cli.Tests.Configuration;

public sealed class LaunchSettingsStoreTests : IDisposable
{
    private const string RootVariable = "HOSTY_HOME";
    private const string LegacyRootVariable = "DOCKER_HOST_HOME";
    private readonly string? previousRoot;
    private readonly string? previousLegacyRoot;
    private readonly string rootDirectory;

    public LaunchSettingsStoreTests()
    {
        previousRoot = Environment.GetEnvironmentVariable(RootVariable);
        previousLegacyRoot = Environment.GetEnvironmentVariable(LegacyRootVariable);
        rootDirectory = Path.Combine(Path.GetTempPath(), $"docker-host-cli-tests-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable(RootVariable, rootDirectory);
        Environment.SetEnvironmentVariable(LegacyRootVariable, null);
    }

    [Fact]
    public void Load_LaunchEnvContainsKnownAndUnknownValues_ParsesKnownValuesAndKeepsDefaults()
    {
        var environment = DockerHostEnvironment.Current();
        Directory.CreateDirectory(environment.ConfigDirectory);
        File.WriteAllText(
            environment.LaunchConfigPath,
            """
            # docker-host launch settings
            HOST_UI_PORT=4321
            HOST_CONTAINER_NAME=test-host
            UNKNOWN_SETTING=ignored
            """);
        var store = new LaunchSettingsStore(environment);

        var settings = store.Load();

        Assert.Equal("4321", settings.HostUiPort);
        Assert.Equal("test-host", settings.HostContainerName);
        Assert.Equal("ghcr.io/alex-de-haas/docker-host:latest", settings.HostImage);
        Assert.Equal("", settings.HostDevRepositoryPathRaw);
        Assert.Equal(3000, settings.GetHostDevPort());
        Assert.False(settings.Values.ContainsKey("UNKNOWN_SETTING"));
    }

    [Fact]
    public void Set_FixedLaunchSetting_ThrowsConfigurationException()
    {
        var environment = DockerHostEnvironment.Current();
        var store = new LaunchSettingsStore(environment);
        store.EnsureInstalled();

        Assert.True(Directory.Exists(environment.AppsDirectory));
        Assert.True(Directory.Exists(environment.ModulesDirectory));

        var exception = Assert.Throws<ConfigurationException>(
            () => store.Set(LaunchSettingDefinitions.HostDataRootContainer, "/other-data"));

        Assert.Contains("cannot be changed", exception.Message);
    }

    [Theory]
    [InlineData("auto", null)]
    [InlineData("3000", 3000)]
    public void Load_HostUiPortValue_ResolvesFixedPort(string hostUiPort, int? expectedPort)
    {
        var environment = DockerHostEnvironment.Current();
        Directory.CreateDirectory(environment.ConfigDirectory);
        File.WriteAllText(environment.LaunchConfigPath, $"HOST_UI_PORT={hostUiPort}{Environment.NewLine}");
        var store = new LaunchSettingsStore(environment);

        var settings = store.Load();

        Assert.Equal(expectedPort, settings.GetFixedHostPort());
    }

    [Fact]
    public void Load_HostDevRepositoryPath_ResolvesConfiguredPath()
    {
        var environment = DockerHostEnvironment.Current();
        Directory.CreateDirectory(environment.ConfigDirectory);
        File.WriteAllText(
            environment.LaunchConfigPath,
            $"HOST_DEV_REPOSITORY_PATH=~/docker-host-dev{Environment.NewLine}");
        var store = new LaunchSettingsStore(environment);

        var settings = store.Load();

        Assert.Equal(Path.Combine(environment.HomeDirectory, "docker-host-dev"), settings.ResolveHostDevRepositoryPath(environment));
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable(RootVariable, previousRoot);
        Environment.SetEnvironmentVariable(LegacyRootVariable, previousLegacyRoot);

        if (Directory.Exists(rootDirectory))
        {
            Directory.Delete(rootDirectory, recursive: true);
        }
    }
}
