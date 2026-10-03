using System.Net;
using Haas.Hosty.Core;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;

namespace Haas.Hosty.Core.Tests;

public sealed class DockerCoreListenerTests
{
    private static readonly IReadOnlyDictionary<string, IReadOnlyList<IPAddress>> Bridges =
        new Dictionary<string, IReadOnlyList<IPAddress>> { ["br-custom"] = [IPAddress.Parse("172.29.0.1")] };

    [Theory]
    [InlineData("http://localhost:7070", true)]
    [InlineData("http://127.0.0.1:7070", true)]
    [InlineData("http://[::1]:7070", true)]
    [InlineData("https://localhost:7443", false)]
    [InlineData("http://0.0.0.0:7070", false)]
    [InlineData("http://192.168.1.2:7070", false)]
    [InlineData("https://core.example.test", false)]
    public void OnlyPlainLoopbackListenersAreExtended(string url, bool expected)
        => Assert.Equal(expected, DockerCoreListener.SupportsAutomaticListener(url));

    [Fact]
    public async Task DiscoversCustomBridgeWithoutHardcodedAddressOrInterface()
    {
        var result = await Discover(new Runner());
        Assert.Equal("172.29.0.1", result.Gateway);
        Assert.Null(result.Diagnostic);
    }

    [Theory]
    [InlineData("bridge|br-custom|172.30.0.1")]
    [InlineData("bridge|eth0|172.29.0.1")]
    [InlineData("host|br-custom|172.29.0.1")]
    [InlineData("bridge|br-custom|0.0.0.0")]
    [InlineData("bridge|br-custom|127.0.0.1")]
    [InlineData("broken")]
    public async Task RejectsGatewaysNotOwnedByTheSelectedLocalBridge(string network)
    {
        var result = await Discover(new Runner { Network = network });
        Assert.Null(result.Gateway);
        Assert.NotNull(result.Diagnostic);
    }

    [Fact]
    public async Task RemoteDockerCannotOpenALocalListenerEvenWithMatchingBridgeAddress()
    {
        var runner = new Runner();
        var result = await DockerCoreListener.DiscoverAsync(runner, Bridges, "ssh://other-host", null, default);
        Assert.Null(result.Gateway);
        Assert.Empty(runner.Commands);
    }

    [Fact]
    public async Task ExplicitContextWinsOverDockerHost()
    {
        var result = await DockerCoreListener.DiscoverAsync(new Runner(), Bridges, "ssh://other-host", "local", default);
        Assert.Equal("172.29.0.1", result.Gateway);
    }

    [Theory]
    [InlineData("Ubuntu|[\"name=rootless\"]", false)]
    [InlineData("Docker Desktop|[]", true)]
    public async Task NonNativeNetworksNeverBindGuessedBridgeAddresses(string info, bool desktop)
    {
        var runner = new Runner { Info = info };
        var result = await Discover(runner);
        Assert.Null(result.Gateway);
        Assert.Equal(desktop, result.Desktop);
        Assert.DoesNotContain("network", runner.Commands);
    }

    [Fact]
    public async Task DockerBecomingAvailableIsDiscoveredOnNextAttempt()
    {
        var runner = new Runner { InfoExitCode = 1 };
        Assert.Null((await Discover(runner)).Gateway);
        runner.InfoExitCode = 0;
        Assert.Equal("172.29.0.1", (await Discover(runner)).Gateway);
    }

    [Fact]
    public void ReloadAddsAndRemovesOnlyTheDockerEndpoint()
    {
        var source = new DockerListenerConfiguration("http://localhost:27070");
        using var root = (ConfigurationRoot)new ConfigurationBuilder().Add(source).Build();
        var changed = false;
        using var registration = root.GetReloadToken().RegisterChangeCallback(_ => changed = true, null);
        source.SetGateway("172.29.0.1");
        Assert.True(changed);
        Assert.Equal("http://localhost:27070", root["Endpoints:Local:Url"]);
        Assert.Equal("http://172.29.0.1:27070", root["Endpoints:Docker:Url"]);
        source.SetGateway(null);
        Assert.Equal("http://localhost:27070", root["Endpoints:Local:Url"]);
        Assert.Empty(root.GetSection("Endpoints:Docker").GetChildren());
    }

    [Theory]
    [InlineData("172.29.0.1", "/control/v1/core/stop", false)]
    [InlineData("172.29.0.1", "/CONTROL/v1/core/status", false)]
    [InlineData("172.29.0.1", "/api/apps", true)]
    [InlineData("127.0.0.1", "/control/v1/core/status", true)]
    [InlineData("::1", "/control/v1/core/status", true)]
    public async Task BridgeControlGuardUsesActualConnectionBeforeForwardedHeaders(string address, string path, bool expected)
    {
        var context = new DefaultHttpContext();
        context.Connection.LocalIpAddress = IPAddress.Parse(address);
        context.Request.Path = path;
        context.Request.Headers["X-Forwarded-For"] = "127.0.0.1";
        var called = false;
        await DockerCoreListener.GuardControlAsync(context, _ => { called = true; return Task.CompletedTask; });
        Assert.Equal(expected, called);
        if (!expected) Assert.Equal(404, context.Response.StatusCode);
    }

    private static Task<DockerBridgeDiscovery> Discover(Runner runner)
        => DockerCoreListener.DiscoverAsync(runner, Bridges, null, null, default);

    private sealed class Runner : IDockerCommandRunner
    {
        public string Network { get; init; } = "bridge|br-custom|172.29.0.1";
        public string Info { get; init; } = "Ubuntu|[]";
        public int InfoExitCode { get; set; }
        public List<string> Commands { get; } = [];
        public Task<DockerCommandResult> RunAsync(IReadOnlyList<string> args,
            IReadOnlyDictionary<string, string>? environment = null, CancellationToken cancellationToken = default)
        {
            Commands.Add(args[0]);
            return Task.FromResult(args[0] switch
            {
                "context" => new DockerCommandResult(0, "unix:///var/run/docker.sock", ""),
                "info" => new DockerCommandResult(InfoExitCode, Info, ""),
                "network" => new DockerCommandResult(0, Network, ""),
                _ => throw new InvalidOperationException()
            });
        }
    }
}
