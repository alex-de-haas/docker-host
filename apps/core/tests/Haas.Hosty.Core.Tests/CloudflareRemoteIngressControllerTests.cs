using System.Text.Json.Nodes;
using Haas.Hosty.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

// The API provider as an ingress controller: a moved local port re-points its own tunnel route, whoever
// moved it. Before this existed, a route followed its port only when an operator pressed Publish, so a
// reassignment or the boot rehoming pass left a public hostname aimed at a port nothing listens on.
public sealed class CloudflareRemoteIngressControllerTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"hosty-cf-remote-ingress-{Guid.NewGuid():N}");

    [Fact]
    public async Task ReconcileAsync_PortMoved_RePointsTheRouteAndLeavesDnsAlone()
    {
        var fixture = await CreateAsync(connected: true);
        await fixture.PublishAsync();
        var dnsBefore = fixture.Api.Dns.Count;

        await fixture.MovePortAsync("http://127.0.0.1:24500");
        await fixture.Controller.ReconcileAsync(await fixture.Apps.ListAppRecordsAsync());

        Assert.Equal("http://127.0.0.1:24500", fixture.RouteService("media.example.test"));
        var publication = await fixture.Publications.GetAsync("com.example.media", "web.http");
        Assert.Equal("http://127.0.0.1:24500", publication!.ServiceUrl);
        Assert.Null(publication.DriftedServiceUrl);
        // The CNAME points at the tunnel, not at a port, so a moved port is not a DNS change.
        Assert.Equal(dnsBefore, fixture.Api.Dns.Count);
    }

    [Fact]
    public async Task ReconcileAsync_NothingMoved_TalksToNoApi()
    {
        // What makes reconciling at boot affordable: the diff is two strings, and a steady-state boot
        // does no network I/O at all.
        var fixture = await CreateAsync(connected: true);
        await fixture.PublishAsync();
        fixture.Api.ResetCallCounts();

        await fixture.Controller.ReconcileAsync(await fixture.Apps.ListAppRecordsAsync());

        Assert.Equal(0, fixture.Api.GetConfigCalls);
        Assert.Equal(0, fixture.Api.PutConfigCalls);
    }

    [Fact]
    public async Task ReconcileAsync_WithoutAConnection_RecordsDriftAndDoesNotThrow()
    {
        // Reconciliation runs on the startup path, where there is no operator to answer "connect first".
        // The drift is recorded so the state projection can report it, and boot continues.
        var fixture = await CreateAsync(connected: true);
        await fixture.PublishAsync();
        await fixture.MovePortAsync("http://127.0.0.1:24500");
        await fixture.DisconnectAsync();

        await fixture.Controller.ReconcileAsync(await fixture.Apps.ListAppRecordsAsync());

        var publication = await fixture.Publications.GetAsync("com.example.media", "web.http");
        Assert.Equal("http://127.0.0.1:24500", publication!.DriftedServiceUrl);
        // The route still points at the old port — that is exactly what the drift marker is claiming.
        Assert.Equal("http://127.0.0.1:8096", publication.ServiceUrl);
    }

    [Fact]
    public async Task ReconcileAsync_ApiFailure_RecordsDriftAndDoesNotThrow()
    {
        var fixture = await CreateAsync(connected: true);
        await fixture.PublishAsync();
        await fixture.MovePortAsync("http://127.0.0.1:24500");
        fixture.Api.Failure = new CloudflareApiException(503, ["Cloudflare is unreachable."]);

        await fixture.Controller.ReconcileAsync(await fixture.Apps.ListAppRecordsAsync());

        var publication = await fixture.Publications.GetAsync("com.example.media", "web.http");
        Assert.Equal("http://127.0.0.1:24500", publication!.DriftedServiceUrl);
    }

    [Fact]
    public async Task ReconcileAsync_AfterDrift_RepairsItAndClearsTheMarker()
    {
        // Drift is not terminal: the next reconcile that can reach Cloudflare fixes it. This is what makes
        // "record and move on" an honest alternative to retrying on the startup path.
        var fixture = await CreateAsync(connected: true);
        await fixture.PublishAsync();
        await fixture.MovePortAsync("http://127.0.0.1:24500");
        fixture.Api.Failure = new CloudflareApiException(503, ["Cloudflare is unreachable."]);
        await fixture.Controller.ReconcileAsync(await fixture.Apps.ListAppRecordsAsync());

        fixture.Api.Failure = null;
        await fixture.Controller.ReconcileAsync(await fixture.Apps.ListAppRecordsAsync());

        var publication = await fixture.Publications.GetAsync("com.example.media", "web.http");
        Assert.Null(publication!.DriftedServiceUrl);
        Assert.Equal("http://127.0.0.1:24500", publication.ServiceUrl);
        Assert.Equal("http://127.0.0.1:24500", fixture.RouteService("media.example.test"));
    }

    [Fact]
    public async Task ReconcileAsync_UnderAnotherProvider_StillFollowsARetainedPublication()
    {
        // A publication outlives a provider change — that is why unpublish is ungated too — so its
        // hostname stays routed and live after the operator switches to `none` or `cloudflared`. Gating
        // reconciliation on the active provider would stranded that hostname on a dead port the moment
        // anything moved it, with nothing even recording the drift. Creating a publication stays gated;
        // keeping one that exists correct is maintenance.
        var fixture = await CreateAsync(connected: true);
        await fixture.PublishAsync();
        await fixture.MovePortAsync("http://127.0.0.1:24500");
        await fixture.SetProviderAsync(IngressSettings.ProviderCloudflared);

        await fixture.Controller.ReconcileAsync(await fixture.Apps.ListAppRecordsAsync());

        Assert.Equal("http://127.0.0.1:24500", fixture.RouteService("media.example.test"));
        Assert.Equal("http://127.0.0.1:24500", (await fixture.Publications.GetAsync("com.example.media", "web.http"))!.ServiceUrl);
    }

    [Fact]
    public async Task ReconcileAsync_NoPublications_DoesNothingUnderAnyProvider()
    {
        // The ungating above is bounded by publications, not by the provider: a host that never published
        // pays nothing for it.
        var fixture = await CreateAsync(connected: true);
        await fixture.SetProviderAsync(IngressSettings.ProviderNone);
        fixture.Api.ResetCallCounts();

        await fixture.Controller.ReconcileAsync(await fixture.Apps.ListAppRecordsAsync());

        Assert.Equal(0, fixture.Api.GetConfigCalls);
        Assert.Equal(0, fixture.Api.PutConfigCalls);
    }

    [Fact]
    public async Task ReconcileAsync_PortMovedBackWhileOffline_ClearsTheDriftWithoutAnApiCall()
    {
        // A reassignment undone, or a rehoming fallback the next boot corrected: the route was never
        // actually wrong by the time anyone could act. Without clearing the marker the endpoint would
        // report origin_drifted forever while being perfectly in sync.
        var fixture = await CreateAsync(connected: true);
        await fixture.PublishAsync();
        await fixture.MovePortAsync("http://127.0.0.1:24500");
        fixture.Api.Failure = new CloudflareApiException(503, ["Cloudflare is unreachable."]);
        await fixture.Controller.ReconcileAsync(await fixture.Apps.ListAppRecordsAsync());
        Assert.NotNull((await fixture.Publications.GetAsync("com.example.media", "web.http"))!.DriftedServiceUrl);

        await fixture.MovePortAsync("http://127.0.0.1:8096");
        fixture.Api.Failure = null;
        fixture.Api.ResetCallCounts();
        await fixture.Controller.ReconcileAsync(await fixture.Apps.ListAppRecordsAsync());

        var publication = await fixture.Publications.GetAsync("com.example.media", "web.http");
        Assert.Null(publication!.DriftedServiceUrl);
        Assert.Equal("http://127.0.0.1:8096", publication.ServiceUrl);
        // Nothing had to be pushed — the route already named this port.
        Assert.Equal(0, fixture.Api.PutConfigCalls);
    }

    [Fact]
    public async Task ReconcileAsync_EndpointWithNoUrl_IsSkipped()
    {
        var fixture = await CreateAsync(connected: true);
        await fixture.PublishAsync();
        await fixture.MovePortAsync(null);
        fixture.Api.ResetCallCounts();

        await fixture.Controller.ReconcileAsync(await fixture.Apps.ListAppRecordsAsync());

        Assert.Equal(0, fixture.Api.PutConfigCalls);
        Assert.Null((await fixture.Publications.GetAsync("com.example.media", "web.http"))!.DriftedServiceUrl);
    }

    private async Task<Fixture> CreateAsync(bool connected)
    {
        Directory.CreateDirectory(root);
        var paths = new CoreDataPaths(
            root,
            Path.Combine(root, "core"),
            Path.Combine(root, "apps"),
            Path.Combine(root, "backups"),
            Path.Combine(root, "sources"),
            Path.Combine(root, "core", "auth"),
            Path.Combine(root, "core", "audit", "a.ndjson"));
        var api = new CountingApi();
        var integration = new CloudflareIntegrationStore(paths);
        var credentials = new CloudflareCredentialStore(paths);
        var publications = new CloudflarePublicationStore(paths);
        var reconciler = new CloudflarePublicationReconciler(api, publications, NullLogger<CloudflarePublicationReconciler>.Instance);
        var apps = new AppRegistryStore(paths);

        if (connected)
        {
            await credentials.SaveAsync(new CloudflareCredential("cf-token", "tok", "Hosty example.test", null));
            await integration.SaveAsync(new CloudflareIntegrationState(
                CloudflareConnectionStatuses.Connected, null, "acc", "Acct", "zone", "example.test", "example.test",
                "tunnel-123", "NL", "healthy", ConnectorLocality.Local, DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch));
        }

        var settings = new CoreSettingsService(new CoreSettingsStore(paths, NullLogger<CoreSettingsStore>.Instance));
        await settings.UpdateAsync(new Dictionary<string, string?> { ["HOSTY_INGRESS_PROVIDER"] = IngressSettings.ProviderCloudflareRemote });
        await apps.UpsertAppAsync(SeedApp("com.example.media", "http://127.0.0.1:8096"));

        var controller = new CloudflareRemoteIngressController(
            settings, integration, credentials, publications, reconciler, NullLogger<CloudflareRemoteIngressController>.Instance);
        return new Fixture(controller, api, apps, publications, integration, credentials, settings, reconciler);
    }

    private static AppRecord SeedApp(string id, string? endpointUrl)
        => new(
            Id: id, DisplayName: id, Description: null, Version: "1.0.0", Kind: "runtime", System: false, Source: "installed",
            ManifestPath: null, ManifestUrl: null, SelectedRuntime: "docker", OperationStatus: "installed",
            RuntimeState: "running", LastOperation: null, LastError: null, Capabilities: [],
            Settings: new Dictionary<string, AppSettingValue>(), StorageMappings: [], Dependencies: [],
            Endpoints: [new AppEndpointContract("web.http", "http", endpointUrl, Public: true, Service: "web", Port: "http")],
            InstalledAt: DateTimeOffset.UtcNow, UpdatedAt: DateTimeOffset.UtcNow);

    private sealed record Fixture(
        CloudflareRemoteIngressController Controller,
        CountingApi Api,
        AppRegistryStore Apps,
        CloudflarePublicationStore Publications,
        CloudflareIntegrationStore Integration,
        CloudflareCredentialStore Credentials,
        CoreSettingsService Settings,
        CloudflarePublicationReconciler Reconciler)
    {
        // Publishes through the reconciler directly: this suite is about reconciliation, not about the
        // publish endpoint's gating and notifications.
        public Task PublishAsync()
            => Reconciler.PublishAsync(
                "tok",
                new CloudflareIngressTarget("acc", "zone", "tunnel-123", "example.test"),
                "com.example.media",
                "web.http",
                "media",
                "http://127.0.0.1:8096");

        public async Task MovePortAsync(string? url)
        {
            var app = await Apps.GetAppAsync("com.example.media");
            await Apps.UpsertAppAsync(app! with
            {
                Endpoints = [new AppEndpointContract("web.http", "http", url, Public: true, Service: "web", Port: "http")],
            });
        }

        public Task DisconnectAsync() => Credentials.DeleteAsync();

        public Task SetProviderAsync(string provider)
            => Settings.UpdateAsync(new Dictionary<string, string?> { ["HOSTY_INGRESS_PROVIDER"] = provider });

        public string? RouteService(string hostname)
            => (Api.Config["ingress"] as JsonArray)?
                .OfType<JsonObject>()
                .FirstOrDefault(rule => string.Equals((string?)rule["hostname"], hostname, StringComparison.OrdinalIgnoreCase))
                is { } match
                ? (string?)match["service"]
                : null;
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, recursive: true);
            }
        }
        catch (IOException)
        {
        }
    }

    // The publication-suite double plus call counters, so "a reconcile that changes nothing makes no API
    // call" can be asserted rather than assumed.
    private sealed class CountingApi : ICloudflareApiClient
    {
        public JsonObject Config { get; private set; } = (JsonObject)JsonNode.Parse("""{"ingress":[{"service":"http_status:404"}],"warp-routing":{"enabled":true}}""")!;
        public List<CloudflareDnsRecord> Dns { get; } = [];
        public int GetConfigCalls { get; private set; }
        public int PutConfigCalls { get; private set; }
        public CloudflareApiException? Failure { get; set; }
        private int nextId = 1;

        public void ResetCallCounts()
        {
            GetConfigCalls = 0;
            PutConfigCalls = 0;
        }

        public Task<CloudflareTunnelConfigResult?> GetTunnelConfigurationAsync(string token, string accountId, string tunnelId, CancellationToken cancellationToken = default)
        {
            GetConfigCalls++;
            return Failure is not null
                ? throw Failure
                : Task.FromResult<CloudflareTunnelConfigResult?>(new CloudflareTunnelConfigResult(1, "cloudflare", (JsonObject)Config.DeepClone()));
        }

        public Task<CloudflareTunnelConfigResult?> PutTunnelConfigurationAsync(string token, string accountId, string tunnelId, JsonObject config, CancellationToken cancellationToken = default)
        {
            PutConfigCalls++;
            if (Failure is not null)
            {
                throw Failure;
            }

            Config = (JsonObject)config.DeepClone();
            return Task.FromResult<CloudflareTunnelConfigResult?>(new CloudflareTunnelConfigResult(2, "cloudflare", (JsonObject)Config.DeepClone()));
        }

        public Task<IReadOnlyList<CloudflareDnsRecord>> ListDnsRecordsAsync(string token, string zoneId, string name, CancellationToken cancellationToken = default)
            => Task.FromResult<IReadOnlyList<CloudflareDnsRecord>>(Dns.Where(record => string.Equals(record.Name, name, StringComparison.OrdinalIgnoreCase)).ToArray());

        public Task<CloudflareDnsRecord?> CreateCnameAsync(string token, string zoneId, string name, string content, bool proxied, CancellationToken cancellationToken = default)
        {
            var record = new CloudflareDnsRecord($"rec-{nextId++}", "CNAME", name, content, proxied, 1);
            Dns.Add(record);
            return Task.FromResult<CloudflareDnsRecord?>(record);
        }

        public Task<CloudflareDnsRecord?> UpdateCnameAsync(string token, string zoneId, string recordId, string name, string content, bool proxied, CancellationToken cancellationToken = default)
        {
            var record = new CloudflareDnsRecord(recordId, "CNAME", name, content, proxied, 1);
            Dns.RemoveAll(existing => string.Equals(existing.Id, recordId, StringComparison.Ordinal));
            Dns.Add(record);
            return Task.FromResult<CloudflareDnsRecord?>(record);
        }

        public Task DeleteDnsRecordAsync(string token, string zoneId, string recordId, CancellationToken cancellationToken = default)
        {
            Dns.RemoveAll(existing => string.Equals(existing.Id, recordId, StringComparison.Ordinal));
            return Task.CompletedTask;
        }

        public Task<IReadOnlyList<CloudflareAccount>> ListAccountsAsync(string token, CancellationToken cancellationToken = default) => Task.FromResult<IReadOnlyList<CloudflareAccount>>([]);
        public Task<IReadOnlyList<CloudflareZone>> ListZonesAsync(string token, CancellationToken cancellationToken = default) => Task.FromResult<IReadOnlyList<CloudflareZone>>([]);
        public Task<IReadOnlyList<CloudflareTunnel>> ListTunnelsAsync(string token, string accountId, CancellationToken cancellationToken = default) => Task.FromResult<IReadOnlyList<CloudflareTunnel>>([]);
        public Task<IReadOnlyList<CloudflareConnectorConn>> GetTunnelConnectionsAsync(string token, string accountId, string tunnelId, CancellationToken cancellationToken = default) => Task.FromResult<IReadOnlyList<CloudflareConnectorConn>>([]);
        public Task<CloudflareTokenStatus?> VerifyAccountTokenAsync(string token, string accountId, CancellationToken cancellationToken = default) => Task.FromResult<CloudflareTokenStatus?>(null);
        public Task<string?> GetEgressIpAsync(CancellationToken cancellationToken = default) => Task.FromResult<string?>(null);
    }
}
