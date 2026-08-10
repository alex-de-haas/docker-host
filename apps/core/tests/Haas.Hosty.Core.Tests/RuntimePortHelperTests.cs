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

    [Fact]
    public void AllocateLoopbackPort_ReturnsPortInsideTheHostyBand()
    {
        // The regression that motivated the band: a port-0 bind hands back an OS dynamic-range port, so a
        // durable reservation sat in the pool the OS itself allocates from and could be taken back at any
        // time. Several allocations, because one landing in the band could be luck.
        var exclude = new HashSet<int>();
        for (var i = 0; i < 8; i++)
        {
            var port = RuntimePortHelper.AllocateLoopbackPort(exclude);

            Assert.InRange(port, RuntimePortHelper.AutomaticPortRangeStart, RuntimePortHelper.OsDynamicPortFloor - 1);
            Assert.False(RuntimePortHelper.IsOsDynamicRangePort(port));
            Assert.DoesNotContain(port, exclude);
            exclude.Add(port);
        }
    }

    [Fact]
    public void AllocateLoopbackPort_HonoursExclusionSet()
    {
        // Candidates are drawn at random now rather than handed over by the OS, so the exclusion set has
        // to be applied to the draw. The window left open is wide enough that 128 attempts cannot all miss
        // it by chance — a narrow one would make this flake into the fallback path.
        var windowStart = RuntimePortHelper.OsDynamicPortFloor - 2000;
        var exclude = new HashSet<int>();
        for (var port = RuntimePortHelper.AutomaticPortRangeStart; port < windowStart; port++)
        {
            exclude.Add(port);
        }

        var allocated = RuntimePortHelper.AllocateLoopbackPort(exclude);

        Assert.DoesNotContain(allocated, exclude);
        Assert.InRange(allocated, windowStart, RuntimePortHelper.OsDynamicPortFloor - 1);
    }

    [Fact]
    public void AllocateLoopbackPort_BandExhausted_FallsBackToOperatingSystemPort()
    {
        // Every port in the band is spoken for. Allocation must degrade to the pre-0.76.0 OS port rather
        // than fail — a fragile reservation on a saturated host still beats a host that cannot install
        // anything. The fallback logs a warning; the caller here passes no logger.
        var exclude = WholeBandExcept(keep: null);

        Assert.True(RuntimePortHelper.IsOsDynamicRangePort(RuntimePortHelper.AllocateLoopbackPort(exclude)));
    }

    [Fact]
    public void AllocateLoopbackPort_HeldBandPort_IsNeverHandedOut()
    {
        // Unlike a port-0 bind, a drawn candidate is not free by construction, so the allocator has to
        // probe it. The only port the exclusion set leaves open is held by a live listener: if the probe
        // were skipped, that port would come straight back.
        var held = HoldAnyBandPort(out var port);
        using (held)
        {
            Assert.NotEqual(port, RuntimePortHelper.AllocateLoopbackPort(WholeBandExcept(port)));
        }
    }

    [Theory]
    [InlineData(0, false)]
    [InlineData(20000, false)]
    [InlineData(32767, false)]
    [InlineData(32768, true)]
    [InlineData(49152, true)]
    [InlineData(65535, true)]
    [InlineData(65536, false)]
    public void IsOsDynamicRangePort_CoversEveryPlatformFloor(int port, bool expected)
    {
        // 32768 is Linux's floor and the lowest of the three; Windows and macOS start at 49152. The
        // predicate is deliberately the widest of them, so a Windows 52306 and a Linux 40000 both rehome.
        Assert.Equal(expected, RuntimePortHelper.IsOsDynamicRangePort(port));
    }

    // Every band port except `keep`, as an allocator exclusion set.
    private static HashSet<int> WholeBandExcept(int? keep)
    {
        var exclude = new HashSet<int>();
        for (var port = RuntimePortHelper.AutomaticPortRangeStart; port < RuntimePortHelper.OsDynamicPortFloor; port++)
        {
            if (port != keep)
            {
                exclude.Add(port);
            }
        }

        return exclude;
    }

    // Listens on some band port and reports which one. Scans rather than picking a constant: a developer
    // machine may already hold any given port, and the test needs a listener it actually owns.
    private static Socket HoldAnyBandPort(out int port)
    {
        for (var candidate = RuntimePortHelper.AutomaticPortRangeStart; candidate < RuntimePortHelper.OsDynamicPortFloor; candidate++)
        {
            var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
            try
            {
                socket.Bind(new IPEndPoint(IPAddress.Loopback, candidate));
                socket.Listen(1);
                port = candidate;
                return socket;
            }
            catch (SocketException)
            {
                socket.Dispose();
            }
        }

        throw new InvalidOperationException("No bindable port in the automatic band.");
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
