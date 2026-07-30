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

        Assert.Equal("media.example.test", result.Hostname);
        Assert.Equal("https://media.example.test", result.PublicOrigin);
        Assert.True(result.RestartRequired); // app is running
        // The public origin was written into the app's managed setting.
        var app = await apps.GetAppAsync("com.example.media");
        var setting = app!.Settings[PublicOriginSettings.BuildSettingKey("web.http")];
        Assert.Equal("https://media.example.test", setting.Value);
        // The tunnel route + DNS were synced.
        Assert.Contains("media.example.test", CloudflareTunnelConfigPatcher.IngressHostnames(api.Config));
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
        Assert.DoesNotContain("media.example.test", CloudflareTunnelConfigPatcher.IngressHostnames(api.Config));
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

    [Fact]
    public async Task PublishAsync_WhenProviderIsNotCloudflareRemote_Throws()
    {
        // Connected, but the operator left ingress on another provider: publishing would hand ownership of
        // HOSTY_PUBLIC_ORIGIN_* to a surface that is not in charge of it.
        var (service, _) = await CreateAsync(new StatefulApi(), connected: true, appRunning: false, provider: IngressSettings.ProviderCloudflared);

        var error = await Assert.ThrowsAsync<CloudflareConnectionException>(() => service.PublishAsync("com.example.media", "web.http", "media"));
        Assert.Equal("cloudflare_provider_inactive", error.Code);
    }

    [Fact]
    public async Task PublishAsync_WhenTheTokenStoppedWorking_RecordsReconnectRequired()
    {
        // Cloudflare tells nobody a token was revoked; it is found out on the next call that uses it.
        var api = new StatefulApi { Failure = new CloudflareApiException(401, ["Invalid API Token"]) };
        var (service, _) = await CreateConnectedAsync(api, appRunning: false);

        var error = await Assert.ThrowsAsync<CloudflareConnectionException>(
            () => service.PublishAsync("com.example.media", "web.http", "media"));
        Assert.Equal("cloudflare_reconnect_required", error.Code);

        // Recorded, so the next attempt says the same thing without another round trip — and nothing was
        // deleted, so reconnecting a fresh token restores the whole setup.
        api.Failure = null;
        var again = await Assert.ThrowsAsync<CloudflareConnectionException>(
            () => service.PublishAsync("com.example.media", "web.http", "media"));
        Assert.Equal("cloudflare_reconnect_required", again.Code);
    }

    [Fact]
    public async Task PublishAsync_WhenAPermissionWasRemoved_AlsoRecordsReconnectRequired()
    {
        var api = new StatefulApi { Failure = new CloudflareApiException(403, ["Unauthorized"]) };
        var (service, _) = await CreateConnectedAsync(api, appRunning: false);

        var error = await Assert.ThrowsAsync<CloudflareConnectionException>(
            () => service.PublishAsync("com.example.media", "web.http", "media"));

        Assert.Equal("cloudflare_reconnect_required", error.Code);
    }

    [Fact]
    public async Task ListForAppAsync_ReportsTheStateAnOperatorAsksAbout()
    {
        var api = new StatefulApi();
        var (service, apps) = await CreateConnectedAsync(api, appRunning: true);
        await service.PublishAsync("com.example.media", "web.http", "media");

        // Published onto a running app: the process is still serving the old origin.
        var published = Assert.Single((await service.ListForAppAsync("com.example.media")).Publications);
        Assert.Equal(CloudflarePublicationStates.RestartRequired, published.State);

        // Starting the app is what clears it — that start reads the current value.
        await service.ClearPendingRestartAsync("com.example.media");
        Assert.Equal(
            CloudflarePublicationStates.Active,
            Assert.Single((await service.ListForAppAsync("com.example.media")).Publications).State);

        // A stopped app is not "restart required": its next start picks the origin up.
        await apps.UpsertAppAsync((await apps.GetAppAsync("com.example.media"))! with { RuntimeState = "stopped" });
        Assert.Equal(
            CloudflarePublicationStates.AppStopped,
            Assert.Single((await service.ListForAppAsync("com.example.media")).Publications).State);
    }

    [Fact]
    public async Task ListForAppAsync_WhenTheConnectionNeedsReconnecting_ReportsError()
    {
        var api = new StatefulApi();
        var (service, _) = await CreateConnectedAsync(api, appRunning: false);
        await service.PublishAsync("com.example.media", "web.http", "media");

        api.Failure = new CloudflareApiException(401, ["Invalid API Token"]);
        await Assert.ThrowsAsync<CloudflareConnectionException>(() => service.UnpublishAsync("com.example.media", "web.http"));

        // The route and the record are still there; what is gone is Hosty's ability to manage them.
        Assert.Equal(
            CloudflarePublicationStates.Error,
            Assert.Single((await service.ListForAppAsync("com.example.media")).Publications).State);
    }

    [Fact]
    public async Task RemoveAllForAppAsync_RemovesRouteAndRecord()
    {
        var api = new StatefulApi();
        var (service, _) = await CreateConnectedAsync(api, appRunning: false);
        await service.PublishAsync("com.example.media", "web.http", "media");

        var removed = await service.RemoveAllForAppAsync("com.example.media");

        Assert.Equal(1, removed);
        Assert.Empty(api.Dns);
        Assert.DoesNotContain("media.example.test", CloudflareTunnelConfigPatcher.IngressHostnames(api.Config));
        Assert.Empty((await service.ListForAppAsync("com.example.media")).Publications);
    }

    [Fact]
    public async Task RemoveAllForAppAsync_WhenCloudflareFails_KeepsThePublicationForARetry()
    {
        // The stored entry is the only remaining pointer to what Hosty created; dropping it would turn a
        // retryable leftover into a permanent orphan.
        var api = new StatefulApi();
        var (service, _) = await CreateConnectedAsync(api, appRunning: false);
        await service.PublishAsync("com.example.media", "web.http", "media");
        api.Failure = new CloudflareApiException(500, ["Internal error"]);

        var removed = await service.RemoveAllForAppAsync("com.example.media");

        Assert.Equal(0, removed);
        Assert.Single((await service.ListForAppAsync("com.example.media")).Publications);
    }

    [Fact]
    public async Task RemoveOrphanedAsync_RemovesOnlyEndpointsTheAppNoLongerPublishes()
    {
        var api = new StatefulApi();
        var (service, _) = await CreateConnectedAsync(api, appRunning: false);
        await service.PublishAsync("com.example.media", "web.http", "media");

        // Still declared: nothing happens.
        Assert.Equal(0, await service.RemoveOrphanedAsync("com.example.media", ["web.http"]));
        Assert.Single((await service.ListForAppAsync("com.example.media")).Publications);

        // Gone from the manifest: the hostname can never serve it again.
        Assert.Equal(1, await service.RemoveOrphanedAsync("com.example.media", ["other.http"]));
        Assert.Empty((await service.ListForAppAsync("com.example.media")).Publications);
        Assert.Empty(api.Dns);
    }

    [Fact]
    public async Task RemoveAllAsync_ReportsWhatItCouldNotRemove()
    {
        // Disconnect-with-Remove uses the count to decide whether to keep the connection: the token is the
        // only way to finish the job.
        var api = new StatefulApi();
        var (service, _) = await CreateConnectedAsync(api, appRunning: false);
        await service.PublishAsync("com.example.media", "web.http", "media");
        api.Failure = new CloudflareApiException(500, ["Internal error"]);

        Assert.Equal(1, await service.RemoveAllAsync());

        api.Failure = null;
        Assert.Equal(0, await service.RemoveAllAsync());
    }

    private async Task<(CloudflarePublicationService, AppRegistryStore)> CreateConnectedAsync(StatefulApi api, bool appRunning)
        => await CreateAsync(api, connected: true, appRunning);

    private async Task<(CloudflarePublicationService, AppRegistryStore)> CreateAsync(
        StatefulApi api,
        bool connected,
        bool appRunning,
        string provider = IngressSettings.ProviderCloudflareRemote)
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
            await credentials.SaveAsync(new CloudflareCredential("cf-token", "tok", "Hosty example.test", null));
            await integration.SaveAsync(new CloudflareIntegrationState(
                CloudflareConnectionStatuses.Connected, null, "acc", "Acct", "zone", "example.test", "example.test",
                "tunnel-123", "NL", "healthy", ConnectorLocality.Local, DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch));
        }

        var settings = new CoreSettingsService(new CoreSettingsStore(paths, NullLogger<CoreSettingsStore>.Instance));
        await settings.UpdateAsync(new Dictionary<string, string?> { ["HOSTY_INGRESS_PROVIDER"] = provider });

        var connection = new CloudflareConnectionService(
            api, credentials, integration, NullLogger<CloudflareConnectionService>.Instance);

        await apps.UpsertAppAsync(SeedApp("com.example.media", appRunning));
        return (new CloudflarePublicationService(settings, integration, credentials, connection, reconciler, publications, apps, NullLogger<CloudflarePublicationService>.Instance), apps);
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

        // Set to make every tunnel/DNS call fail the way a revoked or permission-reduced token does.
        public CloudflareApiException? Failure { get; set; }

        public Task<CloudflareTunnelConfigResult?> GetTunnelConfigurationAsync(string token, string accountId, string tunnelId, CancellationToken cancellationToken = default)
            => Failure is not null
                ? throw Failure
                : Task.FromResult<CloudflareTunnelConfigResult?>(new CloudflareTunnelConfigResult(1, "cloudflare", (JsonObject)Config.DeepClone()));

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
