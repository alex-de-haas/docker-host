using Haas.Hosty.Cli.Configuration;

namespace Haas.Hosty.Cli.Tests.Configuration;

public sealed class LaunchSettingsStoreTests : IDisposable
{
    private const string RootVariable = "HOSTY_HOME";
    private readonly string? previousRoot;
    private readonly string rootDirectory;

    public LaunchSettingsStoreTests()
    {
        previousRoot = Environment.GetEnvironmentVariable(RootVariable);
        rootDirectory = Path.Combine(Path.GetTempPath(), $"hosty-cli-tests-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable(RootVariable, rootDirectory);
    }

    [Fact]
    public void Load_LaunchEnvContainsKnownAndUnknownValues_ParsesKnownValuesAndKeepsDefaults()
    {
        var environment = HostyEnvironment.Current();
        Directory.CreateDirectory(environment.ConfigDirectory);
        File.WriteAllText(
            environment.LaunchConfigPath,
            """
            # hosty launch settings
            HOST_IMAGE=ignored-old-image
            UNKNOWN_SETTING=ignored
            """);
        var store = new LaunchSettingsStore(environment);

        var settings = store.Load();

        Assert.Equal("", settings.HostCorePublicOrigin);
        Assert.Equal("http://127.0.0.1:3000", settings.HostShellPublicOrigin);
        Assert.Equal("https://raw.githubusercontent.com/alex-de-haas/docker-host/main/apps/shell/manifest.json", settings.HostyShellManifestPath);
        Assert.Equal("docker", settings.HostyShellBootstrapRuntime);
        Assert.False(settings.Values.ContainsKey("HOST_IMAGE"));
        Assert.False(settings.Values.ContainsKey("UNKNOWN_SETTING"));
    }

    [Theory]
    [InlineData("HOST_CORE_PUBLIC_ORIGIN", "https://core.example")]
    [InlineData("HOST_SHELL_PUBLIC_ORIGIN", "https://shell.example")]
    [InlineData("HOSTY_SHELL_MANIFEST_PATH", "https://raw.githubusercontent.com/example/shell/main/manifest.json")]
    [InlineData("HOSTY_SHELL_MANIFEST_PATH", "~/shell/manifest.json")]
    [InlineData("HOSTY_SHELL_BOOTSTRAP_RUNTIME", "dev")]
    public void Set_ExplicitPublicOrigin_AcceptsHttpOriginsWithoutPaths(string key, string origin)
    {
        var environment = HostyEnvironment.Current();
        var store = new LaunchSettingsStore(environment);
        store.EnsureInstalled();

        store.Set(key, origin);

        Assert.Equal(origin, store.Load()[key]);
    }

    [Fact]
    public void Set_FixedLaunchSetting_ThrowsConfigurationException()
    {
        var environment = HostyEnvironment.Current();
        var store = new LaunchSettingsStore(environment);
        store.EnsureInstalled();

        Assert.True(Directory.Exists(environment.AppsDirectory));

        var exception = Assert.Throws<ConfigurationException>(
            () => store.Set("HOST_IMAGE", "hosty:dev"));

        Assert.Contains("Unknown launch setting", exception.Message);
    }

    [Fact]
    public void ResolveHostyShellManifestPath_LocalPath_ExpandsForCoreEnvironment()
    {
        var environment = HostyEnvironment.Current();
        var settings = new LaunchSettingsStore(environment)
            .Load()
            .WithValue("HOSTY_SHELL_MANIFEST_PATH", "~/custom-shell/manifest.json");

        var resolved = settings.ResolveHostyShellManifestPath(environment);

        Assert.Equal(Path.Combine(environment.HomeDirectory, "custom-shell", "manifest.json"), resolved);
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
