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
            HOST_IMAGE=ignored-old-image
            UNKNOWN_SETTING=ignored
            """);
        var store = new LaunchSettingsStore(environment);

        var settings = store.Load();

        Assert.Equal("", settings.HostCorePublicOrigin);
        Assert.Equal("", settings.HostShellPublicOrigin);
        Assert.False(settings.Values.ContainsKey("HOST_IMAGE"));
        Assert.False(settings.Values.ContainsKey("UNKNOWN_SETTING"));
    }

    [Theory]
    [InlineData("HOST_CORE_PUBLIC_ORIGIN", "https://core.example")]
    [InlineData("HOST_SHELL_PUBLIC_ORIGIN", "https://shell.example")]
    public void Set_ExplicitPublicOrigin_AcceptsHttpOriginsWithoutPaths(string key, string origin)
    {
        var environment = DockerHostEnvironment.Current();
        var store = new LaunchSettingsStore(environment);
        store.EnsureInstalled();

        store.Set(key, origin);

        Assert.Equal(origin, store.Load()[key]);
    }

    [Fact]
    public void Set_FixedLaunchSetting_ThrowsConfigurationException()
    {
        var environment = DockerHostEnvironment.Current();
        var store = new LaunchSettingsStore(environment);
        store.EnsureInstalled();

        Assert.True(Directory.Exists(environment.AppsDirectory));

        var exception = Assert.Throws<ConfigurationException>(
            () => store.Set("HOST_IMAGE", "docker-host:dev"));

        Assert.Contains("Unknown launch setting", exception.Message);
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
