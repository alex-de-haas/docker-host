using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class CloudflarePublicationStoreTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"hosty-cf-pub-{Guid.NewGuid():N}");

    [Fact]
    public async Task Upsert_ThenGet_RoundTrips_AndReplacesSameKey()
    {
        var store = CreateStore();
        await store.UpsertAsync(Publication("app", "web.http", "media", "media.zayats.io", "http://localhost:8096"));

        var loaded = await store.GetAsync("app", "web.http");
        Assert.Equal("media.zayats.io", loaded!.Hostname);
        Assert.Equal("http://localhost:8096", loaded.ServiceUrl);

        // Upserting the same (app, endpoint) replaces rather than duplicates.
        await store.UpsertAsync(Publication("app", "web.http", "media", "media.zayats.io", "http://localhost:9999"));
        Assert.Single(await store.ListAsync());
        Assert.Equal("http://localhost:9999", (await store.GetAsync("app", "web.http"))!.ServiceUrl);
    }

    [Fact]
    public async Task ListForApp_FiltersByApp()
    {
        var store = CreateStore();
        await store.UpsertAsync(Publication("app-a", "web.http", "a", "a.zayats.io", null));
        await store.UpsertAsync(Publication("app-a", "api.http", "a-api", "a-api.zayats.io", null));
        await store.UpsertAsync(Publication("app-b", "web.http", "b", "b.zayats.io", null));

        Assert.Equal(2, (await store.ListForAppAsync("app-a")).Count);
        Assert.Single(await store.ListForAppAsync("app-b"));
    }

    [Fact]
    public async Task Remove_DeletesOnlyThatEndpoint()
    {
        var store = CreateStore();
        await store.UpsertAsync(Publication("app", "web.http", "w", "w.zayats.io", null));
        await store.UpsertAsync(Publication("app", "api.http", "a", "a.zayats.io", null));

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
