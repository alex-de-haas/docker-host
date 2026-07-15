using System.Net;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class CloudflareApiClientTests
{
    // Real response shapes captured from the phase-0 spike (ids abbreviated).
    private const string AccountsJson = """{"success":true,"errors":[],"result":[{"id":"583c0e86","name":"Aleksandr Zayats"}]}""";
    private const string ZonesJson = """{"success":true,"errors":[],"result":[{"id":"z1","name":"zayats.io","status":"active"}]}""";
    private const string TunnelsJson = """
        {"success":true,"errors":[],"result":[
          {"id":"t-remote","name":"NL_HOME_SERVER","status":"healthy","config_src":"cloudflare","remote_config":true},
          {"id":"t-local","name":"hosty","status":"inactive","config_src":null,"remote_config":false}
        ]}
        """;
    private const string ConnectionsJson = """
        {"success":true,"errors":[],"result":[
          {"id":"c1","conns":[{"origin_ip":"2001:1c01:21e:c100::1","colo_name":"ams13","client_version":"2026.7.1","is_pending_reconnect":false}]}
        ]}
        """;

    [Fact]
    public async Task ListAccountsAsync_ParsesResultAndSendsBearerToken()
    {
        string? sentAuth = null;
        var client = Client((request, _) =>
        {
            sentAuth = request.Headers.Authorization?.ToString();
            return (HttpStatusCode.OK, AccountsJson);
        });

        var accounts = await client.ListAccountsAsync("secret-token");

        var account = Assert.Single(accounts);
        Assert.Equal("583c0e86", account.Id);
        Assert.Equal("Aleksandr Zayats", account.Name);
        // The token is sent as a Bearer header (and nowhere else — this is the only place it appears).
        Assert.Equal("Bearer secret-token", sentAuth);
    }

    [Fact]
    public async Task ListZonesAsync_ParsesResult()
    {
        var client = Client((_, _) => (HttpStatusCode.OK, ZonesJson));

        var zone = Assert.Single(await client.ListZonesAsync("t"));
        Assert.Equal("zayats.io", zone.Name);
        Assert.Equal("active", zone.Status);
    }

    [Fact]
    public async Task ListTunnelsAsync_ParsesConfigSrcAndClassifiesRemotelyManagedHealthy()
    {
        var client = Client((_, _) => (HttpStatusCode.OK, TunnelsJson));

        var tunnels = await client.ListTunnelsAsync("t", "583c0e86");
        Assert.Equal(2, tunnels.Count);
        var remote = Assert.Single(tunnels, tunnel => tunnel.IsRemotelyManaged && tunnel.IsHealthy);
        Assert.Equal("NL_HOME_SERVER", remote.Name);
        var local = Assert.Single(tunnels, tunnel => !tunnel.IsRemotelyManaged);
        Assert.Equal("hosty", local.Name);
        Assert.False(local.IsHealthy);
    }

    [Fact]
    public async Task GetTunnelConnectionsAsync_FlattensConnsAndExposesIpv6OriginIp()
    {
        var client = Client((_, _) => (HttpStatusCode.OK, ConnectionsJson));

        var conn = Assert.Single(await client.GetTunnelConnectionsAsync("t", "acc", "tid"));
        Assert.Equal("2001:1c01:21e:c100::1", conn.OriginIp);
        Assert.Equal("ams13", conn.ColoName);
    }

    [Fact]
    public async Task SendAsync_ThrowsWithStatusAndMessage_OnForbidden()
    {
        const string forbidden = """{"success":false,"errors":[{"code":9109,"message":"Unauthorized to access requested resource"}],"result":null}""";
        var client = Client((_, _) => (HttpStatusCode.Forbidden, forbidden));

        var error = await Assert.ThrowsAsync<CloudflareApiException>(() => client.ListAccountsAsync("t"));
        Assert.Equal(403, error.StatusCode);
        Assert.Contains("Unauthorized to access requested resource", Assert.Single(error.CloudflareErrors));
    }

    [Fact]
    public async Task SendAsync_ThrowsOnSuccessFalse_EvenWithHttp200()
    {
        const string body = """{"success":false,"errors":[{"code":1000,"message":"nope"}],"result":null}""";
        var client = Client((_, _) => (HttpStatusCode.OK, body));

        var error = await Assert.ThrowsAsync<CloudflareApiException>(() => client.ListZonesAsync("t"));
        Assert.Contains("nope", error.CloudflareErrors);
    }

    [Fact]
    public async Task GetTunnelConfigurationAsync_ParsesVersionAndPreservesRawConfigIncludingWarpRouting()
    {
        const string configJson = """
            {"success":true,"errors":[],"result":{"version":41,"source":"cloudflare","config":{
              "ingress":[{"hostname":"media.zayats.io","service":"http://localhost:8096"},{"service":"http_status:404"}],
              "warp-routing":{"enabled":true}
            }}}
            """;
        var client = Client((_, _) => (HttpStatusCode.OK, configJson));

        var result = await client.GetTunnelConfigurationAsync("t", "acc", "tid");

        Assert.Equal(41, result!.Version);
        Assert.NotNull(result.Config);
        // The raw pass-through document keeps the sibling warp-routing key.
        Assert.True((bool)result.Config!["warp-routing"]!["enabled"]!);
    }

    [Fact]
    public async Task PutTunnelConfigurationAsync_SendsPutWithConfigWrapper_AndParsesNewVersion()
    {
        string? method = null;
        string? sentBody = null;
        var client = Client((request, _) =>
        {
            method = request.Method.Method;
            sentBody = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return (HttpStatusCode.OK, """{"success":true,"errors":[],"result":{"version":42,"source":"cloudflare","config":{"ingress":[]}}}""");
        });
        var config = (System.Text.Json.Nodes.JsonObject)System.Text.Json.Nodes.JsonNode.Parse("""{"ingress":[{"hostname":"app.zayats.io","service":"http://localhost:4000"}],"warp-routing":{"enabled":true}}""")!;

        var result = await client.PutTunnelConfigurationAsync("t", "acc", "tid", config);

        Assert.Equal("PUT", method);
        Assert.Equal(42, result!.Version);
        // The body wraps the caller's document under "config" and carries warp-routing verbatim.
        Assert.Contains("\"config\"", sentBody);
        Assert.Contains("warp-routing", sentBody);
        Assert.Contains("app.zayats.io", sentBody);
    }

    [Fact]
    public async Task ListDnsRecordsAsync_ParsesProxiedCnames()
    {
        const string json = """{"success":true,"errors":[],"result":[{"id":"r1","type":"CNAME","name":"media.zayats.io","content":"abc.cfargotunnel.com","proxied":true,"ttl":1}]}""";
        var client = Client((_, _) => (HttpStatusCode.OK, json));

        var record = Assert.Single(await client.ListDnsRecordsAsync("t", "zone", "media.zayats.io"));
        Assert.Equal("r1", record.Id);
        Assert.True(record.Proxied);
        Assert.Equal("abc.cfargotunnel.com", record.Content);
    }

    [Fact]
    public async Task CreateCnameAsync_PostsProxiedCnameBody_AndParsesId()
    {
        string? method = null;
        string? body = null;
        var client = Client((request, _) =>
        {
            method = request.Method.Method;
            body = request.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return (HttpStatusCode.OK, """{"success":true,"errors":[],"result":{"id":"new-id","type":"CNAME","name":"app.zayats.io","content":"abc.cfargotunnel.com","proxied":true,"ttl":1}}""");
        });

        var record = await client.CreateCnameAsync("t", "zone", "app.zayats.io", "abc.cfargotunnel.com", proxied: true);

        Assert.Equal("POST", method);
        Assert.Equal("new-id", record!.Id);
        Assert.Contains("\"type\":\"CNAME\"", body);
        Assert.Contains("\"proxied\":true", body);
        Assert.Contains("app.zayats.io", body);
    }

    [Fact]
    public async Task DeleteDnsRecordAsync_SendsDelete()
    {
        string? method = null;
        var client = Client((request, _) =>
        {
            method = request.Method.Method;
            return (HttpStatusCode.OK, """{"success":true,"errors":[],"result":{"id":"r1"}}""");
        });

        await client.DeleteDnsRecordAsync("t", "zone", "r1");
        Assert.Equal("DELETE", method);
    }

    private static CloudflareApiClient Client(Func<HttpRequestMessage, CancellationToken, (HttpStatusCode, string)> respond)
        => new(new StubHttpClientFactory(new StubHttpMessageHandler(respond)));

    private sealed class StubHttpMessageHandler(Func<HttpRequestMessage, CancellationToken, (HttpStatusCode Status, string Json)> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var (status, json) = respond(request, cancellationToken);
            return Task.FromResult(new HttpResponseMessage(status)
            {
                Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json"),
            });
        }
    }

    private sealed class StubHttpClientFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
    }
}
