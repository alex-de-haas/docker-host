using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class AssistantSettingsHttpTests
{
    private static async Task<(AppRecord Assistant, AppRecord Target, AppIdentityTokenResult Grant)> Seed(CoreHttpHarness host)
    {
        var now = DateTimeOffset.UtcNow;
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var assistant = AssistantMcpAccessHttpTests.Record("example.assistant", now) with {
            ConfirmedRoles = ["assistant"], GrantedCorePermissions = [CoreAppPermissions.ReadApps],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["assistant"] = [new("default", null, "/assistant")] } };
        var target = AssistantMcpAccessHttpTests.Record("example.target", now) with { AgentSkillFile = "agent.md",
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["mcp"] = [new("default", null, "/mcp")] } };
        await apps.UpsertAppAsync(assistant); await apps.UpsertAppAsync(target);
        var paths = host.Services.GetRequiredService<CoreDataPaths>();
        await File.WriteAllTextAsync(Path.Combine(paths.AppsRoot, target.Id, "agent.md"), "Reviewed <script>instructions</script>");
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1,
            [new("admin", "admin@example.test", "Admin", "host.admin", false, now, now)], [], [], []));
        return (assistant, target, await BrowserAuthorityFixture.Grant(host, assistant.Id, "admin"));
    }

    [Theory]
    [InlineData("approve")]
    [InlineData("deny")]
    [InlineData("stale")]
    [InlineData("reinstall")]
    public async Task CoreReview_IsExplicitBoundAndPreservesOtherAssistants(string decision)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var (assistant, target, _) = await Seed(host);
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var other = assistant with { Id = "other.assistant" };
        await apps.UpsertAppAsync(other);
        var policies = host.Services.GetRequiredService<AgentPolicyStore>();
        await policies.ChangeAsync(target.Id, new(target.InstalledAt, true, new Dictionary<string, string>(),
            new Dictionary<string, AssistantTargetGrant> { [other.Id] = new(other.InstalledAt, "preserved") }));
        await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(s => s with {
            Sessions = s.Sessions.Select(v => v with { BrowserOrigin = "http://localhost" }).ToArray() });
        using var client = host.CreateClient();
        client.DefaultRequestHeaders.Add("Cookie", "hosty_session=browser-session");
        using var opened = await client.GetAsync($"/install/agents/{assistant.Id}/{target.Id}");
        Assert.Equal(HttpStatusCode.Redirect, opened.StatusCode);
        var location = opened.Headers.Location!.ToString();
        var html = await client.GetStringAsync(location);
        Assert.Contains("Review assistant MCP access", html);
        Assert.Contains("Reviewed &lt;script&gt;instructions&lt;/script&gt;", html);
        Assert.DoesNotContain("value=true checked", html);
        Assert.DoesNotContain("name=agentSkill value=\"agent\" checked", html);
        var nonce = Regex.Match(html, "name=nonce value=\"([^\"]+)\"").Groups[1].Value;
        Assert.NotEmpty(nonce);
        if (decision == "stale")
            await File.WriteAllTextAsync(Path.Combine(host.Services.GetRequiredService<CoreDataPaths>().AppsRoot, target.Id, "agent.md"), "Different instructions");
        if (decision == "reinstall") await apps.UpsertAppAsync(assistant with { InstalledAt = assistant.InstalledAt.AddSeconds(1) });
        async Task<HttpResponseMessage> Submit() {
            var request = new HttpRequestMessage(HttpMethod.Post, location) {
                Content = new FormUrlEncodedContent(new Dictionary<string, string> {
                    ["nonce"] = nonce, ["decision"] = decision == "deny" ? "deny" : "approve", ["agentEnabled"] = "true", ["agentSkill"] = "agent" }) };
            request.Headers.Add("Origin", "http://localhost");
            return await client.SendAsync(request);
        }
        (await Submit()).EnsureSuccessStatusCode();
        var entry = host.Services.GetRequiredService<InstallationApprovalStore>().Get(location.Split('/').Last());
        for (var i = 0; entry.Status == "executing" && i < 100; i++) await Task.Delay(10);
        Assert.Equal(decision == "approve" ? "succeeded" : decision == "deny" ? "denied" : "failed", entry.Status);
        var policy = (await policies.ReadAsync()).Targets[target.Id];
        Assert.Equal("preserved", policy.Assistants![other.Id].Revision);
        Assert.Equal(decision == "approve", policy.Assistants.ContainsKey(assistant.Id));
        Assert.Equal(decision == "approve", policy.ApprovedSkills.ContainsKey("agent"));
        Assert.Equal(HttpStatusCode.Conflict, (await Submit()).StatusCode);
    }

    [Fact]
    public async Task ExpiredReview_ChangesNeitherAccessNorInstructions()
    {
        var clock = new TestClock();
        await using var host = await CoreHttpHarness.StartAsync(clock);
        var (assistant, target, _) = await Seed(host);
        var plan = await host.Services.GetRequiredService<AgentMcpDirectory>().ReviewAssistantAsync(assistant.Id, target.Id, default);
        var store = host.Services.GetRequiredService<InstallationApprovalStore>();
        var entry = store.Add(new InstallationApproval { UserId = "admin", CallerName = "Core MCP review",
            ExpiresAt = clock.UtcNow.Add(InstallationApprovalStore.Lifetime), AssistantAccessPlan = plan });
        store.Submit(entry, new());
        var nonce = store.IssueNonce(entry, "browser-session");
        clock.UtcNow += InstallationApprovalStore.Lifetime;
        Assert.Throws<AppLifecycleException>(() => store.Decide(entry, nonce, "browser-session", true,
            agentEnabled: true, agentSkills: ["agent"]));
        Assert.False(entry.AgentEnabled);
        Assert.Empty(entry.AgentSkills);
        Assert.False((await host.Services.GetRequiredService<AgentPolicyStore>().ReadAsync()).Targets.ContainsKey(target.Id));
    }

    private sealed class TestClock : IClock { public DateTimeOffset UtcNow { get; set; } = DateTimeOffset.UtcNow; }

    [Fact]
    public async Task CoreReview_RefusesServiceCredentialsAndCrossOriginFetch()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var (assistant, target, _) = await Seed(host);
        using var client = host.CreateClient();
        var path = $"/install/agents/{assistant.Id}/{target.Id}";
        client.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(assistant.Id));
        Assert.Equal(HttpStatusCode.Redirect, (await client.GetAsync(path)).StatusCode);
        client.DefaultRequestHeaders.Add("Sec-Fetch-Mode", "cors");
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(path)).StatusCode);
    }

    [Fact]
    public async Task Discovery_DoesNotCreateChatAuthorityOrPermitToolCalls()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var (assistant, target, grant) = await Seed(host);
        var access = host.Services.GetRequiredService<AssistantMcpAccess>();
        var services = host.Services.GetRequiredService<AppServiceTokenService>();
        var service = services.CreateToken(assistant.Id);
        var policy = host.Services.GetRequiredService<AgentPolicyStore>();
        AgentTargetPolicy Link(DateTimeOffset? installed) => new(installed, true, new Dictionary<string, string>(),
            new Dictionary<string, AssistantTargetGrant> { [assistant.Id] = new(assistant.InstalledAt, "grant") });
        await policy.ChangeAsync(target.Id, Link(target.InstalledAt));
        await policy.ChangeAsync("hosty:core", Link(null));
        var token = await access.IssueAsync(assistant.Id, target.Id, service, grant.AccessToken, default, discoveryOnly: true);
        using var client = host.CreateClient();
        async Task<JsonElement> Inspect(string? tool) {
            var request = new HttpRequestMessage(HttpMethod.Post, $"/api/internal/apps/{target.Id}/token/introspect") {
                Content = JsonContent.Create(new { token = token.Token, purpose = "mcp", tool }) };
            request.Headers.Authorization = new("Bearer", services.CreateToken(target.Id));
            return await (await client.SendAsync(request)).Content.ReadFromJsonAsync<JsonElement>();
        }
        Assert.True((await Inspect(null)).GetProperty("active").GetBoolean());
        Assert.DoesNotContain("mcp:invoke", (await Inspect(null)).GetProperty("scopes").EnumerateArray().Select(s => s.GetString()));
        Assert.False((await Inspect("read_only_tool")).GetProperty("active").GetBoolean());
        var coreToken = await access.IssueAsync(assistant.Id, "hosty:core", service, grant.AccessToken, default, discoveryOnly: true);
        // The same limited credential can read the real Core MCP catalog, with no approved chat.
        var catalog = await AssistantMcpDiscovery.ReadCatalogAsync(new("http://localhost/api/mcp"), coreToken.Token, client, default);
        Assert.Contains(catalog.Tools, tool => tool.Name == "list_apps");
        using var call = new HttpRequestMessage(HttpMethod.Post, "/api/mcp") { Content = JsonContent.Create(new {
            jsonrpc = "2.0", id = 1, method = "tools/call", @params = new { name = "list_apps", arguments = new { } } }) };
        call.Headers.Authorization = new("Bearer", coreToken.Token);
        call.Headers.Accept.ParseAdd("application/json, text/event-stream");
        Assert.Equal(HttpStatusCode.Forbidden, (await client.SendAsync(call)).StatusCode);
        // A client cannot request this mode through the normal token endpoint, even with extra JSON fields.
        using var issue = new HttpRequestMessage(HttpMethod.Post, $"/api/internal/apps/{assistant.Id}/mcp/token") {
            Content = JsonContent.Create(new { targetAppId = target.Id, discoveryOnly = true }) };
        issue.Headers.Authorization = new("Bearer", service); issue.Headers.Add("X-Hosty-User-Token", grant.AccessToken);
        Assert.False((await client.SendAsync(issue)).IsSuccessStatusCode);
        await policy.ChangeAsync(target.Id, Link(target.InstalledAt) with { Assistants = null });
        Assert.False((await Inspect(null)).GetProperty("active").GetBoolean());
        await Assert.ThrowsAsync<AppIdentityException>(() => access.IssueAsync(assistant.Id, target.Id, service, grant.AccessToken, default, discoveryOnly: true));
    }

    [Fact]
    public async Task CatalogEndpoint_RequiresCurrentAdministratorActivityAndTargetAssignment()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var (assistant, _, grant) = await Seed(host);
        var services = host.Services.GetRequiredService<AppServiceTokenService>();
        using var client = host.CreateClient();
        async Task<HttpResponseMessage> Request() {
            var request = new HttpRequestMessage(HttpMethod.Post, $"/api/internal/apps/{assistant.Id}/mcp/catalog/hosty:core");
            request.Headers.Authorization = new("Bearer", services.CreateToken(assistant.Id));
            request.Headers.Add("X-Hosty-User-Token", grant.AccessToken);
            return await client.SendAsync(request);
        }
        Assert.Equal(HttpStatusCode.Forbidden, (await Request()).StatusCode);
        await host.Services.GetRequiredService<AgentPolicyStore>().ChangeAsync("hosty:core", new(null, true,
            new Dictionary<string, string>(), new Dictionary<string, AssistantTargetGrant> { [assistant.Id] = new(assistant.InstalledAt, "grant") }));
        await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(state => state with {
            Users = state.Users.Select(user => user with { Role = "host.user" }).ToArray() });
        Assert.Equal(HttpStatusCode.Forbidden, (await Request()).StatusCode);
    }
}
