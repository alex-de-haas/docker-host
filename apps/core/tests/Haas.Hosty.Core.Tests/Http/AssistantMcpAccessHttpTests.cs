using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class AssistantMcpAccessHttpTests
{
    [Theory]
    [InlineData("revoke")]
    [InlineData("caller-reinstall")]
    [InlineData("target-reinstall")]
    [InlineData("user-disabled")]
    [InlineData("user-unassigned")]
    [InlineData("logout")]
    [InlineData("offer-disabled")]
    public async Task ExplicitLinkAndLiveIdentityRequiredAtIssueAndUse(string change)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        var identity = host.Services.GetRequiredService<AppIdentityService>();
        var policy = host.Services.GetRequiredService<AgentPolicyStore>();
        var tokens = host.Services.GetRequiredService<AppServiceTokenService>();
        var now = DateTimeOffset.UtcNow;
        var caller = Record("example.assistant", now) with { ConfirmedRoles = ["assistant"], Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["assistant"] = [new("default", null, "/assistant")] } };
        var target = Record("example.target", now) with { Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["mcp"] = [new("default", null, "/mcp")] } };
        await apps.UpsertAppAsync(caller); await apps.UpsertAppAsync(target);
        await users.WriteAsync(new(1, [new("user", "user@example.test", "User", "host.member", false, now, now)], [], [new(caller.Id, "user", now), new(target.Id, "user", now)], []));
        var parent = await BrowserAuthorityFixture.Grant(host, caller.Id, "user");
        await BrowserAuthorityFixture.Approve(host, caller.Id, "user");
        using var client = host.CreateClient();
        async Task<HttpResponseMessage> Issue(string serviceApp, string userToken)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/internal/apps/{caller.Id}/mcp/token")
            { Content = JsonContent.Create(new { targetAppId = target.Id, sessionId = "session-one" }) };
            request.Headers.Authorization = new("Bearer", tokens.CreateToken(serviceApp));
            request.Headers.Add("X-Hosty-User-Token", userToken);
            return await client.SendAsync(request);
        }
        async Task<JsonElement> Inspect(string token, string audience, string? purpose = "mcp")
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/internal/apps/{audience}/token/introspect")
            { Content = JsonContent.Create(new { token, purpose, tool = "test_tool" }) };
            request.Headers.Authorization = new("Bearer", tokens.CreateToken(audience));
            using var response = await client.SendAsync(request);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            return await response.Content.ReadFromJsonAsync<JsonElement>();
        }
        var link = new AgentTargetPolicy(target.InstalledAt, true, new Dictionary<string, string>(),
            new Dictionary<string, AssistantTargetGrant> { [caller.Id] = new(caller.InstalledAt, "grant-1") });
        // Existing global offers are not imported as assistant grants.
        await policy.ChangeAsync(target.Id, link with { Assistants = null });
        Assert.Equal(HttpStatusCode.Forbidden, (await Issue(caller.Id, parent.AccessToken)).StatusCode);
        await policy.ChangeAsync(target.Id, link);
        Assert.Equal(HttpStatusCode.Unauthorized, (await Issue(target.Id, parent.AccessToken)).StatusCode);
        var wrongUserGrant = await identity.CreateLaunchTokenAsync(target.Id, "user");
        Assert.Equal(HttpStatusCode.Forbidden, (await Issue(caller.Id, wrongUserGrant.AccessToken)).StatusCode);
        using var issued = await Issue(caller.Id, parent.AccessToken);
        Assert.Equal(HttpStatusCode.OK, issued.StatusCode);
        var token = (await issued.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("token").GetString()!;
        var valid = await Inspect(token, target.Id);
        Assert.True(valid.GetProperty("active").GetBoolean());
        Assert.Equal("user", valid.GetProperty("sub").GetString());
        Assert.Equal(caller.Id, valid.GetProperty("callerAppId").GetString());
        Assert.Contains("mcp:invoke", valid.GetProperty("scopes").EnumerateArray().Select(s => s.GetString()));
        Assert.False((await Inspect(token, target.Id, null)).GetProperty("active").GetBoolean());
        Assert.False((await Inspect(token, caller.Id)).GetProperty("active").GetBoolean());
        Assert.False((await Inspect(token + "bad", target.Id)).GetProperty("active").GetBoolean());
        Assert.Null(host.Services.GetRequiredService<DelegatedTokenService>().ValidateToken(token, target.Id));
        using var api = new HttpRequestMessage(HttpMethod.Get, "/api/profile");
        api.Headers.Authorization = new("Bearer", token);
        Assert.False((await client.SendAsync(api)).IsSuccessStatusCode);
        switch (change)
        {
            case "revoke": await policy.ChangeAsync(target.Id, link with { Assistants = null }); break;
            case "caller-reinstall": await apps.UpsertAppAsync(caller with { InstalledAt = now.AddSeconds(1) }); break;
            case "target-reinstall": await apps.UpsertAppAsync(target with { InstalledAt = now.AddSeconds(1) }); break;
            case "user-disabled":
                var state = await users.ReadAsync();
                await users.WriteAsync(state with { Users = state.Users.Select(u => u with { Disabled = true }).ToArray() }); break;
            case "user-unassigned":
                var assigned = await users.ReadAsync();
                await users.WriteAsync(assigned with { Assignments = assigned.Assignments.Where(a => a.AppId != target.Id).ToArray() }); break;
            case "logout":
                await host.Services.GetRequiredService<AppSessionGrantStore>().RevokeByAuthorizingSessionAsync("browser-session", now, default); break;
            case "offer-disabled": await policy.ChangeAsync(target.Id, link with { Offered = false }); break;
        }
        Assert.False((await Inspect(token, target.Id)).GetProperty("active").GetBoolean());
        if (change == "revoke")
        {
            await policy.ChangeAsync(target.Id, link with { Assistants = new Dictionary<string, AssistantTargetGrant> { [caller.Id] = new(now, "grant-2") } });
            Assert.False((await Inspect(token, target.Id)).GetProperty("active").GetBoolean());
            Assert.Equal(HttpStatusCode.OK, (await Issue(caller.Id, parent.AccessToken)).StatusCode);
        }
    }

    [Fact]
    public async Task CoreMcpRequiresTheCallersOperationPermissionAndCurrentAdmin()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var now = DateTimeOffset.UtcNow;
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var caller = Record("assistant", now) with { ConfirmedRoles = ["assistant"],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["assistant"] = [new("default", null, "/assistant")] },
            GrantedCorePermissions = [CoreAppPermissions.ReadApps] };
        await apps.UpsertAppAsync(caller);
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        await users.WriteAsync(new(1, [new("admin", "admin@example.test", "Admin", "host.admin", false, now, now)], [], [], []));
        var userToken = await BrowserAuthorityFixture.Grant(host, caller.Id, "admin");
        await BrowserAuthorityFixture.Approve(host, caller.Id, "admin");
        await host.Services.GetRequiredService<AgentPolicyStore>().ChangeAsync("hosty:core", new(null, true, new Dictionary<string, string>(),
            new Dictionary<string, AssistantTargetGrant> { [caller.Id] = new(now, "grant") }));
        var access = host.Services.GetRequiredService<AssistantMcpAccess>();
        var token = await access.IssueAsync(caller.Id, "hosty:core", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(caller.Id), userToken.AccessToken, default, "session-one");
        using var client = host.CreateClient();
        async Task<HttpResponseMessage> Call(string tool)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "/api/mcp")
            { Content = JsonContent.Create(new { jsonrpc = "2.0", id = 1, method = "tools/call", @params = new { name = tool, arguments = new { } } }) };
            request.Headers.Authorization = new("Bearer", token.Token);
            request.Headers.Accept.ParseAdd("application/json, text/event-stream");
            return await client.SendAsync(request);
        }
        Assert.Equal(HttpStatusCode.OK, (await Call("list_apps")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await Call("get_host_status")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await Call("restart_core")).StatusCode);
        await apps.UpsertAppAsync(caller with { GrantedCorePermissions = [CoreAppPermissions.ReadApps, CoreAppPermissions.ReadCore] });
        Assert.Equal(HttpStatusCode.OK, (await Call("get_host_status")).StatusCode);
        var state = await users.ReadAsync();
        await users.WriteAsync(state with { Users = state.Users.Select(u => u with { Role = "host.member" }).ToArray(), Assignments = [new(caller.Id, "admin", now)] });
        Assert.Equal(HttpStatusCode.Forbidden, (await Call("list_apps")).StatusCode);
    }

    internal static AppRecord Record(string id, DateTimeOffset now) => new(id, id, null, "1.0.0", "runtime", false,
        "installed", "", null, "local", "installed", "running", null, null, [], new Dictionary<string, AppSettingValue>(), [], [], [], now, now);
}
