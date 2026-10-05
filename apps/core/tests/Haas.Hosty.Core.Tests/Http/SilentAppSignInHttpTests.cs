using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class SilentAppSignInHttpTests
{
    private const string AppId = "example.app";
    private const string SessionId = "browser-session";
    private const string RedirectUri = "http://app.example.test/page?view=notes";
    private static readonly string State = new('a', 64);

    [Fact]
    public async Task SilentOpen_LiveSessionReturnsBoundIdentityOnlyCode_AndLogoutRevokesGrant()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await SeedAsync(host);
        using var browser = host.CreateClient();
        browser.BaseAddress = new Uri("http://127.0.0.1:7070");
        using var request = OpenRequest();
        using var response = await SendOpenAsync(browser, request);

        Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
        Assert.Equal("no-store", response.Headers.CacheControl!.ToString());
        var location = response.Headers.Location!;
        Assert.Equal("app.example.test", location.Host);
        var query = QueryHelpers.ParseQuery(location.Query);
        Assert.Equal("notes", query["view"]);
        Assert.Equal(State, query["state"]);
        Assert.False(query.ContainsKey("error"));
        var code = query["code"].ToString();
        Assert.NotEmpty(code);
        var stored = Assert.Single((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
        Assert.Equal(SessionId, stored.AuthorizingSessionId);
        Assert.False(stored.ActivityAuthorized);

        using var app = host.CreateClient();
        app.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(AppId));
        using var exchanged = await app.PostAsJsonAsync("/api/auth/apps/token", new { code, codeVerifier = AuthCodeProof.Verifier });
        exchanged.EnsureSuccessStatusCode();
        var token = (await exchanged.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString()!;
        var identity = host.Services.GetRequiredService<AppIdentityService>();
        Assert.Null((await identity.RevalidateAsync(token, AppId)).ActiveUntil);
        Assert.Equal("reauth_required", (await Assert.ThrowsAsync<AppIdentityException>(() =>
            identity.RequireActivityAsync(token, AppId, default))).Code);

        using var logout = new HttpRequestMessage(HttpMethod.Post, "/api/auth/logout");
        logout.Headers.Add("Cookie", $"hosty_session={SessionId}; hosty_csrf=logout-csrf");
        logout.Headers.Add(CoreSessionAuthorization.CsrfHeaderName, "logout-csrf");
        using var loggedOut = await browser.SendAsync(logout);
        loggedOut.EnsureSuccessStatusCode();
        Assert.Equal("token_revoked", (await Assert.ThrowsAsync<AppIdentityException>(() => identity.RevalidateAsync(token, AppId))).Code);
    }

    [Theory]
    [InlineData("logout")]
    [InlineData("removed")]
    public async Task SilentOpen_CodeCannotBecomeAGrantAfterItsParentSessionIsRevoked(string revocation)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await SeedAsync(host);
        using var browser = host.CreateClient();
        browser.BaseAddress = new Uri("http://127.0.0.1:7070");
        using var request = OpenRequest();
        using var response = await SendOpenAsync(browser, request);
        var code = QueryHelpers.ParseQuery(response.Headers.Location!.Query)["code"].ToString();
        if (revocation == "logout")
        {
            using var logout = new HttpRequestMessage(HttpMethod.Post, "/api/auth/logout");
            logout.Headers.Add("Cookie", $"hosty_session={SessionId}; hosty_csrf=logout-csrf");
            logout.Headers.Add(CoreSessionAuthorization.CsrfHeaderName, "logout-csrf");
            using var loggedOut = await browser.SendAsync(logout);
            loggedOut.EnsureSuccessStatusCode();
        }
        else
        {
            await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(state => state with { Sessions = [] });
        }
        using var app = host.CreateClient();
        app.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(AppId));
        using var exchanged = await app.PostAsJsonAsync("/api/auth/apps/token", new { code, codeVerifier = AuthCodeProof.Verifier });

        Assert.Equal(HttpStatusCode.Unauthorized, exchanged.StatusCode);
        Assert.Equal("token_revoked", (await exchanged.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
        Assert.NotNull(Assert.Single((await host.Services.GetRequiredService<AppSessionGrantStore>().ReadAsync()).Grants).RevokedAt);
    }

    [Fact]
    public async Task SilentOpen_ParentExpiryDoesNotRevokeIdentityOnlyCodeOrGrant()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await SeedAsync(host);
        using var browser = host.CreateClient();
        browser.BaseAddress = new Uri("http://127.0.0.1:7070");
        using var request = OpenRequest();
        using var response = await SendOpenAsync(browser, request);
        var code = QueryHelpers.ParseQuery(response.Headers.Location!.Query)["code"].ToString();
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(state => state with
        {
            Sessions = state.Sessions.Select(session => session with { ExpiresAt = now }).ToArray(),
        });
        using var app = host.CreateClient();
        app.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(AppId));
        using var exchanged = await app.PostAsJsonAsync("/api/auth/apps/token", new { code, codeVerifier = AuthCodeProof.Verifier });
        exchanged.EnsureSuccessStatusCode();
        var token = (await exchanged.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString()!;
        var identity = await host.Services.GetRequiredService<AppIdentityService>().RevalidateAsync(token, AppId);

        Assert.True(identity.Active);
        Assert.Null(identity.ActiveUntil);
    }

    [Fact]
    public async Task SilentOpen_ParentExpiryPrunedByLoginDoesNotRevokeAnEstablishedGrant()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await SeedAsync(host);
        using var browser = host.CreateClient();
        browser.BaseAddress = new Uri("http://127.0.0.1:7070");
        using var firstRequest = OpenRequest();
        using var firstResponse = await SendOpenAsync(browser, firstRequest);
        var firstCode = QueryHelpers.ParseQuery(firstResponse.Headers.Location!.Query)["code"].ToString();
        using var app = host.CreateClient();
        app.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(AppId));
        using var firstExchange = await app.PostAsJsonAsync("/api/auth/apps/token", new { code = firstCode, codeVerifier = AuthCodeProof.Verifier });
        firstExchange.EnsureSuccessStatusCode();
        var olderToken = (await firstExchange.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("accessToken").GetString()!;
        using var delayedRequest = OpenRequest();
        using var delayedResponse = await SendOpenAsync(browser, delayedRequest);
        var delayedCode = QueryHelpers.ParseQuery(delayedResponse.Headers.Location!.Query)["code"].ToString();

        const string password = "correct-horse-battery-staple";
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        var passwords = host.Services.GetRequiredService<LocalPasswordAuthService>();
        await users.UpdateAsync(state => state with
        {
            Sessions = state.Sessions.Select(session => session with { ExpiresAt = now }).ToArray(),
            PasswordCredentials = passwords.UpsertCredential(state.PasswordCredentials, "user", password, now),
        });
        using var login = await browser.PostAsync("/login", new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["email"] = "user@example.test", ["password"] = password,
            ["returnTo"] = $"/api/apps/{AppId}/open?redirectUri={Uri.EscapeDataString(RedirectUri)}",
        }));
        Assert.Equal(HttpStatusCode.Redirect, login.StatusCode);
        Assert.DoesNotContain((await users.ReadAsync()).Sessions, session => session.Id == SessionId);

        using var delayedExchange = await app.PostAsJsonAsync("/api/auth/apps/token", new { code = delayedCode, codeVerifier = AuthCodeProof.Verifier });
        Assert.Equal(HttpStatusCode.Unauthorized, delayedExchange.StatusCode);
        var identity = await host.Services.GetRequiredService<AppIdentityService>().RevalidateAsync(olderToken, AppId);
        Assert.True(identity.Active);
        Assert.Null(identity.ActiveUntil);
        var grants = (await host.Services.GetRequiredService<AppSessionGrantStore>().ReadAsync()).Grants;
        Assert.Null(grants.Single(grant => grant.TokenHash == AppIdentityService.HashToken(olderToken)).RevokedAt);
        Assert.Single(grants, grant => grant.RevokedAt is not null);
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("unknown")]
    [InlineData("expired")]
    [InlineData("idle-expired")]
    [InlineData("revoked")]
    public async Task SilentOpen_WithoutLiveSessionReturnsLoginRequiredToApp(string sessionState)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await SeedAsync(host);
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        await users.UpdateAsync(state => state with
        {
            Sessions = state.Sessions.Select(session => sessionState switch
            {
                "expired" => session with { ExpiresAt = now },
                "idle-expired" => session with { LastSeenAt = now.Subtract(AuthLifetimes.Defaults.CoreSessionIdle).AddSeconds(-1) },
                "revoked" => session with { RevokedAt = now },
                _ => session,
            }).ToArray(),
        });
        using var browser = host.CreateClient();
        browser.BaseAddress = new Uri("http://127.0.0.1:7070");
        using var request = OpenRequest(sessionId: sessionState switch { "missing" => null, "unknown" => "unknown", _ => SessionId });
        using var response = await SendOpenAsync(browser, request);

        AssertAppErrorRedirect(response, "login_required");
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
    }

    [Theory]
    [InlineData("login_required")]
    [InlineData("access_denied")]
    public async Task SilentOpen_CallbackStateIsNotDuplicatedOnErrors(string error)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await SeedAsync(host);
        if (error == "access_denied")
            await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(current => current with { Assignments = [] });
        using var browser = host.CreateClient();
        browser.BaseAddress = new Uri("http://127.0.0.1:7070");
        using var request = OpenRequest(redirectUri: RedirectUri + "&state=" + State, sessionId: error == "login_required" ? null : SessionId);
        using var response = await SendOpenAsync(browser, request);
        Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
        var query = QueryHelpers.ParseQuery(response.Headers.Location!.Query);
        Assert.Equal(error, query["error"].ToString());
        Assert.Equal(1, query["state"].Count);
        Assert.Equal(State, query["state"].ToString());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SilentOpen_CookieRefusalReturnsOnlyTheStoredErrorCallback_WithoutBurningTheIntent(bool wrongNonce)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await SeedAsync(host);
        using var browser = host.CreateClient();
        browser.BaseAddress = new Uri("http://127.0.0.1:7070");
        using var request = OpenRequest(redirectUri: RedirectUri + "&state=" + State);
        using var started = await browser.SendAsync(request);
        Assert.Equal(HttpStatusCode.SeeOther, started.StatusCode);
        var nonceCookie = started.Headers.GetValues("Set-Cookie").Single().Split(';')[0];
        using var rejectedRequest = new HttpRequestMessage(HttpMethod.Get, started.Headers.Location);
        rejectedRequest.Headers.Add("Sec-Fetch-Mode", "navigate");
        rejectedRequest.Headers.Add("Sec-Fetch-Dest", "iframe");
        rejectedRequest.Headers.Add("Cookie", "hosty_session=" + SessionId + (wrongNonce ? "; " + nonceCookie.Split('=')[0] + "=" + new string('b', 64) : ""));
        using var rejected = await browser.SendAsync(rejectedRequest);
        AssertAppErrorRedirect(rejected, "login_required");
        Assert.Equal(1, QueryHelpers.ParseQuery(rejected.Headers.Location!.Query)["state"].Count);
        Assert.False(rejected.Headers.Contains("Set-Cookie"));
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
        using var rightfulRequest = new HttpRequestMessage(HttpMethod.Get, started.Headers.Location);
        rightfulRequest.Headers.Add("Sec-Fetch-Mode", "navigate");
        rightfulRequest.Headers.Add("Sec-Fetch-Dest", "iframe");
        rightfulRequest.Headers.Add("Cookie", nonceCookie + "; hosty_session=" + SessionId);
        using var rightful = await browser.SendAsync(rightfulRequest);
        Assert.NotEmpty(QueryHelpers.ParseQuery(rightful.Headers.Location!.Query)["code"].ToString());
    }

    [Theory]
    [InlineData("document", AppId)]
    [InlineData("iframe", "wrong.app")]
    public async Task SilentOpen_UnboundErrorCallbackDoesNotAcceptOtherAppsOrTopLevelNavigation(string destination, string appId)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await SeedAsync(host);
        using var browser = host.CreateClient();
        browser.BaseAddress = new Uri("http://127.0.0.1:7070");
        using var intent = OpenRequest();
        using var started = await browser.SendAsync(intent);
        using var wrong = new HttpRequestMessage(HttpMethod.Get, started.Headers.Location!.OriginalString.Replace(AppId, appId));
        wrong.Headers.Add("Sec-Fetch-Mode", "navigate"); wrong.Headers.Add("Sec-Fetch-Dest", destination);
        using var denied = await browser.SendAsync(wrong);
        Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
        Assert.Null(denied.Headers.Location);
        Assert.False(denied.Headers.Contains("Set-Cookie"));
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
    }

    [Theory]
    [InlineData("disabled")]
    [InlineData("unassigned")]
    [InlineData("scoped")]
    public async Task SilentOpen_DeniedSessionReturnsAccessDeniedToApp(string deniedReason)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await SeedAsync(host);
        await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(state => state with
        {
            Users = state.Users.Select(user => user with { Disabled = deniedReason == "disabled" }).ToArray(),
            Assignments = deniedReason == "unassigned" ? [] : state.Assignments,
            Sessions = state.Sessions.Select(session => deniedReason == "scoped" ? session with { Audience = AppId } : session).ToArray(),
        });
        using var browser = host.CreateClient();
        browser.BaseAddress = new Uri("http://127.0.0.1:7070");
        using var request = OpenRequest();
        using var response = await SendOpenAsync(browser, request);

        AssertAppErrorRedirect(response, "access_denied");
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("document")]
    [InlineData("empty")]
    [InlineData("image")]
    public async Task SilentOpen_OnlyIframeNavigationsAreAccepted(string? destination)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await SeedAsync(host);
        using var browser = host.CreateClient();
        browser.BaseAddress = new Uri("http://127.0.0.1:7070");
        using var request = OpenRequest(destination: destination);
        using var response = await SendOpenAsync(browser, request);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Null(response.Headers.Location);
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("short")]
    [InlineData("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    [InlineData("gaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    public async Task SilentOpen_Requires256BitHexState(string? state)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await SeedAsync(host);
        using var browser = host.CreateClient();
        browser.BaseAddress = new Uri("http://127.0.0.1:7070");
        using var request = OpenRequest(state: state);
        using var response = await SendOpenAsync(browser, request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("prompt_invalid", (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
        Assert.Null(response.Headers.Location);
    }

    [Theory]
    [InlineData(null)]
    [InlineData(SessionId)]
    public async Task SilentOpen_RejectsForeignRedirectBeforeReturningCredentialsOrErrors(string? sessionId)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await SeedAsync(host);
        using var browser = host.CreateClient();
        browser.BaseAddress = new Uri("http://127.0.0.1:7070");
        using var request = OpenRequest(redirectUri: "http://foreign.example.test/callback", sessionId: sessionId);
        using var response = await SendOpenAsync(browser, request);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal("redirect_uri_denied", (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
        Assert.Null(response.Headers.Location);
    }

    [Theory]
    [InlineData("http://app.example.test/page#fragment")]
    [InlineData("/callback")]
    public async Task SilentOpen_RejectsMalformedRedirect(string redirectUri)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await SeedAsync(host);
        using var browser = host.CreateClient();
        browser.BaseAddress = new Uri("http://127.0.0.1:7070");
        using var request = OpenRequest(redirectUri: redirectUri);
        using var response = await SendOpenAsync(browser, request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("redirect_uri_invalid", (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
        Assert.Null(response.Headers.Location);
    }

    [Theory]
    [InlineData("select_account", null)]
    [InlineData("none", "web_message")]
    public async Task SilentOpen_RejectsOtherPromptsAndMixedPopupMode(string prompt, string? responseMode)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await SeedAsync(host);
        using var browser = host.CreateClient();
        browser.BaseAddress = new Uri("http://127.0.0.1:7070");
        using var request = OpenRequest();
        request.Content = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["redirectUri"] = RedirectUri, ["state"] = State, ["prompt"] = prompt,
            ["responseMode"] = responseMode ?? "", ["codeChallenge"] = AuthCodeProof.Challenge,
            ["codeChallengeMethod"] = "S256",
        });
        using var response = await SendOpenAsync(browser, request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Null(response.Headers.Location);
    }

    private static void AssertAppErrorRedirect(HttpResponseMessage response, string error)
    {
        Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
        var location = response.Headers.Location!;
        Assert.Equal("app.example.test", location.Host);
        Assert.Equal("/page", location.AbsolutePath);
        var query = QueryHelpers.ParseQuery(location.Query);
        Assert.Equal(error, query["error"]);
        Assert.Equal(State, query["state"]);
        Assert.Equal("notes", query["view"]);
        Assert.False(query.ContainsKey("code"));
    }

    private static HttpRequestMessage OpenRequest(string? state = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        string? destination = "iframe", string redirectUri = RedirectUri, string? sessionId = SessionId)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, $"/api/apps/{AppId}/sign-in-intent");
        var fields = new Dictionary<string, string>
        {
            ["redirectUri"] = redirectUri, ["prompt"] = "none",
            ["codeChallenge"] = AuthCodeProof.Challenge, ["codeChallengeMethod"] = "S256",
        };
        if (state is not null) fields["state"] = state;
        request.Content = new FormUrlEncodedContent(fields);
        request.Headers.Add("Origin", "http://app.example.test");
        request.Headers.Add("Sec-Fetch-Mode", "navigate");
        if (destination is not null) request.Headers.Add("Sec-Fetch-Dest", destination);
        if (sessionId is not null) request.Headers.Add("Cookie", $"hosty_session={sessionId}");
        return request;
    }

    private static async Task<HttpResponseMessage> SendOpenAsync(HttpClient browser, HttpRequestMessage request)
    {
        var started = await browser.SendAsync(request);
        if (started.StatusCode != HttpStatusCode.SeeOther) return started;
        using (started)
        using (var continuation = new HttpRequestMessage(HttpMethod.Get, started.Headers.Location))
        {
            foreach (var header in request.Headers.Where(header => header.Key != "Cookie"))
                continuation.Headers.TryAddWithoutValidation(header.Key, header.Value);
            var session = request.Headers.TryGetValues("Cookie", out var cookies) ? string.Join("; ", cookies) + "; " : "";
            continuation.Headers.Add("Cookie", session + started.Headers.GetValues("Set-Cookie").Single().Split(';')[0]);
            return await browser.SendAsync(continuation);
        }
    }

    private static async Task SeedAsync(CoreHttpHarness host)
    {
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        var user = new HostUserRecord("user", "user@example.test", "Test User", "host.user", false, now, now);
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new UserDirectoryState(1, [user], [],
            [new(AppId, user.Id, now)], [new(SessionId, user.Id, now, now.AddHours(8), null, now, BrowserOrigin: "http://localhost:7070")]));
        await host.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(new AppRecord(AppId, "Test app", null,
            "1.0.0", "runtime", false, "manifest", null, null, "dev", "installed", "stopped", null, null, [],
            new Dictionary<string, AppSettingValue>(), [], [], [new("web", "http", "http://app.example.test", true)], now, now));
    }
}
