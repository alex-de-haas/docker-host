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
        var services = endpoints
            .Select(endpoint => endpoint.Service)
            .Distinct(StringComparer.Ordinal)
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
    public void AnEndpointWithNoPublishedUrlIsNotProbed()
    {
        var targets = AppReadinessProbes.BuildTargets(
            Selection("localCommand", ("app", "http", "http")),
            [new AppEndpointContract("app.http", "http", Url: null, Public: true, Service: "app", Port: "http")],
            TimeSpan.FromSeconds(2));

        Assert.Empty(targets);
    }
}
