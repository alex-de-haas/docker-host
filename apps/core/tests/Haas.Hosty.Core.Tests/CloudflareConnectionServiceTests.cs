using Haas.Hosty.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed class CloudflareConnectionServiceTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"hosty-cf-conn-{Guid.NewGuid():N}");

    [Fact]
    public async Task ConnectAsync_AutoSelectsSingleHealthyRemoteTunnel_PersistsAndMasksToken()
    {
        var api = new FakeApi
        {
            Tunnels =
            [
                new CloudflareTunnel("t-remote", "NL_HOME_SERVER", "healthy", "cloudflare", true),
                new CloudflareTunnel("t-local", "hosty", "inactive", null, false),
            ],
            Conns = [new CloudflareConnectorConn("2001:db8::1", "ams13", "2026.7.1", false)],
            Egress = "2001:db8::1",
        };
        var (service, credentials, integration) = Create(api);

        var status = await service.ConnectAsync("cf-secret-token-value");

        Assert.Equal(CloudflareConnectionStatuses.Connected, status.Status);
        Assert.Equal("example.test", status.BaseDomain);
        Assert.Equal("NL_HOME_SERVER", status.TunnelName);
        Assert.Equal(ConnectorLocality.Local, status.Locality); // egress == connector IP
        Assert.True(status.Token.Present);
        Assert.NotEqual("cf-secret-token-value", status.Token.Masked); // never the raw token
        // Persisted: raw token in the private store, non-secret state in the integration store.
        Assert.Equal("cf-secret-token-value", (await credentials.LoadAsync())!.Token);
        Assert.Equal("t-remote", (await integration.LoadAsync())!.TunnelId);
    }

    [Fact]
    public async Task ConnectAsync_NoHealthyRemoteTunnel_Throws()
    {
        var api = new FakeApi { Tunnels = [new CloudflareTunnel("t", "hosty", "inactive", null, false)] };
        var (service, _, _) = Create(api);

        var error = await Assert.ThrowsAsync<CloudflareConnectionException>(() => service.ConnectAsync("t"));
        Assert.Equal("cloudflare_no_healthy_tunnel", error.Code);
    }

    [Fact]
    public async Task ConnectAsync_MultipleHealthyRemoteTunnels_ReportsAmbiguous()
    {
        var api = new FakeApi
        {
            Tunnels =
            [
                new CloudflareTunnel("a", "A", "healthy", "cloudflare", true),
                new CloudflareTunnel("b", "B", "healthy", "cloudflare", true),
            ],
        };
        var (service, _, _) = Create(api);

        var error = await Assert.ThrowsAsync<CloudflareConnectionException>(() => service.ConnectAsync("t"));
        Assert.Equal("cloudflare_tunnel_ambiguous", error.Code);
    }

    [Fact]
    public async Task ConnectAsync_InvalidToken_ClassifiesAs401()
    {
        var api = new FakeApi { AccountsError = new CloudflareApiException(401, ["Invalid API Token"]) };
        var (service, _, _) = Create(api);

        var error = await Assert.ThrowsAsync<CloudflareConnectionException>(() => service.ConnectAsync("bad"));
        Assert.Equal("cloudflare_token_invalid", error.Code);
    }

    [Fact]
    public async Task ConnectAsync_MissingPermission_ClassifiesAs403()
    {
        var api = new FakeApi { AccountsError = new CloudflareApiException(403, ["Unauthorized to access requested resource"]) };
        var (service, _, _) = Create(api);

        var error = await Assert.ThrowsAsync<CloudflareConnectionException>(() => service.ConnectAsync("scoped"));
        Assert.Equal("cloudflare_token_forbidden", error.Code);
    }

    [Fact]
    public async Task StatusAsync_WhenNeverConnected_IsDisconnected()
    {
        var (service, _, _) = Create(new FakeApi());
        var status = await service.StatusAsync();
        Assert.Equal(CloudflareConnectionStatuses.Disconnected, status.Status);
        Assert.False(status.Token.Present);
    }

    [Fact]
    public async Task DisconnectAsync_DeletesTokenAndState()
    {
        var (service, credentials, integration) = Create(new FakeApi());
        await service.ConnectAsync("cf-token");

        var status = await service.DisconnectAsync();

        Assert.Equal(CloudflareConnectionStatuses.Disconnected, status.Status);
        Assert.Null(await credentials.LoadAsync());
        Assert.Null(await integration.LoadAsync());
    }

    private (CloudflareConnectionService, CloudflareCredentialStore, CloudflareIntegrationStore) Create(FakeApi api)
    {
        Directory.CreateDirectory(root);
        var paths = new CoreDataPaths(
            DataRoot: root,
            CoreRoot: Path.Combine(root, "core"),
            AppsRoot: Path.Combine(root, "apps"),
            BackupsRoot: Path.Combine(root, "backups"),
            SourcesRoot: Path.Combine(root, "sources"),
            AuthRoot: Path.Combine(root, "core", "auth"),
            AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));
        var credentials = new CloudflareCredentialStore(paths);
        var integration = new CloudflareIntegrationStore(paths);
        var service = new CloudflareConnectionService(api, credentials, integration, NullLogger<CloudflareConnectionService>.Instance);
        return (service, credentials, integration);
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

    private sealed class FakeApi : ICloudflareApiClient
    {
        public IReadOnlyList<CloudflareAccount> Accounts { get; init; } = [new("acc", "Acct")];
        public IReadOnlyList<CloudflareZone> Zones { get; init; } = [new("z1", "example.test", "active")];
        public IReadOnlyList<CloudflareTunnel> Tunnels { get; init; } = [new("t", "NL_HOME_SERVER", "healthy", "cloudflare", true)];
        public IReadOnlyList<CloudflareConnectorConn> Conns { get; init; } = [];
        public string? Egress { get; init; }
        public CloudflareApiException? AccountsError { get; init; }

        public Task<IReadOnlyList<CloudflareAccount>> ListAccountsAsync(string token, CancellationToken cancellationToken = default)
            => AccountsError is not null ? throw AccountsError : Task.FromResult(Accounts);

        public Task<IReadOnlyList<CloudflareZone>> ListZonesAsync(string token, CancellationToken cancellationToken = default)
            => Task.FromResult(Zones);

        public Task<IReadOnlyList<CloudflareTunnel>> ListTunnelsAsync(string token, string accountId, CancellationToken cancellationToken = default)
            => Task.FromResult(Tunnels);

        public Task<IReadOnlyList<CloudflareConnectorConn>> GetTunnelConnectionsAsync(string token, string accountId, string tunnelId, CancellationToken cancellationToken = default)
            => Task.FromResult(Conns);

        public Task<CloudflareTokenStatus?> VerifyAccountTokenAsync(string token, string accountId, CancellationToken cancellationToken = default)
            => Task.FromResult<CloudflareTokenStatus?>(new CloudflareTokenStatus("tok-id", "active", null, null));

        public Task<string?> GetEgressIpAsync(CancellationToken cancellationToken = default)
            => Task.FromResult(Egress);

        public Task<CloudflareTunnelConfigResult?> GetTunnelConfigurationAsync(string token, string accountId, string tunnelId, CancellationToken cancellationToken = default)
            => Task.FromResult<CloudflareTunnelConfigResult?>(new CloudflareTunnelConfigResult(41, "cloudflare",
                new System.Text.Json.Nodes.JsonObject { ["ingress"] = new System.Text.Json.Nodes.JsonArray(new System.Text.Json.Nodes.JsonObject { ["service"] = "http_status:404" }) }));

        public Task<CloudflareTunnelConfigResult?> PutTunnelConfigurationAsync(string token, string accountId, string tunnelId, System.Text.Json.Nodes.JsonObject config, CancellationToken cancellationToken = default)
            => Task.FromResult<CloudflareTunnelConfigResult?>(new CloudflareTunnelConfigResult(42, "cloudflare", config));

        public Task<IReadOnlyList<CloudflareDnsRecord>> ListDnsRecordsAsync(string token, string zoneId, string name, CancellationToken cancellationToken = default)
            => Task.FromResult<IReadOnlyList<CloudflareDnsRecord>>([]);

        public Task<CloudflareDnsRecord?> CreateCnameAsync(string token, string zoneId, string name, string content, bool proxied, CancellationToken cancellationToken = default)
            => Task.FromResult<CloudflareDnsRecord?>(new CloudflareDnsRecord("rec-id", "CNAME", name, content, proxied, 1));

        public Task<CloudflareDnsRecord?> UpdateCnameAsync(string token, string zoneId, string recordId, string name, string content, bool proxied, CancellationToken cancellationToken = default)
            => Task.FromResult<CloudflareDnsRecord?>(new CloudflareDnsRecord(recordId, "CNAME", name, content, proxied, 1));

        public Task DeleteDnsRecordAsync(string token, string zoneId, string recordId, CancellationToken cancellationToken = default)
            => Task.CompletedTask;
    }
}
