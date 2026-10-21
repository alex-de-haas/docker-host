using System.Net;
using System.Net.Sockets;
using Haas.Hosty.Initialization;

namespace Haas.Hosty.Core.Tests;

public sealed class InitializationListenerTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "hosty-init-listener-" + Guid.NewGuid().ToString("N"));
    private HostyCoreRuntimeConfig Config(int port) => new(root, Path.Combine(root, "core/run"), Path.Combine(root, "core/run/control.json"), port, $"http://localhost:{port}", null, "127.0.0.1", null, false);
    [Fact]
    public async Task AutomaticBinding_CollisionBeforeReadiness_ReallocatesAndThenStaysStable()
    {
        InitializationFiles.Request(root);
        using var holder = new TcpListener(IPAddress.Loopback, 0); holder.Start();
        var occupied = ((IPEndPoint)holder.LocalEndpoint).Port;
        var prepared = await InitializationListener.PrepareAsync(Config(occupied), explicitlyBound: false);
        Assert.NotEqual(occupied, prepared.Config.CorePort);
        Assert.True(prepared.State!.Automatic);
        Assert.False(prepared.State.Ready);
        await InitializationListener.MarkReadyAsync(root, prepared.State);
        using var newHolder = new TcpListener(IPAddress.Loopback, prepared.Config.CorePort); newHolder.Start();
        var restarted = await InitializationListener.PrepareAsync(prepared.Config, explicitlyBound: false);
        Assert.Equal(prepared.Config.CorePort, restarted.Config.CorePort);
        Assert.True(restarted.State!.Ready);
    }
    [Fact]
    public async Task ExplicitBinding_IsNeverSilentlyMoved()
    {
        InitializationFiles.Request(root);
        using var holder = new TcpListener(IPAddress.Loopback, 0); holder.Start();
        var occupied = ((IPEndPoint)holder.LocalEndpoint).Port;
        var prepared = await InitializationListener.PrepareAsync(Config(occupied), explicitlyBound: true);
        Assert.Equal(occupied, prepared.Config.CorePort);
        Assert.False(prepared.State!.Automatic);
    }
    public void Dispose() { if (Directory.Exists(root)) Directory.Delete(root, true); }
}
