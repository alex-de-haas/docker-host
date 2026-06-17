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

    [Fact]
    public void BuildPortArguments_DefaultPort_PublishesLoopbackTcpOnlyAndInjectsHostPortOnce()
    {
        var port = new RuntimePortManifest { Key = "http", ContainerPort = 8080 };

        var args = DockerRuntimeAdapter.BuildPortArguments(port, hostPort: 49152, containerPort: 8080);

        // Byte-for-byte unchanged from the legacy publish: loopback bind, no protocol suffix.
        Assert.Equal(["-p", "127.0.0.1:49152:8080", "-e", "HOSTY_PORT_HTTP=49152"], args);
        Assert.DoesNotContain(args, arg => arg.Contains("/udp"));
        Assert.Single(args, arg => arg.StartsWith("HOSTY_PORT_", StringComparison.Ordinal));
    }

    [Fact]
    public void BuildPortArguments_HostExposedTcpAndUdp_PublishesBothProtocolsOnAllInterfaces()
    {
        var port = new RuntimePortManifest
        {
            Key = "torrent",
            ContainerPort = 6881,
            HostPort = 6881,
            Expose = "host",
            Transport = ["tcp", "udp"],
        };

        var args = DockerRuntimeAdapter.BuildPortArguments(port, hostPort: 6881, containerPort: 6881);

        Assert.Contains("0.0.0.0:6881:6881/tcp", args);
        Assert.Contains("0.0.0.0:6881:6881/udp", args);
        Assert.Equal(2, args.Count(arg => arg == "-p"));
        Assert.DoesNotContain("127.0.0.1:6881:6881", args);
        // HOSTY_PORT_* is injected exactly once even though two protocols are published.
        Assert.Single(args, arg => arg.StartsWith("HOSTY_PORT_", StringComparison.Ordinal));
        Assert.Contains("HOSTY_PORT_TORRENT=6881", args);
    }

    [Theory]
    [InlineData("host", "0.0.0.0")]
    [InlineData("HOST", "0.0.0.0")]
    [InlineData("loopback", "127.0.0.1")]
    public void BuildPortArguments_ExposeControlsBindAddress(string expose, string expectedBind)
    {
        var port = new RuntimePortManifest { ContainerPort = 6881, HostPort = 6881, Expose = expose };

        var args = DockerRuntimeAdapter.BuildPortArguments(port, hostPort: 6881, containerPort: 6881);

        Assert.Contains($"{expectedBind}:6881:6881/tcp", args);
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
