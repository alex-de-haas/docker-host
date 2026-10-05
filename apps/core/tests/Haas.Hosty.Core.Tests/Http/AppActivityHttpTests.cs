using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class AppActivityHttpTests
{
    private sealed class Clock : IClock { public DateTimeOffset UtcNow { get; set; } = DateTimeOffset.UtcNow; }

    [Theory]
    [InlineData("window")]
    [InlineData("parent-expired")]
    [InlineData("parent-removed")]
    public async Task ManagementExpiresWithoutRevokingIdentity_AndBrowserExchangeRestoresIt(string cause)
    {
        var clock = new Clock();
        await using var host = await CoreHttpHarness.StartAsync(clock);
        using var client = await AppManagementHttpTests.CreateAppClient(host, "console", [CoreAppPermissions.ReadApps]);
        var identity = host.Services.GetRequiredService<AppIdentityService>();
        var token = client.DefaultRequestHeaders.GetValues(AppManagementAuthorization.IdentityHeader).Single();
        var initial = await identity.RequireActivityAsync(token, "console", default);
        Assert.Equal(clock.UtcNow.AddHours(1), initial.ActiveUntil);
        clock.UtcNow = clock.UtcNow.AddMinutes(45);
        await identity.RevalidateAsync(token, "console");
        Assert.Equal(initial.ActiveUntil, (await identity.RevalidateAsync(token, "console")).ActiveUntil);
        (await client.GetAsync("/api/apps")).EnsureSuccessStatusCode();
        if (cause == "window") clock.UtcNow = clock.UtcNow.AddMinutes(16);
        else await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(s => s with {
            Sessions = cause == "parent-removed" ? [] : s.Sessions.Select(x => x with { ExpiresAt = clock.UtcNow }).ToArray() });
        var denied = await client.GetAsync("/api/apps");
        Assert.Equal(HttpStatusCode.Unauthorized, denied.StatusCode);
        Assert.Equal("reauth_required", (await denied.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
        Assert.True((await identity.RevalidateAsync(token, "console")).Active);
        if (cause != "window") Assert.Equal("reauth_required", (await Assert.ThrowsAsync<AppIdentityException>(() =>
            host.Services.GetRequiredService<AssistantSessionAuthority>().StatusAsync("console", "session-one", token, default))).Code);
        (await client.GetAsync("/api/profile")).EnsureSuccessStatusCode();
        var renewed = await BrowserAuthorityFixture.Grant(host, "console", "actor", "operator");
        client.DefaultRequestHeaders.Remove(AppManagementAuthorization.IdentityHeader);
        client.DefaultRequestHeaders.Add(AppManagementAuthorization.IdentityHeader, renewed.AccessToken);
        (await client.GetAsync("/api/apps")).EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task AssistantProviderChecksActivityAgainWhenChildTokenIsUsed()
    {
        var clock = new Clock();
        await using var host = await CoreHttpHarness.StartAsync(clock);
        using var client = await AppManagementHttpTests.CreateAppClient(host, "console", [CoreAppPermissions.AssistantProviders]);
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var caller = (await apps.GetAppAsync("console"))!;
        var target = AssistantMcpAccessHttpTests.Record("provider", clock.UtcNow) with { ConfirmedRoles = ["assistant"],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["assistant"] = [new("default", "api", "/api/assistant/v1", 1, [])] },
            Endpoints = [new("api", "http", "http://provider.test", true)] };
        await apps.UpsertAppAsync(target);
        var token = client.DefaultRequestHeaders.GetValues(AppManagementAuthorization.IdentityHeader).Single();
        var access = host.Services.GetRequiredService<ProviderAccessService>();
        clock.UtcNow = clock.UtcNow.AddMinutes(59);
        var issued = await access.IssueAsync(caller, "assistant", new(target.Id), token, default);
        await access.ValidateAsync(target, new(issued.Token, "assistant"), default);
        clock.UtcNow = clock.UtcNow.AddSeconds(61);
        Assert.Equal("reauth_required", (await Assert.ThrowsAsync<AppIdentityException>(() => access.IssueAsync(caller, "assistant", new(target.Id), token, default))).Code);
        Assert.Equal("reauth_required", (await Assert.ThrowsAsync<AppIdentityException>(() => access.ValidateAsync(target, new(issued.Token, "assistant"), default))).Code);
        var fresh = await BrowserAuthorityFixture.Grant(host, caller.Id, "actor", "operator");
        await access.IssueAsync(caller, "assistant", new(target.Id), fresh.AccessToken, default);
    }

    [Fact]
    public async Task GenericCodeAndDiagnosticGrantCannotEstablishActivity()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await AppManagementHttpTests.CreateAppClient(host, "console", [CoreAppPermissions.ReadApps]);
        var identity = host.Services.GetRequiredService<AppIdentityService>();
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        await host.Services.GetRequiredService<AppAuthCodeStore>().AppendCodeAsync(new("generic", "console", "actor", "http://app.test", now, now.AddMinutes(1), null, "operator"), now);
        foreach (var grant in new[] { await identity.ExchangeCodeAsync("generic"), await identity.CreateLaunchTokenAsync("console", "actor") })
        {
            Assert.Null(grant.ActiveUntil);
            Assert.True((await identity.RevalidateAsync(grant.AccessToken, "console")).Active);
            Assert.Equal("reauth_required", (await Assert.ThrowsAsync<AppIdentityException>(() => identity.RequireActivityAsync(grant.AccessToken, "console", default))).Code);
        }
    }

    [Theory]
    [InlineData("approve")]
    [InlineData("approve_session")]
    public async Task SessionApprovalRequiresCoreBrowserForm_AndCannotBeWrittenThroughServiceApi(string choice)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var service = await AppManagementHttpTests.CreateAppClient(host, "assistant", []);
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        await apps.UpsertAppAsync((await apps.GetAppAsync("assistant"))! with { ConfirmedRoles = ["assistant"],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["assistant"] = [new("default", null, "/assistant")] } });
        const string path = "/activity/assistants/assistant/session-one";
        Assert.False((await service.PostAsJsonAsync("/api/internal/apps/assistant/sessions/session-one/authority", new { activeUntil = DateTimeOffset.UtcNow.AddYears(1) })).IsSuccessStatusCode);
        using var browser = host.CreateClient(); browser.BaseAddress = new Uri("http://localhost:7070");
        Assert.Equal(HttpStatusCode.Redirect, (await browser.GetAsync(path)).StatusCode);
        browser.DefaultRequestHeaders.Add("Cookie", "hosty_session=operator");
        var page = await browser.GetAsync(path); page.EnsureSuccessStatusCode();
        var html = await page.Content.ReadAsStringAsync();
        Assert.Contains("Allow for one hour", html);
        var nonce = System.Text.RegularExpressions.Regex.Match(html, "name=\"nonce\" value=\"([^\"]+)\"").Groups[1].Value;
        Assert.NotEmpty(nonce);
        var form = new Dictionary<string, string> { ["nonce"] = nonce, ["decision"] = choice };
        Assert.Equal(HttpStatusCode.Forbidden, (await browser.PostAsync(path, new FormUrlEncodedContent(form))).StatusCode);
        browser.DefaultRequestHeaders.Add("Origin", "http://localhost:7070");
        (await browser.PostAsync(path, new FormUrlEncodedContent(form))).EnsureSuccessStatusCode();
        Assert.False((await browser.PostAsync(path, new FormUrlEncodedContent(form))).IsSuccessStatusCode);
        var token = service.DefaultRequestHeaders.GetValues(AppManagementAuthorization.IdentityHeader).Single();
        Assert.True((await host.Services.GetRequiredService<AssistantSessionAuthority>().StatusAsync("assistant", "session-one", token, default)).Active);
    }

    [Fact]
    public async Task SessionDurationSurvivesOneHour_ButHonorsRevocationAndSignInExpiry()
    {
        var clock = new Clock();
        await using var host = await CoreHttpHarness.StartAsync(clock);
        using var client = await AppManagementHttpTests.CreateAppClient(host, "assistant", []);
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        await apps.UpsertAppAsync((await apps.GetAppAsync("assistant"))! with { ConfirmedRoles = ["assistant"],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["assistant"] = [new("default", null, "/assistant")] } });
        var grant = await BrowserAuthorityFixture.Grant(host, "assistant", "actor");
        var authority = host.Services.GetRequiredService<AssistantSessionAuthority>();
        var hash = AppIdentityService.HashToken(grant.AccessToken);
        async Task Decide(string choice)
        {
            var nonce = await authority.CreateDecisionAsync("assistant", "chat", "actor", "browser-session", default);
            await authority.DecideAsync(nonce, "assistant", "chat", "actor", "browser-session", choice, default);
        }
        await Decide("approve_session");
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        var browser = (await users.ReadAsync()).Sessions.Single(s => s.Id == "browser-session");
        Assert.Equal(browser.ExpiresAt, (await authority.RequireAsync("assistant", "chat", hash, default)).ActiveUntil);
        clock.UtcNow = clock.UtcNow.AddMinutes(61);
        await users.UpdateAsync(state => state with { Sessions = state.Sessions.Select(s => s.Id == browser.Id ? s with { LastSeenAt = clock.UtcNow } : s).ToArray() });
        Assert.Equal("session", (await authority.StatusAsync("assistant", "chat", grant.AccessToken, default)).Duration);
        await Decide("revoke");
        await Assert.ThrowsAsync<AppIdentityException>(() => authority.RequireAsync("assistant", "chat", hash, default));
        await Decide("approve_session");
        await users.UpdateAsync(state => state with { Sessions = state.Sessions.Select(s => s.Id == browser.Id ? s with { RevokedAt = clock.UtcNow } : s).ToArray() });
        await Assert.ThrowsAsync<AppIdentityException>(() => authority.RequireAsync("assistant", "chat", hash, default));
        await users.UpdateAsync(state => state with { Sessions = state.Sessions.Select(s => s.Id == browser.Id ? s with { RevokedAt = null } : s).ToArray() });
        clock.UtcNow = browser.ExpiresAt;
        await Assert.ThrowsAsync<AppIdentityException>(() => authority.RequireAsync("assistant", "chat", hash, default));
    }

    [Fact]
    public async Task SessionLeaseExpires_Renews_Revokes_AndCannotMoveToAnotherConversation()
    {
        var clock = new Clock();
        await using var host = await CoreHttpHarness.StartAsync(clock);
        using var client = await AppManagementHttpTests.CreateAppClient(host, "assistant", [CoreAppPermissions.Sources]);
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        await apps.UpsertAppAsync((await apps.GetAppAsync("assistant"))! with { ConfirmedRoles = ["assistant"],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["assistant"] = [new("default", null, "/assistant")] } });
        var grant = await BrowserAuthorityFixture.Grant(host, "assistant", "actor");
        var authority = host.Services.GetRequiredService<AssistantSessionAuthority>();
        var hash = AppIdentityService.HashToken(grant.AccessToken);
        await Assert.ThrowsAsync<AppIdentityException>(() => authority.RequireAsync("assistant", "session-one", hash, default));
        await BrowserAuthorityFixture.Approve(host, "assistant", "actor");
        var lease = await authority.RequireAsync("assistant", "session-one", hash, default);
        Assert.Equal(clock.UtcNow.AddHours(1), lease.ActiveUntil);
        await Assert.ThrowsAsync<AppIdentityException>(() => authority.RequireAsync("assistant", "session-two", hash, default));
        await host.Services.GetRequiredService<AgentPolicyStore>().ChangeAsync("hosty:core", new(null, true,
            new Dictionary<string, string>(), new Dictionary<string, AssistantTargetGrant> { ["assistant"] = new(clock.UtcNow, "link") }));
        var mcp = host.Services.GetRequiredService<AssistantMcpAccess>();
        var mcpService = host.Services.GetRequiredService<AppServiceTokenService>().CreateToken("assistant");
        var child = await mcp.IssueAsync("assistant", "hosty:core", mcpService, grant.AccessToken, default, "session-one");
        Assert.NotNull(await mcp.ValidateAsync(child.Token, "hosty:core", default));
        await BrowserAuthorityFixture.Approve(host, "assistant", "actor");
        Assert.Null(await mcp.ValidateAsync(child.Token, "hosty:core", default));
        using var service = host.CreateClient();
        service.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken("assistant"));
        service.DefaultRequestHeaders.Add("X-Hosty-User-Token", grant.AccessToken);
        const string workspace = "/api/internal/apps/assistant/sessions/session-one/workspaces";
        (await service.GetAsync(workspace)).EnsureSuccessStatusCode();
        clock.UtcNow = clock.UtcNow.AddMinutes(61);
        var mcpDenied = await Assert.ThrowsAsync<AppIdentityException>(() => mcp.IssueAsync("assistant", "hosty:core", mcpService, grant.AccessToken, default, "session-one"));
        Assert.Equal("reauth_required", mcpDenied.Code);
        var expired = await service.GetAsync(workspace);
        Assert.Equal(HttpStatusCode.Unauthorized, expired.StatusCode);
        Assert.Contains("reauth_required", await expired.Content.ReadAsStringAsync());
        await BrowserAuthorityFixture.Approve(host, "assistant", "actor");
        var fresh = await authority.RequireAsync("assistant", "session-one", hash, default);
        Assert.NotEqual(lease.Revision, fresh.Revision);
        // Explicit session authority substitutes for app activity, never for the parent login.
        (await service.GetAsync(workspace)).EnsureSuccessStatusCode();
        var nonce = await authority.CreateDecisionAsync("assistant", "session-one", "actor", "browser-session", default);
        await authority.DecideAsync(nonce, "assistant", "session-one", "actor", "browser-session", "revoke", default);
        Assert.Equal(HttpStatusCode.Unauthorized, (await service.GetAsync(workspace)).StatusCode);
        await Assert.ThrowsAsync<AppIdentityException>(() => authority.DecideAsync(nonce, "assistant", "session-one", "actor", "browser-session", "approve", default));
    }
}
