using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class CorePublicationTests
{
    [Fact]
    public void IsCore_MatchesOnlyTheReservedPair_NotTheAppIdAlone()
    {
        Assert.True(CorePublication.IsCore(CorePublication.AppId, CorePublication.EndpointKey));
        // An app that somehow carries the reserved id owns its OWN endpoints: matching on the id alone
        // would let uninstalling it delete Core's hostname and hide its own publications.
        Assert.False(CorePublication.IsCore(CorePublication.AppId, "web"));
        Assert.False(CorePublication.IsCore("com.haas.demo-app", CorePublication.EndpointKey));
    }

    [Theory]
    // A loopback or all-interface binding is reachable from the connector as localhost…
    [InlineData("http://localhost:7070", "http://localhost:7070")]
    [InlineData("http://0.0.0.0:7070", "http://localhost:7070")]
    [InlineData("http://[::]:7070", "http://localhost:7070")]
    [InlineData("http://127.0.0.1:7070", "http://localhost:7070")]
    // …the scheme and port follow the listener rather than an assumed http/{corePort}…
    [InlineData("https://localhost:7443", "https://localhost:7443")]
    // …and a specific address is dialled as itself, because localhost would serve nothing.
    [InlineData("http://192.168.1.10:7070", "http://192.168.1.10:7070")]
    public void ServiceUrl_FollowsTheActiveListener(string listenUrl, string expected)
        => Assert.Equal(expected, CorePublication.ServiceUrl(listenUrl, 7070));

    [Fact]
    public void ServiceUrl_UnparseableListenUrl_FallsBackToTheCorePort()
        => Assert.Equal("http://localhost:7070", CorePublication.ServiceUrl("not-a-url", 7070));
}

public sealed class CloudflarePublicationStoreTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"hosty-cf-pub-{Guid.NewGuid():N}");

    [Fact]
    public async Task Upsert_ThenGet_RoundTrips_AndReplacesSameKey()
    {
        var store = CreateStore();
        await store.UpsertAsync(Publication("app", "web.http", "media", "media.example.test", "http://localhost:8096"));

        var loaded = await store.GetAsync("app", "web.http");
        Assert.Equal("media.example.test", loaded!.Hostname);
        Assert.Equal("http://localhost:8096", loaded.ServiceUrl);

        // Upserting the same (app, endpoint) replaces rather than duplicates.
        await store.UpsertAsync(Publication("app", "web.http", "media", "media.example.test", "http://localhost:9999"));
        Assert.Single(await store.ListAsync());
        Assert.Equal("http://localhost:9999", (await store.GetAsync("app", "web.http"))!.ServiceUrl);
    }

    [Fact]
    public async Task ListForApp_FiltersByApp()
    {
        var store = CreateStore();
        await store.UpsertAsync(Publication("app-a", "web.http", "a", "a.example.test", null));
        await store.UpsertAsync(Publication("app-a", "api.http", "a-api", "a-api.example.test", null));
        await store.UpsertAsync(Publication("app-b", "web.http", "b", "b.example.test", null));

        Assert.Equal(2, (await store.ListForAppAsync("app-a")).Count);
        Assert.Single(await store.ListForAppAsync("app-b"));
    }

    [Fact]
    public async Task Remove_DeletesOnlyThatEndpoint()
    {
        var store = CreateStore();
        await store.UpsertAsync(Publication("app", "web.http", "w", "w.example.test", null));
        await store.UpsertAsync(Publication("app", "api.http", "a", "a.example.test", null));

        await store.RemoveAsync("app", "web.http");

        Assert.Null(await store.GetAsync("app", "web.http"));
        Assert.NotNull(await store.GetAsync("app", "api.http"));
    }

    [Fact]
    public async Task List_WhenEmpty_ReturnsEmpty()
        => Assert.Empty(await CreateStore().ListAsync());

    private static CloudflarePublication Publication(string appId, string endpointKey, string label, string hostname, string? serviceUrl)
        => new(appId, endpointKey, label, hostname, "rec-id", serviceUrl, CloudflareOwnershipStates.Owned, DateTimeOffset.UnixEpoch);

    private CloudflarePublicationStore CreateStore()
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
        return new CloudflarePublicationStore(paths);
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
}
