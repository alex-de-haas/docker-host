using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Haas.Hosty.Core;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class DevelopmentWorkspaceHttpTests
{
    private const string Root = "/api/internal/apps/hosty.harness/sessions/session-one/workspaces";
    [Fact]
    public async Task ServiceRequestsRequireReviewedPermissionAndCurrentAdminAudience()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        await users.WriteAsync(new UserDirectoryState(1,
            [new HostUserRecord("admin", "admin@example.test", "Admin", "host.admin", false, now, now)], [], [], []));
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var app = new AppRecord("hosty.harness", "Harness", null, "1.0.0", "runtime", true, "installed", null, null,
            "local", "installed", "running", null, null, [], new Dictionary<string, AppSettingValue>(), [], [], [], now, now);
        app = app with { ConfirmedRoles = ["assistant"], Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["assistant"] = [new("default", null, "/assistant")] } };
        await apps.UpsertAppAsync(app);
        using var client = host.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(Root)).StatusCode);
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(app.Id));
        var tokens = host.Services.GetRequiredService<DelegatedTokenService>();
        client.DefaultRequestHeaders.Add("X-Hosty-User-Token", tokens.CreateToken(app.Id, "admin", "host.admin").Token);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(Root)).StatusCode);
        await apps.UpsertAppAsync(app with { GrantedCorePermissions = [CoreAppPermissions.Sources] });
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(Root)).StatusCode);
        var browserGrant = await BrowserAuthorityFixture.Grant(host, app.Id, "admin");
        client.DefaultRequestHeaders.Remove("X-Hosty-User-Token");
        client.DefaultRequestHeaders.Add("X-Hosty-User-Token", browserGrant.AccessToken);
        var success = await client.GetAsync(Root);
        Assert.Equal(HttpStatusCode.OK, success.StatusCode);
        Assert.Contains("workspaces", await success.Content.ReadAsStringAsync());
        client.DefaultRequestHeaders.Remove("X-Hosty-User-Token");
        client.DefaultRequestHeaders.Add("X-Hosty-User-Token", tokens.CreateToken("other.app", "admin", "host.admin").Token);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(Root)).StatusCode);
        client.DefaultRequestHeaders.Remove("X-Hosty-User-Token");
        client.DefaultRequestHeaders.Add("X-Hosty-User-Token", browserGrant.AccessToken);
        await users.UpdateAsync(state => state with { Users = state.Users.Select(u => u with { Role = "host.user" }).ToArray() });
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(Root)).StatusCode);
    }

    [Fact]
    public async Task BrowserMutationsRequireAdminCookieAndCsrf()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        await users.WriteAsync(new UserDirectoryState(1,
            [new HostUserRecord("admin", "admin@example.test", "Admin", "host.admin", false, now, now)], [], [],
            [new AuthSessionRecord("operator", "admin", now, now.AddHours(1), null, now, BrowserOrigin: "http://localhost")]));
        using var client = host.CreateClient();
        var route = "/api/development/workspaces/" + new string('a', 64) + "/operations/cleanup";
        async Task<HttpStatusCode> Post() => (await client.PostAsJsonAsync(route, new { requestId = Guid.NewGuid().ToString(), expectedHead = "test" })).StatusCode;
        Assert.NotEqual(HttpStatusCode.NotFound, await Post());
        client.DefaultRequestHeaders.Add("Cookie", "hosty_session=operator; hosty_csrf=csrf");
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/development/workspaces")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, await Post());
        client.DefaultRequestHeaders.Add("X-Hosty-CSRF", "csrf");
        Assert.Equal(HttpStatusCode.NotFound, await Post());
    }
}
