using Microsoft.Extensions.DependencyInjection;
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
        Assert.Equal("http://localhost:7070", config.ListenUrl);
        Assert.Null(config.CorePublicOrigin);
        Assert.Equal("http://localhost:7070", config.EffectiveCorePublicOrigin);
        // No effective-Shell counterpart: Core no longer synthesises a Shell origin. Where Shell is
        // reachable comes from its own app record now (ShellPublicOriginResolver), and a host without
        // Shell has none at all — the old http://localhost:{ShellPort} fallback pointed at nothing.
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
        Assert.Equal("http://localhost:8080", config.ListenUrl);
        Assert.Equal("http://localhost:8080", config.EffectiveCorePublicOrigin);
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
    public void FromEnvironment_UsesExplicitCorePublicOrigin()
    {
        using var coreEnv = TemporaryEnvironment.With("HOSTY_CORE_PUBLIC_ORIGIN", "https://core.example");
        using var shellEnv = TemporaryEnvironment.With("HOSTY_SHELL_PUBLIC_ORIGIN", null);

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Production));

        Assert.Equal("https://core.example", config.CorePublicOrigin);
        Assert.Equal("https://core.example", config.EffectiveCorePublicOrigin);
    }

    [Fact]
    public void FromEnvironment_DefaultsRuntimePublicHostToIpv4Loopback()
    {
        using var runtimeHostEnv = TemporaryEnvironment.With("HOSTY_RUNTIME_PUBLIC_HOST", null);

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Production));

        // Not "localhost": on IPv6-first hosts .NET's HttpClient stalls on ::1 (where docker publishes
        // only 127.0.0.1), silently emptying every telemetry/health read to a runtime app.
        Assert.Equal("127.0.0.1", config.RuntimePublicHost);
    }

    [Fact]
    public void FromEnvironment_UsesExplicitRuntimePublicHost()
    {
        using var runtimeHostEnv = TemporaryEnvironment.With("HOSTY_RUNTIME_PUBLIC_HOST", " 0.0.0.0 ");

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Production));

        Assert.Equal("0.0.0.0", config.RuntimePublicHost);
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
        var response = CoreStatusResponse.From(config, IngressSettings.FromEnvironment(), shellPublicOrigin: null, cloudflareConnected: false);

        Assert.Equal("http://localhost:7070", response.CorePublicOrigin);
        // Reported straight from the resolver: null here stands for "this host has no Shell installed".
        Assert.Null(response.ShellPublicOrigin);
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
    public void FromEnvironment_ShellBootstrapRuntimeNullWhenUnset()
    {
        using var env = TemporaryEnvironment.With("HOSTY_SHELL_BOOTSTRAP_RUNTIME", null);

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Development));

        // Unset (the normal case): the manifest default chooses on first install and the operator's
        // switch-runtime choice is preserved on later boots.
        Assert.Null(config.ShellBootstrapRuntime);
    }

    [Fact]
    public void FromEnvironment_ReadsExplicitShellBootstrapRuntimeAsAmbientOverride()
    {
        using var env = TemporaryEnvironment.With("HOSTY_SHELL_BOOTSTRAP_RUNTIME", " dev ");

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Development));

        // A source tree / air-gapped fork can still pin a non-default profile (e.g. the dev localCommand).
        Assert.Equal("dev", config.ShellBootstrapRuntime);
    }

    [Fact]
    public void FromEnvironment_CapturesLegacyShellManifestPathVerbatim()
    {
        using var env = TemporaryEnvironment.With("HOSTY_SHELL_MANIFEST_PATH", " https://raw.githubusercontent.com/example/shell/main/manifest.json ");

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Production));

        Assert.Equal("https://raw.githubusercontent.com/example/shell/main/manifest.json", config.Legacy?.ShellManifestPath);
    }

    [Fact]
    public void FromEnvironment_LeavesLegacyBootstrapFlagsNullWhenUnset()
    {
        using var shellEnabledEnv = TemporaryEnvironment.With("HOSTY_SHELL_BOOTSTRAP_ENABLED", null);
        using var observabilityEnv = TemporaryEnvironment.With("HOSTY_OBSERVABILITY_ENABLED", null);
        using var shellManifestEnv = TemporaryEnvironment.With("HOSTY_SHELL_MANIFEST_PATH", null);
        using var collectorManifestEnv = TemporaryEnvironment.With("HOSTY_COLLECTOR_MANIFEST_PATH", null);

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Production));

        Assert.NotNull(config.Legacy);
        Assert.Null(config.Legacy!.ShellBootstrapEnabled);
        Assert.Null(config.Legacy.ObservabilityEnabled);
        Assert.Null(config.Legacy.ShellManifestPath);
        Assert.Null(config.Legacy.CollectorManifestPath);
    }

    [Fact]
    public void FromEnvironment_CapturesExplicitLegacyBootstrapFlags()
    {
        using var shellEnabledEnv = TemporaryEnvironment.With("HOSTY_SHELL_BOOTSTRAP_ENABLED", "false");
        using var observabilityEnv = TemporaryEnvironment.With("HOSTY_OBSERVABILITY_ENABLED", "1");

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Production));

        Assert.False(config.Legacy?.ShellBootstrapEnabled);
        Assert.True(config.Legacy?.ObservabilityEnabled);
    }

    [Fact]
    public void FromEnvironment_UsesExplicitShellSourceOverridePath()
    {
        using var env = TemporaryEnvironment.With("HOSTY_SHELL_SOURCE_OVERRIDE_PATH", " /repo ");

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Development));

        Assert.Equal("/repo", config.ShellSourceOverridePath);
    }

    [Fact]
    public void FromEnvironment_TracksAbsentMarketplaceManifestPathAsUnconfigured()
    {
        using var env = TemporaryEnvironment.With("HOSTY_MARKETPLACE_MANIFEST_PATH", null);

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Production));

        Assert.False(config.Legacy?.MarketplaceManifestPathConfigured);
        Assert.Null(config.Legacy?.MarketplaceManifestPath);
    }

    [Fact]
    public void FromEnvironment_TracksEmptyMarketplaceManifestPathAsExplicitDisable()
    {
        // Present-but-empty is a meaningful explicit disable per the marketplace pivot's contract, so
        // raw presence must survive normalization. (Whitespace stands in for empty here because
        // Environment.SetEnvironmentVariable deletes a variable when handed "".)
        using var env = TemporaryEnvironment.With("HOSTY_MARKETPLACE_MANIFEST_PATH", " ");

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Production));

        Assert.True(config.Legacy?.MarketplaceManifestPathConfigured);
        Assert.Null(config.Legacy?.MarketplaceManifestPath);
    }

    [Fact]
    public void FromEnvironment_CapturesExplicitMarketplaceManifestPath()
    {
        using var env = TemporaryEnvironment.With(
            "HOSTY_MARKETPLACE_MANIFEST_PATH",
            " https://apps.example.test/marketplace/manifest.json ");

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Production));

        Assert.True(config.Legacy?.MarketplaceManifestPathConfigured);
        Assert.Equal("https://apps.example.test/marketplace/manifest.json", config.Legacy?.MarketplaceManifestPath);
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
    public void FromEnvironment_CollectorBootstrapRuntimeNullWhenUnset()
    {
        using var runtimeEnv = TemporaryEnvironment.With("HOSTY_COLLECTOR_BOOTSTRAP_RUNTIME", null);

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Production));

        Assert.Null(config.CollectorBootstrapRuntime);
    }

    // The flake this class used to cause, made deterministic: every env mutation in the suite happens
    // here, but the HTTP harness classes run in parallel with it, and while ConfigureServices read the
    // process environment a harness booting during FromEnvironment_RejectsInvalidPort inherited that
    // test's HOSTY_CORE_PORT=65536 and failed on a config it never asked for. Booting a harness with the
    // env deliberately poisoned proves the startup path takes the config it is handed instead. It lives
    // in this class so the mutation stays serialized with the suite's other env mutations.
    [Fact]
    public async Task ConfigureServices_TakesTheGivenConfig_NotThePoisonedEnvironment()
    {
        using var corePortEnv = TemporaryEnvironment.With("HOSTY_CORE_PORT", "65536");

        await using var harness = await Http.CoreHttpHarness.StartAsync();

        Assert.Equal(7070, harness.Services.GetRequiredService<HostyCoreRuntimeConfig>().CorePort);
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
