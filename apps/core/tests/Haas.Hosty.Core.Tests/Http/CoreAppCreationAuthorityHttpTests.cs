using System.Net;
using System.Net.Http.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class CoreAppCreationAuthorityHttpTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CanonicalCreation_UsesRealCallerAndOpaqueTaskWithoutConversation(bool installedCaller)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        await users.WriteAsync(new(1, [new("admin", "admin@example.test", "Admin", "host.admin", false, now, now)], [], [], []));
        using var client = host.CreateClient();
        string? direct = null;
        var caller = AssistantMcpAccessHttpTests.Record("independent.builder", now) with { GrantedCorePermissions = [CoreAppPermissions.Sources], Interfaces = null, ConfirmedRoles = [] };
        if (installedCaller)
        {
            await apps.UpsertAppAsync(caller);
            var grant = await BrowserAuthorityFixture.Grant(host, caller.Id, "admin");
            client.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(caller.Id));
            client.DefaultRequestHeaders.Add(AppManagementAuthorization.IdentityHeader, grant.AccessToken);
        }
        else
        {
            Assert.Empty(await apps.ListAppRecordsAsync(default));
            direct = (await AccessTokenEndpoints.IssueAsync("admin", AccessTokenKinds.Manual, "Builder", users,
                host.Services.GetRequiredService<IClock>(), host.Services.GetRequiredService<AuthLifetimes>(), default,
                audience: AccessTokenScopes.CoreAudience, scopes: [AccessTokenScopes.McpRead, AccessTokenScopes.McpWorkspaces])).Id;
            client.DefaultRequestHeaders.Authorization = new("Bearer", direct);
        }
        var input = new CanonicalAppCreation("opaque-task", Guid.NewGuid().ToString(), new(Guid.NewGuid().ToString(), "example.created", "Created application",
            BootstrapCommit: true, AuthorName: "Test", AuthorEmail: "test@example.test"));
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync("/api/app-creations/v1/create", input)).StatusCode);
        Assert.Null(await apps.GetAppAsync(input.Input.AppId));
        if (installedCaller) await apps.UpsertAppAsync(caller with { GrantedCorePermissions = [CoreAppPermissions.Sources, CoreAppPermissions.Install] });
        else await users.UpdateAsync(s => s with { Sessions = s.Sessions.Select(v => v.Id == direct ? v with {
            Scopes = [AccessTokenScopes.McpRead, AccessTokenScopes.McpWorkspaces, AccessTokenScopes.McpAppCreate] } : v).ToArray() });
        var response = await client.PostAsJsonAsync("/api/app-creations/v1/create", input);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var result = (await response.Content.ReadFromJsonAsync<AppCreationResult>())!;
        Assert.NotNull(result.Workspace); Assert.Null(result.Workspace.SessionPath);
        Assert.Equal(installedCaller ? caller.Id : "", result.Workspace.Owner.AppId);
        Assert.Equal("opaque-task", result.Workspace.Owner.SessionId);
        Assert.Contains(input.LeaseId, result.Workspace.Leases);
        var repeated = (await (await client.PostAsJsonAsync("/api/app-creations/v1/create", input)).Content.ReadFromJsonAsync<AppCreationResult>())!;
        Assert.Equal(result.Workspace.Id, repeated.Workspace!.Id);
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/app-creations/v1/get", new CanonicalAppCreationStatus(input.TaskId, input.Input.RequestId))).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync("/api/app-creations/v1/get", new CanonicalAppCreationStatus("other-task", input.Input.RequestId))).StatusCode);
    }
}
