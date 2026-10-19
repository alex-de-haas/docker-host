using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Haas.Hosty.Core;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class WorkspaceInspectionHttpTests
{
    [Fact]
    public async Task InspectionRequiresItsOwnGrantAndActiveAppAdministratorAndDoesNotGrantMutations()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        const string appId = "hosty.workspaces";
        const string root = "/api/internal/apps/hosty.workspaces/workspace-inspection";
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        var record = AssistantMcpAccessHttpTests.Record(appId, now);
        await apps.UpsertAppAsync(record);
        await users.WriteAsync(new(1, [new("admin", "admin@example.test", "Admin", "host.admin", false, now, now)], [], [], []));
        using var client = host.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(root)).StatusCode);
        var previewRoot = root + "/" + new string('a', 64) + "/previews/" + new string('b', 32) + "/example.app/";
        foreach (var action in new[] { "checks", "run", "restart", "logs" })
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsJsonAsync(previewRoot + action,
                new { id = "web/test", digest = "test", requestId = Guid.NewGuid().ToString() })).StatusCode);
        var resourcePath = root + "/" + new string('a', 64) + "/environments/" + new string('b', 32) + "/stop";
        var resourceBody = new CoreEnvironmentCommand(Guid.NewGuid().ToString(), 0);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsJsonAsync(resourcePath, resourceBody)).StatusCode);
        var recovery = root + "/" + new string('a', 64) + "/worktrees/" + new string('b', 64) + "/recover-lease";
        var recoveryBody = new WorkspaceLeaseRecovery(Guid.NewGuid().ToString(), "head", Guid.NewGuid().ToString(), true);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsJsonAsync(recovery, recoveryBody)).StatusCode);
        client.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(appId));
        var grant = await BrowserAuthorityFixture.Grant(host, appId, "admin");
        client.DefaultRequestHeaders.Add("X-Hosty-User-Token", grant.AccessToken);
        foreach (var permission in new[] { CoreAppPermissions.Sources, CoreAppPermissions.SourcesRead, "apps.workspaces.manage" })
        {
            await apps.UpsertAppAsync(record with { GrantedCorePermissions = [permission] });
            Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(root)).StatusCode);
        }
        await apps.UpsertAppAsync(record with { GrantedCorePermissions = [CoreAppPermissions.WorkspacesRead] });
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync(recovery, recoveryBody)).StatusCode);
        using var response = await client.GetAsync(root);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("no-store", response.Headers.CacheControl!.ToString());
        Assert.Empty((await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("workspaces").EnumerateArray());
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/internal/apps/hosty.workspaces/sessions/session/workspaces")).StatusCode);
        Assert.Equal(HttpStatusCode.MethodNotAllowed, (await client.PostAsJsonAsync(root, new { })).StatusCode);
        await apps.UpsertAppAsync(record with { GrantedCorePermissions = [CoreAppPermissions.WorkspacesRead, CoreAppPermissions.Sources] });
        client.DefaultRequestHeaders.Add("Cookie", "hosty_session=browser-session");
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(root)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync(recovery, recoveryBody)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync(resourcePath, resourceBody)).StatusCode);
        client.DefaultRequestHeaders.Remove("Cookie");
        await users.UpdateAsync(s => s with { Users = s.Users.Select(u => u with { Role = "host.member" }).ToArray(), Assignments = [new(appId, "admin", now)] });
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(root)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync(recovery, recoveryBody)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync(resourcePath, resourceBody)).StatusCode);
        foreach (var action in new[] { "checks", "run", "restart", "logs" })
            Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync(previewRoot + action,
                new { id = "web/test", digest = "test", requestId = Guid.NewGuid().ToString() })).StatusCode);
    }

    [Theory]
    [InlineData("//evil.test/path")]
    [InlineData("/\\evil.test/path")]
    [InlineData("https://evil.test/path")]
    [InlineData("/path\n")]
    public void SessionDestinationRejectsEscapes(string path)
    {
        var app = AssistantMcpAccessHttpTests.Record("owner.app", DateTimeOffset.UtcNow) with { Endpoints = [new("http", "http", "http://localhost:43210", true)] };
        Assert.Null(WorkspaceInspectionService.BrowserDestination(app, path).Url);
    }
    [Fact]
    public void SessionDestinationUsesCurrentApplicationOriginAndKeepsOpaqueSessionQuery()
    {
        var app = AssistantMcpAccessHttpTests.Record("owner.app", DateTimeOffset.UtcNow) with {
            Endpoints = [new("http", "http", "http://localhost:43210", true)] };
        var destination = WorkspaceInspectionService.BrowserDestination(app, "/assistant?session=one%2Ftwo");
        Assert.NotNull(destination.Url);
        Assert.Equal(LocalBrowserOrigins.App(app, app.Endpoints[0]), new Uri(destination.Url).GetLeftPart(UriPartial.Authority));
        Assert.EndsWith("/assistant?session=one%2Ftwo", destination.Url);
        Assert.Null(WorkspaceInspectionService.BrowserDestination(null, "/assistant").Url);
    }

}
