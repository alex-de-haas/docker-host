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
        await host.Services.GetRequiredService<AppAuthCodeStore>().AppendCodeAsync(new("generic", "console", "actor", "http://app.test", now, now.AddMinutes(1), null, "operator", CodeChallenge: AuthCodeProof.Challenge), now);
        foreach (var grant in new[] { await identity.ExchangeCodeAsync("generic", "console", AuthCodeProof.Verifier), await identity.CreateLaunchTokenAsync("console", "actor") })
        {
            Assert.Null(grant.ActiveUntil);
            Assert.True((await identity.RevalidateAsync(grant.AccessToken, "console")).Active);
            Assert.Equal("reauth_required", (await Assert.ThrowsAsync<AppIdentityException>(() => identity.RequireActivityAsync(grant.AccessToken, "console", default))).Code);
        }
    }

    [Theory]
    [InlineData("activity")]
    [InlineData("parent-expired")]
    [InlineData("parent-revoked")]
    [InlineData("parent-idle")]
    public async Task ConversationsShareAppActivity_AndExpiryOrRevocationStopsMcpAndWorkspaces(string cause)
    {
        var clock = new Clock();
        await using var host = await CoreHttpHarness.StartAsync(clock);
        using var client = await AppManagementHttpTests.CreateAppClient(host, "assistant", [CoreAppPermissions.Sources]);
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var assistant = (await apps.GetAppAsync("assistant"))! with { ConfirmedRoles = ["assistant"],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["assistant"] = [new("default", null, "/assistant")] } };
        await apps.UpsertAppAsync(assistant);
        var grant = await BrowserAuthorityFixture.Grant(host, "assistant", "actor");
        await host.Services.GetRequiredService<AgentPolicyStore>().ChangeAsync("hosty:core", new(null, true,
            new Dictionary<string, string>(), new Dictionary<string, AssistantTargetGrant> { ["assistant"] = new(assistant.InstalledAt, "link") }));
        var mcp = host.Services.GetRequiredService<AssistantMcpAccess>();
        var serviceToken = host.Services.GetRequiredService<AppServiceTokenService>().CreateToken("assistant");
        using var service = host.CreateClient();
        service.DefaultRequestHeaders.Authorization = new("Bearer", serviceToken);
        service.DefaultRequestHeaders.Add("X-Hosty-User-Token", grant.AccessToken);
        string Workspace(string session) => $"/api/internal/apps/assistant/sessions/{session}/workspaces";
        clock.UtcNow = clock.UtcNow.AddMinutes(59);
        var children = new List<string>();
        // A second conversation needs no new browser decision and cannot extend the app deadline.
        foreach (var session in new[] { "session-one", "session-two" })
        {
            var child = await mcp.IssueAsync("assistant", "hosty:core", serviceToken, grant.AccessToken, default, session);
            Assert.Equal(grant.ActiveUntil, child.ExpiresAt);
            Assert.NotNull(await mcp.ValidateAsync(child.Token, "hosty:core", default));
            children.Add(child.Token);
            (await service.GetAsync(Workspace(session))).EnsureSuccessStatusCode();
        }
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        if (cause == "activity") clock.UtcNow = clock.UtcNow.AddSeconds(61);
        else await users.UpdateAsync(state => state with { Sessions = state.Sessions.Select(s => s.Id != "browser-session" ? s : cause switch
        {
            "parent-expired" => s with { ExpiresAt = clock.UtcNow },
            "parent-revoked" => s with { RevokedAt = clock.UtcNow },
            _ => s with { LastSeenAt = clock.UtcNow.AddYears(-1) },
        }).ToArray() });
        foreach (var token in children) Assert.Null(await mcp.ValidateAsync(token, "hosty:core", default));
        foreach (var session in new[] { "session-one", "session-two" })
        {
            Assert.Equal("reauth_required", (await Assert.ThrowsAsync<AppIdentityException>(() =>
                mcp.IssueAsync("assistant", "hosty:core", serviceToken, grant.AccessToken, default, session))).Code);
            Assert.Equal(HttpStatusCode.Unauthorized, (await service.GetAsync(Workspace(session))).StatusCode);
        }
        // Normal browser renewal restores both conversations without a conversation-specific grant.
        var fresh = await BrowserAuthorityFixture.Grant(host, "assistant", "actor", "renewed-browser");
        service.DefaultRequestHeaders.Remove("X-Hosty-User-Token");
        service.DefaultRequestHeaders.Add("X-Hosty-User-Token", fresh.AccessToken);
        foreach (var session in new[] { "session-one", "session-two" })
        {
            var child = await mcp.IssueAsync("assistant", "hosty:core", serviceToken, fresh.AccessToken, default, session);
            Assert.NotNull(await mcp.ValidateAsync(child.Token, "hosty:core", default));
            (await service.GetAsync(Workspace(session))).EnsureSuccessStatusCode();
        }
    }

    [Fact]
    public async Task AssistantActivityStillRequiresBrowserProvenanceAndConfirmedInstallation()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await AppManagementHttpTests.CreateAppClient(host, "assistant", []);
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var assistant = (await apps.GetAppAsync("assistant"))!;
        var identity = host.Services.GetRequiredService<AppIdentityService>();
        var authority = host.Services.GetRequiredService<AssistantSessionAuthority>();
        var grant = await BrowserAuthorityFixture.Grant(host, assistant.Id, "actor");
        Task<AppSessionValidationResult> Require(string token, string session = "chat") =>
            authority.RequireAsync(assistant.Id, session, AppIdentityService.HashToken(token), default);
        Assert.Equal("mcp_assistant_required", (await Assert.ThrowsAsync<AppIdentityException>(() => Require(grant.AccessToken))).Code);
        assistant = assistant with { ConfirmedRoles = ["assistant"], Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["assistant"] = [new("default", null, "/assistant")] } };
        await apps.UpsertAppAsync(assistant);
        Assert.Equal("actor", (await Require(grant.AccessToken)).UserId);
        Assert.Equal("assistant_session_invalid", (await Assert.ThrowsAsync<AppIdentityException>(() => Require(grant.AccessToken, "../other"))).Code);
        var diagnostic = await identity.CreateLaunchTokenAsync(assistant.Id, "actor");
        Assert.Equal("reauth_required", (await Assert.ThrowsAsync<AppIdentityException>(() => Require(diagnostic.AccessToken))).Code);
        await apps.UpsertAppAsync(assistant with { InstalledAt = DateTimeOffset.UtcNow.AddMinutes(1) });
        Assert.Equal("token_invalid", (await Assert.ThrowsAsync<AppIdentityException>(() => Require(grant.AccessToken))).Code);
    }
}
