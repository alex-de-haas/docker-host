using System.Net;
using System.Net.Http.Json;
using Haas.Hosty.Core;
using HostySdk.App;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class CoreDecisionHttpTests
{
    [Fact]
    public async Task EmptyCoreSupportsDirectHttpAndMcpWithSeparatelyReviewedScope()
    {
        await using var host = await CoreHttpHarness.StartAsync(); await Seed(host);
        using var client = host.CreateClient();
        var token = await Token(host, [AccessTokenScopes.McpRead]);
        client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/decisions/v1/requests")).StatusCode);
        await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(state => state with { Sessions = state.Sessions.Select(s => s.Id == token ? s with { Scopes = [AccessTokenScopes.McpRead, AccessTokenScopes.McpDecisions] } : s).ToArray() });
        var input = Input();
        var create = await client.PostAsJsonAsync("/api/decisions/v1/requests", input);
        Assert.Equal(HttpStatusCode.OK, create.StatusCode);
        var row = (await create.Content.ReadFromJsonAsync<HostyDecisionRecord>())!;
        var mcp = await DirectEnvironmentHttpTests.Tool(client, "decision_get", new { id = row.Id });
        Assert.False(mcp.TryGetProperty("isError", out var error) && error.GetBoolean(), mcp.ToString());
        Assert.Equal(row.Id, mcp.GetProperty("structuredContent").GetProperty("id").GetString());
        var response = await client.PostAsJsonAsync($"/api/decisions/v1/requests/{row.Id}/resolve", new HostyDecisionResolve(Id(), 1, new Dictionary<string, HostyDecisionAnswer> { ["q"] = new(Text: "Proceed") }));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("pending", (await response.Content.ReadFromJsonAsync<HostyDecisionRecord>())!.Continuation!.State);
        Assert.Empty(await host.Services.GetRequiredService<AppRegistryStore>().ListAppRecordsAsync());
    }

    [Fact]
    public async Task AppTransportRequiresCurrentUserAndEachSeparatePermission()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var app = await AppManagementHttpTests.CreateAppClient(host, "independent.question-source", [CoreAppPermissions.DecisionsRequest]);
        var identity = app.DefaultRequestHeaders.GetValues(AppManagementAuthorization.IdentityHeader).Single();
        app.DefaultRequestHeaders.Remove(AppManagementAuthorization.IdentityHeader);
        app.DefaultRequestHeaders.Add("X-Hosty-User-Token", identity);
        const string root = "/api/internal/apps/independent.question-source/decisions/v1";
        var response = await app.PostAsJsonAsync(root + "/requests", Input());
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var row = (await response.Content.ReadFromJsonAsync<HostyDecisionRecord>())!;
        Assert.Equal("independent.question-source", row.SourceAppId);
        Assert.Equal(HttpStatusCode.Forbidden, (await app.GetAsync(root + "/requests")).StatusCode);
        var registry = host.Services.GetRequiredService<AppRegistryStore>();
        var source = (await registry.GetAppAsync(row.SourceAppId!))!;
        await registry.UpsertAppAsync(source with { GrantedCorePermissions = [CoreAppPermissions.DecisionsRead] });
        Assert.Equal(HttpStatusCode.OK, (await app.GetAsync(root + "/requests")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await app.GetAsync(root + "/responses")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await app.PostAsJsonAsync(root + "/requests/" + row.Id + "/resolve", new HostyDecisionResolve(Id(), 1, new Dictionary<string, HostyDecisionAnswer> { ["q"] = new(Text: "Yes") }))).StatusCode);
        app.DefaultRequestHeaders.Remove("X-Hosty-User-Token");
        Assert.False((await app.GetAsync(root + "/requests")).IsSuccessStatusCode);
    }

    [Fact]
    public async Task MalformedOversizedAndUnauthenticatedInputsNeverCreateAQuestion()
    {
        await using var host = await CoreHttpHarness.StartAsync(); await Seed(host);
        using var client = host.CreateClient();
        Assert.False((await client.PostAsJsonAsync("/api/decisions/v1/requests", Input())).IsSuccessStatusCode);
        client.DefaultRequestHeaders.Authorization = new("Bearer", await Token(host, [AccessTokenScopes.McpRead, AccessTokenScopes.McpDecisions]));
        using var bad = new StringContent("{", System.Text.Encoding.UTF8, "application/json");
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsync("/api/decisions/v1/requests", bad)).StatusCode);
        using var oversized = new StringContent(new string(' ', 65537), System.Text.Encoding.UTF8, "application/json");
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsync("/api/decisions/v1/requests", oversized)).StatusCode);
        Assert.Empty((await client.GetFromJsonAsync<HostyDecisionPage>("/api/decisions/v1/requests"))!.Items);
    }
    [Fact]
    public async Task StreamIsPrivateAndRevalidatesBeforeDeliveringHints()
    {
        await using var host = await CoreHttpHarness.StartAsync(); await Seed(host);
        using var client = host.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", await Token(host, [AccessTokenScopes.McpRead, AccessTokenScopes.McpDecisions]));
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var response = await client.GetAsync("/api/decisions/v1/events", HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        using var reader = new StreamReader(await response.Content.ReadAsStreamAsync(timeout.Token));
        Assert.Equal("event: stream.ready", await reader.ReadLineAsync(timeout.Token));
        Assert.Equal("data: {}", await reader.ReadLineAsync(timeout.Token));
        await reader.ReadLineAsync(timeout.Token);
        var next = reader.ReadLineAsync(timeout.Token).AsTask();
        var events = host.Services.GetRequiredService<CoreEventHub>();
        events.PublishDecision("another-owner");
        Assert.NotSame(next, await Task.WhenAny(next, Task.Delay(100, timeout.Token)));
        events.PublishDecision("owner");
        Assert.Equal("event: decisions.changed", await next);
        Assert.Equal("data: {}", await reader.ReadLineAsync(timeout.Token));
        await reader.ReadLineAsync(timeout.Token);
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        var state = await users.ReadAsync();
        await users.WriteAsync(state with { Users = state.Users.Select(user => user with { Disabled = true }).ToArray() });
        events.PublishDecision("owner");
        Assert.Equal("event: stream.revoked", await reader.ReadLineAsync(timeout.Token));
    }

    private static string Id() => Guid.NewGuid().ToString("D");
    private static HostyDecisionCreate Input() => new(Id(), new(Id(), "Review approach", [new("q", "Which approach?")]));
    private static async Task Seed(CoreHttpHarness host)
    {
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1, [new("owner", "owner@example.test", "Owner", "host.admin", false, now, now)], [], [], []));
    }
    private static async Task<string> Token(CoreHttpHarness host, string[] scopes) =>
        (await AccessTokenEndpoints.IssueAsync("owner", AccessTokenKinds.Manual, "Decisions test", host.Services.GetRequiredService<UserDirectoryStore>(),
            host.Services.GetRequiredService<IClock>(), host.Services.GetRequiredService<AuthLifetimes>(), default, audience: AccessTokenScopes.CoreAudience, scopes: scopes)).Id;
}
