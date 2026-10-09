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
        client.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(appId));
        var grant = await BrowserAuthorityFixture.Grant(host, appId, "admin");
        client.DefaultRequestHeaders.Add("X-Hosty-User-Token", grant.AccessToken);
        foreach (var permission in new[] { CoreAppPermissions.Sources, CoreAppPermissions.SourcesRead, "apps.workspaces.manage" })
        {
            await apps.UpsertAppAsync(record with { GrantedCorePermissions = [permission] });
            Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(root)).StatusCode);
        }
        await apps.UpsertAppAsync(record with { GrantedCorePermissions = [CoreAppPermissions.WorkspacesRead] });
        using var response = await client.GetAsync(root);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("no-store", response.Headers.CacheControl!.ToString());
        Assert.Empty((await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("workspaces").EnumerateArray());
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/internal/apps/hosty.workspaces/sessions/session/workspaces")).StatusCode);
        Assert.Equal(HttpStatusCode.MethodNotAllowed, (await client.PostAsJsonAsync(root, new { })).StatusCode);
        client.DefaultRequestHeaders.Add("Cookie", "hosty_session=browser-session");
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(root)).StatusCode);
        client.DefaultRequestHeaders.Remove("Cookie");
        await users.UpdateAsync(s => s with { Users = s.Users.Select(u => u with { Role = "host.member" }).ToArray(), Assignments = [new(appId, "admin", now)] });
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(root)).StatusCode);
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
