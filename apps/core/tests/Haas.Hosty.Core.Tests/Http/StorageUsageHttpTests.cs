using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class StorageUsageHttpTests
{
    [Theory]
    [InlineData(null, HttpStatusCode.Unauthorized)]
    [InlineData("host.user", HttpStatusCode.Forbidden)]
    [InlineData("host.admin", HttpStatusCode.OK)]
    public async Task SnapshotIsAdminOnlyAndGetNeverScans(string? role, HttpStatusCode expected)
    {
        var fs = new ControlledFileSystem();
        await using var host = await Start(fs);
        using var client = host.CreateClient();
        if (role is not null) await Authenticate(host, client, role);
        using var response = await client.GetAsync("/api/storage");
        Assert.Equal(expected, response.StatusCode);
        Assert.True(response.Headers.CacheControl?.NoStore);
        Assert.Equal(0, fs.Scans);
        if (expected == HttpStatusCode.OK)
        {
            var json = await response.Content.ReadFromJsonAsync<JsonElement>();
            Assert.Equal(JsonValueKind.Null, json.GetProperty("snapshot").ValueKind);
            Assert.False(json.GetProperty("isScanning").GetBoolean());
        }
    }

    [Fact]
    public async Task RefreshRequiresCsrfAndValidUuidAndReturnsSameCachedSnapshotOnReplay()
    {
        var fs = new ControlledFileSystem();
        await using var host = await Start(fs);
        using var client = host.CreateClient();
        await Authenticate(host, client, "host.admin");
        var id = Guid.NewGuid().ToString();
        using var noCsrf = await client.PostAsJsonAsync("/api/storage/refresh", new { requestId = id });
        Assert.Equal(HttpStatusCode.Forbidden, noCsrf.StatusCode);
        Assert.True(noCsrf.Headers.CacheControl?.NoStore);
        Assert.Equal(0, fs.Scans);
        Csrf(client);
        using var invalid = await client.PostAsJsonAsync("/api/storage/refresh", new { requestId = "not-a-uuid" });
        Assert.Equal(HttpStatusCode.BadRequest, invalid.StatusCode);
        Assert.True(invalid.Headers.CacheControl?.NoStore);
        using var first = await client.PostAsJsonAsync("/api/storage/refresh", new { requestId = id });
        Assert.Equal(HttpStatusCode.Accepted, first.StatusCode);
        Assert.True(first.Headers.CacheControl?.NoStore);
        await host.Services.GetRequiredService<StorageUsageService>().WaitForScanAsync();
        var snapshot = await Snapshot(client);
        Assert.Equal(123, snapshot.GetProperty("logicalBytes").GetInt64());
        using var replay = await client.PostAsJsonAsync("/api/storage/refresh", new { requestId = id });
        Assert.Equal(HttpStatusCode.Accepted, replay.StatusCode);
        Assert.True(replay.Headers.CacheControl?.NoStore);
        Assert.Equal(snapshot.GetProperty("id").GetString(), (await Snapshot(client)).GetProperty("id").GetString());
        Assert.Equal(1, fs.Scans);
    }

    [Fact]
    public async Task ConcurrentRequestIdsJoinSingleScanAndFailedRefreshRetainsPreviousSnapshot()
    {
        var fs = new ControlledFileSystem { Block = true };
        await using var host = await Start(fs);
        using var client = host.CreateClient();
        await Authenticate(host, client, "host.admin"); Csrf(client);
        try
        {
            using var first = await client.PostAsJsonAsync("/api/storage/refresh", new { requestId = Guid.NewGuid() });
            Assert.Equal(HttpStatusCode.Accepted, first.StatusCode);
            Assert.True(fs.Entered.Wait(TimeSpan.FromSeconds(10)));
            using var second = await client.PostAsJsonAsync("/api/storage/refresh", new { requestId = Guid.NewGuid() });
            var scanning = await second.Content.ReadFromJsonAsync<JsonElement>();
            Assert.True(scanning.GetProperty("isScanning").GetBoolean());
            Assert.Equal(1, fs.Scans);
        }
        finally { fs.Release.Set(); }
        var service = host.Services.GetRequiredService<StorageUsageService>();
        await service.WaitForScanAsync();
        var snapshot = await Snapshot(client);
        fs.Fail = true;
        using var failed = await client.PostAsJsonAsync("/api/storage/refresh", new { requestId = Guid.NewGuid() });
        await service.WaitForScanAsync();
        var state = service.GetState();
        Assert.Equal(snapshot.GetProperty("id").GetString(), state.Snapshot!.Id);
        Assert.Equal("storage_scan_failed", state.LastError);
        Assert.False(state.IsScanning);
        Assert.Equal(2, fs.Scans);
    }

    [Theory]
    [InlineData("core.read")]
    [InlineData("core.configure")]
    [InlineData("core.storage.read")]
    [InlineData("")]
    public async Task ArbitraryAppNeedsExplicitStorageAndOperationPermission(string missing)
    {
        var fs = new ControlledFileSystem();
        await using var host = await Start(fs);
        var granted = new[] { CoreAppPermissions.ReadCore, CoreAppPermissions.ConfigureCore, CoreAppPermissions.ReadStorage }.Where(p => p != missing).ToArray();
        using var client = await AppManagementHttpTests.CreateAppClient(host, "net.vendor.unrelated-console", granted);
        using var get = await client.GetAsync("/api/storage");
        Assert.Equal(missing is "core.read" or "core.storage.read" ? HttpStatusCode.Forbidden : HttpStatusCode.OK, get.StatusCode);
        using var refresh = await client.PostAsJsonAsync("/api/storage/refresh", new { requestId = Guid.NewGuid() });
        var refreshAllowed = missing is not ("core.configure" or "core.storage.read");
        Assert.Equal(refreshAllowed ? HttpStatusCode.Accepted : HttpStatusCode.Forbidden, refresh.StatusCode);
        if (refreshAllowed) await host.Services.GetRequiredService<StorageUsageService>().WaitForScanAsync();
    }

    [Fact]
    public async Task AssignedOrdinaryUserCannotUseStorageEvenWithAllAppPermissions()
    {
        var fs = new ControlledFileSystem();
        await using var host = await Start(fs);
        using var client = await AppManagementHttpTests.CreateAppClient(host, "net.vendor.assigned-app", CoreAppPermissions.Known);
        await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(s => s with
        { Users = s.Users.Select(u => u with { Role = "host.user" }).ToArray() });
        using var get = await client.GetAsync("/api/storage");
        using var refresh = await client.PostAsJsonAsync("/api/storage/refresh", new { requestId = Guid.NewGuid() });
        Assert.Equal(HttpStatusCode.Forbidden, get.StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, refresh.StatusCode);
        Assert.Equal(0, fs.Scans);
    }

    [Fact]
    public async Task ScopedCoreCredentialIsNotAnOperatorSession()
    {
        await using var host = await Start(new ControlledFileSystem());
        using var client = host.CreateClient();
        await Authenticate(host, client, "host.admin");
        var store = host.Services.GetRequiredService<UserDirectoryStore>();
        await store.UpdateAsync(s => s with { Sessions = s.Sessions.Select(session => session with { Audience = "net.vendor.app" }).ToArray() });
        using var response = await client.GetAsync("/api/storage");
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    private static Task<CoreHttpHarness> Start(ControlledFileSystem fs) => CoreHttpHarness.StartAsync(configure: services =>
    { services.RemoveAll<IStorageFileSystem>(); services.AddSingleton<IStorageFileSystem>(fs); });
    private static async Task Authenticate(CoreHttpHarness host, HttpClient client, string role)
    {
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1,
            [new("user", "user@example.test", "User", role, false, now, now)], [], [],
            [new("session", "user", now, now.AddHours(1), null, now)]));
        client.DefaultRequestHeaders.Add("Cookie", $"{CoreSessionAuthorization.SessionCookieName}=session");
    }
    private static void Csrf(HttpClient client)
    {
        client.DefaultRequestHeaders.Remove("Cookie");
        client.DefaultRequestHeaders.Add("Cookie", $"{CoreSessionAuthorization.SessionCookieName}=session; {CoreSessionAuthorization.CsrfCookieName}=csrf");
        client.DefaultRequestHeaders.Add(CoreSessionAuthorization.CsrfHeaderName, "csrf");
    }
    private static async Task<JsonElement> Snapshot(HttpClient client)
    {
        using var response = await client.GetAsync("/api/storage"); response.EnsureSuccessStatusCode();
        Assert.True(response.Headers.CacheControl?.NoStore);
        return (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("snapshot").Clone();
    }
    private sealed class ControlledFileSystem : IStorageFileSystem
    {
        public int Scans;
        public bool Block, Fail;
        public ManualResetEventSlim Entered { get; } = new();
        public ManualResetEventSlim Release { get; } = new();
        public IEnumerable<StorageFileEntry> Walk(string root, CancellationToken ct)
        {
            Interlocked.Increment(ref Scans); Entered.Set();
            if (Block) Release.Wait(ct);
            if (Fail) throw new IOException("Arbitrary sensitive path and text must not reach clients");
            yield return StorageUsageTests.Entry("apps/org.third-party.example/data/file", 1, 512, 123);
        }
    }
}
