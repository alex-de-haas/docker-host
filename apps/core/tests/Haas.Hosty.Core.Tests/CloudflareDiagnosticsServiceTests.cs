using System.Text.Json.Nodes;
using Haas.Hosty.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

// Publication is request-driven and never reconciled, so what Hosty believes it published and what
// Cloudflare actually serves can drift. These pin what the read-only comparison reports.
public sealed class CloudflareDiagnosticsServiceTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"hosty-cf-diag-{Guid.NewGuid():N}");

    private CoreDataPaths Paths => new(
        DataRoot: root,
        CoreRoot: Path.Combine(root, "core"),
        AppsRoot: Path.Combine(root, "apps"),
        BackupsRoot: Path.Combine(root, "backups"),
        SourcesRoot: Path.Combine(root, "sources"),
        AuthRoot: Path.Combine(root, "core", "auth"),
        AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));

    [Fact]
    public async Task InspectAsync_EverythingInPlace_ReportsOk()
    {
        var (service, api, _) = await CreateAsync();
        api.Config = Config("media.example.test");
        api.Dns.Add(new CloudflareDnsRecord("rec", "CNAME", "media.example.test", "tunnel-123.cfargotunnel.com", true, 1));

        var diagnostics = await service.InspectAsync();

        Assert.True(diagnostics.Checked);
        Assert.Equal(CloudflareDiagnosticStates.Ok, Assert.Single(diagnostics.Publications).State);
    }

    [Fact]
    public async Task InspectAsync_RouteDeletedFromTheDashboard_ReportsRouteMissing()
    {
        // The hostname now resolves to nothing, and nothing in the publish path would ever notice.
        var (service, api, _) = await CreateAsync();
        api.Config = Config();
        api.Dns.Add(new CloudflareDnsRecord("rec", "CNAME", "media.example.test", "tunnel-123.cfargotunnel.com", true, 1));

        var diagnostics = await service.InspectAsync();

        Assert.Equal(CloudflareDiagnosticStates.RouteMissing, Assert.Single(diagnostics.Publications).State);
    }

    [Fact]
    public async Task InspectAsync_RecordRepointedElsewhere_ReportsDnsForeign()
    {
        var (service, api, _) = await CreateAsync();
        api.Config = Config("media.example.test");
        api.Dns.Add(new CloudflareDnsRecord("rec", "CNAME", "media.example.test", "someone-else.example.com", true, 1));

        var diagnostics = await service.InspectAsync();

        Assert.Equal(CloudflareDiagnosticStates.DnsForeign, Assert.Single(diagnostics.Publications).State);
    }

    [Fact]
    public async Task InspectAsync_RecordRecreatedByHand_IsStillOk()
    {
        // Matched on content, not record id: an operator who recreated the record still has a working
        // setup, and calling that broken would send them chasing a problem they do not have.
        var (service, api, _) = await CreateAsync();
        api.Config = Config("media.example.test");
        api.Dns.Add(new CloudflareDnsRecord("different-id", "CNAME", "media.example.test", "tunnel-123.cfargotunnel.com", true, 1));

        Assert.Equal(CloudflareDiagnosticStates.Ok, Assert.Single((await service.InspectAsync()).Publications).State);
    }

    [Fact]
    public async Task InspectAsync_RecordDeleted_ReportsDnsMissing()
    {
        var (service, api, _) = await CreateAsync();
        api.Config = Config("media.example.test");

        Assert.Equal(CloudflareDiagnosticStates.DnsMissing, Assert.Single((await service.InspectAsync()).Publications).State);
    }

    [Fact]
    public async Task InspectAsync_AppUninstalledWithoutCleanup_ReportsAnOrphan()
    {
        var (service, api, apps) = await CreateAsync();
        api.Config = Config("media.example.test");
        await apps.RemoveAppAsync("com.example.media");

        Assert.Equal(CloudflareDiagnosticStates.AppMissing, Assert.Single((await service.InspectAsync()).Publications).State);
    }

    [Fact]
    public async Task InspectAsync_EndpointDroppedByAnUpdate_ReportsEndpointMissing()
    {
        // The app is still installed, so an app-id-only check would call this healthy while the hostname
        // fronts an endpoint the app no longer serves.
        var (service, api, apps) = await CreateAsync();
        api.Config = Config("media.example.test");
        api.Dns.Add(new CloudflareDnsRecord("rec", "CNAME", "media.example.test", "tunnel-123.cfargotunnel.com", true, 1));
        await apps.UpsertAppAsync((await apps.GetAppAsync("com.example.media"))! with { Endpoints = [] });

        Assert.Equal(CloudflareDiagnosticStates.EndpointMissing, Assert.Single((await service.InspectAsync()).Publications).State);
    }

    [Fact]
    public async Task InspectAsync_RouteLeftOnAnOldPort_ReportsRouteStale()
    {
        // A port reassignment moves the endpoint; the tunnel route keeps forwarding to the old port until
        // something re-publishes it.
        var (service, api, apps) = await CreateAsync();
        api.Config = Config("media.example.test");
        api.Dns.Add(new CloudflareDnsRecord("rec", "CNAME", "media.example.test", "tunnel-123.cfargotunnel.com", true, 1));
        await apps.UpsertAppAsync((await apps.GetAppAsync("com.example.media"))! with
        {
            Endpoints = [new AppEndpointContract("web.http", "http", "http://127.0.0.1:3999", Public: true, Service: "web", Port: "http")],
        });

        Assert.Equal(CloudflareDiagnosticStates.RouteStale, Assert.Single((await service.InspectAsync()).Publications).State);
    }

    [Fact]
    public async Task InspectAsync_AfterAProviderSwitch_StillListsWhatIsPublished()
    {
        // Switching the provider away retracts nothing, so an operator who reads "ingress is off" must
        // still be able to see what remains exposed.
        var (service, _, _) = await CreateAsync(provider: IngressSettings.ProviderNone);

        var diagnostics = await service.InspectAsync();

        Assert.False(diagnostics.Checked);
        var publication = Assert.Single(diagnostics.Publications);
        Assert.Equal("media.example.test", publication.Hostname);
        Assert.Equal(CloudflareDiagnosticStates.Unknown, publication.State);
    }

    [Fact]
    public async Task InspectAsync_WithoutAConnection_StillAnswersTheMissingOriginHalf()
    {
        // Useful precisely to an operator on provider "none": a public endpoint reachable from nowhere.
        var (service, _, _) = await CreateAsync(connected: false, publish: false);

        var diagnostics = await service.InspectAsync();

        Assert.False(diagnostics.Checked);
        Assert.Empty(diagnostics.Publications);
        var unpublished = Assert.Single(diagnostics.UnpublishedEndpoints);
        Assert.Equal("com.example.media", unpublished.AppId);
        Assert.Equal("web.http", unpublished.EndpointKey);
    }

    [Fact]
    public async Task InspectAsync_APublishedOrEnvSetEndpointIsNotReportedAsMissing()
    {
        var (service, api, apps) = await CreateAsync();
        api.Config = Config("media.example.test");

        // Published: not missing.
        Assert.Empty((await service.InspectAsync()).UnpublishedEndpoints);

        // Operator-set origin with no publication: also not missing.
        await apps.RemoveAppAsync("com.example.media");
        await apps.UpsertAppAsync(SeedApp("com.example.other", new Dictionary<string, AppSettingValue>(StringComparer.Ordinal)
        {
            ["HOSTY_PUBLIC_ORIGIN_WEB_HTTP"] = new("HOSTY_PUBLIC_ORIGIN_WEB_HTTP", "url", "https://media.example.com", Secret: false),
        }));

        Assert.Empty((await service.InspectAsync()).UnpublishedEndpoints);
    }

    // Core's own hostname. Nothing in Hosty publishes it — it is not an app — so every verdict here ends in
    // something the operator does by hand, and the recipe is what these pin.
    [Fact]
    public async Task InspectAsync_CoreRoutedAndResolving_ReportsOk()
    {
        var (service, api, _) = await CreateAsync(publish: false);
        api.Config = Config("core.example.test");
        api.Dns.Add(new CloudflareDnsRecord("rec", "CNAME", "core.example.test", "tunnel-123.cfargotunnel.com", true, 1));

        var core = (await service.InspectAsync()).Core;

        Assert.Equal(CloudflareDiagnosticStates.Ok, core.State);
        Assert.Equal("core.example.test", core.Hostname);
    }

    [Fact]
    public async Task InspectAsync_CoreWithoutAPublicOrigin_ReportsNotConfiguredWithTheFullRecipe()
    {
        // The case the hint exists for: Core answers on loopback, so the operator cannot guess either half
        // of what to create — and publishing an app never creates it for them.
        var (service, api, _) = await CreateAsync(publish: false, corePublicOrigin: null);
        api.Config = Config();

        var core = (await service.InspectAsync()).Core;

        Assert.Equal(CloudflareDiagnosticStates.NotConfigured, core.State);
        Assert.Null(core.Hostname);
        Assert.Equal("tunnel-123.cfargotunnel.com", core.ExpectedDnsContent);
        Assert.Equal("http://localhost:7070", core.ExpectedService);
    }

    [Fact]
    public async Task InspectAsync_CoreConfiguredButUnrouted_ReportsRouteMissing()
    {
        var (service, api, _) = await CreateAsync(publish: false);
        api.Config = Config();
        api.Dns.Add(new CloudflareDnsRecord("rec", "CNAME", "core.example.test", "tunnel-123.cfargotunnel.com", true, 1));

        Assert.Equal(CloudflareDiagnosticStates.RouteMissing, (await service.InspectAsync()).Core.State);
    }

    [Fact]
    public async Task InspectAsync_CoreServedOutsideTheZone_ReportsExternal()
    {
        // An operator's own reverse proxy in front of Core is a legitimate setup, and this tunnel has
        // nothing to say about it. Reporting it as broken would send them chasing a problem they do not have.
        var (service, api, _) = await CreateAsync(publish: false, corePublicOrigin: "https://hosty.elsewhere.test");
        api.Config = Config();

        var core = (await service.InspectAsync()).Core;

        Assert.Equal(CloudflareDiagnosticStates.External, core.State);
        Assert.Equal("hosty.elsewhere.test", core.Hostname);
    }

    [Fact]
    public async Task InspectAsync_WithoutAConnection_StillReportsCoreHasNoPublicOrigin()
    {
        // The half that needs no Cloudflare at all: whether Core has an address is local knowledge, and it
        // is the first thing an operator setting this up gets wrong.
        var (service, _, _) = await CreateAsync(connected: false, publish: false, corePublicOrigin: null);

        var diagnostics = await service.InspectAsync();

        Assert.False(diagnostics.Checked);
        Assert.Equal(CloudflareDiagnosticStates.NotConfigured, diagnostics.Core.State);
        Assert.Null(diagnostics.Core.ExpectedDnsContent);
    }

    private async Task<(CloudflareDiagnosticsService, StatefulApi, AppRegistryStore)> CreateAsync(
        bool connected = true,
        bool publish = true,
        string provider = IngressSettings.ProviderCloudflareRemote,
        string? corePublicOrigin = "https://core.example.test")
    {
        Directory.CreateDirectory(root);
        var paths = Paths;
        var api = new StatefulApi();
        var integration = new CloudflareIntegrationStore(paths);
        var credentials = new CloudflareCredentialStore(paths);
        var publications = new CloudflarePublicationStore(paths);
        var apps = new AppRegistryStore(paths);
        var settings = new CoreSettingsService(new CoreSettingsStore(paths, NullLogger<CoreSettingsStore>.Instance));
        await settings.UpdateAsync(new Dictionary<string, string?>
        {
            ["HOSTY_INGRESS_PROVIDER"] = provider,
        });

        if (connected)
        {
            await credentials.SaveAsync(new CloudflareCredential("cf-token", "tok", "Hosty example.test", null));
            await integration.SaveAsync(new CloudflareIntegrationState(
                CloudflareConnectionStatuses.Connected, null, "acc", "Acct", "zone", "example.test", "example.test",
                "tunnel-123", "NL", "healthy", ConnectorLocality.Local, DateTimeOffset.UnixEpoch, DateTimeOffset.UnixEpoch));
        }

        await apps.UpsertAppAsync(SeedApp("com.example.media", new Dictionary<string, AppSettingValue>(StringComparer.Ordinal)));
        if (publish)
        {
            await publications.UpsertAsync(new CloudflarePublication(
                "com.example.media", "web.http", "media", "media.example.test", "rec", "http://127.0.0.1:3000",
                CloudflareOwnershipStates.Owned, DateTimeOffset.UnixEpoch));
        }

        var config = new HostyCoreRuntimeConfig(
            DataRoot: root,
            RunDirectory: Path.Combine(root, "run"),
            ControlDiscoveryPath: Path.Combine(root, "run", "control.json"),
            CorePort: 7070,
            ListenUrl: "http://localhost:7070",
            CorePublicOrigin: corePublicOrigin,
            RuntimePublicHost: "127.0.0.1",
            ShellSourceOverridePath: null,
            ShellAutostart: false);

        var service = new CloudflareDiagnosticsService(
            settings, integration, credentials, publications, apps, config, api, NullLogger<CloudflareDiagnosticsService>.Instance);
        return (service, api, apps);
    }

    private static JsonObject Config(params string[] hostnames)
    {
        var ingress = new JsonArray();
        foreach (var hostname in hostnames)
        {
            ingress.Add(new JsonObject { ["hostname"] = hostname, ["service"] = "http://127.0.0.1:3000" });
        }

        ingress.Add(new JsonObject { ["service"] = "http_status:404" });
        return new JsonObject { ["ingress"] = ingress };
    }

    private static AppRecord SeedApp(string id, Dictionary<string, AppSettingValue> settings)
        => new(
            Id: id, DisplayName: id, Description: null, Version: "1.0.0", Kind: "runtime", System: false, Source: "installed",
            ManifestPath: null, ManifestUrl: null, SelectedRuntime: "docker", OperationStatus: "installed",
            RuntimeState: "stopped", LastOperation: null, LastError: null, Capabilities: [],
            Settings: settings, StorageMappings: [], Dependencies: [],
            Endpoints: [new AppEndpointContract("web.http", "http", "http://127.0.0.1:3000", Public: true, Service: "web", Port: "http")],
            InstalledAt: DateTimeOffset.UnixEpoch, UpdatedAt: DateTimeOffset.UnixEpoch);

    private sealed class StatefulApi : ICloudflareApiClient
    {
        public JsonObject Config { get; set; } = new() { ["ingress"] = new JsonArray() };
        public List<CloudflareDnsRecord> Dns { get; } = [];

        public Task<CloudflareTunnelConfigResult?> GetTunnelConfigurationAsync(string token, string accountId, string tunnelId, CancellationToken cancellationToken = default)
            => Task.FromResult<CloudflareTunnelConfigResult?>(new CloudflareTunnelConfigResult(1, "cloudflare", (JsonObject)Config.DeepClone()));

        public Task<IReadOnlyList<CloudflareDnsRecord>> ListDnsRecordsAsync(string token, string zoneId, string name, CancellationToken cancellationToken = default)
            => Task.FromResult<IReadOnlyList<CloudflareDnsRecord>>(Dns.Where(record => string.Equals(record.Name, name, StringComparison.OrdinalIgnoreCase)).ToArray());

        public Task<CloudflareTunnelConfigResult?> PutTunnelConfigurationAsync(string token, string accountId, string tunnelId, JsonObject config, CancellationToken cancellationToken = default)
            => throw new NotSupportedException("Diagnostics never mutate.");

        public Task<CloudflareDnsRecord?> CreateCnameAsync(string token, string zoneId, string name, string content, bool proxied, CancellationToken cancellationToken = default)
            => throw new NotSupportedException("Diagnostics never mutate.");

        public Task<CloudflareDnsRecord?> UpdateCnameAsync(string token, string zoneId, string recordId, string name, string content, bool proxied, CancellationToken cancellationToken = default)
            => throw new NotSupportedException("Diagnostics never mutate.");

        public Task DeleteDnsRecordAsync(string token, string zoneId, string recordId, CancellationToken cancellationToken = default)
            => throw new NotSupportedException("Diagnostics never mutate.");

        public Task<IReadOnlyList<CloudflareAccount>> ListAccountsAsync(string token, CancellationToken cancellationToken = default) => Task.FromResult<IReadOnlyList<CloudflareAccount>>([]);
        public Task<IReadOnlyList<CloudflareZone>> ListZonesAsync(string token, CancellationToken cancellationToken = default) => Task.FromResult<IReadOnlyList<CloudflareZone>>([]);
        public Task<IReadOnlyList<CloudflareTunnel>> ListTunnelsAsync(string token, string accountId, CancellationToken cancellationToken = default) => Task.FromResult<IReadOnlyList<CloudflareTunnel>>([]);
        public Task<IReadOnlyList<CloudflareConnectorConn>> GetTunnelConnectionsAsync(string token, string accountId, string tunnelId, CancellationToken cancellationToken = default) => Task.FromResult<IReadOnlyList<CloudflareConnectorConn>>([]);
        public Task<CloudflareTokenStatus?> VerifyAccountTokenAsync(string token, string accountId, CancellationToken cancellationToken = default) => Task.FromResult<CloudflareTokenStatus?>(null);
        public Task<string?> GetEgressIpAsync(CancellationToken cancellationToken = default) => Task.FromResult<string?>(null);
    }

    public void Dispose()
    {
        if (Directory.Exists(root))
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
