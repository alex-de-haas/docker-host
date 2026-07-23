using System.Net;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

// End-to-end HTTP coverage for the app-asset authorization (C-H4), which until the harness existed was
// verified only by driving a live Core by hand. It doubles as proof the enumeration guard is not
// vacuous: an authenticated session DOES reach a protected route here, so the anonymous 401s elsewhere
// are real authorization, not a globally broken app.
public sealed class AppAssetAuthorizationHttpTests
{
    [Fact]
    public async Task AssetEndpoint_EnforcesSessionAndAssignment()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var paths = harness.Services.GetRequiredService<CoreDataPaths>();
        var users = harness.Services.GetRequiredService<UserDirectoryStore>();
        var apps = harness.Services.GetRequiredService<AppRegistryStore>();
        var now = harness.Services.GetRequiredService<IClock>().UtcNow;

        // An installed app with a real display asset on disk, plus a private file under its data root —
        // the exact IDOR target: /assets/data/... must never be served even to a permitted user.
        const string appId = "com.example.notes";
        await apps.UpsertAppAsync(CreateApp(appId));
        var appRoot = Path.Combine(paths.AppsRoot, appId);
        Directory.CreateDirectory(Path.Combine(appRoot, "assets"));
        await File.WriteAllTextAsync(Path.Combine(appRoot, "assets", "icon.svg"), "<svg/>");
        Directory.CreateDirectory(Path.Combine(appRoot, "data"));
        await File.WriteAllTextAsync(Path.Combine(appRoot, "data", "secret.txt"), "private");

        // Two sessions: an admin (sees everything) and a plain user assigned to nothing.
        var admin = SeedUser("user_admin", "host.admin", now);
        var user = SeedUser("user_1", "host.user", now);
        await users.WriteAsync(new UserDirectoryState(
            1,
            [admin.User, user.User],
            [],
            [],
            [admin.Session, user.Session]));

        using var client = harness.CreateClient();
        var assetUrl = $"/api/apps/{appId}/assets/assets/icon.svg";
        var dataUrl = $"/api/apps/{appId}/assets/data/secret.txt";

        // Anonymous: rejected.
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(assetUrl)).StatusCode);

        // Unassigned user: 404 (not 403 — must not learn the app exists), and no data leak.
        Assert.Equal(HttpStatusCode.NotFound, (await GetAsAsync(client, assetUrl, user.Session.Id)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await GetAsAsync(client, dataUrl, user.Session.Id)).StatusCode);

        // Admin: serves the display asset, still refuses the reserved data path.
        var adminAsset = await GetAsAsync(client, assetUrl, admin.Session.Id);
        Assert.Equal(HttpStatusCode.OK, adminAsset.StatusCode);
        Assert.Equal("<svg/>", await adminAsset.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.NotFound, (await GetAsAsync(client, dataUrl, admin.Session.Id)).StatusCode);

        // Assign the app to the plain user: the display asset flips to 200, the data path stays 404.
        await users.UpdateAsync(state => state with
        {
            Assignments = [new AppAssignmentRecord(appId, user.User.Id, now)],
        });
        Assert.Equal(HttpStatusCode.OK, (await GetAsAsync(client, assetUrl, user.Session.Id)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await GetAsAsync(client, dataUrl, user.Session.Id)).StatusCode);
    }

    private static async Task<HttpResponseMessage> GetAsAsync(HttpClient client, string url, string sessionId)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, url);
        request.Headers.Add("Cookie", $"{CoreSessionAuthorization.SessionCookieName}={sessionId}");
        return await client.SendAsync(request);
    }

    private static (HostUserRecord User, AuthSessionRecord Session) SeedUser(string id, string role, DateTimeOffset now)
    {
        var user = new HostUserRecord(id, $"{id}@example.test", id, role, false, now, now);
        var session = new AuthSessionRecord($"sess_{id}", id, now, now.AddHours(1), null, now);
        return (user, session);
    }

    private static AppRecord CreateApp(string id)
        => new(
            Id: id,
            DisplayName: "Notes",
            Description: "Personal notes app.",
            Version: "1.0.0",
            Kind: "runtime",
            System: false,
            Source: "installed",
            ManifestPath: $"apps/{id}/manifest.json",
            ManifestUrl: null,
            SelectedRuntime: "docker",
            OperationStatus: "installed",
            RuntimeState: "stopped",
            LastOperation: null,
            LastError: null,
            Capabilities: ["open"],
            Settings: new Dictionary<string, AppSettingValue>(),
            StorageMappings: [],
            Dependencies: [],
            Endpoints: [],
            InstalledAt: DateTimeOffset.UtcNow,
            UpdatedAt: DateTimeOffset.UtcNow);
}
