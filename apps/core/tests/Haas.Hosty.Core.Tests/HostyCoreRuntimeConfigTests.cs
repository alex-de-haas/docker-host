using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Hosting;

namespace Haas.Hosty.Core.Tests;

public sealed class HostyCoreRuntimeConfigTests
{
    [Fact]
    public void FromEnvironment_DefaultsShellPublicOriginInDevelopment()
    {
        using var env = TemporaryEnvironment.With("HOST_SHELL_PUBLIC_ORIGIN", null);

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Development));

        Assert.Equal("http://127.0.0.1:3000", config.ShellPublicOrigin);
    }

    [Fact]
    public void FromEnvironment_LeavesShellPublicOriginUnsetOutsideDevelopment()
    {
        using var env = TemporaryEnvironment.With("HOST_SHELL_PUBLIC_ORIGIN", null);

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Production));

        Assert.Null(config.ShellPublicOrigin);
    }

    [Fact]
    public void FromEnvironment_UsesExplicitShellPublicOrigin()
    {
        using var env = TemporaryEnvironment.With("HOST_SHELL_PUBLIC_ORIGIN", " http://localhost:3100/ ");

        var config = HostyCoreRuntimeConfig.FromEnvironment(new TestHostEnvironment(Environments.Development));

        Assert.Equal("http://localhost:3100/", config.ShellPublicOrigin);
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
