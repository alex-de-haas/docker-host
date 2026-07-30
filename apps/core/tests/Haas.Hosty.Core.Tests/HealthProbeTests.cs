using System.Net;
using System.Net.Sockets;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class HealthProbeTests
{
    [Fact]
    public void ResolveProbeTarget_NonHttpTcpType_ReturnsNull()
        => Assert.Null(LocalCommandRuntimeAdapter.ResolveProbeTarget(
            new RuntimeServiceHealthcheckManifest { Type = "exec" }, [], new Dictionary<string, int>()));

    [Fact]
    public void ResolveProbeTarget_HttpDefaultsToFirstPortAndRootPath()
    {
        var target = LocalCommandRuntimeAdapter.ResolveProbeTarget(
            new RuntimeServiceHealthcheckManifest { Type = "http" },
            [new RuntimePortManifest { ContainerPort = 3000 }],
            new Dictionary<string, int> { ["3000"] = 45000 });

        Assert.NotNull(target);
        Assert.Equal("http", target.Type);
        Assert.Equal("127.0.0.1", target.Host);
        Assert.Equal(45000, target.Port);
        Assert.Equal("/", target.Path);
    }

    [Fact]
    public void ResolveProbeTarget_SelectsNamedPortAndNormalizesPath()
    {
        var target = LocalCommandRuntimeAdapter.ResolveProbeTarget(
            new RuntimeServiceHealthcheckManifest { Type = "http", Port = 9000, Path = "healthz" },
            [new RuntimePortManifest { ContainerPort = 3000 }, new RuntimePortManifest { ContainerPort = 9000 }],
            new Dictionary<string, int> { ["3000"] = 45000, ["9000"] = 46000 });

        Assert.NotNull(target);
        Assert.Equal(46000, target.Port);
        Assert.Equal("/healthz", target.Path);
    }

    [Fact]
    public void ResolveProbeTarget_UnassignedPort_ReturnsNull()
        => Assert.Null(LocalCommandRuntimeAdapter.ResolveProbeTarget(
            new RuntimeServiceHealthcheckManifest { Type = "tcp", Port = 3000 },
            [new RuntimePortManifest { ContainerPort = 3000 }],
            new Dictionary<string, int>()));

    [Fact]
    public async Task NetworkHealthProbe_TcpConnectToListener_IsHealthy()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;

        var healthy = await new NetworkHealthProbe().ProbeAsync(
            new HealthProbeTarget("tcp", "127.0.0.1", port, "/", TimeSpan.FromSeconds(2)));

        Assert.True(healthy);
        listener.Stop();
    }

    [Fact]
    public async Task NetworkHealthProbe_TcpToClosedPort_IsUnhealthy()
        => Assert.False(await new NetworkHealthProbe().ProbeAsync(
            new HealthProbeTarget("tcp", "127.0.0.1", GetFreePort(), "/", TimeSpan.FromSeconds(2))));

    [Fact]
    public async Task NetworkHealthProbe_HttpSuccessStatus_IsHealthy()
    {
        await using var server = RespondWith(200);

        Assert.True(await new NetworkHealthProbe().ProbeAsync(
            new HealthProbeTarget("http", "127.0.0.1", server.Port, "/", TimeSpan.FromSeconds(5))));
    }

    [Fact]
    public async Task NetworkHealthProbe_HttpServerError_IsUnhealthy()
    {
        await using var server = RespondWith(503);

        Assert.False(await new NetworkHealthProbe().ProbeAsync(
            new HealthProbeTarget("http", "127.0.0.1", server.Port, "/", TimeSpan.FromSeconds(5))));
    }

    [Fact]
    public async Task NetworkHealthProbe_HttpConnectionRefused_IsUnhealthy()
        => Assert.False(await new NetworkHealthProbe().ProbeAsync(
            new HealthProbeTarget("http", "127.0.0.1", GetFreePort(), "/", TimeSpan.FromSeconds(2))));

    private static LoopbackHttpServer RespondWith(int statusCode)
        => LoopbackHttpServer.Start(context =>
        {
            context.Response.StatusCode = statusCode;
            return Task.CompletedTask;
        });

    private static int GetFreePort()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return port;
    }
}
