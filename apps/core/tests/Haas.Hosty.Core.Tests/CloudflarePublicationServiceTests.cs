using System.Text.Json.Nodes;
using Haas.Hosty.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed class CloudflarePublicationServiceTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"hosty-cf-pubsvc-{Guid.NewGuid():N}");

    [Fact]
    public async Task PublishAsync_SyncsRouteAndDns_WritesPublicOriginSetting_AndFlagsRestart()
    {
        var api = new StatefulApi();
        var (service, apps) = await CreateConnectedAsync(api, appRunning: true);

        var result = await service.PublishAsync("com.example.media", "web.http", "media");

        Assert.Equal("media.zayats.io", result.Hostname);
        Assert.Equal("https://media.zayats.io", result.PublicOrigin);
        Assert.True(result.RestartRequired); // app is running
        // The public origin was written into the app's managed setting.
        var app = await apps.GetAppAsync("com.example.media");
        var setting = app!.Settings[PublicOriginSettings.BuildSettingKey("web.http")];
        Assert.Equal("https://media.zayats.io", setting.Value);
        // The tunnel route + DNS were synced.
        Assert.Contains("media.zayats.io", CloudflareTunnelConfigPatcher.IngressHostnames(api.Config));
        Assert.Single(api.Dns);
    }

    [Fact]
    public async Task UnpublishAsync_RemovesRouteDnsAndSetting()
    {
        var api = new StatefulApi();
        var (service, apps) = await CreateConnectedAsync(api, appRunning: false);
        await service.PublishAsync("com.example.media", "web.http", "media");

        var result = await service.UnpublishAsync("com.example.media", "web.http");

        Assert.False(result.RestartRequired); // app stopped
        var app = await apps.GetAppAsync("com.example.media");
        Assert.False(app!.Settings.ContainsKey(PublicOriginSettings.BuildSettingKey("web.http")));
        Assert.DoesNotContain("media.zayats.io", CloudflareTunnelConfigPatcher.IngressHostnames(api.Config));
        Assert.Empty(api.Dns);
    }

    [Fact]
    public async Task PublishAsync_WhenNotConnected_Throws()
    {
        var (service, _) = await CreateAsync(new StatefulApi(), connected: false, appRunning: false);
        var error = await Assert.ThrowsAsync<CloudflareConnectionException>(() => service.PublishAsync("com.example.media", "web.http", "media"));
        Assert.Equal("cloudflare_not_connected", error.Code);
    }

    [Fact]
    public async Task PublishAsync_EndpointWithoutLocalUrl_Throws()
    {
        var api = new StatefulApi();
        var (service, apps) = await CreateConnectedAsync(api, appRunning: false);
        // An endpoint with no reserved local URL yet.
        await apps.UpsertAppAsync((await apps.GetAppAsync("com.example.media"))! with
        {
            Endpoints = [new AppEndpointContract("web.http", "http", null, Public: true, Service: "web", Port: "http")],
        });

        var error = await Assert.ThrowsAsync<CloudflareConnectionException>(() => service.PublishAsync("com.example.media", "web.http", "media"));
        Assert.Equal("cloudflare_endpoint_no_local_url", error.Code);
    }

    private async Task<(CloudflarePublicationService, AppRegistryStore)> CreateConnectedAsync(StatefulApi api, bool appRunning)
        => await CreateAsync(api, connected: true, appRunning);

    private async Task<(CloudflarePublicationService, AppRegistryStore)> CreateAsync(StatefulApi api, bool connected, bool appRunning)
    {
        Directory.CreateDirectory(root);
        var paths = new CoreDataPaths(root, Path.Combine(root, "core"), Path.Combine(root, "apps"), Path.Combine(root, "backups"), Path.Combine(root, "sources"), Path.Combine(root, "core", "auth"), Path.Combine(root, "core", "audit", "a.ndjson"));
        var integration = new CloudflareIntegrationStore(paths);
        var credentials = new CloudflareCredentialStore(paths);
        var publications = new CloudflarePublicationStore(paths);
        var reconciler = new CloudflarePublicationReconciler(api, publications, NullLogger<CloudflarePublicationReconciler>.Instance);
        var apps = new AppRegistryStore(paths);

        if (connected)
        {
            await credentials.SaveAsync(new CloudflareCredential("cf-token", "tok", "Hosty zayats.io", null));
            await integration.SaveAsync(new CloudflareIntegrationState(
                CloudflareConnectionStatuses.Connected, null, "acc", "Acct", "zone", "zayats.io", "zayats.io",
                "tunnel-123", "NL", "healthy", ConnectorLocality.Local, DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch));
        }

        await apps.UpsertAppAsync(SeedApp("com.example.media", appRunning));
        return (new CloudflarePublicationService(integration, credentials, reconciler, publications, apps), apps);
    }

    private static AppRecord SeedApp(string id, bool running)
        => new(
            Id: id, DisplayName: id, Description: null, Version: "1.0.0", Kind: "runtime", System: false, Source: "installed",
            ManifestPath: null, ManifestUrl: null, SelectedRuntime: "docker", OperationStatus: "installed",
            RuntimeState: running ? "running" : "stopped", LastOperation: null, LastError: null, Capabilities: [],
            Settings: new Dictionary<string, AppSettingValue>(), StorageMappings: [], Dependencies: [],
            Endpoints: [new AppEndpointContract("web.http", "http", "http://127.0.0.1:8096", Public: true, Service: "web", Port: "http")],
            InstalledAt: DateTimeOffset.UtcNow, UpdatedAt: DateTimeOffset.UtcNow);

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

    private sealed class StatefulApi : ICloudflareApiClient
    {
        public JsonObject Config { get; private set; } = (JsonObject)JsonNode.Parse("""{"ingress":[{"service":"http_status:404"}],"warp-routing":{"enabled":true}}""")!;
        public List<CloudflareDnsRecord> Dns { get; } = [];
        private int nextId = 1;

        public Task<CloudflareTunnelConfigResult?> GetTunnelConfigurationAsync(string token, string accountId, string tunnelId, CancellationToken cancellationToken = default)
            => Task.FromResult<CloudflareTunnelConfigResult?>(new CloudflareTunnelConfigResult(1, "cloudflare", (JsonObject)Config.DeepClone()));

        public Task<CloudflareTunnelConfigResult?> PutTunnelConfigurationAsync(string token, string accountId, string tunnelId, JsonObject config, CancellationToken cancellationToken = default)
        {
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
            => Task.FromResult<CloudflareDnsRecord?>(new CloudflareDnsRecord(recordId, "CNAME", name, content, proxied, 1));

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
