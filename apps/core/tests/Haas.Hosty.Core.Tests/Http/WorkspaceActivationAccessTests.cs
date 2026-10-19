using System.Net;
using System.Net.Http.Json;
using Haas.Hosty.Launch;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class WorkspaceActivationAccessTests
{
    [Fact]
    public async Task HarnessNeedsSeparatelyGrantedCoreCapability_AndRevocationStopsRecovery()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await AppManagementHttpTests.CreateAppClient(host, "hosty.harness", [CoreAppPermissions.Sources, CoreAppPermissions.AppLifecycle]);
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var app = (await apps.GetAppAsync("hosty.harness"))!;
        var actor = new WorkspaceActivationActor("actor", "assistant:hosty.harness", app.Id, app.InstalledAt, AppIdentityHash: AppIdentityService.HashToken(client.DefaultRequestHeaders.GetValues(AppManagementAuthorization.IdentityHeader).Single()));
        var access = host.Services.GetRequiredService<WorkspaceActivationAccess>();
        await access.ValidateAsync(actor, false, default);
        await Assert.ThrowsAsync<AppIdentityException>(() => access.ValidateAsync(actor, true, default));
        await apps.UpdateAppAsync(app.Id, a => a with { GrantedCorePermissions = [CoreAppPermissions.Sources, CoreAppPermissions.AppLifecycle, CoreAppPermissions.WorkspaceCore] });
        await access.ValidateAsync(actor, true, default);
        await apps.UpdateAppAsync(app.Id, a => a with { GrantedCorePermissions = [CoreAppPermissions.Sources, CoreAppPermissions.WorkspaceCore] });
        await Assert.ThrowsAsync<AppIdentityException>(() => access.ValidateAsync(actor, true, default));
        await apps.UpdateAppAsync(app.Id, a => a with { GrantedCorePermissions = CoreAppPermissions.Known, InstalledAt = a.InstalledAt.AddSeconds(1) });
        await Assert.ThrowsAsync<AppIdentityException>(() => access.ValidateAsync(actor, false, default));
    }

    [Fact]
    public async Task InitiatingAppGrantAndBrowserSessionAreRecheckedAtRuntimeBoundary()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await AppManagementHttpTests.CreateAppClient(host, "hosty.harness", CoreAppPermissions.Known);
        var app = (await host.Services.GetRequiredService<AppRegistryStore>().GetAppAsync("hosty.harness"))!;
        var actor = new WorkspaceActivationActor("actor", "assistant:hosty.harness", app.Id, app.InstalledAt,
            AppIdentityHash: AppIdentityService.HashToken(client.DefaultRequestHeaders.GetValues(AppManagementAuthorization.IdentityHeader).Single()));
        var browser = new WorkspaceActivationActor("actor", "manual", Principal: "browser:" + DevelopmentWorkspaceService.Hash("operator"));
        var access = host.Services.GetRequiredService<WorkspaceActivationAccess>();
        await access.ValidateAsync(actor, true, default);
        await access.ValidateAsync(browser, true, default);
        await host.Services.GetRequiredService<AppSessionGrantStore>().RevokeByAuthorizingSessionAsync("operator", DateTimeOffset.UtcNow);
        await Assert.ThrowsAsync<AppIdentityException>(() => access.ValidateAsync(actor, true, default));
        await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(state => state with
            { Sessions = state.Sessions.Select(s => s with { RevokedAt = DateTimeOffset.UtcNow }).ToArray() });
        await Assert.ThrowsAsync<AppIdentityException>(() => access.ValidateAsync(browser, true, default));
    }

    [Fact]
    public async Task DirectAuthorityNeedsBothWorkspaceLifecycleAndCoreScopes_WithoutPersistingBearer()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        var access = host.Services.GetRequiredService<WorkspaceActivationAccess>();
        var now = DateTimeOffset.UtcNow;
        var token = new AuthSessionRecord("fixture-secret", "actor", now, now.AddHours(1), null, now,
            Kind: AccessTokenKinds.Manual, Audience: AccessTokenScopes.CoreAudience,
            Scopes: [AccessTokenScopes.McpRead, AccessTokenScopes.McpWorkspaces, AccessTokenScopes.McpLifecycle]);
        await users.WriteAsync(new(1, [new("actor", null, "Actor", "host.admin", false, now, now)], [], [], [token]));
        var actor = new WorkspaceActivationActor("actor", "direct-mcp", Principal: "manual:" + DevelopmentWorkspaceService.Hash(token.Id));
        await access.ValidateAsync(actor, false, default);
        await Assert.ThrowsAsync<AppIdentityException>(() => access.ValidateAsync(actor, true, default));
        await users.UpdateAsync(s => s with { Sessions = [token with { Scopes = [.. token.Scopes!, AccessTokenScopes.McpCoreRestart] }] });
        await access.ValidateAsync(actor, true, default);
        Assert.DoesNotContain(token.Id, CoreJson.Text(actor));
        await users.UpdateAsync(s => s with { Sessions = s.Sessions.Select(t => t with { RevokedAt = now }).ToArray() });
        await Assert.ThrowsAsync<AppIdentityException>(() => access.ValidateAsync(actor, false, default));
        await Assert.ThrowsAsync<AppIdentityException>(() => access.ValidateAsync(new("actor", "delegated"), false, default));
    }

    [Theory]
    [InlineData("plan")]
    [InlineData("apply")]
    [InlineData("return")]
    [InlineData("resume")]
    public async Task BrowserMutationRequiresAdminAndCsrf(string kind)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var browser = host.CreateClient();
        var route = "/api/development/workspaces/" + new string('a', 64) + "/activation/" + kind;
        Assert.Contains((await browser.PostAsJsonAsync(route, new {})).StatusCode, new[] { HttpStatusCode.Unauthorized, HttpStatusCode.Forbidden });
        var now = DateTimeOffset.UtcNow;
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1,
            [new("admin", null, "Admin", "host.admin", false, now, now)], [], [],
            [new("operator", "admin", now, now.AddHours(1), null, now, BrowserOrigin: "http://localhost")]));
        browser.DefaultRequestHeaders.Add("Cookie", "hosty_session=operator; hosty_csrf=csrf");
        Assert.Equal(HttpStatusCode.Forbidden, (await browser.PostAsJsonAsync(route, new {})).StatusCode);
        Assert.Empty(WorkspaceRuntimeFiles.List(host.Services.GetRequiredService<CoreDataPaths>().DataRoot));
    }
}
