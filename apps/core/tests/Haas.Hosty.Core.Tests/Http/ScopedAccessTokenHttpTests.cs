using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

// Scoped access tokens over the real pipeline (docs/features/scoped-access-tokens/feature.md).
//
// Audience and scopes were added to the record a Core session already resolves through, which is what
// makes the first test here the load-bearing one: if a scoped credential were still accepted as a
// session, a token minted to read one app's read-only tools would install apps. Every other assertion
// is about the credential doing what it *is* for.
public sealed class ScopedAccessTokenHttpTests
{
    [Fact]
    public async Task AScopedCredentialIsNotASession_WhileAnUnscopedOneStillIs()
    {
        // The pair. Either half alone is satisfied by a broken build: refusing everything passes the
        // first, and accepting everything passes the second.
        await using var harness = await CoreHttpHarness.StartAsync();
        await SeedAppAsync(harness, "com.example.notes");
        var owner = await SeedUserAsync(harness, "host.admin");
        using var client = harness.CreateClient();

        var scoped = await CreateCredentialAsync(client, owner, "agent client", "com.example.notes", ["mcp:read"]);
        var unscoped = await CreateCredentialAsync(client, owner, "backup script");

        // An administrator route: the credential is refused by name, so the holder can see why.
        using var refused = await SendAsync(client, HttpMethod.Get, "/api/auth/credentials", scoped.Token);
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        var error = await ReadJsonAsync(refused);
        Assert.Equal("credential_scoped", error.GetProperty("code").GetString());
        // The audience is named because the holder knows what they presented: an unexplained refusal
        // sends someone looking for a bug in the wrong half of the system.
        Assert.Contains("com.example.notes", error.GetProperty("message").GetString()!, StringComparison.Ordinal);

        // The session probe every client makes first. It resolves sessions by hand instead of through
        // CoreSessionAuthorization, so it is asserted separately rather than assumed to inherit the
        // rule — it answered with the user record for a scoped credential until this feature.
        using var probe = await SendAsync(client, HttpMethod.Get, "/api/auth/session", scoped.Token);
        Assert.Equal(HttpStatusCode.OK, probe.StatusCode);
        var probed = await ReadJsonAsync(probe);
        Assert.False(probed.GetProperty("authenticated").GetBoolean());
        Assert.Equal(JsonValueKind.Null, probed.GetProperty("user").ValueKind);

        // And the credential this feature did not change behaves exactly as it always did.
        using var accepted = await SendAsync(client, HttpMethod.Get, "/api/auth/session", unscoped.Token);
        Assert.Equal(HttpStatusCode.OK, accepted.StatusCode);
        Assert.True((await ReadJsonAsync(accepted)).GetProperty("authenticated").GetBoolean());
    }

    [Fact]
    public async Task IntrospectionAnswersForItsOwnAudienceAndForNobodyElses()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        await SeedAppAsync(harness, "com.example.notes");
        await SeedAppAsync(harness, "com.example.tasks");
        var owner = await SeedUserAsync(harness, "host.admin");
        using var client = harness.CreateClient();

        var scoped = await CreateCredentialAsync(client, owner, "agent client", "com.example.notes", ["mcp:read"]);

        var active = await IntrospectAsync(client, harness, "com.example.notes", scoped.Token, tool: "list_people");
        Assert.True(active.GetProperty("active").GetBoolean());
        Assert.Equal("user_1", active.GetProperty("sub").GetString());
        Assert.Equal("host.admin", active.GetProperty("role").GetString());
        Assert.Equal("mcp:read", Assert.Single(active.GetProperty("scopes").EnumerateArray().ToArray()).GetString());

        // The neighbour holding the same bearer learns nothing. This is the replay the one-audience
        // rule exists to stop: were a credential valid at two apps, the first could act as the user
        // at the second.
        var foreign = await IntrospectAsync(client, harness, "com.example.tasks", scoped.Token);
        Assert.False(foreign.GetProperty("active").GetBoolean());
        Assert.Equal(JsonValueKind.Null, foreign.GetProperty("sub").ValueKind);

        // An unscoped credential is a Core session, not an app credential — it is not active anywhere.
        var unscoped = await CreateCredentialAsync(client, owner, "backup script");
        var fullRole = await IntrospectAsync(client, harness, "com.example.notes", unscoped.Token);
        Assert.False(fullRole.GetProperty("active").GetBoolean());

        // And a value that is not a credential at all answers in exactly the same shape, so an app
        // cannot use introspection to discover which credentials exist.
        var nonsense = await IntrospectAsync(client, harness, "com.example.notes", "not-a-credential");
        Assert.False(nonsense.GetProperty("active").GetBoolean());
    }

    [Fact]
    public async Task RevocationTakesEffectOnTheVeryNextCall()
    {
        // The whole reason this credential is opaque and validated online. Nothing is cached, so
        // there is no window to describe here — which is the property being asserted.
        await using var harness = await CoreHttpHarness.StartAsync();
        await SeedAppAsync(harness, "com.example.notes");
        var owner = await SeedUserAsync(harness, "host.admin");
        using var client = harness.CreateClient();

        var scoped = await CreateCredentialAsync(client, owner, "agent client", "com.example.notes", ["mcp:read"]);
        Assert.True((await IntrospectAsync(client, harness, "com.example.notes", scoped.Token)).GetProperty("active").GetBoolean());

        using var revoked = await SendAsync(client, HttpMethod.Delete, $"/api/auth/credentials/{scoped.Fingerprint}", owner);
        Assert.Equal(HttpStatusCode.OK, revoked.StatusCode);

        Assert.False((await IntrospectAsync(client, harness, "com.example.notes", scoped.Token)).GetProperty("active").GetBoolean());
    }

    [Fact]
    public async Task AccessIsRecheckedAtEveryCall_NotAssumedFromIssuance()
    {
        // A credential outlives the state it was minted against. Here the user keeps the credential
        // and loses the assignment, which is the ordinary way access ends.
        await using var harness = await CoreHttpHarness.StartAsync();
        await SeedAppAsync(harness, "com.example.notes");
        var owner = await SeedUserAsync(harness, "host.admin");
        var member = await SeedUserAsync(harness, "host.user", "user_member", append: true);
        await AssignAsync(harness, "com.example.notes", "user_member");
        using var client = harness.CreateClient();

        var scoped = await CreateCredentialAsync(client, member, "member client", "com.example.notes", ["mcp:read"]);
        Assert.True((await IntrospectAsync(client, harness, "com.example.notes", scoped.Token)).GetProperty("active").GetBoolean());

        await UnassignAsync(harness, "com.example.notes", "user_member");
        Assert.False((await IntrospectAsync(client, harness, "com.example.notes", scoped.Token)).GetProperty("active").GetBoolean());

        // The administrator's own credential is unaffected: admins reach every app by role, so this
        // shows the refusal came from the access rule rather than from the credential going stale.
        var adminScoped = await CreateCredentialAsync(client, owner, "admin client", "com.example.notes", ["mcp:read"]);
        Assert.True((await IntrospectAsync(client, harness, "com.example.notes", adminScoped.Token)).GetProperty("active").GetBoolean());
    }

    [Fact]
    public async Task IntrospectionRefusesAnAnonymousCallerAndAForeignServiceToken()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        await SeedAppAsync(harness, "com.example.notes");
        await SeedAppAsync(harness, "com.example.tasks");
        var owner = await SeedUserAsync(harness, "host.admin");
        using var client = harness.CreateClient();
        var scoped = await CreateCredentialAsync(client, owner, "agent client", "com.example.notes", ["mcp:read"]);

        using var anonymous = await client.PostAsJsonAsync(
            "/api/internal/apps/com.example.notes/token/introspect", new { token = scoped.Token });
        Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);

        // The caller is who the service token says, never who the URL says — so a neighbour cannot
        // introspect *as* the audience by writing its id into the path.
        using var foreign = await SendIntrospectAsync(
            client, IssueServiceToken(harness, "com.example.tasks"), "com.example.notes", scoped.Token, null);
        Assert.Equal(HttpStatusCode.Unauthorized, foreign.StatusCode);
    }

    [Fact]
    public async Task CoreMcpAcceptsACredentialScopedToCore_AndRefusesOneWithoutTheScope()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var owner = await SeedUserAsync(harness, "host.admin");
        using var client = harness.CreateClient();

        var reader = await CreateCredentialAsync(client, owner, "claude code", "hosty:core", ["mcp:read"]);
        using var initialized = await InitializeMcpAsync(client, reader.Token);
        Assert.Equal(HttpStatusCode.OK, initialized.StatusCode);

        // A credential scoped to an app is not a Core MCP credential, however capable it is there.
        await SeedAppAsync(harness, "com.example.notes");
        var appScoped = await CreateCredentialAsync(client, owner, "app client", "com.example.notes", ["mcp:read"]);
        using var wrongAudience = await InitializeMcpAsync(client, appScoped.Token);
        Assert.Equal(HttpStatusCode.Forbidden, wrongAudience.StatusCode);
    }

    [Fact]
    public async Task AScopeNarrowsWhatACredentialDoes_ItNeverWidensWhoMayHoldOne()
    {
        // Core MCP is administrator-only. A scope that let an ordinary user reach it would be an
        // escalation wearing the clothes of a restriction, so both halves are asserted: issuance
        // refuses, and a credential that exists anyway is refused at use after a role change.
        await using var harness = await CoreHttpHarness.StartAsync();
        var admin = await SeedUserAsync(harness, "host.admin");
        var member = await SeedUserAsync(harness, "host.user", "user_member", append: true);
        using var client = harness.CreateClient();

        using var refused = await SendAsync(
            client, HttpMethod.Post, "/api/auth/credentials", member,
            new { label = "member client", audience = "hosty:core", scopes = new[] { "mcp:read" } });
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        Assert.Equal("admin_required", (await ReadJsonAsync(refused)).GetProperty("code").GetString());

        // Issued while an administrator, then demoted: the credential outlives the role, and use is
        // where that catches up with it.
        var credential = await CreateCredentialAsync(client, admin, "was an admin", "hosty:core", ["mcp:read"]);
        using var whileAdmin = await InitializeMcpAsync(client, credential.Token);
        Assert.Equal(HttpStatusCode.OK, whileAdmin.StatusCode);

        await DemoteAsync(harness, "user_1");
        using var afterDemotion = await InitializeMcpAsync(client, credential.Token);
        Assert.Equal(HttpStatusCode.Forbidden, afterDemotion.StatusCode);
        Assert.Equal("admin_required", (await ReadJsonAsync(afterDemotion)).GetProperty("code").GetString());
    }

    [Fact]
    public async Task IssuanceRefusesHalfAScope_AnUnknownScope_AndAnAudienceThatIsNotInstalled()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var owner = await SeedUserAsync(harness, "host.admin");
        using var client = harness.CreateClient();

        // An audience with no scopes may do nothing; scopes with no audience name powers over
        // nothing. Both would be minted silently and then puzzled over.
        using var audienceOnly = await SendAsync(
            client, HttpMethod.Post, "/api/auth/credentials", owner, new { label = "a", audience = "hosty:core" });
        Assert.Equal(HttpStatusCode.BadRequest, audienceOnly.StatusCode);
        Assert.Equal("scope_incomplete", (await ReadJsonAsync(audienceOnly)).GetProperty("code").GetString());

        using var scopesOnly = await SendAsync(
            client, HttpMethod.Post, "/api/auth/credentials", owner, new { label = "a", scopes = new[] { "mcp:read" } });
        Assert.Equal(HttpStatusCode.BadRequest, scopesOnly.StatusCode);

        // A typo in a scope must not quietly become a narrower credential nobody asked for.
        using var unknownScope = await SendAsync(
            client, HttpMethod.Post, "/api/auth/credentials", owner,
            new { label = "a", audience = "hosty:core", scopes = new[] { "mcp:write" } });
        Assert.Equal(HttpStatusCode.BadRequest, unknownScope.StatusCode);

        // Nor may an audience name an app that is not installed: the credential would be valid,
        // listed, and silently useless.
        using var unknownApp = await SendAsync(
            client, HttpMethod.Post, "/api/auth/credentials", owner,
            new { label = "a", audience = "com.example.absent", scopes = new[] { "mcp:read" } });
        Assert.Equal(HttpStatusCode.BadRequest, unknownApp.StatusCode);
        Assert.Equal("audience_not_found", (await ReadJsonAsync(unknownApp)).GetProperty("code").GetString());
    }

    [Fact]
    public async Task TheListingShowsWhatACredentialMayReach_AndStillNeverItsValue()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        await SeedAppAsync(harness, "com.example.notes");
        var owner = await SeedUserAsync(harness, "host.admin");
        using var client = harness.CreateClient();

        var scoped = await CreateCredentialAsync(client, owner, "agent client", "com.example.notes", ["mcp:read"]);
        using var list = await SendAsync(client, HttpMethod.Get, "/api/auth/credentials", owner);
        var body = await list.Content.ReadAsStringAsync();
        Assert.DoesNotContain(scoped.Token, body, StringComparison.Ordinal);

        var entry = (await ReadJsonAsync(list)).GetProperty("credentials").EnumerateArray()
            .Single(credential => credential.GetProperty("id").GetString() == scoped.Fingerprint);
        Assert.Equal("com.example.notes", entry.GetProperty("audience").GetString());
        Assert.Equal("mcp:read", Assert.Single(entry.GetProperty("scopes").EnumerateArray().ToArray()).GetString());
    }

    private static async Task<HttpResponseMessage> InitializeMcpAsync(HttpClient client, string credential)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/mcp");
        request.Headers.Add("Authorization", $"Bearer {credential}");
        request.Headers.Add("Accept", "application/json, text/event-stream");
        request.Content = JsonContent.Create(new
        {
            jsonrpc = "2.0",
            id = 1,
            method = "initialize",
            @params = new
            {
                protocolVersion = "2025-06-18",
                capabilities = new { },
                clientInfo = new { name = "test", version = "1" },
            },
        });
        return await client.SendAsync(request);
    }

    private static async Task<JsonElement> IntrospectAsync(
        HttpClient client,
        CoreHttpHarness harness,
        string appId,
        string token,
        string? tool = null)
    {
        using var response = await SendIntrospectAsync(client, IssueServiceToken(harness, appId), appId, token, tool);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await ReadJsonAsync(response);
    }

    private static async Task<HttpResponseMessage> SendIntrospectAsync(
        HttpClient client,
        string serviceToken,
        string appId,
        string token,
        string? tool)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/internal/apps/{appId}/token/introspect");
        request.Headers.Add("Authorization", $"Bearer {serviceToken}");
        request.Content = JsonContent.Create(new { token, tool });
        return await client.SendAsync(request);
    }

    private static async Task<(string Token, string Fingerprint)> CreateCredentialAsync(
        HttpClient client,
        string session,
        string label,
        string? audience = null,
        string[]? scopes = null)
    {
        object body = audience is null
            ? new { label }
            : new { label, audience, scopes = scopes ?? [] };
        using var response = await SendAsync(client, HttpMethod.Post, "/api/auth/credentials", session, body);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var payload = await ReadJsonAsync(response);
        return (payload.GetProperty("token").GetString()!, payload.GetProperty("id").GetString()!);
    }

    private static string IssueServiceToken(CoreHttpHarness harness, string appId)
        => harness.Services.GetRequiredService<AppServiceTokenService>().CreateToken(appId);

    private static async Task<HttpResponseMessage> SendAsync(
        HttpClient client,
        HttpMethod method,
        string path,
        string credential,
        object? body = null)
    {
        using var request = new HttpRequestMessage(method, path);
        request.Headers.Add("Authorization", $"Bearer {credential}");
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }

        return await client.SendAsync(request);
    }

    private static async Task<JsonElement> ReadJsonAsync(HttpResponseMessage response)
        => JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.Clone();

    private static async Task SeedAppAsync(CoreHttpHarness harness, string appId)
        => await harness.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(new AppRecord(
            Id: appId,
            DisplayName: "App",
            Description: null,
            Version: "1.0.0",
            Kind: "runtime",
            System: false,
            Source: "installed",
            ManifestPath: $"apps/{appId}/manifest.json",
            ManifestUrl: null,
            SelectedRuntime: "docker",
            OperationStatus: "installed",
            RuntimeState: "running",
            LastOperation: null,
            LastError: null,
            Capabilities: ["open"],
            Settings: new Dictionary<string, AppSettingValue>(),
            StorageMappings: [],
            Dependencies: [],
            Endpoints: [],
            InstalledAt: DateTimeOffset.UtcNow,
            UpdatedAt: DateTimeOffset.UtcNow));

    private static async Task DemoteAsync(CoreHttpHarness harness, string userId)
    {
        var users = harness.Services.GetRequiredService<UserDirectoryStore>();
        await users.UpdateAsync(state => state with
        {
            Users = state.Users
                .Select(user => string.Equals(user.Id, userId, StringComparison.Ordinal)
                    ? user with { Role = "host.user" }
                    : user)
                .ToArray(),
        });
    }

    private static async Task AssignAsync(CoreHttpHarness harness, string appId, string userId)
    {
        var users = harness.Services.GetRequiredService<UserDirectoryStore>();
        var now = harness.Services.GetRequiredService<IClock>().UtcNow;
        await users.UpdateAsync(state => state with
        {
            Assignments = state.Assignments.Append(new AppAssignmentRecord(appId, userId, now)).ToArray(),
        });
    }

    private static async Task UnassignAsync(CoreHttpHarness harness, string appId, string userId)
    {
        var users = harness.Services.GetRequiredService<UserDirectoryStore>();
        await users.UpdateAsync(state => state with
        {
            Assignments = state.Assignments
                .Where(assignment => !(string.Equals(assignment.AppId, appId, StringComparison.Ordinal) &&
                    string.Equals(assignment.UserId, userId, StringComparison.Ordinal)))
                .ToArray(),
        });
    }

    private static async Task<string> SeedUserAsync(
        CoreHttpHarness harness,
        string role,
        string userId = "user_1",
        bool append = false)
    {
        var users = harness.Services.GetRequiredService<UserDirectoryStore>();
        var now = harness.Services.GetRequiredService<IClock>().UtcNow;
        var user = new HostUserRecord(userId, $"{userId}@example.test", userId, role, false, now, now);
        var session = new AuthSessionRecord($"session_{userId}", userId, now, now.AddHours(1), null, now);

        if (append)
        {
            var existing = await users.ReadAsync();
            await users.WriteAsync(existing with
            {
                Users = existing.Users.Append(user).ToArray(),
                Sessions = existing.Sessions.Append(session).ToArray(),
            });
        }
        else
        {
            await users.WriteAsync(new UserDirectoryState(1, [user], [], [], [session]));
        }

        return session.Id;
    }
}
