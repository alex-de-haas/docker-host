using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;

namespace Haas.Hosty.Core.Tests;

public sealed class HostyCoreRuntimeConfigTests
{
    [Fact]
    public void FromEnvironment_DefaultsShellPublicOriginInDevelopment()
    {
        using var env = TemporaryEnvironment.With("HOST_SHELL_PUBLIC_ORIGIN", null);
        using var coreEnv = TemporaryEnvironment.With("HOST_CORE_PUBLIC_ORIGIN", null);
        using var combinedEnv = TemporaryEnvironment.With("HOST_PUBLIC_ORIGIN", null);

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Development));

        Assert.Equal("http://localhost:3000", config.ShellPublicOrigin);
    }

    [Fact]
    public void FromEnvironment_LeavesShellPublicOriginUnsetOutsideDevelopment()
    {
        using var env = TemporaryEnvironment.With("HOST_SHELL_PUBLIC_ORIGIN", null);
        using var coreEnv = TemporaryEnvironment.With("HOST_CORE_PUBLIC_ORIGIN", null);
        using var combinedEnv = TemporaryEnvironment.With("HOST_PUBLIC_ORIGIN", null);

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Production));

        Assert.Null(config.ShellPublicOrigin);
    }

    [Fact]
    public void FromEnvironment_UsesExplicitShellPublicOrigin()
    {
        using var env = TemporaryEnvironment.With("HOST_SHELL_PUBLIC_ORIGIN", " http://localhost:3100/ ");
        using var coreEnv = TemporaryEnvironment.With("HOST_CORE_PUBLIC_ORIGIN", null);
        using var combinedEnv = TemporaryEnvironment.With("HOST_PUBLIC_ORIGIN", null);

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Development));

        Assert.Equal("http://localhost:3100/", config.ShellPublicOrigin);
    }

    [Fact]
    public void FromEnvironment_UsesCombinedPublicOriginForCoreAndShell()
    {
        using var env = TemporaryEnvironment.With("HOST_PUBLIC_ORIGIN", "https://hosty.example");
        using var coreEnv = TemporaryEnvironment.With("HOST_CORE_PUBLIC_ORIGIN", null);
        using var shellEnv = TemporaryEnvironment.With("HOST_SHELL_PUBLIC_ORIGIN", null);

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Production));

        Assert.Equal("https://hosty.example", config.CorePublicOrigin);
        Assert.Equal("https://hosty.example", config.ShellPublicOrigin);
    }

    [Fact]
    public void FromEnvironment_ExplicitOriginsOverrideCombinedPublicOrigin()
    {
        using var env = TemporaryEnvironment.With("HOST_PUBLIC_ORIGIN", "https://hosty.example");
        using var coreEnv = TemporaryEnvironment.With("HOST_CORE_PUBLIC_ORIGIN", "https://core.example");
        using var shellEnv = TemporaryEnvironment.With("HOST_SHELL_PUBLIC_ORIGIN", "https://shell.example");

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Production));

        Assert.Equal("https://core.example", config.CorePublicOrigin);
        Assert.Equal("https://shell.example", config.ShellPublicOrigin);
    }

    [Fact]
    public void BuildPublicOriginWarnings_WarnsForInsecureNonLoopbackOrigins()
    {
        using var coreEnv = TemporaryEnvironment.With("HOST_CORE_PUBLIC_ORIGIN", "http://core.example");
        using var shellEnv = TemporaryEnvironment.With("HOST_SHELL_PUBLIC_ORIGIN", "http://127.0.0.1:3000");
        using var combinedEnv = TemporaryEnvironment.With("HOST_PUBLIC_ORIGIN", null);

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
