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

        Assert.Equal(rootDirectory, settings[LaunchSettingDefinitions.HostyDataRoot]);
        Assert.Equal("7070", settings.HostyCorePort);
        Assert.Equal("7171", settings.HostyShellPort);
        Assert.Equal("", settings.HostyCorePublicOrigin);
        Assert.Equal("", settings.HostyShellPublicOrigin);
        Assert.Equal("", settings.HostyShellManifestPath);
        Assert.Equal("docker", settings.HostyShellBootstrapRuntime);
        // A launch.env that predates the collector-manifest setting still resolves its default, so an
        // existing install self-heals (Core gets the collector manifest URL; bootstrap proceeds).
        Assert.Equal("", settings.HostyCollectorManifestPath);
        Assert.Equal("", settings.HostyMarketplaceManifestPath);
        Assert.False(settings.Values.ContainsKey("HOST_IMAGE"));
        Assert.False(settings.Values.ContainsKey("UNKNOWN_SETTING"));
    }

    [Fact]
    public void Load_LegacyOriginKeys_IgnoresOldValues()
    {
        var environment = HostyEnvironment.Current();
        Directory.CreateDirectory(environment.ConfigDirectory);
        File.WriteAllText(
            environment.LaunchConfigPath,
            """
            # hosty launch settings
            HOST_CORE_PUBLIC_ORIGIN=http://127.0.0.1:3001
            HOST_SHELL_PUBLIC_ORIGIN=http://127.0.0.1:3000
            """);
        var store = new LaunchSettingsStore(environment);

        var settings = store.Load();

        Assert.Equal("", settings.HostyCorePublicOrigin);
        Assert.Equal("", settings.HostyShellPublicOrigin);
        Assert.False(settings.Values.ContainsKey("HOST_CORE_PUBLIC_ORIGIN"));
        Assert.False(settings.Values.ContainsKey("HOST_SHELL_PUBLIC_ORIGIN"));
    }

    [Fact]
    public void Load_LegacyDataRootKey_IgnoresOldValue()
    {
        var environment = HostyEnvironment.Current();
        var legacyDataRoot = Path.Combine(rootDirectory, "legacy-data");
        Directory.CreateDirectory(environment.ConfigDirectory);
        File.WriteAllText(
            environment.LaunchConfigPath,
            $"""
            # hosty launch settings
            HOST_DATA_ROOT_HOST={legacyDataRoot}
            """);
        var store = new LaunchSettingsStore(environment);

        var settings = store.Load();

        Assert.Equal(rootDirectory, settings[LaunchSettingDefinitions.HostyDataRoot]);
        Assert.False(settings.Values.ContainsKey("HOST_DATA_ROOT_HOST"));
    }

    [Fact]
    public void Load_ScrubsLegacyDefaultManifestUrlsMaterializedByOlderClis()
    {
        // Older CLIs wrote the pre-generic-bootstrap default URLs into launch.env; those were never
        // operator intent and must read as unset so they cannot re-pin a stale location.
        var environment = HostyEnvironment.Current();
        Directory.CreateDirectory(environment.ConfigDirectory);
        File.WriteAllText(
            environment.LaunchConfigPath,
            $"""
            # hosty launch settings
            HOSTY_SHELL_MANIFEST_PATH={LaunchSettingDefinitions.LegacyDefaultShellManifestPath}
            HOSTY_COLLECTOR_MANIFEST_PATH={LaunchSettingDefinitions.LegacyDefaultCollectorManifestPath}
            HOSTY_MARKETPLACE_MANIFEST_PATH={LaunchSettingDefinitions.LegacyDefaultMarketplaceManifestPath}
            """);

        var settings = new LaunchSettingsStore(environment).Load();

        Assert.Equal("", settings.HostyShellManifestPath);
        Assert.Equal("", settings.HostyCollectorManifestPath);
        Assert.Equal("", settings.HostyMarketplaceManifestPath);
    }

    [Fact]
    public void Load_KeepsExplicitNonDefaultManifestOverrides()
    {
        var environment = HostyEnvironment.Current();
        Directory.CreateDirectory(environment.ConfigDirectory);
        File.WriteAllText(
            environment.LaunchConfigPath,
            """
            # hosty launch settings
            HOSTY_SHELL_MANIFEST_PATH=https://example.test/custom/shell/manifest.json
            """);

        var settings = new LaunchSettingsStore(environment).Load();

        Assert.Equal("https://example.test/custom/shell/manifest.json", settings.HostyShellManifestPath);
    }

    [Theory]
    [InlineData("HOSTY_DATA_ROOT", "$HOME/custom-hosty")]
    [InlineData("HOSTY_CORE_PORT", "8080")]
    [InlineData("HOSTY_SHELL_PORT", "8181")]
    [InlineData("HOSTY_CORE_PUBLIC_ORIGIN", "https://core.example")]
    [InlineData("HOSTY_SHELL_PUBLIC_ORIGIN", "https://shell.example")]
    [InlineData("HOSTY_SHELL_MANIFEST_PATH", "https://raw.githubusercontent.com/example/shell/main/manifest.json")]
    [InlineData("HOSTY_SHELL_MANIFEST_PATH", "~/shell/manifest.json")]
    [InlineData("HOSTY_SHELL_BOOTSTRAP_RUNTIME", "dev")]
    [InlineData("HOSTY_MARKETPLACE_MANIFEST_PATH", "https://raw.githubusercontent.com/example/marketplace/main/manifest.json")]
    [InlineData("HOSTY_MARKETPLACE_MANIFEST_PATH", "~/marketplace/manifest.json")]
    [InlineData("HOSTY_MARKETPLACE_MANIFEST_PATH", "")]
    public void Set_EditableLaunchSetting_AcceptsValidValues(string key, string value)
    {
        var environment = HostyEnvironment.Current();
        var store = new LaunchSettingsStore(environment);
        store.EnsureInstalled();

        store.Set(key, value);

        Assert.Equal(value, store.Load()[key]);
    }

    [Fact]
    public void Set_PortSetting_TrimsWhitespace()
    {
        var environment = HostyEnvironment.Current();
        var store = new LaunchSettingsStore(environment);
        store.EnsureInstalled();

        store.Set("HOSTY_CORE_PORT", " 8080 ");

        Assert.Equal("8080", store.Load()["HOSTY_CORE_PORT"]);
    }

    [Theory]
    [InlineData("HOSTY_CORE_PORT", "0")]
    [InlineData("HOSTY_CORE_PORT", "65536")]
    [InlineData("HOSTY_SHELL_PORT", "port")]
    public void Set_PortSetting_RejectsInvalidPorts(string key, string value)
    {
        var environment = HostyEnvironment.Current();
        var store = new LaunchSettingsStore(environment);
        store.EnsureInstalled();

        var exception = Assert.Throws<ConfigurationException>(() => store.Set(key, value));

        Assert.Contains("Port must be an integer between 1 and 65535", exception.Message);
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
    public void ResolveHostDataRoot_LocalPath_ExpandsForCoreEnvironment()
    {
        var environment = HostyEnvironment.Current();
        var settings = new LaunchSettingsStore(environment)
            .Load()
            .WithValue("HOSTY_DATA_ROOT", "~/custom-data");

        var resolved = settings.ResolveHostDataRoot(environment);

        Assert.Equal(Path.Combine(environment.HomeDirectory, "custom-data"), resolved);
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

    [Fact]
    public void ResolveHostyMarketplaceManifestPath_LocalPath_ExpandsForCoreEnvironment()
    {
        var environment = HostyEnvironment.Current();
        var settings = new LaunchSettingsStore(environment)
            .Load()
            .WithValue(LaunchSettingDefinitions.HostyMarketplaceManifestPath, "~/custom-marketplace/manifest.json");

        var resolved = settings.ResolveHostyMarketplaceManifestPath(environment);

        Assert.Equal(Path.Combine(environment.HomeDirectory, "custom-marketplace", "manifest.json"), resolved);
    }

    [Fact]
    public void ResolveHostyMarketplaceManifestPath_EmptyValue_RemainsEmptyForCoreEnvironment()
    {
        var environment = HostyEnvironment.Current();
        var settings = new LaunchSettingsStore(environment)
            .Load()
            .WithValue(LaunchSettingDefinitions.HostyMarketplaceManifestPath, "");

        Assert.Equal(string.Empty, settings.ResolveHostyMarketplaceManifestPath(environment));
    }

    [Theory]
    [InlineData("ftp://example.com/marketplace/manifest.json", "must use http or https")]
    [InlineData("https://user@example.com/marketplace/manifest.json", "must not include credentials")]
    public void Set_MarketplaceManifestPath_RejectsInvalidReferences(string value, string expectedMessage)
    {
        var environment = HostyEnvironment.Current();
        var store = new LaunchSettingsStore(environment);
        store.EnsureInstalled();

        var exception = Assert.Throws<ConfigurationException>(() =>
            store.Set(LaunchSettingDefinitions.HostyMarketplaceManifestPath, value));

        Assert.Contains(expectedMessage, exception.Message);
    }

    [Fact]
    public void Load_ObservabilitySettings_HaveCoreMatchingDefaults()
    {
        var environment = HostyEnvironment.Current();

        var settings = new LaunchSettingsStore(environment).Load();

        Assert.Equal("false", settings.HostyObservabilityEnabled);
        Assert.Equal("true", settings.HostyCollectorAutostart);
    }

    [Theory]
    [InlineData("HOSTY_OBSERVABILITY_ENABLED", "1", "true")]
    [InlineData("HOSTY_OBSERVABILITY_ENABLED", "yes", "true")]
    [InlineData("HOSTY_OBSERVABILITY_ENABLED", "ENABLED", "true")]
    [InlineData("HOSTY_OBSERVABILITY_ENABLED", "off", "false")]
    [InlineData("HOSTY_COLLECTOR_AUTOSTART", "false", "false")]
    [InlineData("HOSTY_COLLECTOR_AUTOSTART", " No ", "false")]
    public void Set_BooleanSetting_CanonicalizesToTrueFalse(string key, string value, string expected)
    {
        var environment = HostyEnvironment.Current();
        var store = new LaunchSettingsStore(environment);
        store.EnsureInstalled();

        store.Set(key, value);

        Assert.Equal(expected, store.Load()[key]);
    }

    [Theory]
    [InlineData("HOSTY_OBSERVABILITY_ENABLED", "maybe")]
    [InlineData("HOSTY_COLLECTOR_AUTOSTART", "2")]
    public void Set_BooleanSetting_RejectsNonBooleanValues(string key, string value)
    {
        var environment = HostyEnvironment.Current();
        var store = new LaunchSettingsStore(environment);
        store.EnsureInstalled();

        var exception = Assert.Throws<ConfigurationException>(() => store.Set(key, value));

        Assert.Contains("must be a boolean", exception.Message);
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
