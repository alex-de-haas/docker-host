using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class SourceDocumentHttpTests
{
    private const string AppId = "hosty.plans";
    private const string Root = "/api/internal/apps/hosty.plans/source-documents";

    [Theory]
    [InlineData("../README.md", HttpStatusCode.BadRequest, "source_document_path_invalid")]
    [InlineData("docs/../README.md", HttpStatusCode.BadRequest, "source_document_path_invalid")]
    [InlineData("docs/features/example/plan.txt", HttpStatusCode.BadRequest, "source_document_path_invalid")]
    [InlineData("docs/features/example/plan.md", HttpStatusCode.NotFound, "source_document_not_found")]
    public async Task FocusedDocumentPathsAreBoundAndValidatedBeforeRepositoryLookup(string path, HttpStatusCode status, string code)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        await host.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(
            AssistantMcpAccessHttpTests.Record(AppId, now) with { GrantedCorePermissions = [CoreAppPermissions.SourcesRead] });
        var credential = new AuthSessionRecord("focused-document-test", "admin", now, now.AddHours(1),
            RevokedAt: null, Kind: AccessTokenKinds.Manual, LastSeenAt: now, Audience: AppId, Scopes: [AccessTokenScopes.McpRead]);
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1,
            [new("admin", "admin@example.test", "Admin", "host.admin", false, now, now)], [], [], [credential]));
        using var client = host.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(AppId));
        client.DefaultRequestHeaders.Add("X-Hosty-User-Token", credential.Id);
        using var response = await client.GetAsync(Root + "/repositories/unknown/documents?path=" + Uri.EscapeDataString(path));
        Assert.Equal(status, response.StatusCode);
        Assert.Equal(code, (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
    }

    [Theory]
    [InlineData("hosty.plans", "mcp:read", true)]
    [InlineData("other.app", "mcp:read", false)]
    [InlineData("hosty:core", "mcp:read", false)]
    [InlineData("hosty.plans", "", false)]
    [InlineData(null, "mcp:read", false)]
    public async Task ScopedCredentialsRequireThisAppAudienceAndReadScope(string? audience, string scope, bool allowed)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        await host.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(
            AssistantMcpAccessHttpTests.Record(AppId, now) with { GrantedCorePermissions = [CoreAppPermissions.SourcesRead] });
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        var credential = new AuthSessionRecord("scoped-test", "admin", now, now.AddHours(1),
            RevokedAt: null, Kind: AccessTokenKinds.Manual, LastSeenAt: now, Audience: audience, Scopes: scope.Length > 0 ? [scope] : []);
        await users.WriteAsync(new(1, [new("admin", "admin@example.test", "Admin", "host.admin", false, now, now)], [], [], [credential]));
        using var client = host.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(AppId));
        client.DefaultRequestHeaders.Add("X-Hosty-User-Token", credential.Id);
        Assert.Equal(allowed ? HttpStatusCode.OK : HttpStatusCode.Unauthorized, (await client.GetAsync(Root + "/repositories")).StatusCode);
        if (!allowed) return;
        await users.UpdateAsync(state => state with { Sessions = [] });
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(Root + "/repositories")).StatusCode);
    }

    [Fact]
    public async Task ReadsRequireTheServiceGrantAndCurrentAdministratorIdentity()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        var record = AssistantMcpAccessHttpTests.Record(AppId, now);
        await apps.UpsertAppAsync(record);
        await users.WriteAsync(new(1, [new("admin", "admin@example.test", "Admin", "host.admin", false, now, now)], [], [], []));
        using var client = host.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(Root + "/repositories")).StatusCode);
        client.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(AppId));
        var grant = await BrowserAuthorityFixture.Grant(host, AppId, "admin");
        client.DefaultRequestHeaders.Add("X-Hosty-User-Token", grant.AccessToken);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(Root + "/repositories")).StatusCode);
        await apps.UpsertAppAsync(record with { GrantedCorePermissions = [CoreAppPermissions.Sources] });
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(Root + "/repositories")).StatusCode);
        await apps.UpsertAppAsync(record with { GrantedCorePermissions = [CoreAppPermissions.SourcesRead] });
        using var response = await client.GetAsync(Root + "/repositories");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("no-store", response.Headers.CacheControl?.ToString());
        Assert.Empty((await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("repositories").EnumerateArray());
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync(Root + "/workspaces")).StatusCode);
        client.DefaultRequestHeaders.Add("Cookie", "hosty_session=browser-session");
        Assert.False((await client.GetAsync(Root + "/repositories")).IsSuccessStatusCode);
        client.DefaultRequestHeaders.Remove("Cookie");
        client.DefaultRequestHeaders.Remove("X-Hosty-User-Token");
        client.DefaultRequestHeaders.Add("X-Hosty-User-Token", host.Services.GetRequiredService<DelegatedTokenService>().CreateToken(AppId, "admin", "host.admin").Token);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(Root + "/repositories")).StatusCode);
        client.DefaultRequestHeaders.Remove("X-Hosty-User-Token");
        client.DefaultRequestHeaders.Add("X-Hosty-User-Token", grant.AccessToken);
        await users.UpdateAsync(state => state with { Users = state.Users.Select(user => user with { Role = "host.member" }).ToArray(), Assignments = [new(AppId, "admin", now)] });
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(Root + "/repositories")).StatusCode);
    }

    [Theory]
    [InlineData("host.admin", true)]
    [InlineData("host.member", false)]
    public async Task AddressedMcpInvocationCredentialsAuthorizeOnlyTheseAdministratorReads(string role, bool allowed)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        var assistant = AssistantMcpAccessHttpTests.Record("example.assistant", now) with
        {
            ConfirmedRoles = ["assistant"],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["assistant"] = [new("default", null, "/assistant")] },
        };
        var target = AssistantMcpAccessHttpTests.Record(AppId, now) with
        {
            GrantedCorePermissions = [CoreAppPermissions.SourcesRead],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["mcp"] = [new("default", null, "/mcp")] },
        };
        await apps.UpsertAppAsync(assistant);
        await apps.UpsertAppAsync(target);
        await users.WriteAsync(new(1, [new("user", "user@example.test", "User", role, false, now, now)], [],
            [new(assistant.Id, "user", now), new(AppId, "user", now)], []));
        var parent = await BrowserAuthorityFixture.Grant(host, assistant.Id, "user");
        await host.Services.GetRequiredService<AgentPolicyStore>().ChangeAsync(AppId, new(target.InstalledAt, true,
            new Dictionary<string, string>(), new Dictionary<string, AssistantTargetGrant> { [assistant.Id] = new(now, "reviewed") }));
        var serviceTokens = host.Services.GetRequiredService<AppServiceTokenService>();
        var token = await host.Services.GetRequiredService<AssistantMcpAccess>().IssueAsync(assistant.Id, AppId,
            serviceTokens.CreateToken(assistant.Id), parent.AccessToken, default, "session-one");
        using var client = host.CreateClient();
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", serviceTokens.CreateToken(AppId));
        client.DefaultRequestHeaders.Add("X-Hosty-User-Token", token.Token);
        Assert.Equal(allowed ? HttpStatusCode.OK : HttpStatusCode.Forbidden, (await client.GetAsync(Root + "/repositories")).StatusCode);
        if (!allowed) return;
        using var unrelated = new HttpRequestMessage(HttpMethod.Get, "/api/profile");
        unrelated.Headers.Authorization = new("Bearer", serviceTokens.CreateToken(AppId));
        unrelated.Headers.Add(AppManagementAuthorization.IdentityHeader, token.Token);
        Assert.False((await client.SendAsync(unrelated)).IsSuccessStatusCode);
        client.DefaultRequestHeaders.Authorization = new("Bearer", serviceTokens.CreateToken(assistant.Id));
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(Root + "/repositories")).StatusCode);
        client.DefaultRequestHeaders.Authorization = new("Bearer", serviceTokens.CreateToken(AppId));
        await host.Services.GetRequiredService<AgentPolicyStore>().ChangeAsync(AppId, new(target.InstalledAt, false, new Dictionary<string, string>()));
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(Root + "/repositories")).StatusCode);
    }
}
