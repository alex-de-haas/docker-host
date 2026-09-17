using System.Text.Json;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class MixedRuntimeTests
{
    private const string Manifest = """
    {"schemaVersion":"app.0.1","id":"com.example.mixed","name":"Mixed","version":"1.0.0",
     "runtimeProfiles":[{"key":"dev","type":"mixed","development":true}],
     "services":[
       {"key":"ui","dependsOn":["backend"],"runtimes":{"dev":{"type":"localCommand","command":"ui","ports":[{"key":"http","containerPort":3000}]}}},
       {"key":"collector","runtimes":{"dev":{"type":"docker","image":"example/collector:1","ports":[{"key":"metrics","containerPort":9464}]}}},
       {"key":"backend","dependsOn":[{"service":"collector","port":"metrics"}],"runtimes":{"dev":{"type":"localCommand","command":"backend","ports":[{"key":"query","containerPort":8080}]}}}
     ]}
    """;

    internal static RuntimeAppManifestSelection Selection(string json = Manifest)
        => new AppManifestService().Select(JsonSerializer.Deserialize(json, CoreJsonSerializerContext.Default.RuntimeAppManifest)!,
            "/tmp/manifest.json", "digest", "dev", json);

    internal static RuntimeLifecycleContext Context(RuntimeAppManifestSelection? selection = null)
    {
        selection ??= Selection();
        var app = new AppRecord("com.example.mixed", "Mixed", null, "1.0.0", "runtime", false, "manifest",
            "/tmp/manifest.json", null, "dev", "installed", "stopped", null, null, [],
            new Dictionary<string, AppSettingValue>(), [], [], [], DateTimeOffset.UtcNow, DateTimeOffset.UtcNow,
            PortAssignments: selection.Services.SelectMany((service, index) => service.Runtime.Ports.Select(port =>
                new AppPortAssignment(service.Key, port.Key!, 34000 + index, "tcp", "loopback", "automatic", true, DateTimeOffset.UtcNow))).ToArray());
        return new(app, selection, "/tmp/mixed", "/tmp/mixed/data", new Dictionary<string, string>(), []);
    }

    [Fact]
    public void MixedSelection_PreservesServiceExecutionAndArtifactKinds()
    {
        var selection = Selection();
        Assert.Equal("mixed", selection.RuntimeProfile.Type);
        Assert.Equal("image", selection.Services.Single(service => service.Key == "collector").Artifact);
        Assert.Equal("source", selection.Services.Single(service => service.Key == "backend").Artifact);
    }

    [Fact]
    public async Task StartAndStop_RespectDependenciesAcrossAdapters()
    {
        var events = new List<string>();
        var adapter = new MixedRuntimeAdapter([new FakeAdapter("docker", events), new FakeAdapter("localCommand", events)]);
        await adapter.StartAsync(Context());
        await adapter.StopAsync(Context());
        Assert.Equal(new[] { "start:collector", "start:backend", "start:ui", "stop:ui", "stop:backend", "stop:collector" }, events);
    }

    [Fact]
    public async Task FailedStart_StopsOnlyServicesStartedByThisOperation()
    {
        var events = new List<string>();
        var adapter = new MixedRuntimeAdapter([new FakeAdapter("docker", events, running: true), new FakeAdapter("localCommand", events, fail: "ui")]);
        await Assert.ThrowsAsync<AppLifecycleException>(() => adapter.StartAsync(Context()));
        Assert.Equal(new[] { "start:collector", "start:backend", "start:ui", "stop:backend" }, events);
    }

    [Fact]
    public async Task FailedStart_RemovesARecreatedServiceEvenWhenItWasPreviouslyRunning()
    {
        var events = new List<string>();
        var adapter = new MixedRuntimeAdapter([new FakeAdapter("docker", events, running: true, recreated: true),
            new FakeAdapter("localCommand", events, fail: "ui")]);
        await Assert.ThrowsAsync<AppLifecycleException>(() => adapter.StartAsync(Context()));
        Assert.Equal(new[] { "start:collector", "start:backend", "start:ui", "stop:backend", "stop:collector" }, events);
    }

    [Fact]
    public async Task InvalidCrossRuntimeEdge_FailsBeforeAnyServiceStarts()
    {
        var context = Context();
        var collector = context.Manifest.Services.Single(service => service.Key == "collector");
        var backend = context.Manifest.Services.Single(service => service.Key == "backend") with { DependsOn = [] };
        context = context with { Manifest = context.Manifest with { Services = [collector with { DependsOn = [new("backend", "query")] }, backend] } };
        var events = new List<string>();
        var adapter = new MixedRuntimeAdapter([new FakeAdapter("docker", events), new FakeAdapter("localCommand", events)]);
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => adapter.StartAsync(context));
        Assert.Equal("mixed_host_binding_required", error.Code);
        Assert.Empty(events);
    }

    [Fact]
    public async Task Stop_ContinuesAfterOneAdapterFailsAndReportsFailure()
    {
        var events = new List<string>();
        var adapter = new MixedRuntimeAdapter([new FakeAdapter("docker", events), new FakeAdapter("localCommand", events, failStop: "ui")]);
        await Assert.ThrowsAsync<AppLifecycleException>(() => adapter.StopAsync(Context()));
        Assert.Equal(new[] { "stop:ui", "stop:backend", "stop:collector" }, events);
    }

    [Fact]
    public void Discovery_UsesConsumerNamespaceAndRequiresExplicitHostExposure()
    {
        var context = Context();
        var collector = context.Manifest.Services.Single(service => service.Key == "collector");
        var backend = context.Manifest.Services.Single(service => service.Key == "backend");
        Assert.Equal("http://127.0.0.1:34001", RuntimeServiceDiscovery.BuildPeerUrl(context, backend, collector, collector.Runtime.Ports[0]));
        Assert.Equal("http://collector:9464", RuntimeServiceDiscovery.BuildPeerUrl(context, collector, collector, collector.Runtime.Ports[0]));
        Assert.Throws<AppLifecycleException>(() => RuntimeServiceDiscovery.BuildPeerUrl(context, collector, backend, backend.Runtime.Ports[0]));
        Assert.Equal("http://host.docker.internal:34002", RuntimeServiceDiscovery.BuildPeerUrl(context, collector, backend, new RuntimePortManifest { Key = "query", ContainerPort = 8080, Expose = "host" }));
    }

    [Fact]
    public void LiveManifest_RequiresReviewForImagesButAllowsWatchCommandEdits()
    {
        var baseline = Selection();
        Assert.True(DockerSourceRuntime.RequiresReview(baseline, Selection(Manifest.Replace("example/collector:1", "example/collector:2"))));
        Assert.False(DockerSourceRuntime.RequiresReview(baseline, Selection(Manifest.Replace("\"command\":\"backend\"", "\"command\":\"backend --watch\""))));
    }

    [Fact]
    public void MixedProfile_RequiresSourceAndExplicitServiceExecution()
    {
        Assert.Throws<AppManifestException>(() => Selection(Manifest.Replace("\"development\":true", "\"development\":false")));
        Assert.Throws<AppManifestException>(() => Selection(Manifest.Replace("\"type\":\"localCommand\",", "")));
    }

    private sealed class FakeAdapter(string type, List<string> events, string? fail = null, bool running = false, string? failStop = null, bool recreated = false) : IAppRuntimeAdapter
    {
        public string Type => type;
        public Task<AppRuntimeStartResult> StartAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
        {
            var service = Assert.Single(context.Manifest.Services);
            Assert.Equal(type, service.Runtime.Type);
            Assert.Equal(3, context.AllServices.Count);
            events.Add("start:" + service.Key);
            if (service.Key == fail) throw new AppLifecycleException("test_start_failure", "start failed");
            return Task.FromResult(new AppRuntimeStartResult("running", [], CreatedServices: recreated ? [service.Key] : null));
        }
        public Task<AppRuntimeOperationResult> StopAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
        {
            var service = Assert.Single(context.Manifest.Services);
            events.Add("stop:" + service.Key);
            if (service.Key == failStop) throw new AppLifecycleException("test_stop_failure", "stop failed");
            return Task.FromResult(new AppRuntimeOperationResult("stopped"));
        }
        public Task<AppRuntimeOperationResult> RemoveAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default) => StopAsync(context, cancellationToken);
        public Task<AppRuntimeLogsResult> GetLogsAsync(RuntimeLifecycleContext context, int tail, CancellationToken cancellationToken = default) => Task.FromResult(new AppRuntimeLogsResult(""));
        public Task<AppRuntimeHealthResult> GetHealthAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
            => Task.FromResult(new AppRuntimeHealthResult(running ? "running" : "stopped", [new(Assert.Single(context.Manifest.Services).Key, running ? "running" : "stopped", null, null, null, null, null)]));
    }
}
