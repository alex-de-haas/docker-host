using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;

namespace Haas.Hosty.Core.Tests;

public sealed class HostyCoreRuntimeConfigTests
{
    [Fact]
    public void FromEnvironment_DefaultsPortsAndEffectiveLocalOrigins()
    {
        using var coreUrlEnv = TemporaryEnvironment.With("HOSTY_CORE_URL", null);
        using var aspNetUrlsEnv = TemporaryEnvironment.With("ASPNETCORE_URLS", null);
        using var corePortEnv = TemporaryEnvironment.With("HOSTY_CORE_PORT", null);
        using var shellPortEnv = TemporaryEnvironment.With("HOSTY_SHELL_PORT", null);
        using var coreOriginEnv = TemporaryEnvironment.With("HOSTY_CORE_PUBLIC_ORIGIN", null);
        using var shellOriginEnv = TemporaryEnvironment.With("HOSTY_SHELL_PUBLIC_ORIGIN", null);

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Production));

        Assert.Equal(7070, config.CorePort);
        Assert.Equal(7171, config.ShellPort);
        Assert.Equal("http://localhost:7070", config.ListenUrl);
        Assert.Null(config.CorePublicOrigin);
        Assert.Null(config.ShellPublicOrigin);
        Assert.Equal("http://localhost:7070", config.EffectiveCorePublicOrigin);
        Assert.Equal("http://localhost:7171", config.EffectiveShellPublicOrigin);
    }

    [Fact]
    public void FromEnvironment_UsesExplicitDataRoot()
    {
        var dataRoot = Path.Combine(Path.GetTempPath(), $"hosty-core-data-{Guid.NewGuid():N}");
        using var dataRootEnv = TemporaryEnvironment.With("HOSTY_DATA_ROOT", dataRoot);
        using var homeEnv = TemporaryEnvironment.With("HOSTY_HOME", null);

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Production));

        Assert.Equal(Path.GetFullPath(dataRoot), config.DataRoot);
    }

    [Fact]
    public void FromEnvironment_IgnoresLegacyDataRootVariables()
    {
        using var dataRootEnv = TemporaryEnvironment.With("HOSTY_DATA_ROOT", null);
        using var homeEnv = TemporaryEnvironment.With("HOSTY_HOME", null);
        using var coreDataRootEnv = TemporaryEnvironment.With("HOSTY_CORE_DATA_ROOT", Path.Combine(Path.GetTempPath(), "legacy-core-data"));
        using var hostDataRootEnv = TemporaryEnvironment.With("HOST_DATA_ROOT_HOST", Path.Combine(Path.GetTempPath(), "legacy-host-data"));

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Production));

        Assert.Equal(
            Path.GetFullPath(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".hosty")),
            config.DataRoot);
    }

    [Fact]
    public void FromEnvironment_UsesExplicitPorts()
    {
        using var coreUrlEnv = TemporaryEnvironment.With("HOSTY_CORE_URL", null);
        using var aspNetUrlsEnv = TemporaryEnvironment.With("ASPNETCORE_URLS", null);
        using var corePortEnv = TemporaryEnvironment.With("HOSTY_CORE_PORT", "8080");
        using var shellPortEnv = TemporaryEnvironment.With("HOSTY_SHELL_PORT", "8181");

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Production));

        Assert.Equal(8080, config.CorePort);
        Assert.Equal(8181, config.ShellPort);
        Assert.Equal("http://localhost:8080", config.ListenUrl);
        Assert.Equal("http://localhost:8080", config.EffectiveCorePublicOrigin);
        Assert.Equal("http://localhost:8181", config.EffectiveShellPublicOrigin);
    }

    [Fact]
    public void FromEnvironment_RejectsInvalidPort()
    {
        using var corePortEnv = TemporaryEnvironment.With("HOSTY_CORE_PORT", "65536");

        var exception = Assert.Throws<InvalidOperationException>(() =>
            HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Production)));

        Assert.Contains("HOSTY_CORE_PORT must be an integer between 1 and 65535", exception.Message);
    }

    [Fact]
    public void FromEnvironment_UsesExplicitShellPublicOrigin()
    {
        using var env = TemporaryEnvironment.With("HOSTY_SHELL_PUBLIC_ORIGIN", " http://localhost:3100/ ");
        using var coreEnv = TemporaryEnvironment.With("HOSTY_CORE_PUBLIC_ORIGIN", null);

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Development));

        Assert.Equal("http://localhost:3100/", config.ShellPublicOrigin);
        Assert.Equal("http://localhost:3100/", config.EffectiveShellPublicOrigin);
    }

    [Fact]
    public void FromEnvironment_UsesExplicitCorePublicOrigin()
    {
        using var coreEnv = TemporaryEnvironment.With("HOSTY_CORE_PUBLIC_ORIGIN", "https://core.example");
        using var shellEnv = TemporaryEnvironment.With("HOSTY_SHELL_PUBLIC_ORIGIN", null);

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Production));

        Assert.Equal("https://core.example", config.CorePublicOrigin);
        Assert.Null(config.ShellPublicOrigin);
        Assert.Equal("https://core.example", config.EffectiveCorePublicOrigin);
    }

    [Fact]
    public void CoreStatusResponse_ReportsEffectivePublicOrigins()
    {
        using var coreUrlEnv = TemporaryEnvironment.With("HOSTY_CORE_URL", null);
        using var aspNetUrlsEnv = TemporaryEnvironment.With("ASPNETCORE_URLS", null);
        using var corePortEnv = TemporaryEnvironment.With("HOSTY_CORE_PORT", null);
        using var shellPortEnv = TemporaryEnvironment.With("HOSTY_SHELL_PORT", null);
        using var coreOriginEnv = TemporaryEnvironment.With("HOSTY_CORE_PUBLIC_ORIGIN", null);
        using var shellOriginEnv = TemporaryEnvironment.With("HOSTY_SHELL_PUBLIC_ORIGIN", null);

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Production));
        var response = CoreStatusResponse.From(config);

        Assert.Equal("http://localhost:7070", response.CorePublicOrigin);
        Assert.Equal("http://localhost:7171", response.ShellPublicOrigin);
        Assert.False(string.IsNullOrWhiteSpace(response.Version));
    }

    [Fact]
    public void FromEnvironment_IgnoresLegacyPublicOriginVariables()
    {
        using var combinedEnv = TemporaryEnvironment.With("HOST_PUBLIC_ORIGIN", "https://hosty.example");
        using var legacyCoreEnv = TemporaryEnvironment.With("HOST_CORE_PUBLIC_ORIGIN", "https://core.example");
        using var legacyShellEnv = TemporaryEnvironment.With("HOST_SHELL_PUBLIC_ORIGIN", "https://shell.example");
        using var coreEnv = TemporaryEnvironment.With("HOSTY_CORE_PUBLIC_ORIGIN", null);
        using var shellEnv = TemporaryEnvironment.With("HOSTY_SHELL_PUBLIC_ORIGIN", null);

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Production));

        Assert.Null(config.CorePublicOrigin);
        Assert.Null(config.ShellPublicOrigin);
    }

    [Fact]
    public void BuildPublicOriginWarnings_WarnsForInsecureNonLoopbackOrigins()
    {
        using var coreEnv = TemporaryEnvironment.With("HOSTY_CORE_PUBLIC_ORIGIN", "http://core.example");
        using var shellEnv = TemporaryEnvironment.With("HOSTY_SHELL_PUBLIC_ORIGIN", "http://127.0.0.1:3000");

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Production));

        var warning = Assert.Single(config.BuildPublicOriginWarnings());
        Assert.Contains("Core public origin uses insecure HTTP", warning);
    }

    [Fact]
    public void FromEnvironment_DefaultsShellBootstrapRuntimeToDocker()
    {
        using var env = TemporaryEnvironment.With("HOSTY_SHELL_BOOTSTRAP_RUNTIME", null);

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Development));

        Assert.Equal("docker", config.ShellBootstrapRuntime);
    }

    [Fact]
    public void FromEnvironment_UsesExplicitShellBootstrapRuntime()
    {
        using var env = TemporaryEnvironment.With("HOSTY_SHELL_BOOTSTRAP_RUNTIME", " dev ");

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Development));

        Assert.Equal("dev", config.ShellBootstrapRuntime);
    }

    [Fact]
    public void FromEnvironment_UsesHttpShellManifestPath()
    {
        using var env = TemporaryEnvironment.With("HOSTY_SHELL_MANIFEST_PATH", " https://raw.githubusercontent.com/example/shell/main/manifest.json ");

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Production));

        Assert.Equal("https://raw.githubusercontent.com/example/shell/main/manifest.json", config.ShellManifestPath);
    }

    [Fact]
    public void FromEnvironment_UsesExplicitShellSourceOverridePath()
    {
        using var env = TemporaryEnvironment.With("HOSTY_SHELL_SOURCE_OVERRIDE_PATH", " /repo ");

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Development));

        Assert.Equal("/repo", config.ShellSourceOverridePath);
    }

    [Fact]
    public void FromEnvironment_DefaultsTrustedProxySecretToDisabled()
    {
        using var env = TemporaryEnvironment.With("HOSTY_TRUSTED_PROXY_SECRET", null);

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Production));

        Assert.Null(config.TrustedProxySecret);
    }

    [Fact]
    public void FromEnvironment_UsesExplicitTrustedProxySecret()
    {
        using var env = TemporaryEnvironment.With("HOSTY_TRUSTED_PROXY_SECRET", " proxy-secret ");

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Production));

        Assert.Equal("proxy-secret", config.TrustedProxySecret);
    }

    [Fact]
    public void FromEnvironment_DefaultsObservabilityDisabled()
    {
        using var enabledEnv = TemporaryEnvironment.With("HOSTY_OBSERVABILITY_ENABLED", null);
        using var runtimeEnv = TemporaryEnvironment.With("HOSTY_COLLECTOR_BOOTSTRAP_RUNTIME", null);
        using var autostartEnv = TemporaryEnvironment.With("HOSTY_COLLECTOR_AUTOSTART", null);

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Production));

        Assert.False(config.ObservabilityEnabled);
        Assert.Equal("docker", config.CollectorBootstrapRuntime);
        Assert.True(config.CollectorAutostart);
    }

    [Fact]
    public void FromEnvironment_EnablesObservabilityWhenRequested()
    {
        using var enabledEnv = TemporaryEnvironment.With("HOSTY_OBSERVABILITY_ENABLED", "1");
        using var autostartEnv = TemporaryEnvironment.With("HOSTY_COLLECTOR_AUTOSTART", "false");
        using var runtimeEnv = TemporaryEnvironment.With("HOSTY_COLLECTOR_BOOTSTRAP_RUNTIME", null);

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Production));

        Assert.True(config.ObservabilityEnabled);
        Assert.False(config.CollectorAutostart);
    }

    private sealed class TestHostEnvironment(string environmentName) : IHostEnvironment
    {
        public string EnvironmentName { get; set; } = environmentName;

        public string ApplicationName { get; set; } = "Haas.Hosty.Core.Tests";

        public string ContentRootPath { get; set; } = Directory.GetCurrentDirectory();

        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
    }

    private sealed class TemporaryEnvironment : IDisposable
    {
        private readonly string name;
        private readonly string? previousValue;

        private TemporaryEnvironment(string name, string? value)
        {
            this.name = name;
            previousValue = Environment.GetEnvironmentVariable(name);
            Environment.SetEnvironmentVariable(name, value);
        }

        public static TemporaryEnvironment With(string name, string? value) => new(name, value);

        public void Dispose() => Environment.SetEnvironmentVariable(name, previousValue);
    }
}
