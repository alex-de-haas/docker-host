using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

// The OAuth issuance path over the real pipeline (docs/features/mcp-oauth/feature.md): registration
// behind its breaker, the authorization dance with PKCE, redemption, rotation, and the one page
// that revokes it all. What comes out of the flow is an ordinary scoped access token, so the final
// authority on every positive case is the surface the token is *for* answering it.
public sealed class OAuthHttpTests
{
    [Fact]
    public async Task TheWholeFlow_FromRegistrationToAWorkingRotatedRevokedCredential()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        await SeedShellAsync(harness);
        var admin = await SeedSessionAsync(harness, "host.admin");
        using var client = harness.CreateClient();
        await EnableRegistrationAsync(client, admin);

        // 1. The client registers itself and is told it is a public client.
        var registered = await RegisterAsync(client, "Claude Code");
        Assert.Equal("none", registered.GetProperty("token_endpoint_auth_method").GetString());
        var clientId = registered.GetProperty("client_id").GetString()!;

        // 2. The authorization request parks server-side and the browser is sent to Shell's consent
        //    page — nothing but a request id in the URL, so nothing the user consents to can be
        //    swapped after validation.
        var (verifier, challenge) = NewPkcePair();
        var authorize = await AuthorizeAsync(client, clientId, challenge, resource: "http://localhost:7070/api/mcp");
        Assert.Equal(HttpStatusCode.Redirect, authorize.StatusCode);
        var location = authorize.Headers.Location!.ToString();
        Assert.StartsWith("http://127.0.0.1:7171/oauth/consent?request=", location, StringComparison.Ordinal);
        var requestId = location.Split("request=")[1];

        // 3. The consent page reads Core's copy of the request.
        var view = await ReadJsonAsync(await SendAsync(client, HttpMethod.Get, $"/api/auth/oauth/requests/{requestId}", admin));
        Assert.Equal("Claude Code", view.GetProperty("clientName").GetString());
        Assert.Equal("Hosty Core", view.GetProperty("audienceDisplayName").GetString());
        Assert.Equal("mcp:read", view.GetProperty("scopes").EnumerateArray().Single().GetString());

        // 4. Approval mints the one-time code and hands the browser its redirect target.
        var decided = await DecideAsync(client, admin, requestId, "approve");
        var redirectTo = decided.GetProperty("redirectTo").GetString()!;
        Assert.StartsWith("http://127.0.0.1:9993/callback?code=", redirectTo, StringComparison.Ordinal);
        Assert.Contains("state=st4te", redirectTo, StringComparison.Ordinal);
        var code = redirectTo.Split("code=")[1].Split('&')[0];

        // 5. Redemption with the PKCE verifier yields the pair.
        var tokens = await RedeemAsync(client, clientId, code, verifier);
        var access = tokens.GetProperty("access_token").GetString()!;
        var refresh = tokens.GetProperty("refresh_token").GetString()!;
        Assert.Equal(3600, tokens.GetProperty("expires_in").GetInt32());

        // 6. The access token is an ordinary scoped credential: Core MCP accepts it...
        Assert.Equal(HttpStatusCode.OK, (await InitializeMcpAsync(client, access)).StatusCode);
        // ...and every other /api surface refuses it, exactly like a manually minted one.
        Assert.Equal(HttpStatusCode.Forbidden, (await SendAsync(client, HttpMethod.Get, "/api/auth/credentials", access)).StatusCode);

        // 7. Rotation: the new pair works. (Presenting the *spent* token is deliberately not done
        //    here — a replay is a theft signal that kills the whole chain, and it has its own test.)
        var rotated = await RefreshAsync(client, clientId, refresh);
        var access2 = rotated.GetProperty("access_token").GetString()!;
        var refresh2 = rotated.GetProperty("refresh_token").GetString()!;
        Assert.Equal(HttpStatusCode.OK, (await InitializeMcpAsync(client, access2)).StatusCode);

        // 8. The credential page lists the grant as one row, named for the client — not the hourly
        //    access tokens it issued.
        var listed = await ReadJsonAsync(await SendAsync(client, HttpMethod.Get, "/api/auth/credentials", admin));
        var row = listed.GetProperty("credentials").EnumerateArray()
            .Single(credential => credential.GetProperty("kind").GetString() == "oauth");
        Assert.Equal("Claude Code", row.GetProperty("label").GetString());
        Assert.Equal("hosty:core", row.GetProperty("audience").GetString());

        // 9. Revoking that row kills the whole grant: the live access token on its next call, and
        //    the refresh chain on its next rotation.
        var fingerprint = row.GetProperty("id").GetString()!;
        Assert.Equal(HttpStatusCode.OK,
            (await SendAsync(client, HttpMethod.Delete, $"/api/auth/credentials/{fingerprint}", admin)).StatusCode);
        // 401, not 403: a *live* credential with the wrong audience is refused by name, but a
        // revoked one is simply no longer a credential at all.
        Assert.Equal(HttpStatusCode.Unauthorized, (await InitializeMcpAsync(client, access2)).StatusCode);
        using var refreshDead = await PostFormAsync(client, new()
        {
            ["grant_type"] = "refresh_token",
            ["refresh_token"] = refresh2,
            ["client_id"] = clientId,
        });
        Assert.Equal(HttpStatusCode.BadRequest, refreshDead.StatusCode);
    }

    [Fact]
    public async Task AReplayedRefreshTokenKillsTheWholeChain()
    {
        // The theft this exists for: two parties hold one refresh token, the thief refreshes first
        // and wins the live chain, the victim's replay is the only signal anything is wrong. That
        // replay must revoke everything — the chain and the winner's access token — or the thief
        // keeps a credential while the victim is quietly locked out.
        await using var harness = await CoreHttpHarness.StartAsync();
        await SeedShellAsync(harness);
        var admin = await SeedSessionAsync(harness, "host.admin");
        using var client = harness.CreateClient();
        await EnableRegistrationAsync(client, admin);
        var clientId = (await RegisterAsync(client, "c")).GetProperty("client_id").GetString()!;

        var (verifier, challenge) = NewPkcePair();
        var code = await ApprovedCodeAsync(client, admin, clientId, challenge);
        var tokens = await RedeemAsync(client, clientId, code, verifier);
        var refresh1 = tokens.GetProperty("refresh_token").GetString()!;

        // The "thief" rotates and holds the live pair.
        var rotated = await RefreshAsync(client, clientId, refresh1);
        var thiefAccess = rotated.GetProperty("access_token").GetString()!;
        var thiefRefresh = rotated.GetProperty("refresh_token").GetString()!;
        Assert.Equal(HttpStatusCode.OK, (await InitializeMcpAsync(client, thiefAccess)).StatusCode);

        // The "victim" replays the spent token: refused, and the chain dies with it.
        using var replay = await PostFormAsync(client, new()
        {
            ["grant_type"] = "refresh_token",
            ["refresh_token"] = refresh1,
            ["client_id"] = clientId,
        });
        Assert.Equal(HttpStatusCode.BadRequest, replay.StatusCode);

        // The winner's spoils are gone too: access token dead now, refresh dead on its next use.
        Assert.Equal(HttpStatusCode.Unauthorized, (await InitializeMcpAsync(client, thiefAccess)).StatusCode);
        using var thiefRefreshDead = await PostFormAsync(client, new()
        {
            ["grant_type"] = "refresh_token",
            ["refresh_token"] = thiefRefresh,
            ["client_id"] = clientId,
        });
        Assert.Equal(HttpStatusCode.BadRequest, thiefRefreshDead.StatusCode);
    }

    [Fact]
    public async Task RegistrationIsOffByDefault_AndTheToggleIsTheOnlyDoor()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var admin = await SeedSessionAsync(harness, "host.admin");
        using var client = harness.CreateClient();

        using var refused = await client.PostAsJsonAsync("/api/auth/oauth/register",
            new { redirect_uris = new[] { "http://127.0.0.1:9993/callback" }, client_name = "x" });
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        Assert.Equal("oauth_registration_disabled", (await ReadJsonAsync(refused)).GetProperty("code").GetString());

        await EnableRegistrationAsync(client, admin);
        var registered = await RegisterAsync(client, "editor");
        Assert.StartsWith("hosty_oauth_", registered.GetProperty("client_id").GetString(), StringComparison.Ordinal);

        // Turning it back off closes the door without touching what walked through it.
        await SetRegistrationAsync(client, admin, "false");
        using var refusedAgain = await client.PostAsJsonAsync("/api/auth/oauth/register",
            new { redirect_uris = new[] { "http://127.0.0.1:9993/callback" }, client_name = "x" });
        Assert.Equal(HttpStatusCode.Forbidden, refusedAgain.StatusCode);
    }

    [Fact]
    public async Task PkceIsTheClientBinding_WrongVerifierRefusedBesideRightAccepted()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        await SeedShellAsync(harness);
        var admin = await SeedSessionAsync(harness, "host.admin");
        using var client = harness.CreateClient();
        await EnableRegistrationAsync(client, admin);
        var clientId = (await RegisterAsync(client, "c")).GetProperty("client_id").GetString()!;

        var (_, challenge) = NewPkcePair();
        var code = await ApprovedCodeAsync(client, admin, clientId, challenge);
        using var wrong = await PostFormAsync(client, new()
        {
            ["grant_type"] = "authorization_code",
            ["code"] = code,
            ["code_verifier"] = "not-the-verifier-that-made-the-challenge",
            ["client_id"] = clientId,
        });
        Assert.Equal(HttpStatusCode.BadRequest, wrong.StatusCode);

        // A code dies on its first presentation, valid or not — so the right verifier cannot save
        // this code, and a fresh dance with the right verifier succeeds.
        var (verifier2, challenge2) = NewPkcePair();
        var code2 = await ApprovedCodeAsync(client, admin, clientId, challenge2);
        var redeemed = await RedeemAsync(client, clientId, code2, verifier2);
        Assert.False(string.IsNullOrEmpty(redeemed.GetProperty("access_token").GetString()));

        // And single-use holds for a *successful* redemption too.
        using var again = await PostFormAsync(client, new()
        {
            ["grant_type"] = "authorization_code",
            ["code"] = code2,
            ["code_verifier"] = verifier2,
            ["client_id"] = clientId,
        });
        Assert.Equal(HttpStatusCode.BadRequest, again.StatusCode);
    }

    [Fact]
    public async Task TheResourceDecidesTheAudience_AndItsAbsenceRefuses()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        await SeedShellAsync(harness);
        await SeedMcpAppAsync(harness, "com.example.notes", "http://127.0.0.1:31000/api/mcp");
        var admin = await SeedSessionAsync(harness, "host.admin");
        using var client = harness.CreateClient();
        await EnableRegistrationAsync(client, admin);
        var clientId = (await RegisterAsync(client, "c")).GetProperty("client_id").GetString()!;

        // No resource: refused through the redirect, never defaulted to something broad.
        var (_, challenge) = NewPkcePair();
        var missing = await AuthorizeAsync(client, clientId, challenge, resource: null);
        Assert.Contains("error=invalid_target", missing.Headers.Location!.ToString(), StringComparison.Ordinal);

        // A resource that is nothing on this host: refused the same way.
        var unknown = await AuthorizeAsync(client, clientId, challenge, resource: "https://elsewhere.example/api/mcp");
        Assert.Contains("error=invalid_target", unknown.Headers.Location!.ToString(), StringComparison.Ordinal);

        // An app's declared MCP endpoint resolves to that app — proven by the minted token being
        // active at that app's introspection and nowhere else.
        var (verifier, challenge2) = NewPkcePair();
        var code = await ApprovedCodeAsync(client, admin, clientId, challenge2, "http://127.0.0.1:31000/api/mcp");
        var tokens = await RedeemAsync(client, clientId, code, verifier);
        var access = tokens.GetProperty("access_token").GetString()!;

        var own = await IntrospectAsync(client, harness, "com.example.notes", access);
        Assert.True(own.GetProperty("active").GetBoolean());
        Assert.Equal(HttpStatusCode.Forbidden, (await InitializeMcpAsync(client, access)).StatusCode);
    }

    [Fact]
    public async Task ConsentEnforcesTheSameBarsAsManualIssuance()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        await SeedShellAsync(harness);
        var admin = await SeedSessionAsync(harness, "host.admin");
        var member = await SeedSessionAsync(harness, "host.user", "user_member", append: true);
        using var client = harness.CreateClient();
        await EnableRegistrationAsync(client, admin);
        var clientId = (await RegisterAsync(client, "c")).GetProperty("client_id").GetString()!;

        // A non-administrator consenting to the control plane is refused at the decision, exactly
        // as manual issuance refuses the audience.
        var (_, challenge) = NewPkcePair();
        var authorize = await AuthorizeAsync(client, clientId, challenge, resource: "http://localhost:7070/api/mcp");
        var requestId = authorize.Headers.Location!.ToString().Split("request=")[1];
        using var refused = await SendAsync(client, HttpMethod.Post, $"/api/auth/oauth/requests/{requestId}/decide", member,
            new { decision = "approve" });
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        Assert.Equal("admin_required", (await ReadJsonAsync(refused)).GetProperty("code").GetString());

        // Denial is first-class: the client hears access_denied at its own redirect_uri.
        var authorize2 = await AuthorizeAsync(client, clientId, challenge, resource: "http://localhost:7070/api/mcp");
        var requestId2 = authorize2.Headers.Location!.ToString().Split("request=")[1];
        var denied = await DecideAsync(client, admin, requestId2, "deny");
        Assert.Contains("error=access_denied", denied.GetProperty("redirectTo").GetString(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task TheHandshakeIsDiscoverable_MetadataAndTheChallengeHeader()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        using var client = harness.CreateClient();

        var server = await ReadJsonAsync(await client.GetAsync("/.well-known/oauth-authorization-server"));
        Assert.Equal("http://localhost:7070", server.GetProperty("issuer").GetString());
        Assert.Equal("S256", server.GetProperty("code_challenge_methods_supported").EnumerateArray().Single().GetString());

        // Both documents are built from the live public origin, which an operator edits, so neither
        // is storable — a cached one names the machine this host used to be reachable at.
        using var resourceResponse = await client.GetAsync("/.well-known/oauth-protected-resource/api/mcp");
        Assert.True(resourceResponse.Headers.CacheControl?.NoStore);
        var resource = await ReadJsonAsync(resourceResponse);
        Assert.Equal("http://localhost:7070/api/mcp", resource.GetProperty("resource").GetString());
        Assert.Equal("http://localhost:7070", resource.GetProperty("authorization_servers").EnumerateArray().Single().GetString());

        // A 401 from Core MCP names where the metadata lives — the thread a stock client pulls to
        // discover the whole flow.
        using var challenge = await InitializeMcpAsync(client, "not-a-credential");
        Assert.Equal(HttpStatusCode.Unauthorized, challenge.StatusCode);
        var header = challenge.Headers.WwwAuthenticate.ToString();
        Assert.Contains("resource_metadata=", header, StringComparison.Ordinal);
        Assert.Contains("/.well-known/oauth-protected-resource/api/mcp", header, StringComparison.Ordinal);
    }

    [Fact]
    public async Task TheMetadataAdvertisesRegistrationOnlyWhileTheBreakerIsOn()
    {
        // The document must not name a door that answers 403. A client reading a
        // registration_endpoint it cannot use spends the flow discovering that; a client reading no
        // registration_endpoint falls back to the manual token path, which is the honest outcome.
        await using var harness = await CoreHttpHarness.StartAsync();
        var admin = await SeedSessionAsync(harness, "host.admin");
        using var client = harness.CreateClient();

        // Off (the default): the key is absent — not null, absent, per RFC 8414's optional field.
        using var offResponse = await client.GetAsync("/.well-known/oauth-authorization-server");
        // And the document says not to keep it. A copy held by a client or a proxy is a copy of a
        // toggle that has since moved, which would hand back the confusion this test exists to end.
        Assert.True(offResponse.Headers.CacheControl?.NoStore);
        var off = await ReadJsonAsync(offResponse);
        Assert.False(off.TryGetProperty("registration_endpoint", out _));
        // The rest of the document is unaffected: the flow stays discoverable for a client that
        // already registered while the breaker was on.
        Assert.Equal("http://localhost:7070/api/auth/oauth/token", off.GetProperty("token_endpoint").GetString());

        await EnableRegistrationAsync(client, admin);
        var on = await ReadJsonAsync(await client.GetAsync("/.well-known/oauth-authorization-server"));
        Assert.Equal(
            "http://localhost:7070/api/auth/oauth/register",
            on.GetProperty("registration_endpoint").GetString());

        // And it disappears again with the breaker, in the same process — the endpoint reads the
        // live setting rather than a value captured at startup.
        await SetRegistrationAsync(client, admin, "false");
        var offAgain = await ReadJsonAsync(await client.GetAsync("/.well-known/oauth-authorization-server"));
        Assert.False(offAgain.TryGetProperty("registration_endpoint", out _));
    }

    [Fact]
    public async Task AnUnregisteredRedirectUriIsA400_NeverARedirect()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        await SeedShellAsync(harness);
        var admin = await SeedSessionAsync(harness, "host.admin");
        using var client = harness.CreateClient();
        await EnableRegistrationAsync(client, admin);
        var clientId = (await RegisterAsync(client, "c")).GetProperty("client_id").GetString()!;

        // Redirecting to an unvalidated URI would hand the flow to whoever supplied it. 400 in
        // place, both for a foreign URI and for an unknown client.
        var (_, challenge) = NewPkcePair();
        using var foreign = await client.GetAsync(
            $"/api/auth/oauth/authorize?client_id={clientId}&redirect_uri={Uri.EscapeDataString("http://127.0.0.1:9999/other")}" +
            $"&response_type=code&code_challenge={challenge}&code_challenge_method=S256");
        Assert.Equal(HttpStatusCode.BadRequest, foreign.StatusCode);

        using var unknown = await client.GetAsync(
            $"/api/auth/oauth/authorize?client_id=hosty_oauth_nope&redirect_uri={Uri.EscapeDataString(RedirectUri)}" +
            $"&response_type=code&code_challenge={challenge}&code_challenge_method=S256");
        Assert.Equal(HttpStatusCode.BadRequest, unknown.StatusCode);
    }

    // --- helpers -------------------------------------------------------------------------------

    private const string RedirectUri = "http://127.0.0.1:9993/callback";

    private static (string Verifier, string Challenge) NewPkcePair()
    {
        var verifier = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        var challenge = Convert.ToBase64String(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');
        return (verifier, challenge);
    }

    private static async Task EnableRegistrationAsync(HttpClient client, string admin)
        => await SetRegistrationAsync(client, admin, "true");

    private static async Task SetRegistrationAsync(HttpClient client, string admin, string value)
    {
        using var response = await SendAsync(client, HttpMethod.Put, "/api/core/settings", admin,
            new { settings = new Dictionary<string, string> { ["HOSTY_OAUTH_DCR_ENABLED"] = value } });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    private static async Task<JsonElement> RegisterAsync(HttpClient client, string name)
    {
        using var response = await client.PostAsJsonAsync("/api/auth/oauth/register",
            new { redirect_uris = new[] { RedirectUri }, client_name = name });
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return await ReadJsonAsync(response);
    }

    private static Task<HttpResponseMessage> AuthorizeAsync(
        HttpClient client, string clientId, string challenge, string? resource)
        => client.GetAsync(
            $"/api/auth/oauth/authorize?client_id={clientId}&redirect_uri={Uri.EscapeDataString(RedirectUri)}" +
            $"&response_type=code&state=st4te&code_challenge={challenge}&code_challenge_method=S256" +
            (resource is null ? "" : $"&resource={Uri.EscapeDataString(resource)}"));

    private static async Task<string> ApprovedCodeAsync(
        HttpClient client, string admin, string clientId, string challenge,
        string resource = "http://localhost:7070/api/mcp")
    {
        var authorize = await AuthorizeAsync(client, clientId, challenge, resource);
        var requestId = authorize.Headers.Location!.ToString().Split("request=")[1];
        var decided = await DecideAsync(client, admin, requestId, "approve");
        return decided.GetProperty("redirectTo").GetString()!.Split("code=")[1].Split('&')[0];
    }

    private static async Task<JsonElement> DecideAsync(HttpClient client, string session, string requestId, string decision)
    {
        using var response = await SendAsync(
            client, HttpMethod.Post, $"/api/auth/oauth/requests/{requestId}/decide", session, new { decision });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await ReadJsonAsync(response);
    }

    private static async Task<JsonElement> RedeemAsync(HttpClient client, string clientId, string code, string verifier)
    {
        using var response = await PostFormAsync(client, new()
        {
            ["grant_type"] = "authorization_code",
            ["code"] = code,
            ["code_verifier"] = verifier,
            ["client_id"] = clientId,
            ["redirect_uri"] = RedirectUri,
        });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await ReadJsonAsync(response);
    }

    private static async Task<JsonElement> RefreshAsync(HttpClient client, string clientId, string refreshToken)
    {
        using var response = await PostFormAsync(client, new()
        {
            ["grant_type"] = "refresh_token",
            ["refresh_token"] = refreshToken,
            ["client_id"] = clientId,
        });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await ReadJsonAsync(response);
    }

    private static Task<HttpResponseMessage> PostFormAsync(HttpClient client, Dictionary<string, string> form)
        => client.PostAsync("/api/auth/oauth/token", new FormUrlEncodedContent(form));

    private static async Task<HttpResponseMessage> InitializeMcpAsync(HttpClient client, string credential)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, "/api/mcp");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credential);
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
        request.Content = JsonContent.Create(new
        {
            jsonrpc = "2.0",
            id = 1,
            method = "initialize",
            @params = new { protocolVersion = "2025-06-18", capabilities = new { }, clientInfo = new { name = "t", version = "1" } },
        });
        return await client.SendAsync(request);
    }

    private static async Task<JsonElement> IntrospectAsync(HttpClient client, CoreHttpHarness harness, string appId, string token)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, $"/api/internal/apps/{appId}/token/introspect");
        request.Headers.Authorization = new AuthenticationHeaderValue(
            "Bearer", harness.Services.GetRequiredService<AppServiceTokenService>().CreateToken(appId));
        request.Content = JsonContent.Create(new { token });
        using var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await ReadJsonAsync(response);
    }

    private static async Task<HttpResponseMessage> SendAsync(
        HttpClient client, HttpMethod method, string path, string credential, object? body = null)
    {
        var request = new HttpRequestMessage(method, path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credential);
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }

        return await client.SendAsync(request);
    }

    private static async Task<JsonElement> ReadJsonAsync(HttpResponseMessage response)
        => JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.Clone();

    private static Task SeedShellAsync(CoreHttpHarness harness)
        => SeedAppAsync(harness, "hosty.shell", system: true, endpoints:
            [new AppEndpointContract("web", "http", "http://127.0.0.1:7171", Public: true)]);

    private static Task SeedMcpAppAsync(CoreHttpHarness harness, string appId, string mcpUrl)
        => SeedAppAsync(harness, appId, system: false, interfaces: new Dictionary<string, IReadOnlyList<AppInterfaceContract>>
        {
            ["mcp"] = [new AppInterfaceContract("default", null, "/api/mcp")],
        }, interfaceUrl: mcpUrl);

    private static async Task SeedAppAsync(
        CoreHttpHarness harness,
        string appId,
        bool system,
        IReadOnlyList<AppEndpointContract>? endpoints = null,
        Dictionary<string, IReadOnlyList<AppInterfaceContract>>? interfaces = null,
        string? interfaceUrl = null)
    {
        var apps = harness.Services.GetRequiredService<AppRegistryStore>();
        // The interface URL resolution happens in AppSummary projection from endpoints; seeding an
        // endpoint whose origin carries the interface path lets ListAppsAsync resolve the same URL
        // the test hands to the authorize endpoint.
        var endpointList = endpoints ?? (interfaceUrl is null
            ? []
            : [new AppEndpointContract("api", "http", interfaceUrl[..interfaceUrl.LastIndexOf("/api/mcp", StringComparison.Ordinal)], Public: false)]);
        await apps.UpsertAppAsync(new AppRecord(
            Id: appId,
            DisplayName: appId == "hosty.shell" ? "Shell" : "Notes",
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
            Endpoints: endpointList,
            InstalledAt: DateTimeOffset.UtcNow,
            UpdatedAt: DateTimeOffset.UtcNow)
        {
            Interfaces = interfaces,
        });
    }

    private static async Task<string> SeedSessionAsync(
        CoreHttpHarness harness, string role, string userId = "user_1", bool append = false)
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
