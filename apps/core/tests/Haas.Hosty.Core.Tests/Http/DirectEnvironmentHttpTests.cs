using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class DirectEnvironmentHttpTests
{
    private static readonly string[] Manage = [AccessTokenScopes.McpRead, AccessTokenScopes.McpEnvironmentsRead, AccessTokenScopes.McpEnvironmentsManage];

    [Fact]
    public async Task DirectApi_ReplaysWithinPrincipalAndSeparatesReadManageChildApiAndOtherUsers()
    {
        await using var host = await CoreEnvironmentHttpTests.StartHostAsync();
        await Seed(host);
        using var client = host.CreateClient();
        var token = await Issue(host, Manage);
        client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var input = new CoreEnvironmentCreate(Guid.NewGuid().ToString(), "Independent QA");
        using var created = await client.PostAsJsonAsync("/api/core-environments", input);
        Assert.Equal(HttpStatusCode.OK, created.StatusCode);
        var environment = (await created.Content.ReadFromJsonAsync<CoreEnvironmentView>())!;
        using var replay = await client.PostAsJsonAsync("/api/core-environments", input);
        Assert.Equal(environment.Id, (await replay.Content.ReadFromJsonAsync<CoreEnvironmentView>())!.Id);
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsJsonAsync("/api/core-environments", input with { Label = "Changed" })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync($"/api/core-environments/{environment.Id}/api", new CoreEnvironmentApiRequest("GET", "/api/apps"))).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync($"/api/core-environments/{environment.Id}/setup", new CoreEnvironmentSetup("test@example.test", "Test", "Test-password-42"))).StatusCode);
        await Scopes(host, token, [AccessTokenScopes.McpRead, AccessTokenScopes.McpEnvironmentsRead]);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync($"/api/core-environments/{environment.Id}")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync("/api/core-environments", input)).StatusCode);
        var service = host.Services.GetRequiredService<CoreEnvironmentService>();
        var foreign = await service.CreateAsync(new("other"), new(Guid.NewGuid().ToString(), "Other user's QA"), default);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync($"/api/core-environments/{foreign.Id}")).StatusCode);
        Assert.Equal(environment.Id, Assert.Single((await client.GetFromJsonAsync<CoreEnvironmentList>("/api/core-environments"))!.Environments).Id);
        await Scopes(host, token, [AccessTokenScopes.McpRead]);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/core-environments")).StatusCode);
    }

    [Fact]
    public async Task Mcp_UsesSameServiceAndCurrentAuthorityWithNoApplicationsOrConversation()
    {
        await using var host = await CoreEnvironmentHttpTests.StartHostAsync();
        await Seed(host);
        using var client = host.CreateClient();
        var token = await Issue(host, Manage);
        client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var input = new CoreEnvironmentCreate(Guid.NewGuid().ToString(), "Direct MCP QA");
        var created = await Tool(client, "environment_create", new { input });
        Assert.False(created.TryGetProperty("isError", out var failure) && failure.GetBoolean(), created.ToString());
        var id = created.GetProperty("structuredContent").GetProperty("id").GetString()!;
        var api = (await client.GetFromJsonAsync<CoreEnvironmentView>($"/api/core-environments/{id}"))!;
        var listed = await Tool(client, "environment_list", new { });
        Assert.Equal(id, listed.GetProperty("structuredContent").GetProperty("environments")[0].GetProperty("id").GetString());
        var command = new CoreEnvironmentCommand(Guid.NewGuid().ToString(), api.Revision);
        var finished = await Tool(client, "environment_finish", new { environmentId = id, input = command });
        Assert.Equal("finished", finished.GetProperty("structuredContent").GetProperty("state").GetString());
        Assert.False(Directory.Exists(api.DataRoot));
        var replay = await Tool(client, "environment_finish", new { environmentId = id, input = command });
        Assert.Equal(finished.GetProperty("structuredContent").GetProperty("revision").GetInt64(), replay.GetProperty("structuredContent").GetProperty("revision").GetInt64());
        await Scopes(host, token, [AccessTokenScopes.McpRead, AccessTokenScopes.McpEnvironmentsRead]);
        var denied = await Tool(client, "environment_finish", new { environmentId = id, input = command });
        Assert.True(denied.GetProperty("isError").GetBoolean());
        Assert.Equal("scope_required", denied.GetProperty("structuredContent").GetProperty("code").GetString());
    }

    [Fact]
    public async Task ScopedAuthority_DoesNotInheritOperatorCookieOrDisabledUserAccess()
    {
        await using var host = await CoreEnvironmentHttpTests.StartHostAsync();
        await Seed(host);
        using var client = host.CreateClient();
        var token = await Issue(host, Manage);
        client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        client.DefaultRequestHeaders.Add("Cookie", $"{CoreSessionAuthorization.SessionCookieName}=browser-admin");
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/core-environments")).StatusCode);
        client.DefaultRequestHeaders.Remove("Cookie");
        await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(s => s with { Users = s.Users.Select(u => u.Id == "admin" ? u with { Disabled = true } : u).ToArray() });
        Assert.False((await client.GetAsync("/api/core-environments")).IsSuccessStatusCode);
    }

    [Fact]
    public void LegacyActorFingerprintRemainsStableAndRequestLocalAuthorityIsNeverPersisted()
    {
        var actor = new SandboxActor("user", "app", DateTimeOffset.UnixEpoch);
        const string previous = """{"userId":"user","appId":"app","installation":"1970-01-01T00:00:00+00:00","grantId":null,"scopeId":null}""";
        Assert.Equal(previous, CoreJson.Text(actor));
        Assert.Equal(SandboxValidation.Hash(previous), actor.Key);
    }

    internal static async Task<JsonElement> Tool(HttpClient client, string name, object arguments)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/mcp");
        request.Headers.Accept.Add(new("application/json")); request.Headers.Accept.Add(new("text/event-stream"));
        request.Content = JsonContent.Create(new { jsonrpc = "2.0", id = 1, method = "tools/call", @params = new { name, arguments } });
        using var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        var json = body.TrimStart().StartsWith('{') ? body : body.Split('\n').First(l => l.StartsWith("data:", StringComparison.Ordinal))[5..];
        using var doc = JsonDocument.Parse(json);
        Assert.False(doc.RootElement.TryGetProperty("error", out _), json);
        return doc.RootElement.GetProperty("result").Clone();
    }
    private static async Task Seed(CoreHttpHarness host)
    {
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1,
            [new("admin", "admin@example.test", "Admin", "host.admin", false, now, now), new("other", "other@example.test", "Other", "host.admin", false, now, now)], [], [],
            [new("browser-admin", "admin", now, now.AddHours(1), null, now)]));
    }
    private static async Task<string> Issue(CoreHttpHarness host, string[] scopes)
        => (await AccessTokenEndpoints.IssueAsync("admin", AccessTokenKinds.Manual, "Direct QA", host.Services.GetRequiredService<UserDirectoryStore>(),
            host.Services.GetRequiredService<IClock>(), host.Services.GetRequiredService<AuthLifetimes>(), default,
            audience: AccessTokenScopes.CoreAudience, scopes: scopes)).Id;
    private static Task Scopes(CoreHttpHarness host, string token, string[] scopes)
        => host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(s => s with { Sessions = s.Sessions.Select(v => v.Id == token ? v with { Scopes = scopes } : v).ToArray() });
}
