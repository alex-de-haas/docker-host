using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class DockerRuntimeAdapterTests
{
    [Fact]
    public void BuildDockerCoreEnvironment_SplitsContainerAndBrowserOrigins()
    {
        var config = CreateConfig(corePort: 7070, listenUrl: "http://localhost:7070", corePublicOrigin: null);

        var result = DockerRuntimeAdapter.BuildDockerCoreEnvironment(config);

        Assert.Contains("HOSTY_CORE_PORT=7070", result);
        Assert.Contains("HOSTY_CORE_PUBLIC_ORIGIN=http://localhost:7070", result);
        Assert.Contains("HOSTY_CORE_ORIGIN=http://host.docker.internal:7070", result);
        Assert.DoesNotContain("HOSTY_CORE_PUBLIC_ORIGIN=http://host.docker.internal:7070", result);
    }

    [Theory]
    [InlineData("http://localhost:7070", "http://host.docker.internal:7070")]
    [InlineData("http://127.0.0.1:7070", "http://host.docker.internal:7070")]
    [InlineData("http://[::1]:7070", "http://host.docker.internal:7070")]
    [InlineData("https://localhost:7443", "https://host.docker.internal:7443")]
    public void BuildDockerCoreOrigin_RewritesLoopbackOriginsForContainerAccess(
        string coreOrigin,
        string expected)
    {
        var result = DockerRuntimeAdapter.BuildDockerCoreOrigin(coreOrigin);

        Assert.Equal(expected, result);
    }

    [Theory]
    [InlineData("https://core.example")]
    [InlineData("http://192.168.1.20:7070")]
    [InlineData("not-a-url")]
    public void BuildDockerCoreOrigin_KeepsNonLoopbackOrigins(string coreOrigin)
    {
        var result = DockerRuntimeAdapter.BuildDockerCoreOrigin(coreOrigin);

        Assert.Equal(coreOrigin, result);
    }

    private static HostyCoreRuntimeConfig CreateConfig(int corePort, string listenUrl, string? corePublicOrigin)
        => new(
            DataRoot: "/tmp/hosty",
            RunDirectory: "/tmp/hosty/core/run",
            ControlDiscoveryPath: "/tmp/hosty/core/run/control.json",
            CorePort: corePort,
            ShellPort: 7171,
            ListenUrl: listenUrl,
            CorePublicOrigin: corePublicOrigin,
            ShellPublicOrigin: null,
            RuntimePublicHost: "localhost",
            ShellManifestPath: null,
            ShellBootstrapRuntime: "docker",
            ShellSourceOverridePath: null,
            ShellBootstrapEnabled: false,
            ShellAutostart: false);
}
