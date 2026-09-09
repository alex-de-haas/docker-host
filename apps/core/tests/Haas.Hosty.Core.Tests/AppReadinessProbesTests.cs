using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

// The implicit readiness targets per runtime (docs/features/app-readiness/). The docker/localCommand
// split is the measured one: through docker's userland proxy a tcp connect succeeds before the
// container listens, so docker gets an any-response http request on its http endpoints and nothing on
// the rest, while localCommand keeps the tcp connect.
public sealed class AppReadinessProbesTests
{
    private static RuntimeAppManifestSelection Selection(string runtimeType, params (string Service, string Port, string Protocol)[] endpoints)
    {
        var manifest = new RuntimeAppManifest
        {
            Endpoints = endpoints
                .Select(endpoint => new RuntimeAppEndpointManifest { Key = $"{endpoint.Service}.{endpoint.Port}", Service = endpoint.Service, Port = endpoint.Port, Protocol = endpoint.Protocol })
                .ToArray(),
        };
        // The service list comes from the endpoint tuples; with none declared (the projected-ports
        // case) the app still has its one service, which is exactly what that case is about.
        var serviceKeys = endpoints.Select(endpoint => endpoint.Service).Distinct(StringComparer.Ordinal).ToArray();
        var services = (serviceKeys.Length > 0 ? serviceKeys : ["app"])
            .Select(service => new RuntimeSelectedService(
                service,
                [],
                new RuntimeServiceProfileManifest { Type = runtimeType, Ports = [new RuntimePortManifest { Key = "http", ContainerPort = 3000 }, new RuntimePortManifest { Key = "db", ContainerPort = 6379 }] },
                null,
                runtimeType == "docker" ? "image" : "source"))
            .ToArray();
        return new RuntimeAppManifestSelection(manifest, "manifest.json", "digest", new RuntimeProfileManifest { Key = runtimeType, Type = runtimeType }, services, null, "{}", null);
    }

    private static AppEndpointContract Published(string service, string port, int hostPort, string protocol = "http")
        => new($"{service}.{port}", protocol, $"{protocol}://localhost:{hostPort}", Public: true, Service: service, Port: port);

    [Fact]
    public void ADockerHttpEndpointGetsAnAnyResponseHttpProbe()
    {
        var targets = AppReadinessProbes.BuildTargets(
            Selection("docker", ("app", "http", "http")),
            [Published("app", "http", 41000)],
            TimeSpan.FromSeconds(2));

        var target = Assert.Single(Assert.Single(targets).Value);
        Assert.Equal(("http", "127.0.0.1", 41000, "/", true), (target.Type, target.Host, target.Port, target.Path, target.AnyResponse));
    }

    [Fact]
    public void ADockerNonHttpEndpointGetsNoImplicitProbe()
    {
        // tcp through the proxy proves nothing and http does not apply: the image HEALTHCHECK is the
        // only signal, so the service reads ready once alive rather than being probed by a lie.
        var targets = AppReadinessProbes.BuildTargets(
            Selection("docker", ("cache", "db", "redis")),
            [Published("cache", "db", 46379, "redis")],
            TimeSpan.FromSeconds(2));

        Assert.Empty(targets);
    }

    [Fact]
    public void ALocalCommandEndpointGetsATcpConnect()
    {
        var targets = AppReadinessProbes.BuildTargets(
            Selection("localCommand", ("app", "http", "http"), ("app", "db", "redis")),
            [Published("app", "http", 41000), Published("app", "db", 46379, "redis")],
            TimeSpan.FromSeconds(2));

        var app = Assert.Single(targets).Value;
        Assert.Equal(2, app.Count);
        Assert.All(app, target => Assert.Equal(("tcp", false), (target.Type, target.AnyResponse)));
        Assert.Equal([41000, 46379], app.Select(target => target.Port).Order());
    }

    [Fact]
    public void ADeclaredHttpHealthcheckWinsAndKeepsTheHealthRule()
    {
        var selection = Selection("localCommand", ("app", "http", "http"));
        var service = selection.Services[0];
        var declared = service with
        {
            Runtime = new RuntimeServiceProfileManifest
            {
                Type = "localCommand",
                Ports = service.Runtime.Ports,
                Healthcheck = new RuntimeServiceHealthcheckManifest { Type = "http", Path = "ready", TimeoutSeconds = 1 },
            },
        };
        var targets = AppReadinessProbes.BuildTargets(
            selection with { Services = [declared] },
            [Published("app", "http", 41000)],
            TimeSpan.FromSeconds(2));

        var target = Assert.Single(Assert.Single(targets).Value);
        // A declared check is a health rule: 2xx/3xx, on the declared path, with its own (shorter) timeout.
        Assert.Equal(("http", "/ready", false, TimeSpan.FromSeconds(1)), (target.Type, target.Path, target.AnyResponse, target.Timeout));
    }

    [Fact]
    public void RuntimePortsProjectedAsEndpointsAreProbedWhenTheManifestDeclaresNone()
    {
        // A valid manifest may declare no top-level endpoints; Core then projects every runtime port
        // as one, and those contracts — not the manifest's (empty) list — are what get probed.
        var targets = AppReadinessProbes.BuildTargets(
            Selection("localCommand"),
            [Published("app", "http", 41000)],
            TimeSpan.FromSeconds(2));

        var target = Assert.Single(Assert.Single(targets).Value);
        Assert.Equal(("tcp", 41000), (target.Type, target.Port));
    }

    [Fact]
    public void ADockerHttpsEndpointKeepsItsScheme()
    {
        var targets = AppReadinessProbes.BuildTargets(
            Selection("docker", ("app", "http", "https")),
            [Published("app", "http", 41443, "https")],
            TimeSpan.FromSeconds(2));

        var target = Assert.Single(Assert.Single(targets).Value);
        Assert.Equal(("https", 41443, true), (target.Type, target.Port, target.AnyResponse));
    }

    [Fact]
    public async Task ServicesAndTargetsAreProbedConcurrently()
    {
        // Three silent targets at 300 ms each: serial would cost ~900 ms per scan, concurrent ~300 ms.
        // The budget is checked between scans, so a scan must not grow with the endpoint count.
        var probe = new SlowProbe(TimeSpan.FromMilliseconds(300));
        var targets = new Dictionary<string, IReadOnlyList<HealthProbeTarget>>(StringComparer.Ordinal)
        {
            ["a"] = [Target(1), Target(2)],
            ["b"] = [Target(3)],
        };
        var services = new[] { Service("a"), Service("b") };

        var stopwatch = System.Diagnostics.Stopwatch.StartNew();
        var result = await AppReadinessProbes.ApplyAsync(services, targets, probe, CancellationToken.None);

        Assert.True(stopwatch.Elapsed < TimeSpan.FromMilliseconds(750), $"scan took {stopwatch.Elapsed}");
        Assert.All(result, service => Assert.Equal("healthy", service.Health));
        Assert.Equal(3, probe.Calls);
    }

    [Fact]
    public void SameReadingIgnoresServiceOrder()
    {
        var now = DateTimeOffset.UnixEpoch;
        var left = new AppHealthSummary("healthy", [new("a", "running", "healthy"), new("b", "running", null)], now);
        var right = new AppHealthSummary("healthy", [new("b", "running", null), new("a", "running", "healthy")], now.AddMinutes(1));
        var changed = new AppHealthSummary("healthy", [new("b", "running", null), new("a", "running", "unhealthy")], now);

        Assert.True(AppReadinessProbes.SameReading(left, right));
        Assert.False(AppReadinessProbes.SameReading(left, changed));
        Assert.False(AppReadinessProbes.SameReading(left, null));
        Assert.True(AppReadinessProbes.SameReading(null, null));
    }

    private static HealthProbeTarget Target(int port) => new("tcp", "127.0.0.1", 40000 + port, "/", TimeSpan.FromSeconds(1));

    private static AppRuntimeServiceHealth Service(string key) => new(key, "running", null, null, null, null, null);

    private sealed class SlowProbe(TimeSpan delay) : IHealthProbe
    {
        private int calls;

        public int Calls => Volatile.Read(ref calls);

        public async Task<bool> ProbeAsync(HealthProbeTarget target, CancellationToken cancellationToken = default)
        {
            Interlocked.Increment(ref calls);
            await Task.Delay(delay, cancellationToken);
            return true;
        }
    }

    [Fact]
    public void AnEndpointWithNoPublishedUrlIsNotProbed()
    {
        var targets = AppReadinessProbes.BuildTargets(
            Selection("localCommand", ("app", "http", "http")),
            [new AppEndpointContract("app.http", "http", Url: null, Public: true, Service: "app", Port: "http")],
            TimeSpan.FromSeconds(2));

        Assert.Empty(targets);
    }
}
