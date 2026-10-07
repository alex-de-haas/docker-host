using System.Diagnostics;
using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class ExternalWorkspaceMcpHttpTests
{
    private const string SourceApp = "com.example.external-source";
    private static readonly string[] WorkspaceScopes = [AccessTokenScopes.McpRead, AccessTokenScopes.McpWorkspaces];

    [Theory]
    [InlineData("read-only")]
    [InlineData("browser")]
    [InlineData("full-role")]
    [InlineData("delegated")]
    [InlineData("device")]
    public async Task WorkspaceTools_DoNotInheritAuthorityFromOtherCredentials(string kind)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await SeedAdminAsync(host);
        using var client = host.CreateClient();
        var token = kind switch
        {
            "browser" => "browser-admin",
            "delegated" => host.Services.GetRequiredService<DelegatedTokenService>()
                .CreateToken(AccessTokenScopes.CoreAudience, "admin", "host.admin").Token,
            "read-only" => await IssueAsync(host, [AccessTokenScopes.McpRead]),
            "device" => await IssueAsync(host, WorkspaceScopes, AccessTokenKinds.Device),
            _ => await IssueAsync(host, null),
        };
        var preparation = await ToolAsync(client, token, "prepare_workspace", new
        {
            requestId = Guid.NewGuid().ToString(), taskId = "task", appId = "unknown",
            leaseId = Guid.NewGuid().ToString(),
        });
        Assert.Contains("mcp:workspaces", preparation.GetProperty("error").GetString());
        Assert.DoesNotContain("unknown", preparation.GetProperty("error").GetString());
        var diff = await ToolAsync(client, token, "get_workspace_diff", new { workspaceId = new string('a', 64), path = "README.md" });
        Assert.Contains("mcp:workspaces", diff.GetProperty("error").GetString());
        var list = await ToolAsync(client, token, "list_workspaces", new { });
        Assert.Contains("mcp:workspaces", list.GetProperty("error").GetString());
        Assert.Empty((await host.Services.GetRequiredService<DevelopmentWorkspaceService>().ListAsync(null, true, default)).Workspaces);
    }

    [Theory]
    [InlineData("start_app", "mcp:lifecycle")]
    [InlineData("plan_app_update", "mcp:update")]
    [InlineData("restart_core", "mcp:core-restart")]
    public async Task WorkspaceScope_DoesNotGrantAppLifecycleUpdatesOrCoreRestart(string tool, string scope)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await SeedAdminAsync(host);
        using var client = host.CreateClient();
        var token = await IssueAsync(host, WorkspaceScopes);
        var arguments = tool == "restart_core"
            ? (object)new { requestId = Guid.NewGuid().ToString("N"), instance = "unknown", sourceRevision = "unknown" }
            : new { appId = "unknown.app" };
        var result = await ToolAsync(client, token, tool, arguments);
        Assert.Contains(scope, result.GetProperty("error").GetString());
        Assert.DoesNotContain("unknown", result.GetProperty("error").GetString());
    }

    [Fact]
    public async Task ManualWorkspaceCredential_IsStableAcrossDisplayChangesButIsolatedFromOtherCredentials()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await SeedAdminAsync(host);
        await SeedSourceAsync(host);
        using var client = host.CreateClient();
        var token = await IssueAsync(host, WorkspaceScopes);
        var arguments = new { requestId = Guid.NewGuid().ToString(), taskId = "first-task", appId = SourceApp,
            leaseId = Guid.NewGuid().ToString(), targetBranch = "main" };
        var first = await ToolAsync(client, token, "prepare_workspace", arguments);
        var id = first.GetProperty("id").GetString()!;
        Assert.Equal("active", first.GetProperty("state").GetString());
        Assert.Equal(JsonValueKind.Null, first.GetProperty("sessionPath").ValueKind);
        Assert.True(Path.IsPathFullyQualified(first.GetProperty("path").GetString()!));
        Assert.DoesNotContain(token, first.GetRawText());
        Assert.Equal("manual:" + DevelopmentWorkspaceService.Hash(token),
            first.GetProperty("owner").GetProperty("external").GetProperty("principalId").GetString());
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        await users.UpdateAsync(state => state with { Sessions = state.Sessions.Select(session => session.Id == token
            ? session with { Label = "Renamed agent" } : session).ToArray() });
        var repeated = await ToolAsync(client, token, "prepare_workspace", arguments);
        Assert.Equal(id, repeated.GetProperty("id").GetString());
        Assert.Single(repeated.GetProperty("operations").EnumerateArray());
        var conflict = await ToolAsync(client, token, "prepare_workspace", new { arguments.requestId, arguments.taskId,
            arguments.appId, leaseId = Guid.NewGuid().ToString(), arguments.targetBranch });
        Assert.Contains("different preparation arguments", conflict.GetProperty("error").GetString());
        var secondTask = await ToolAsync(client, token, "prepare_workspace", new { requestId = Guid.NewGuid().ToString(),
            taskId = "second-task", appId = SourceApp, leaseId = Guid.NewGuid().ToString(), targetBranch = "main" });
        Assert.NotEqual(id, secondTask.GetProperty("id").GetString());
        var listed = await ToolAsync(client, token, "list_workspaces", new { });
        Assert.Equal(2, listed.GetProperty("workspaces").GetArrayLength());
        var filtered = await ToolAsync(client, token, "list_workspaces", new { taskId = "first-task" });
        Assert.Equal(id, Assert.Single(filtered.GetProperty("workspaces").EnumerateArray()).GetProperty("id").GetString());
        var other = await IssueAsync(host, WorkspaceScopes);
        Assert.Empty((await ToolAsync(client, other, "list_workspaces", new { })).GetProperty("workspaces").EnumerateArray());
        var refused = await ToolAsync(client, other, "get_workspace", new { workspaceId = id });
        Assert.Equal("No owned workspace has that ID.", refused.GetProperty("error").GetString());
        var diffRefused = await ToolAsync(client, other, "get_workspace_diff", new { workspaceId = id, path = "README.md" });
        Assert.Equal("No owned workspace has that ID.", diffRefused.GetProperty("error").GetString());
    }

    [Fact]
    public async Task WorkspaceMcp_SeesNativeChangesAndRetainsLeasesUntilExplicitRelease()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await SeedAdminAsync(host);
        var source = await SeedSourceAsync(host);
        using var client = host.CreateClient();
        var token = await IssueAsync(host, WorkspaceScopes);
        var leaseId = Guid.NewGuid().ToString();
        var workspace = await ToolAsync(client, token, "prepare_workspace", new { requestId = Guid.NewGuid().ToString(),
            taskId = "edit-plan", appId = SourceApp, leaseId, targetBranch = "main" });
        var id = workspace.GetProperty("id").GetString()!;
        var path = workspace.GetProperty("path").GetString()!;
        var head = workspace.GetProperty("originalBase").GetString()!;
        await File.WriteAllTextAsync(Path.Combine(path, "README.md"), "verified workspace progress\n");
        var observed = await ToolAsync(client, token, "get_workspace", new { workspaceId = id });
        Assert.Contains("README.md", observed.GetProperty("observation").GetProperty("sessionFiles").EnumerateArray().Select(x => x.GetString()));
        var diff = await ToolAsync(client, token, "get_workspace_diff", new { workspaceId = id, path = "README.md" });
        Assert.Contains("+verified workspace progress", diff.GetProperty("combined").GetString());
        Assert.Equal("source\n", await File.ReadAllTextAsync(Path.Combine(source, "README.md")));
        var leased = await ToolAsync(client, token, "cleanup_workspace", new { workspaceId = id,
            requestId = Guid.NewGuid().ToString(), expectedHead = head });
        Assert.Contains("activity lease", leased.GetProperty("error").GetString());
        var releaseArgs = new { workspaceId = id, requestId = Guid.NewGuid().ToString(), leaseId };
        var released = await ToolAsync(client, token, "release_workspace_lease", releaseArgs);
        Assert.Empty(released.GetProperty("leases").EnumerateArray());
        var replay = await ToolAsync(client, token, "release_workspace_lease", releaseArgs);
        Assert.Equal(released.GetProperty("operations").GetArrayLength(), replay.GetProperty("operations").GetArrayLength());
        var dirty = await ToolAsync(client, token, "cleanup_workspace", new { workspaceId = id,
            requestId = Guid.NewGuid().ToString(), expectedHead = head });
        Assert.Contains("changes", dirty.GetProperty("error").GetString());
        Assert.True(Directory.Exists(path));
    }

    [Fact]
    public async Task OAuthWorkspaceGrant_RefreshKeepsPrincipalAndANewGrantCannotClaimIt()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await SeedAdminAsync(host);
        await SeedSourceAsync(host);
        using var client = host.CreateClient();
        var (clientId, tokens) = await OAuthTokensAsync(host, client);
        var access = tokens.GetProperty("access_token").GetString()!;
        var args = new { requestId = Guid.NewGuid().ToString(), taskId = "oauth-task", appId = SourceApp,
            leaseId = Guid.NewGuid().ToString(), targetBranch = "main" };
        var first = await ToolAsync(client, access, "prepare_workspace", args);
        var id = first.GetProperty("id").GetString()!;
        var grant = Assert.Single((await host.Services.GetRequiredService<OAuthStore>().ReadAsync()).Grants);
        Assert.Equal("oauth:" + grant.Id, first.GetProperty("owner").GetProperty("external").GetProperty("principalId").GetString());
        using var refreshed = await client.PostAsync("/api/auth/oauth/token", new FormUrlEncodedContent(new Dictionary<string, string>
        { ["grant_type"] = "refresh_token", ["client_id"] = clientId, ["refresh_token"] = tokens.GetProperty("refresh_token").GetString()! }));
        Assert.Equal(HttpStatusCode.OK, refreshed.StatusCode);
        var rotated = await ReadJsonAsync(refreshed);
        var refreshedToken = rotated.GetProperty("access_token").GetString()!;
        Assert.NotEqual(access, refreshedToken);
        Assert.Equal(id, (await ToolAsync(client, refreshedToken, "prepare_workspace", args)).GetProperty("id").GetString());
        var (_, otherTokens) = await OAuthTokensAsync(host, client, clientId);
        var other = otherTokens.GetProperty("access_token").GetString()!;
        Assert.Empty((await ToolAsync(client, other, "list_workspaces", new { })).GetProperty("workspaces").EnumerateArray());
        Assert.Equal("No owned workspace has that ID.", (await ToolAsync(client, other, "get_workspace", new { workspaceId = id })).GetProperty("error").GetString());
        // Interrupt after durable OAuth revocation but before session cascade. Per-call grant
        // validation must refuse the otherwise-live access token immediately.
        await host.Services.GetRequiredService<OAuthStore>().UpdateAsync<object?>(state => (state with
        { Grants = state.Grants.Select(g => g.Id == grant.Id ? g with { RevokedAt = DateTimeOffset.UtcNow } : g).ToArray() }, null));
        var revoked = await ToolAsync(client, refreshedToken, "get_workspace", new { workspaceId = id });
        Assert.Contains("mcp:workspaces", revoked.GetProperty("error").GetString());
        var records = await host.Services.GetRequiredService<DevelopmentWorkspaceService>().ListAsync(null, true, default);
        Assert.Single(records.Workspaces);
        Assert.Single(records.Workspaces[0].Leases);
        Assert.True(Directory.Exists(records.Workspaces[0].Path));
    }

    [Theory]
    [InlineData("demoted")]
    [InlineData("disabled")]
    [InlineData("revoked")]
    [InlineData("expired")]
    public async Task WorkspaceCredential_RechecksCurrentUserAndSession(string change)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await SeedAdminAsync(host);
        using var client = host.CreateClient();
        var token = await IssueAsync(host, WorkspaceScopes);
        Assert.Empty((await ToolAsync(client, token, "list_workspaces", new { })).GetProperty("workspaces").EnumerateArray());
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        await users.UpdateAsync(state => state with
        {
            Users = state.Users.Select(user => user with { Role = change == "demoted" ? "host.user" : user.Role,
                Disabled = change == "disabled" }).ToArray(),
            Sessions = state.Sessions.Select(session => session.Id != token ? session : session with
            { RevokedAt = change == "revoked" ? DateTimeOffset.UtcNow : null,
                ExpiresAt = change == "expired" ? DateTimeOffset.UtcNow.AddMinutes(-1) : session.ExpiresAt }).ToArray(),
        });
        using var response = await McpAsync(client, token, "tools/call", new { name = "list_workspaces", arguments = new { } });
        Assert.Contains(response.StatusCode, new[] { HttpStatusCode.Unauthorized, HttpStatusCode.Forbidden });
    }

    [Fact]
    public async Task WorkspaceScope_IsAdvertisedAndRequiresCoreAudienceAndRead()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await SeedAdminAsync(host);
        await SeedSourceAsync(host);
        using var client = host.CreateClient();
        using var metadataResponse = await client.GetAsync("/.well-known/oauth-protected-resource/api/mcp");
        var metadata = await ReadJsonAsync(metadataResponse);
        Assert.Contains(AccessTokenScopes.McpWorkspaces, metadata.GetProperty("scopes_supported").EnumerateArray().Select(x => x.GetString()));
        async Task<JsonElement> Issue(string audience, string[] scopes)
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "/api/auth/credentials")
            { Content = JsonContent.Create(new { label = "workspace", audience, scopes }) };
            request.Headers.Authorization = new("Bearer", "browser-admin");
            using var response = await client.SendAsync(request);
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            return await ReadJsonAsync(response);
        }
        Assert.Equal("scope_invalid_for_audience", (await Issue(SourceApp, WorkspaceScopes)).GetProperty("code").GetString());
        Assert.Equal("scope_requires_read", (await Issue(AccessTokenScopes.CoreAudience, [AccessTokenScopes.McpWorkspaces])).GetProperty("code").GetString());
        var (_, readTokens) = await OAuthTokensAsync(host, client, selectedScopes: [AccessTokenScopes.McpRead]);
        Assert.Equal("mcp:read", readTokens.GetProperty("scope").GetString());
        Assert.Contains("mcp:workspaces", (await ToolAsync(client, readTokens.GetProperty("access_token").GetString()!,
            "list_workspaces", new { })).GetProperty("error").GetString());
    }

    [Fact]
    public async Task WorkspaceToolSchema_ContainsNoCallerSelectedAuthorityOrArbitraryCommand()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await SeedAdminAsync(host);
        using var client = host.CreateClient();
        using var response = await McpAsync(client, "browser-admin", "tools/list", new { });
        var tools = (await McpResultAsync(response)).GetProperty("tools").EnumerateArray()
            .Where(tool => tool.GetProperty("name").GetString()!.Contains("workspace", StringComparison.Ordinal)).ToArray();
        Assert.Equal(12, tools.Length);
        foreach (var tool in tools)
        {
            var names = tool.GetProperty("inputSchema").GetProperty("properties").EnumerateObject().Select(property => property.Name).ToArray();
            Assert.DoesNotContain(names, name => name is "userId" or "principalId" or "owner" or "installation" or "command" or "repository");
        }
    }

    private static async Task SeedAdminAsync(CoreHttpHarness host)
    {
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1,
            [new("admin", "admin@example.test", "Admin", "host.admin", false, now, now)], [], [],
            [new("browser-admin", "admin", now, now.AddHours(1), null, now)]));
    }

    private static async Task<string> IssueAsync(CoreHttpHarness host, IReadOnlyList<string>? scopes,
        string kind = AccessTokenKinds.Manual)
        => (await AccessTokenEndpoints.IssueAsync("admin", kind, "Codex", host.Services.GetRequiredService<UserDirectoryStore>(),
            host.Services.GetRequiredService<IClock>(), host.Services.GetRequiredService<AuthLifetimes>(), default,
            audience: scopes is null ? null : AccessTokenScopes.CoreAudience, scopes: scopes)).Id;

    private static async Task<string> SeedSourceAsync(CoreHttpHarness host)
    {
        var paths = host.Services.GetRequiredService<CoreDataPaths>();
        var origin = Path.Combine(paths.CoreRoot, "external-source");
        Directory.CreateDirectory(origin);
        await GitAsync(origin, "init", "--initial-branch=main");
        await File.WriteAllTextAsync(Path.Combine(origin, "README.md"), "source\n");
        await GitAsync(origin, "add", "README.md");
        await GitAsync(origin, "-c", "user.name=Test Author", "-c", "user.email=author@example.test", "commit", "-m", "initial");
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        await host.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(new AppRecord(SourceApp, "Source", null,
            "1.0.0", "runtime", false, "installed", null, null, "docker", "installed", "stopped", null, null, [],
            new Dictionary<string, AppSettingValue>(), [], [], [], now, now)
            { SourceState = new("git", origin, "main", null, origin, null, now) });
        return origin;
    }

    private static async Task GitAsync(string directory, params string[] arguments)
    {
        var start = new ProcessStartInfo("git") { WorkingDirectory = directory, RedirectStandardError = true,
            RedirectStandardOutput = true, UseShellExecute = false };
        foreach (var argument in arguments) start.ArgumentList.Add(argument);
        using var process = Process.Start(start)!;
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        await stdout;
        Assert.True(process.ExitCode == 0, await stderr);
    }

    private static async Task<(string ClientId, JsonElement Tokens)> OAuthTokensAsync(CoreHttpHarness host, HttpClient client,
        string? existingClientId = null, string[]? selectedScopes = null)
    {
        const string redirect = "http://127.0.0.1:9993/callback";
        var clientId = existingClientId ?? "external_client_" + Guid.NewGuid().ToString("N");
        if (existingClientId is null)
            await host.Services.GetRequiredService<OAuthStore>().UpdateAsync<object?>(state => (state with
            { Clients = state.Clients.Append(new(clientId, "Codex", [redirect], DateTimeOffset.UtcNow)).ToArray() }, null));
        var verifier = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        var challenge = Convert.ToBase64String(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');
        using var authorization = await client.GetAsync($"/api/auth/oauth/authorize?client_id={clientId}&redirect_uri={Uri.EscapeDataString(redirect)}" +
            $"&response_type=code&code_challenge={challenge}&code_challenge_method=S256&resource={Uri.EscapeDataString("http://localhost:7070/api/mcp")}" +
            $"&scope={Uri.EscapeDataString(string.Join(' ', WorkspaceScopes))}");
        Assert.Equal(HttpStatusCode.Redirect, authorization.StatusCode);
        var requestId = authorization.Headers.Location!.ToString().Split("request=")[1];
        using var consent = new HttpRequestMessage(HttpMethod.Post, $"/api/auth/oauth/requests/{requestId}/decide")
        { Content = JsonContent.Create(new { decision = "approve", scopes = selectedScopes ?? WorkspaceScopes }) };
        consent.Headers.Add("Cookie", "hosty_session=browser-admin; hosty_csrf=csrf");
        consent.Headers.Add("X-Hosty-CSRF", "csrf");
        using var approved = await client.SendAsync(consent);
        Assert.Equal(HttpStatusCode.OK, approved.StatusCode);
        var code = (await ReadJsonAsync(approved)).GetProperty("redirectTo").GetString()!.Split("code=")[1].Split('&')[0];
        using var redeemed = await client.PostAsync("/api/auth/oauth/token", new FormUrlEncodedContent(new Dictionary<string, string>
        { ["grant_type"] = "authorization_code", ["client_id"] = clientId, ["code"] = code,
            ["code_verifier"] = verifier, ["redirect_uri"] = redirect }));
        Assert.Equal(HttpStatusCode.OK, redeemed.StatusCode);
        return (clientId, await ReadJsonAsync(redeemed));
    }

    private static async Task<JsonElement> ToolAsync(HttpClient client, string token, string name, object arguments)
    {
        using var response = await McpAsync(client, token, "tools/call", new { name, arguments });
        var result = await McpResultAsync(response);
        return JsonDocument.Parse(result.GetProperty("content").EnumerateArray().First().GetProperty("text").GetString()!).RootElement.Clone();
    }

    private static Task<HttpResponseMessage> McpAsync(HttpClient client, string token, string method, object parameters)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, "/api/mcp")
        { Content = JsonContent.Create(new { jsonrpc = "2.0", id = 2, method, @params = parameters }) };
        request.Headers.Authorization = new("Bearer", token);
        request.Headers.Accept.Add(new("application/json"));
        request.Headers.Accept.Add(new("text/event-stream"));
        return client.SendAsync(request);
    }

    private static async Task<JsonElement> McpResultAsync(HttpResponseMessage response)
    {
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        var json = body.TrimStart().StartsWith('{') ? body : body.Split('\n').Select(line => line.Trim())
            .First(line => line.StartsWith("data:", StringComparison.Ordinal))["data:".Length..];
        var envelope = JsonDocument.Parse(json).RootElement;
        Assert.False(envelope.TryGetProperty("error", out var error), error.ToString());
        return envelope.GetProperty("result").Clone();
    }

    private static async Task<JsonElement> ReadJsonAsync(HttpResponseMessage response)
        => JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.Clone();
}
