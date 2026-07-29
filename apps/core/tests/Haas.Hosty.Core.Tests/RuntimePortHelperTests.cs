using System.Net;
using System.Net.Sockets;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class RuntimePortHelperTests
{
    [Fact]
    public void IsLoopbackTcpPortAvailable_FreePort_IsAvailable()
    {
        Assert.True(RuntimePortHelper.IsLoopbackTcpPortAvailable(RuntimePortHelper.AllocateLoopbackPort()));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(70000)]
    public void IsLoopbackTcpPortAvailable_OutOfRange_IsUnavailable(int port)
    {
        Assert.False(RuntimePortHelper.IsLoopbackTcpPortAvailable(port));
    }

    [Fact]
    public void IsLoopbackTcpPortAvailable_LoopbackHolder_IsUnavailable()
    {
        // The shape a docker publish produces (`-p 127.0.0.1:<host>:<container>`).
        using var holder = Hold(IPAddress.Loopback, dualMode: false, out var port);

        Assert.False(RuntimePortHelper.IsLoopbackTcpPortAvailable(port));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void IsLoopbackTcpPortAvailable_WildcardHolder_IsUnavailable(bool ipv6)
    {
        // The regression: a localCommand app that listens on "all interfaces" holds `0.0.0.0`/`::`, not
        // `127.0.0.1`. On BSD/macOS a loopback-only probe binds happily beside such a holder — .NET turns
        // SO_REUSEADDR on inside Bind — so the port looked free and the conflict only surfaced later as a
        // generic bind failure from the adapter, or as an app that started but never served.
        if (ipv6 && !Socket.OSSupportsIPv6)
        {
            return;
        }

        using var holder = Hold(ipv6 ? IPAddress.IPv6Any : IPAddress.Any, dualMode: false, out var port);

        Assert.False(RuntimePortHelper.IsLoopbackTcpPortAvailable(port));
    }

    [Fact]
    public void IsLoopbackTcpPortAvailable_DualStackWildcardHolder_IsUnavailable()
    {
        // What a Node/Next app gets from `listen(port)`: one `::` socket serving IPv4 as well.
        if (!Socket.OSSupportsIPv6)
        {
            return;
        }

        using var holder = Hold(IPAddress.IPv6Any, dualMode: true, out var port);

        Assert.False(RuntimePortHelper.IsLoopbackTcpPortAvailable(port));
    }

    [Fact]
    public void IsLoopbackTcpPortAvailable_PortLeftInTimeWait_IsStillAvailable()
    {
        // The false positive the wildcard probes must not introduce: an app that served traffic and was
        // then stopped leaves TIME_WAIT sockets on its port for up to a minute. Nothing is listening, so
        // the restart must be allowed through — every probe binds with SO_REUSEADDR, which is exactly the
        // flag that makes a TIME_WAIT remnant non-blocking.
        var port = ServeOneConnectionThenStop();

        Assert.True(RuntimePortHelper.IsLoopbackTcpPortAvailable(port));
    }

    // Binds and listens on `address` with an OS-chosen port, the way a runtime app's own listener would.
    private static Socket Hold(IPAddress address, bool dualMode, out int port)
    {
        var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp);
        try
        {
            if (address.AddressFamily == AddressFamily.InterNetworkV6)
            {
                socket.DualMode = dualMode;
            }

            socket.Bind(new IPEndPoint(address, 0));
            socket.Listen(1);
            port = ((IPEndPoint)socket.LocalEndPoint!).Port;
            return socket;
        }
        catch
        {
            socket.Dispose();
            throw;
        }
    }

    // Runs a listener, serves one connection, closes the server side first (so the server end is the one
    // left in TIME_WAIT), then drops the listener — the state a just-stopped app leaves behind.
    private static int ServeOneConnectionThenStop()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        using (var client = new TcpClient())
        {
            client.Connect(IPAddress.Loopback, port);
            using var accepted = listener.AcceptTcpClient();
            accepted.Client.Shutdown(SocketShutdown.Both);
            accepted.Close();
            client.Client.Shutdown(SocketShutdown.Both);
        }

        listener.Stop();
        return port;
    }
}
