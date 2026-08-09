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
    {
        using var closed = ClosedPort.Reserve();

        Assert.False(await new NetworkHealthProbe().ProbeAsync(
            new HealthProbeTarget("tcp", "127.0.0.1", closed.Port, "/", TimeSpan.FromSeconds(2))));
    }

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
    {
        using var closed = ClosedPort.Reserve();

        Assert.False(await new NetworkHealthProbe().ProbeAsync(
            new HealthProbeTarget("http", "127.0.0.1", closed.Port, "/", TimeSpan.FromSeconds(2))));
    }

    // The reservation's whole contract, and the half the probe assertions cannot see: a port that merely
    // refuses connections today is worthless if a parallel test can still take it. The rival here binds the
    // exact same address and port with SO_REUSEADDR — what every TcpListener in this suite carries — and
    // must be turned away. Drop ExclusiveAddressUse from Reserve and this fails on macOS (measured), which
    // is the point: the reservation rests on that flag, not on the kernel refusing duplicates on its own.
    [Fact]
    public void ClosedPort_Reserve_ExcludesARivalBinder()
    {
        using var closed = ClosedPort.Reserve();

        using var rival = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
        rival.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, 1);

        var error = Assert.Throws<SocketException>(
            () => rival.Bind(new IPEndPoint(IPAddress.Loopback, closed.Port)));
        Assert.Equal(SocketError.AddressAlreadyInUse, error.SocketErrorCode);
    }

    private static LoopbackHttpServer RespondWith(int statusCode)
        => LoopbackHttpServer.Start(context =>
        {
            context.Response.StatusCode = statusCode;
            return Task.CompletedTask;
        });

    // A loopback port nothing can be listening on, held for as long as the reservation lives. The socket
    // stays bound but never listens, so the kernel answers a probe with RST — indistinguishable, to the
    // probe, from a port no one ever touched.
    //
    // The obvious helper (bind port 0, read the assigned port, close the socket) only makes the port free
    // at the moment it is read: test classes run in parallel here, and any of the suite's
    // `TcpListener(IPAddress.Loopback, 0)` helpers — or an unrelated process on the machine — can be handed
    // that port in the window before the probe runs, then answer it. The probe reads healthy and a test
    // about probe semantics fails over port luck. Holding the bind makes "nothing is listening here" true
    // by construction instead of by hope.
    private sealed class ClosedPort : IDisposable
    {
        private readonly Socket socket;

        private ClosedPort(Socket socket)
        {
            this.socket = socket;
            Port = ((IPEndPoint)socket.LocalEndPoint!).Port;
        }

        public int Port { get; }

        public static ClosedPort Reserve()
        {
            // ExclusiveAddressUse is load-bearing, not decoration: a .NET socket carries SO_REUSEADDR from
            // construction (the property's own default is false, and it maps to that flag on Unix), and a
            // bound-but-not-listening holder with SO_REUSEADDR does not exclude anyone — a second socket
            // binds the *exact* same address and port and can then listen on it. Clearing it via
            // ExclusiveAddressUse is what turns this from a hint into a reservation. Reserve_ExcludesARivalBinder
            // pins the behavior down, since the flags decide it and no platform refuses this outright.
            var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp)
            {
                ExclusiveAddressUse = true,
            };
            try
            {
                socket.Bind(new IPEndPoint(IPAddress.Loopback, 0));
            }
            catch
            {
                socket.Dispose();
                throw;
            }

            return new ClosedPort(socket);
        }

        public void Dispose() => socket.Dispose();
    }
}
