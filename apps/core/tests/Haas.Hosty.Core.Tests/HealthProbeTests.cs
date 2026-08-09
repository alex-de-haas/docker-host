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

    // The half the probe assertions cannot see: a port that refuses connections right now is worthless if
    // a parallel test can still be handed it and listen there. The taker that actually threatens this
    // suite is the ephemeral allocator — every `TcpListener(IPAddress.Loopback, 0)` in it — and the kernel
    // never picks a port that is already bound. That is what the reservation rests on, so it is what gets
    // asserted; the ports are held simultaneously so each iteration sweeps a different one.
    [Fact]
    public void ClosedPort_Reserve_IsNeverHandedOutToAnEphemeralBind()
    {
        using var closed = ClosedPort.Reserve();

        var allocated = new List<TcpListener>();
        try
        {
            for (var attempt = 0; attempt < 64; attempt++)
            {
                var listener = new TcpListener(IPAddress.Loopback, 0);
                listener.Start();
                allocated.Add(listener);
                Assert.NotEqual(closed.Port, ((IPEndPoint)listener.LocalEndpoint).Port);
            }
        }
        finally
        {
            foreach (var listener in allocated)
            {
                listener.Stop();
            }
        }
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
            // What the reservation rests on is the bind itself: no platform's ephemeral allocator hands out
            // a port that is already bound, which is the only way a parallel test here could take it
            // (Reserve_IsNeverHandedOutToAnEphemeralBind pins that down).
            //
            // ExclusiveAddressUse is extra hardening against a *deliberate* bind of this exact port, and it
            // only bites on macOS: measured on .NET 10, macOS refuses such a rival once the flag is set,
            // while on Linux the rival binds anyway — the flag reads back as requested, but Bind puts
            // SO_REUSEADDR on the kernel socket regardless, and Linux lets two SO_REUSEADDR sockets share
            // the port of a non-listening holder. No test binds a specific port, so nothing here depends on
            // that difference.
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
