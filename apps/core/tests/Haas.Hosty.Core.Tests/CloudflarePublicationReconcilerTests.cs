using System.Text.Json.Nodes;
using Haas.Hosty.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed class CloudflarePublicationReconcilerTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"hosty-cf-recon-{Guid.NewGuid():N}");
    private static readonly CloudflareIngressTarget Target = new("acc", "zone", "tunnel-123", "example.test");

    [Fact]
    public async Task PublishAsync_AddsRouteBeforeDns_AndPreservesExistingRulesAndWarpRouting()
    {
        var api = new StatefulApi(SampleConfig());
        var (reconciler, _) = Create(api);

        var publication = await reconciler.PublishAsync("t", Target, "app", "web.http", "media", "http://127.0.0.1:8096");

        Assert.Equal("media.example.test", publication.Hostname);
        // The route was written before the DNS record.
        Assert.True(api.Ops.IndexOf("put-config") < api.Ops.IndexOf("dns-create"));
        // The new rule is present; the pre-existing rule and warp-routing survive.
        var hostnames = CloudflareTunnelConfigPatcher.IngressHostnames(api.Config);
        Assert.Contains("media.example.test", hostnames);
        Assert.Contains("core.example.test", hostnames);
        Assert.True((bool)api.Config["warp-routing"]!["enabled"]!);
        // A proxied CNAME to the tunnel was created.
        var dns = Assert.Single(api.Dns);
        Assert.Equal("tunnel-123.cfargotunnel.com", dns.Content);
        Assert.True(dns.Proxied);
    }

    [Fact]
    public async Task PublishAsync_WhenDnsCreateFails_RollsBackTheRouteItAdded()
    {
        var api = new StatefulApi(SampleConfig()) { FailDnsCreate = true };
        var (reconciler, publications) = Create(api);

        await Assert.ThrowsAsync<CloudflareApiException>(() =>
            reconciler.PublishAsync("t", Target, "app", "web.http", "media", "http://127.0.0.1:8096"));

        // The route it added was rolled back, no DNS record remains, and nothing was persisted.
        Assert.DoesNotContain("media.example.test", CloudflareTunnelConfigPatcher.IngressHostnames(api.Config));
        Assert.Empty(api.Dns);
        Assert.Null(await publications.GetAsync("app", "web.http"));
        // The pre-existing route is untouched by the rollback.
        Assert.Contains("core.example.test", CloudflareTunnelConfigPatcher.IngressHostnames(api.Config));
    }

    [Fact]
    public async Task PublishAsync_HostnameOwnedByAnotherEndpoint_Throws()
    {
        var api = new StatefulApi(SampleConfig());
        var (reconciler, publications) = Create(api);
        await publications.UpsertAsync(new CloudflarePublication("other-app", "web.http", "media", "media.example.test", "rec", "url", CloudflareOwnershipStates.Owned, DateTimeOffset.UnixEpoch));

        var error = await Assert.ThrowsAsync<CloudflareConnectionException>(() =>
            reconciler.PublishAsync("t", Target, "app", "web.http", "media", "http://127.0.0.1:8096"));
        Assert.Equal("cloudflare_hostname_owned", error.Code);
    }

    [Fact]
    public async Task PublishAsync_ForeignPreexistingDnsRecord_Throws()
    {
        var api = new StatefulApi(SampleConfig());
        api.Dns.Add(new CloudflareDnsRecord("foreign", "CNAME", "media.example.test", "something-else.example", true, 1));
        var (reconciler, _) = Create(api);

        var error = await Assert.ThrowsAsync<CloudflareConnectionException>(() =>
            reconciler.PublishAsync("t", Target, "app", "web.http", "media", "http://127.0.0.1:8096"));
        Assert.Equal("cloudflare_hostname_conflict", error.Code);
    }

    [Fact]
    public async Task PublishAsync_AdoptTakesOverTheExistingRecordWithoutCreatingOne()
    {
        // The phase-0 spike found the live account already carrying matching proxied CNAMEs, so this is the
        // first connect's normal case, not an edge one.
        var api = new StatefulApi(SampleConfig());
        api.Dns.Add(new CloudflareDnsRecord("foreign", "CNAME", "media.example.test", "something-else.example", true, 1));
        var (reconciler, publications) = Create(api);

        var publication = await reconciler.PublishAsync("t", Target, "app", "web.http", "media", "http://127.0.0.1:8096", adopt: true);

        Assert.Equal(CloudflareOwnershipStates.Adopted, publication.OwnershipState);
        Assert.Equal("foreign", publication.DnsRecordId);
        // Updated in place, not duplicated, and now pointing at the tunnel.
        var record = Assert.Single(api.Dns);
        Assert.Equal("foreign", record.Id);
        Assert.Equal($"{Target.TunnelId}.cfargotunnel.com", record.Content);
        Assert.Contains("media.example.test", CloudflareTunnelConfigPatcher.IngressHostnames(api.Config));
        Assert.Equal(CloudflareOwnershipStates.Adopted, (await publications.GetAsync("app", "web.http"))!.OwnershipState);
    }

    [Fact]
    public async Task UnpublishAsync_AdoptedRecord_RemovesTheRouteButKeepsTheRecord()
    {
        // Adoption means Hosty manages the record, not that it created it. Deleting an operator's DNS
        // record on unpublish would destroy something Hosty was only ever lent.
        var api = new StatefulApi(SampleConfig());
        api.Dns.Add(new CloudflareDnsRecord("foreign", "CNAME", "media.example.test", "something-else.example", true, 1));
        var (reconciler, publications) = Create(api);
        await reconciler.PublishAsync("t", Target, "app", "web.http", "media", "http://127.0.0.1:8096", adopt: true);

        await reconciler.UnpublishAsync("t", Target, "app", "web.http");

        Assert.Single(api.Dns);
        Assert.DoesNotContain("media.example.test", CloudflareTunnelConfigPatcher.IngressHostnames(api.Config));
        Assert.Null(await publications.GetAsync("app", "web.http"));
    }

    [Fact]
    public async Task PublishAsync_RepublishingAnAdoptedHostname_StaysAdopted()
    {
        // Promoting it to "owned" on a re-publish would quietly turn the operator's record into something
        // a later unpublish deletes.
        var api = new StatefulApi(SampleConfig());
        api.Dns.Add(new CloudflareDnsRecord("foreign", "CNAME", "media.example.test", "something-else.example", true, 1));
        var (reconciler, _) = Create(api);
        await reconciler.PublishAsync("t", Target, "app", "web.http", "media", "http://127.0.0.1:8096", adopt: true);

        var republished = await reconciler.PublishAsync("t", Target, "app", "web.http", "media", "http://127.0.0.1:9000");

        Assert.Equal(CloudflareOwnershipStates.Adopted, republished.OwnershipState);
    }

    [Fact]
    public async Task PublishAsync_InvalidLabel_Throws()
    {
        var (reconciler, _) = Create(new StatefulApi(SampleConfig()));
        var error = await Assert.ThrowsAsync<CloudflareConnectionException>(() =>
            reconciler.PublishAsync("t", Target, "app", "web.http", "a.b", "http://127.0.0.1:8096"));
        Assert.Equal("cloudflare_label_invalid", error.Code);
    }

    [Fact]
    public async Task UnpublishAsync_RemovesDnsBeforeRoute_AndClearsOwnership()
    {
        var api = new StatefulApi(SampleConfig());
        var (reconciler, publications) = Create(api);
        await reconciler.PublishAsync("t", Target, "app", "web.http", "media", "http://127.0.0.1:8096");
        api.Ops.Clear();

        await reconciler.UnpublishAsync("t", Target, "app", "web.http");

        Assert.True(api.Ops.IndexOf("dns-delete") < api.Ops.IndexOf("put-config"));
        Assert.DoesNotContain("media.example.test", CloudflareTunnelConfigPatcher.IngressHostnames(api.Config));
        Assert.Empty(api.Dns);
        Assert.Null(await publications.GetAsync("app", "web.http"));
        // The pre-existing route survives unpublish.
        Assert.Contains("core.example.test", CloudflareTunnelConfigPatcher.IngressHostnames(api.Config));
    }

    [Fact]
    public async Task PublishAsync_LabelChange_RemovesOldRouteAndRenamesDns()
    {
        var api = new StatefulApi(SampleConfig());
        var (reconciler, _) = Create(api);
        await reconciler.PublishAsync("t", Target, "app", "web.http", "media", "http://127.0.0.1:8096");

        // Republish the same endpoint with a different label → a rename.
        await reconciler.PublishAsync("t", Target, "app", "web.http", "media-new", "http://127.0.0.1:8096");

        var hostnames = CloudflareTunnelConfigPatcher.IngressHostnames(api.Config);
        Assert.Contains("media-new.example.test", hostnames);
        Assert.DoesNotContain("media.example.test", hostnames); // old route removed, not leaked
        Assert.Contains("core.example.test", hostnames); // unrelated preserved
        // The DNS record was renamed in place (still a single owned record).
        var dns = Assert.Single(api.Dns);
        Assert.Equal("media-new.example.test", dns.Name);
    }

    [Fact]
    public async Task PublishAsync_WhenRenameDnsUpdateFails_RestoresThePreviousRoute()
    {
        var api = new StatefulApi(SampleConfig());
        var (reconciler, publications) = Create(api);
        await reconciler.PublishAsync("t", Target, "app", "web.http", "media", "http://127.0.0.1:8096");
        // Give the published rule an originRequest, the way an operator tuning timeouts in the dashboard would.
        api.SetIngressProperty("media.example.test", "originRequest", new JsonObject { ["connectTimeout"] = 30 });
        api.FailDnsUpdate = true;

        await Assert.ThrowsAsync<CloudflareApiException>(() =>
            reconciler.PublishAsync("t", Target, "app", "web.http", "media-new", "http://127.0.0.1:8096"));

        // The endpoint is still served: the half-applied rename was undone, not left with neither route.
        var hostnames = CloudflareTunnelConfigPatcher.IngressHostnames(api.Config);
        Assert.Contains("media.example.test", hostnames);
        Assert.DoesNotContain("media-new.example.test", hostnames);
        Assert.Contains("core.example.test", hostnames);
        // Restored verbatim rather than rebuilt from hostname + service.
        var restored = CloudflareTunnelConfigPatcher.FindIngress(api.Config, "media.example.test");
        Assert.Equal("http://127.0.0.1:8096", (string?)restored!["service"]);
        Assert.Equal(30, (int?)restored["originRequest"]?["connectTimeout"]);
        // DNS still answers for the old hostname, and the publication was not moved.
        var dns = Assert.Single(api.Dns);
        Assert.Equal("media.example.test", dns.Name);
        Assert.Equal("media.example.test", (await publications.GetAsync("app", "web.http"))!.Hostname);
    }

    [Fact]
    public async Task PublishAsync_RenameOntoForeignRecord_IsRefusedBeforeAnyMutation()
    {
        var api = new StatefulApi(SampleConfig());
        var (reconciler, publications) = Create(api);
        await reconciler.PublishAsync("t", Target, "app", "web.http", "media", "http://127.0.0.1:8096");
        // Somebody else's record already answers for the label the operator is renaming onto.
        api.Dns.Add(new CloudflareDnsRecord("foreign-1", "CNAME", "media-new.example.test", "elsewhere.example", true, 1));
        api.Ops.Clear();

        var error = await Assert.ThrowsAsync<CloudflareConnectionException>(() =>
            reconciler.PublishAsync("t", Target, "app", "web.http", "media-new", "http://127.0.0.1:8096"));

        Assert.Equal("cloudflare_hostname_conflict", error.Code);
        // Refused as a preflight: nothing was written, so there is nothing to roll back.
        Assert.DoesNotContain("put-config", api.Ops);
        Assert.Contains("media.example.test", CloudflareTunnelConfigPatcher.IngressHostnames(api.Config));
        Assert.DoesNotContain("media-new.example.test", CloudflareTunnelConfigPatcher.IngressHostnames(api.Config));
        Assert.Equal("media.example.test", (await publications.GetAsync("app", "web.http"))!.Hostname);
        // The foreign record is untouched — a rename never adopts, even when asked to.
        Assert.Contains(api.Dns, record => record.Id == "foreign-1" && record.Content == "elsewhere.example");
        var adoptAttempt = await Assert.ThrowsAsync<CloudflareConnectionException>(() =>
            reconciler.PublishAsync("t", Target, "app", "web.http", "media-new", "http://127.0.0.1:8096", adopt: true));
        Assert.Equal("cloudflare_hostname_conflict", adoptAttempt.Code);
    }

    [Fact]
    public async Task PublishAsync_SameLabelWithAStrayDuplicateRecord_StillReapplies()
    {
        var api = new StatefulApi(SampleConfig());
        var (reconciler, _) = Create(api);
        await reconciler.PublishAsync("t", Target, "app", "web.http", "media", "http://127.0.0.1:8096");
        // A hand-made duplicate at our own hostname must not turn Reapply — the repair for a drifted route —
        // into a conflict. Only a rename onto a foreign record is refused.
        api.Dns.Add(new CloudflareDnsRecord("stray-1", "CNAME", "media.example.test", "elsewhere.example", true, 1));

        var publication = await reconciler.PublishAsync("t", Target, "app", "web.http", "media", "http://127.0.0.1:9000");

        Assert.Equal("media.example.test", publication.Hostname);
        Assert.Equal("http://127.0.0.1:9000", publication.ServiceUrl);
    }

    [Fact]
    public async Task UnpublishAsync_ToleratesAlreadyDeletedDnsRecord()
    {
        var api = new StatefulApi(SampleConfig());
        var (reconciler, publications) = Create(api);
        await reconciler.PublishAsync("t", Target, "app", "web.http", "media", "http://127.0.0.1:8096");
        api.Dns.Clear(); // operator deleted the record from the dashboard → DELETE will 404
        api.FailDnsDeleteWith404 = true;

        await reconciler.UnpublishAsync("t", Target, "app", "web.http");

        // Cleanup still completes: route gone, publication cleared.
        Assert.DoesNotContain("media.example.test", CloudflareTunnelConfigPatcher.IngressHostnames(api.Config));
        Assert.Null(await publications.GetAsync("app", "web.http"));
    }

    private static JsonObject SampleConfig() => (JsonObject)JsonNode.Parse("""
        {
          "ingress": [
            {"hostname":"core.example.test","service":"http://127.0.0.1:3001"},
            {"service":"http_status:404"}
          ],
          "warp-routing": {"enabled": true}
        }
        """)!;

    private (CloudflarePublicationReconciler, CloudflarePublicationStore) Create(StatefulApi api)
    {
        Directory.CreateDirectory(root);
        var paths = new CoreDataPaths(root, Path.Combine(root, "core"), Path.Combine(root, "apps"), Path.Combine(root, "backups"), Path.Combine(root, "sources"), Path.Combine(root, "core", "auth"), Path.Combine(root, "core", "audit", "a.ndjson"));
        var publications = new CloudflarePublicationStore(paths);
        return (new CloudflarePublicationReconciler(api, publications, NullLogger<CloudflarePublicationReconciler>.Instance), publications);
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

    // In-memory Cloudflare with a mutable tunnel config + DNS list, recording the operation order.
    private sealed class StatefulApi(JsonObject config) : ICloudflareApiClient
    {
        public JsonObject Config { get; private set; } = config;
        public List<CloudflareDnsRecord> Dns { get; } = [];
        public List<string> Ops { get; } = [];
        public bool FailDnsCreate { get; init; }
        public bool FailDnsDeleteWith404 { get; set; }
        public bool FailDnsUpdate { get; set; }
        private int nextId = 1;

        // Attach a property to an existing ingress rule, standing in for whatever an operator tuned in the
        // dashboard and which a rollback must not quietly discard.
        public void SetIngressProperty(string hostname, string property, JsonNode value)
            => CloudflareTunnelConfigPatcher.FindIngress(Config, hostname)![property] = value;

        public Task<CloudflareTunnelConfigResult?> GetTunnelConfigurationAsync(string token, string accountId, string tunnelId, CancellationToken cancellationToken = default)
        {
            Ops.Add("get-config");
            return Task.FromResult<CloudflareTunnelConfigResult?>(new CloudflareTunnelConfigResult(41, "cloudflare", (JsonObject)Config.DeepClone()));
        }

        public Task<CloudflareTunnelConfigResult?> PutTunnelConfigurationAsync(string token, string accountId, string tunnelId, JsonObject config, CancellationToken cancellationToken = default)
        {
            Ops.Add("put-config");
            Config = (JsonObject)config.DeepClone();
            return Task.FromResult<CloudflareTunnelConfigResult?>(new CloudflareTunnelConfigResult(42, "cloudflare", (JsonObject)Config.DeepClone()));
        }

        public Task<IReadOnlyList<CloudflareDnsRecord>> ListDnsRecordsAsync(string token, string zoneId, string name, CancellationToken cancellationToken = default)
            => Task.FromResult<IReadOnlyList<CloudflareDnsRecord>>(Dns.Where(record => string.Equals(record.Name, name, StringComparison.OrdinalIgnoreCase)).ToArray());

        public Task<CloudflareDnsRecord?> CreateCnameAsync(string token, string zoneId, string name, string content, bool proxied, CancellationToken cancellationToken = default)
        {
            Ops.Add("dns-create");
            if (FailDnsCreate)
            {
                throw new CloudflareApiException(400, ["DNS create failed"]);
            }

            var record = new CloudflareDnsRecord($"rec-{nextId++}", "CNAME", name, content, proxied, 1);
            Dns.Add(record);
            return Task.FromResult<CloudflareDnsRecord?>(record);
        }

        public Task<CloudflareDnsRecord?> UpdateCnameAsync(string token, string zoneId, string recordId, string name, string content, bool proxied, CancellationToken cancellationToken = default)
        {
            Ops.Add("dns-update");
            if (FailDnsUpdate)
            {
                throw new CloudflareApiException(400, ["DNS update failed"]);
            }

            var record = new CloudflareDnsRecord(recordId, "CNAME", name, content, proxied, 1);
            Dns.RemoveAll(existing => string.Equals(existing.Id, recordId, StringComparison.Ordinal));
            Dns.Add(record);
            return Task.FromResult<CloudflareDnsRecord?>(record);
        }

        public Task DeleteDnsRecordAsync(string token, string zoneId, string recordId, CancellationToken cancellationToken = default)
        {
            Ops.Add("dns-delete");
            if (FailDnsDeleteWith404)
            {
                throw new CloudflareApiException(404, ["Record not found"]);
            }

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
