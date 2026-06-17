using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class RuntimeServiceDiscoveryTests
{
    [Theory]
    [InlineData("api", "HOSTY_SERVICE_API_URL")]
    [InlineData("media-api", "HOSTY_SERVICE_MEDIA_API_URL")]
    public void EnvironmentName_NormalizesServiceKey(string serviceKey, string expected)
        => Assert.Equal(expected, RuntimeServiceDiscovery.EnvironmentName(serviceKey));

    [Fact]
    public void ChooseInternalPort_PrefersFirstNonPublicPort()
    {
        var service = Service("api",
            Port("public", 8080, isPublic: true),
            Port("internal", 3000));

        var chosen = RuntimeServiceDiscovery.ChooseInternalPort(service, namedPort: null);

        Assert.Equal("internal", chosen?.Key);
    }

    [Fact]
    public void ChooseInternalPort_FallsBackToFirstPortWhenAllPublic()
    {
        var service = Service("api", Port("a", 8080, isPublic: true), Port("b", 8081, isPublic: true));

        var chosen = RuntimeServiceDiscovery.ChooseInternalPort(service, namedPort: null);

        Assert.Equal("a", chosen?.Key);
    }

    [Fact]
    public void ChooseInternalPort_HonorsNamedPort()
    {
        var service = Service("api", Port("internal", 3000), Port("metrics", 9000));

        var chosen = RuntimeServiceDiscovery.ChooseInternalPort(service, namedPort: "metrics");

        Assert.Equal("metrics", chosen?.Key);
    }

    [Fact]
    public void ChooseInternalPort_ReturnsNullForUnknownNamedPortOrNoPorts()
    {
        Assert.Null(RuntimeServiceDiscovery.ChooseInternalPort(Service("api", Port("internal", 3000)), "nope"));
        Assert.Null(RuntimeServiceDiscovery.ChooseInternalPort(Service("api"), namedPort: null));
    }

    [Fact]
    public void ChooseInternalPort_MatchesNamedPortByContainerPortNumber()
    {
        var service = Service("api", Port("internal", 3000), Port("metrics", 9000));

        var chosen = RuntimeServiceDiscovery.ChooseInternalPort(service, namedPort: "3000");

        Assert.Equal("internal", chosen?.Key);
    }

    [Fact]
    public void BuildEnvironment_SkipsWhenUrlFactoryReturnsNull()
    {
        var api = Service("api", Port("internal", 3000));
        var web = Service("web", dependsOn: new RuntimeServiceDependency("api", null));

        var environment = RuntimeServiceDiscovery
            .BuildEnvironment([api, web], web, (_, _) => null)
            .ToList();

        Assert.Empty(environment);
    }

    [Fact]
    public void BuildEnvironment_InjectsUrlPerResolvedDependency()
    {
        var api = Service("api", Port("internal", 3000));
        var web = Service("web", dependsOn: new RuntimeServiceDependency("api", null));

        var environment = RuntimeServiceDiscovery
            .BuildEnvironment([api, web], web, (target, port) => $"test://{target.Key}:{port.ContainerPort}")
            .ToList();

        var entry = Assert.Single(environment);
        Assert.Equal("HOSTY_SERVICE_API_URL", entry.Key);
        Assert.Equal("test://api:3000", entry.Value);
    }

    [Fact]
    public void BuildEnvironment_SkipsUnknownTargetAndOrderingOnlyDependency()
    {
        var ordering = Service("ordering"); // declares no port -> discovery yields nothing
        var web = Service("web",
            dependsOn: new[] { new RuntimeServiceDependency("ordering", null), new RuntimeServiceDependency("ghost", null) });

        var environment = RuntimeServiceDiscovery
            .BuildEnvironment([ordering, web], web, (target, port) => $"test://{target.Key}:{port.ContainerPort}")
            .ToList();

        Assert.Empty(environment);
    }

    private static RuntimeSelectedService Service(string key, params RuntimePortManifest[] ports)
        => Service(key, dependsOn: Array.Empty<RuntimeServiceDependency>(), ports);

    private static RuntimeSelectedService Service(string key, RuntimeServiceDependency dependsOn, params RuntimePortManifest[] ports)
        => Service(key, new[] { dependsOn }, ports);

    private static RuntimeSelectedService Service(string key, IReadOnlyList<RuntimeServiceDependency> dependsOn, params RuntimePortManifest[] ports)
        => new(key, dependsOn, new RuntimeServiceProfileManifest { Type = "docker", Ports = ports }, null);

    private static RuntimePortManifest Port(string key, int containerPort, bool isPublic = false)
        => new() { Key = key, ContainerPort = containerPort, Public = isPublic };
}
