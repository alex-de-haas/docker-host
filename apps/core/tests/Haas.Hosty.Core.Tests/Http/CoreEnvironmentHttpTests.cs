using System.Net;
using System.Net.Http.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class CoreEnvironmentHttpTests
{
    [Fact]
    public async Task EnvironmentApi_RequiresSeparatePermissionAndCurrentOwner()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var caller = await Client(host, "qa.client", [CoreAppPermissions.SandboxesRead, CoreAppPermissions.SandboxesManage]);
        const string root = "/api/internal/apps/qa.client/core-environments";
        Assert.Equal(HttpStatusCode.Forbidden, (await caller.GetAsync(root)).StatusCode);
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var app = (await apps.GetAppAsync("qa.client"))!;
        await apps.UpsertAppAsync(app with { GrantedCorePermissions = [CoreAppPermissions.CoreEnvironmentsRead, CoreAppPermissions.CoreEnvironmentsManage] });
        using var created = await caller.PostAsJsonAsync(root, new CoreEnvironmentCreate(Guid.NewGuid().ToString(), "QA"));
        created.EnsureSuccessStatusCode(); var view = (await created.Content.ReadFromJsonAsync<CoreEnvironmentView>())!;
        Assert.Null(view.Context);
        using var other = await Client(host, "other.client", [CoreAppPermissions.CoreEnvironmentsRead, CoreAppPermissions.CoreEnvironmentsManage]);
        Assert.Equal(HttpStatusCode.Forbidden, (await other.GetAsync("/api/internal/apps/other.client/core-environments/" + view.Id)).StatusCode);
        await apps.UpsertAppAsync(app with { GrantedCorePermissions = [] });
        Assert.Equal(HttpStatusCode.Forbidden, (await caller.GetAsync(root + "/" + view.Id)).StatusCode);
    }
    [Fact]
    public async Task OperatorMutation_RequiresCookieAndCsrf()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = host.CreateClient();
        var response = await client.PostAsJsonAsync("/api/core-environments", new CoreEnvironmentCreate(Guid.NewGuid().ToString(), "QA"));
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }
    [Fact]
    public async Task OperatorApps_NeedExplicitGrantsAndCannotUseGenericChildTransport()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var service = host.Services.GetRequiredService<CoreEnvironmentService>();
        var child = await service.CreateAsync(new("admin", "other.app", DateTimeOffset.UnixEpoch),
            new(Guid.NewGuid().ToString(), "Other app sandbox"), default);
        using var client = await AppManagementHttpTests.CreateAppClient(host, "hosty.workspaces", [CoreAppPermissions.WorkspacesRead]);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/core-environments")).StatusCode);
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var record = (await apps.GetAppAsync("hosty.workspaces"))!;
        await apps.UpsertAppAsync(record with { GrantedCorePermissions = [CoreAppPermissions.CoreEnvironmentsInspect] });
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/core-environments/" + child.Id)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/core-environments/" + child.Id + "/apps")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync("/api/core-environments/" + child.Id + "/operations/finish",
            new CoreEnvironmentCommand(Guid.NewGuid().ToString(), child.Revision))).StatusCode);
        await apps.UpsertAppAsync(record with { GrantedCorePermissions = [CoreAppPermissions.CoreEnvironmentsInspect, CoreAppPermissions.CoreEnvironmentsOperate] });
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync("/api/core-environments/from-workspace",
            new CoreEnvironmentWorkspaceCreate(Guid.NewGuid().ToString(), "Denied", "missing", ["missing"]))).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync("/api/core-environments/" + child.Id + "/api",
            new CoreEnvironmentApiRequest("GET", "/api/apps"))).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync("/api/core-environments", new CoreEnvironmentCreate(Guid.NewGuid().ToString(), "Denied"))).StatusCode);
        var finished = await client.PostAsJsonAsync("/api/core-environments/" + child.Id + "/operations/finish",
            new CoreEnvironmentCommand(Guid.NewGuid().ToString(), child.Revision));
        finished.EnsureSuccessStatusCode();
        Assert.Equal("finished", (await finished.Content.ReadFromJsonAsync<CoreEnvironmentView>())!.State);
        await apps.UpsertAppAsync(record with { GrantedCorePermissions = [] });
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/core-environments")).StatusCode);
    }
    private static async Task<HttpClient> Client(CoreHttpHarness host, string id, string[] permissions)
    {
        var client = await AppManagementHttpTests.CreateAppClient(host, id, permissions);
        var token = client.DefaultRequestHeaders.GetValues(AppManagementAuthorization.IdentityHeader).Single();
        client.DefaultRequestHeaders.Remove(AppManagementAuthorization.IdentityHeader);
        client.DefaultRequestHeaders.Add("X-Hosty-User-Token", token); return client;
    }
}
