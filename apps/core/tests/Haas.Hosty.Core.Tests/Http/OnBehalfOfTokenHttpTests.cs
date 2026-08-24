using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

// A system app reaching another app for a user it never got a browser session from
// (docs/features/mcp-facade/plan.md). The authorization is the scoped access token the user issued
// to that app; the bound is the user's own access.
public sealed class OnBehalfOfTokenHttpTests
{
    [Fact]
    public async Task ASystemAppActsForAUserWhoGaveItACredential_AndAnOrdinaryAppCannot()
    {
        // The pair: either half alone is satisfied by a route that answers everyone, or by one that
        // answers nobody — and the second looks like security while being a bug.
        await using var harness = await CoreHttpHarness.StartAsync();
        await SeedAppAsync(harness, "hosty.ai-gateway", system: true);
        await SeedAppAsync(harness, "com.example.forwarder", system: false);
        await SeedAppAsync(harness, "com.example.notes");
        var owner = await SeedUserAsync(harness, "host.admin");
        using var client = harness.CreateClient();

        var facadeCredential = await CreateCredentialAsync(client, owner, "claude code", "hosty.ai-gateway");
        using var issued = await OnBehalfOfAsync(client, harness, "hosty.ai-gateway", facadeCredential, "com.example.notes");
        Assert.Equal(HttpStatusCode.OK, issued.StatusCode);
        var token = (await ReadJsonAsync(issued)).GetProperty("token").GetString();
        Assert.False(string.IsNullOrWhiteSpace(token));

        // Acting as a user toward another app is a platform delegation capability, not something
        // every app that holds a credential may do.
        var ordinaryCredential = await CreateCredentialAsync(client, owner, "other", "com.example.forwarder");
        using var refused = await OnBehalfOfAsync(
            client, harness, "com.example.forwarder", ordinaryCredential, "com.example.notes");
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        Assert.Equal("on_behalf_of_forbidden", (await ReadJsonAsync(refused)).GetProperty("code").GetString());
    }

    [Fact]
    public async Task ACredentialAddressedToOneAppCannotBeSpentByAnother()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        await SeedAppAsync(harness, "hosty.ai-gateway", system: true);
        await SeedAppAsync(harness, "hosty.other-system-app", system: true);
        await SeedAppAsync(harness, "com.example.notes");
        var owner = await SeedUserAsync(harness, "host.admin");
        using var client = harness.CreateClient();

        var facadeCredential = await CreateCredentialAsync(client, owner, "claude code", "hosty.ai-gateway");

        // A second system app — equally entitled to the capability in general — presenting a
        // credential addressed to its neighbour. The audience Core checks is the caller it
        // authenticated, never one read out of the credential.
        using var refused = await OnBehalfOfAsync(
            client, harness, "hosty.other-system-app", facadeCredential, "com.example.notes");
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        Assert.Equal("on_behalf_of_denied", (await ReadJsonAsync(refused)).GetProperty("code").GetString());
    }

    [Fact]
    public async Task TheActingUsersOwnAccessIsTheCeiling()
    {
        // The whole safety argument: an app acting for a user reaches exactly what that user could
        // reach personally. A member with no assignment is refused; the same call for an
        // administrator succeeds, so the refusal is shown to come from the access rule.
        await using var harness = await CoreHttpHarness.StartAsync();
        await SeedAppAsync(harness, "hosty.ai-gateway", system: true);
        await SeedAppAsync(harness, "com.example.notes");
        var admin = await SeedUserAsync(harness, "host.admin");
        var member = await SeedUserAsync(harness, "host.user", "user_member", append: true);
        await AssignAsync(harness, "hosty.ai-gateway", "user_member");
        using var client = harness.CreateClient();

        var memberCredential = await CreateCredentialAsync(client, member, "member client", "hosty.ai-gateway");
        using var unassigned = await OnBehalfOfAsync(
            client, harness, "hosty.ai-gateway", memberCredential, "com.example.notes");
        Assert.Equal(HttpStatusCode.Forbidden, unassigned.StatusCode);

        var adminCredential = await CreateCredentialAsync(client, admin, "admin client", "hosty.ai-gateway");
        using var allowed = await OnBehalfOfAsync(
            client, harness, "hosty.ai-gateway", adminCredential, "com.example.notes");
        Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);
    }

    [Fact]
    public async Task RevocationStopsTheNextCall_AndAnonymousCallersAreRefused()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        await SeedAppAsync(harness, "hosty.ai-gateway", system: true);
        await SeedAppAsync(harness, "com.example.notes");
        var owner = await SeedUserAsync(harness, "host.admin");
        using var client = harness.CreateClient();

        using var anonymous = await client.PostAsJsonAsync(
            "/api/internal/apps/hosty.ai-gateway/delegated-token",
            new { token = "whatever", targetAppId = "com.example.notes" });
        Assert.Equal(HttpStatusCode.Unauthorized, anonymous.StatusCode);

        var credential = await CreateCredentialAsync(client, owner, "claude code", "hosty.ai-gateway");
        using var before = await OnBehalfOfAsync(client, harness, "hosty.ai-gateway", credential, "com.example.notes");
        Assert.Equal(HttpStatusCode.OK, before.StatusCode);

        using var revoked = await SendAsync(
            client, HttpMethod.Delete, $"/api/auth/credentials/{credential.Fingerprint}", owner);
        Assert.Equal(HttpStatusCode.OK, revoked.StatusCode);

        using var after = await OnBehalfOfAsync(client, harness, "hosty.ai-gateway", credential, "com.example.notes");
        Assert.Equal(HttpStatusCode.Forbidden, after.StatusCode);
    }

    [Fact]
    public async Task CoreMcpIsATarget_SoOneCatalogCanCarryTheControlPlane_ButOnlyForAnAdministrator()
    {
        // The facade's whole promise is one config entry covering the host, which means Core's own
        // tools have to be reachable the same way an app's are. The token it gets back is an
        // ordinary delegated token addressed to Core MCP, and that endpoint stays administrator-only.
        await using var harness = await CoreHttpHarness.StartAsync();
        await SeedAppAsync(harness, "hosty.ai-gateway", system: true);
        var admin = await SeedUserAsync(harness, "host.admin");
        var member = await SeedUserAsync(harness, "host.user", "user_member", append: true);
        await AssignAsync(harness, "hosty.ai-gateway", "user_member");
        using var client = harness.CreateClient();

        var adminCredential = await CreateCredentialAsync(client, admin, "claude code", "hosty.ai-gateway");
        using var issued = await OnBehalfOfAsync(client, harness, "hosty.ai-gateway", adminCredential, "hosty:core");
        Assert.Equal(HttpStatusCode.OK, issued.StatusCode);
        var coreToken = (await ReadJsonAsync(issued)).GetProperty("token").GetString()!;

        // And it actually opens Core MCP, which is the only thing that makes the round trip worth
        // anything — a token nothing accepts would pass a test and fail a user.
        using var initialize = new HttpRequestMessage(HttpMethod.Post, "/api/mcp");
        initialize.Headers.Add("Authorization", $"Bearer {coreToken}");
        initialize.Headers.Add("Accept", "application/json, text/event-stream");
        initialize.Content = JsonContent.Create(new
        {
            jsonrpc = "2.0",
            id = 1,
            method = "initialize",
            @params = new
            {
                protocolVersion = "2025-06-18",
                capabilities = new { },
                clientInfo = new { name = "facade", version = "1" },
            },
        });
        using var opened = await client.SendAsync(initialize);
        Assert.Equal(HttpStatusCode.OK, opened.StatusCode);

        // An ordinary user reaching the gateway is still not an administrator, and the control plane
        // is where that has to keep being true.
        var memberCredential = await CreateCredentialAsync(client, member, "member client", "hosty.ai-gateway");
        using var refused = await OnBehalfOfAsync(client, harness, "hosty.ai-gateway", memberCredential, "hosty:core");
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        Assert.Equal("admin_required", (await ReadJsonAsync(refused)).GetProperty("code").GetString());
    }

    private static Task<HttpResponseMessage> OnBehalfOfAsync(
        HttpClient client,
        CoreHttpHarness harness,
        string callerAppId,
        (string Token, string Fingerprint) credential,
        string targetAppId)
    {
        var request = new HttpRequestMessage(
            HttpMethod.Post, $"/api/internal/apps/{callerAppId}/delegated-token");
        request.Headers.Add(
            "Authorization",
            $"Bearer {harness.Services.GetRequiredService<AppServiceTokenService>().CreateToken(callerAppId)}");
        request.Content = JsonContent.Create(new { token = credential.Token, targetAppId });
        return client.SendAsync(request);
    }

    private static async Task<(string Token, string Fingerprint)> CreateCredentialAsync(
        HttpClient client,
        string session,
        string label,
        string audience)
    {
        using var response = await SendAsync(
            client, HttpMethod.Post, "/api/auth/credentials", session,
            new { label, audience, scopes = new[] { "mcp:read" } });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var payload = await ReadJsonAsync(response);
        return (payload.GetProperty("token").GetString()!, payload.GetProperty("id").GetString()!);
    }

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

    private static async Task SeedAppAsync(CoreHttpHarness harness, string appId, bool system = false)
        => await harness.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(new AppRecord(
            Id: appId,
            DisplayName: "App",
            Description: null,
            Version: "1.0.0",
            Kind: "runtime",
            System: system,
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

    private static async Task AssignAsync(CoreHttpHarness harness, string appId, string userId)
    {
        var users = harness.Services.GetRequiredService<UserDirectoryStore>();
        var now = harness.Services.GetRequiredService<IClock>().UtcNow;
        await users.UpdateAsync(state => state with
        {
            Assignments = state.Assignments.Append(new AppAssignmentRecord(appId, userId, now)).ToArray(),
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
