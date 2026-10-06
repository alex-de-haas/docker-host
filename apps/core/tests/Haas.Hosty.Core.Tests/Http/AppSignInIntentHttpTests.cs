using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class AppSignInIntentHttpTests
{
    private const string AppId = "example.app";
    private const string AppOrigin = "http://app.example.test";
    private const string SessionId = "browser-session";
    private static readonly string State = new('a', 64);

    [Theory]
    [InlineData(null)]
    [InlineData("null")]
    [InlineData("http://evil.example.test")]
    [InlineData("http://other.app.example.test")]
    [InlineData("http://app.example.test:8080")]
    public async Task Intent_RequiresTheExactTargetAppOrigin(string? origin)
    {
        await using var host = await HostAsync();
        using var browser = Browser(host);
        using var response = await IntentAsync(browser, origin);
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal("sign_in_origin_invalid", await ErrorAsync(response));
        Assert.False(response.Headers.Contains("Set-Cookie"));
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
    }

    [Fact]
    public async Task RelayedAttackerIntent_CannotIssueInVictimBrowser_AndFailureDoesNotConsumeIt()
    {
        await using var host = await HostAsync();
        using var attacker = Browser(host);
        using var started = await IntentAsync(attacker);
        Assert.Equal(HttpStatusCode.SeeOther, started.StatusCode);
        var nonceCookie = Cookie(started);
        using var victim = Browser(host);
        using var absent = await OpenAsync(victim, started.Headers.Location!, "hosty_session=" + SessionId);
        Assert.Equal(HttpStatusCode.Forbidden, absent.StatusCode);
        Assert.Null(absent.Headers.Location);
        Assert.False(absent.Headers.Contains("Set-Cookie"));
        using var wrong = await OpenAsync(victim, started.Headers.Location!, nonceCookie.Split('=')[0] + "=" + new string('b', 64) + "; hosty_session=" + SessionId);
        Assert.Equal(HttpStatusCode.Forbidden, wrong.StatusCode);
        Assert.False(wrong.Headers.Contains("Set-Cookie"));
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
        using var rightful = await OpenAsync(attacker, started.Headers.Location!, nonceCookie + "; hosty_session=" + SessionId);
        Assert.Equal(HttpStatusCode.Redirect, rightful.StatusCode);
        var code = QueryHelpers.ParseQuery(rightful.Headers.Location!.Query)["code"].ToString();
        Assert.NotEmpty(code);
        var record = Assert.Single((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
        Assert.Equal(AuthCodeProof.Challenge, record.CodeChallenge);
        Assert.Equal(SessionId, record.AuthorizingSessionId);
        Assert.True(record.ActivityAuthorized);
        var audit = await File.ReadAllTextAsync(host.Services.GetRequiredService<CoreDataPaths>().AuditLogPath);
        foreach (var secret in new[] { code, nonceCookie.Split('=')[1], AuthCodeProof.Challenge, AuthCodeProof.Verifier })
            Assert.DoesNotContain(secret, audit);
    }

    [Theory]
    [InlineData("&state=changed")]
    [InlineData("&codeChallenge=changed")]
    [InlineData("&redirectUri=http://app.example.test/other")]
    [InlineData("&prompt=none")]
    [InlineData("&requestId=duplicate")]
    public async Task Continuation_RejectsOverridesWithoutConsumingTheIntent(string suffix)
    {
        await using var host = await HostAsync();
        using var browser = Browser(host);
        using var started = await IntentAsync(browser);
        var cookies = Cookie(started) + "; hosty_session=" + SessionId;
        using var refused = await OpenAsync(browser, new Uri(started.Headers.Location!.OriginalString + suffix, UriKind.Relative), cookies);
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        Assert.False(refused.Headers.Contains("Set-Cookie"));
        using var rightful = await OpenAsync(browser, started.Headers.Location, cookies);
        Assert.Equal(HttpStatusCode.Redirect, rightful.StatusCode);
        Assert.Single((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
    }

    [Fact]
    public async Task Continuation_ClaimsOnceAcrossConcurrentRequests_AndSeparateAttemptsHaveSeparateCookies()
    {
        await using var host = await HostAsync();
        using var browser = Browser(host);
        using var first = await IntentAsync(browser);
        using var second = await IntentAsync(browser);
        Assert.NotEqual(first.Headers.Location, second.Headers.Location);
        Assert.NotEqual(Cookie(first).Split('=')[0], Cookie(second).Split('=')[0]);
        var cookie = Cookie(first) + "; hosty_session=" + SessionId;
        var responses = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => OpenAsync(browser, first.Headers.Location!, cookie)));
        try
        {
            Assert.Single(responses, response => response.StatusCode == HttpStatusCode.Redirect);
            Assert.Equal(7, responses.Count(response => response.StatusCode == HttpStatusCode.Forbidden));
        }
        finally { foreach (var response in responses) response.Dispose(); }
        using var independent = await OpenAsync(browser, second.Headers.Location!, Cookie(second) + "; hosty_session=" + SessionId);
        Assert.Equal(HttpStatusCode.Redirect, independent.StatusCode);
        Assert.Equal(2, (await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes.Count);
    }

    [Fact]
    public async Task Continuation_ValidNonceSurvivesLogin_AndExpiredIntentCannotIssue()
    {
        var clock = new Clock();
        await using var host = await HostAsync(clock);
        using var browser = Browser(host);
        using var started = await IntentAsync(browser);
        using var login = await OpenAsync(browser, started.Headers.Location!, Cookie(started));
        Assert.Equal(HttpStatusCode.Redirect, login.StatusCode);
        Assert.Equal(started.Headers.Location!.OriginalString, QueryHelpers.ParseQuery(login.Headers.Location!.OriginalString["/login".Length..])["returnTo"].ToString());
        Assert.False(login.Headers.Contains("Set-Cookie"));
        clock.UtcNow = clock.UtcNow.AddMinutes(5);
        using var expired = await OpenAsync(browser, started.Headers.Location, Cookie(started) + "; hosty_session=" + SessionId);
        Assert.Equal(HttpStatusCode.Forbidden, expired.StatusCode);
        Assert.True(Microsoft.Net.Http.Headers.SetCookieHeaderValue.Parse(expired.Headers.GetValues("Set-Cookie").Single()).Expires < clock.UtcNow);
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
    }

    [Theory]
    [InlineData("http://core.example.test:7070", "http://app.example.test", 409)]
    [InlineData("http://127.0.0.1:7070", "http://127.1:3100", 409)]
    [InlineData("http://[::1]:7070", "http://[0:0:0:0:0:0:0:1]:3100", 409)]
    [InlineData("https://CORE.Example.test.:7070", "https://core.example.test:3100", 409)]
    [InlineData("http://127.0.0.1:7070", "http://localhost:3100", 303)]
    [InlineData("http://127.0.0.2:7070", "http://127.0.0.1:3100", 303)]
    [InlineData("http://[::1]:7070", "http://127.0.0.1:3100", 303)]
    [InlineData("https://core.example.test", "https://app.example.test", 303)]
    public async Task Intent_EnforcesCookieHostTopologyAndCanonicalAliases(string core, string app, int status)
    {
        await using var host = await HostAsync(appOrigin: app);
        using var browser = Browser(host, core);
        using var started = await IntentAsync(browser, app, app + "/callback");
        Assert.Equal(status, (int)started.StatusCode);
        if (status == 409) Assert.Equal("sign_in_cookie_host_unsafe", await ErrorAsync(started));
        else
        {
            var cookie = started.Headers.GetValues("Set-Cookie").Single();
            Assert.Contains("path=/", cookie);
            Assert.Contains("httponly", cookie);
            Assert.Contains("samesite=lax", cookie);
            Assert.Contains("max-age=300", cookie);
            Assert.DoesNotContain("domain=", cookie);
            if (core.StartsWith("https")) { Assert.StartsWith("__Host-", cookie); Assert.Contains("secure", cookie); }
            else { Assert.StartsWith("hosty_signin_", cookie); Assert.DoesNotContain("; secure", cookie); }
            Assert.DoesNotContain(Cookie(started).Split('=')[1], await started.Content.ReadAsStringAsync());
        }
    }

    [Fact]
    public async Task Intent_ChecksEveryInstalledAppHost_AndRefusesCapacityWithoutEviction()
    {
        await using var host = await HostAsync();
        using var browser = Browser(host);
        using var first = await IntentAsync(browser);
        for (var index = 1; index < OAuthAuthorizationStore.MaxPendingPerSource; index++)
        {
            using var next = await IntentAsync(browser);
            Assert.Equal(HttpStatusCode.SeeOther, next.StatusCode);
        }
        using var capacity = await IntentAsync(browser);
        Assert.Equal(HttpStatusCode.TooManyRequests, capacity.StatusCode);
        using var rightful = await OpenAsync(browser, first.Headers.Location!, Cookie(first) + "; hosty_session=" + SessionId);
        Assert.Equal(HttpStatusCode.Redirect, rightful.StatusCode);
        await AddAppAsync(host, "other.app", "http://127.0.0.1:9000");
        using var unsafeHost = await IntentAsync(browser);
        Assert.Equal(HttpStatusCode.Conflict, unsafeHost.StatusCode);
    }

    [Theory]
    [InlineData("ws://core.example.test:9000", 409)]
    [InlineData("wss://CORE.example.test.:9000", 409)]
    [InlineData("tcp://core.example.test:9000", 409)]
    [InlineData("custom://core.example.test:9000", 409)]
    [InlineData("wss://socket.example.test:9000", 303)]
    public async Task Intent_ChecksPrivateEndpointHostsRegardlessOfDeclaredProtocol(string endpoint, int status)
    {
        await using var host = await HostAsync();
        using var browser = Browser(host, "https://core.example.test");
        await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(state => state with
        {
            Sessions = state.Sessions.Select(session => session with { BrowserOrigin = "https://core.example.test" }).ToArray(),
        });
        using var started = await IntentAsync(browser);
        Assert.Equal(HttpStatusCode.SeeOther, started.StatusCode);
        await AddAppAsync(host, "socket.app", endpoint);
        await host.Services.GetRequiredService<AppRegistryStore>().UpdateAppAsync("socket.app", app => app with
        {
            Endpoints = app.Endpoints.Select(value => value with { Public = false, Protocol = new Uri(endpoint).Scheme }).ToArray(),
        });
        using var fresh = await IntentAsync(browser);
        Assert.Equal(status, (int)fresh.StatusCode);
        using var continuation = await OpenAsync(browser, started.Headers.Location!, Cookie(started) + "; hosty_session=" + SessionId);
        Assert.Equal(status == 409 ? HttpStatusCode.Conflict : HttpStatusCode.Redirect, continuation.StatusCode);
        if (status == 409)
        {
            Assert.Equal("sign_in_cookie_host_unsafe", await ErrorAsync(fresh));
            Assert.Equal("sign_in_cookie_host_unsafe", await ErrorAsync(continuation));
            Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
            Assert.Empty((await host.Services.GetRequiredService<AppSessionGrantStore>().ReadAsync()).Grants);
        }
    }

    [Fact]
    public async Task Continuation_BrowserCapacityRefusesOnlyTheNewAttempt_WhenPostOmittedLaxCookies()
    {
        await using var host = await HostAsync();
        var store = host.Services.GetRequiredService<AppSignInIntentStore>();
        // Different sources model a browser moving networks; the per-source cap still applies to each.
        var attempts = Enumerable.Range(0, 17).Select(index => store.Create(AppId, AppOrigin + "/callback", State,
            AuthCodeProof.Challenge, AppSignInMode.Standalone, index.ToString(), 0)!).ToArray();
        var cookies = string.Join("; ", attempts.Select(attempt => "hosty_signin_" + attempt.Intent.Id + "=" + attempt.Nonce)) + "; hosty_session=" + SessionId;
        using var browser = Browser(host);
        using var newest = await OpenAsync(browser, new Uri($"/api/apps/{AppId}/open?requestId={attempts[^1].Intent.Id}", UriKind.Relative), cookies);
        Assert.Equal(HttpStatusCode.TooManyRequests, newest.StatusCode);
        Assert.Contains("hosty_signin_" + attempts[^1].Intent.Id + "=;", newest.Headers.GetValues("Set-Cookie").Single());
        using var older = await OpenAsync(browser, new Uri($"/api/apps/{AppId}/open?requestId={attempts[0].Intent.Id}", UriKind.Relative), cookies);
        Assert.Equal(HttpStatusCode.Redirect, older.StatusCode);
        Assert.Same(attempts[1].Intent, store.Find(AppId, attempts[1].Intent.Id, attempts[1].Nonce));
    }

    [Fact]
    public async Task PlainBootstrapIsCredentialFree_AndProofBearingGetCannotIssue()
    {
        await using var host = await HostAsync();
        using var browser = Browser(host);
        using var bootstrap = await browser.GetAsync($"/api/apps/{AppId}/open?redirectUri={Uri.EscapeDataString(AppOrigin + "/page")}");
        Assert.Equal(HttpStatusCode.Redirect, bootstrap.StatusCode);
        Assert.Equal(AppOrigin + "/page", bootstrap.Headers.Location!.OriginalString);
        using var proofGet = await browser.GetAsync($"/api/apps/{AppId}/open?redirectUri={Uri.EscapeDataString(AppOrigin + "/page")}&codeChallenge={AuthCodeProof.Challenge}&codeChallengeMethod=S256&state={State}");
        Assert.Equal(HttpStatusCode.Forbidden, proofGet.StatusCode);
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
        using var metadata = await browser.GetAsync("/api/auth/apps/protocol");
        Assert.Equal(2, (await metadata.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("version").GetInt32());
        Assert.Equal("no-store", metadata.Headers.CacheControl!.ToString());
    }

    [Theory]
    [InlineData("standalone", false)]
    [InlineData("standalone", true)]
    [InlineData("silent", false)]
    [InlineData("silent", true)]
    [InlineData("popup", false)]
    [InlineData("popup", true)]
    public async Task LegacyGet_UpgradeRefusalReturnsOnlyCorrelatedError_AndPreservesLiveIntentAndCode(string mode, bool callbackHasState)
    {
        await using var host = await HostAsync();
        using var browser = Browser(host);
        using var pending = await IntentAsync(browser);
        var pendingId = QueryHelpers.ParseQuery(pending.Headers.Location!.OriginalString.Split('?')[1])["requestId"].ToString();
        var intents = host.Services.GetRequiredService<AppSignInIntentStore>();
        var intent = intents.Find(AppId, pendingId, Cookie(pending).Split('=')[1]);
        var previous = await host.Services.GetRequiredService<AppIdentityService>().CreateAuthorizationCodeAsync(
            AppId, "user", AppOrigin + "/callback", AuthCodeProof.Challenge, "S256", SessionId);
        var sessions = (await host.Services.GetRequiredService<UserDirectoryStore>().ReadAsync()).Sessions;
        var redirect = AppOrigin + "/page?view=notes" + (callbackHasState ? "&state=" + State : "");
        using var request = LegacyRequest(mode, redirect);
        request.Headers.Add("Cookie", "hosty_session=" + SessionId + "; " + Cookie(pending));
        using var response = await browser.SendAsync(request);

        Assert.Equal("no-store", response.Headers.CacheControl!.ToString());
        Assert.Equal("no-referrer", response.Headers.GetValues("Referrer-Policy").Single());
        Assert.False(response.Headers.Contains("Set-Cookie"));
        if (mode == "popup")
        {
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Null(response.Headers.Location);
            var html = await response.Content.ReadAsStringAsync();
            Assert.Contains("type:\"hosty:app-auth-code\"", html);
            Assert.Contains("state:\"" + State + "\"", html);
            Assert.Contains("error:\"protocol_required\"},\"" + AppOrigin + "\"", html);
            Assert.DoesNotContain("code:", html);
            Assert.DoesNotContain("window.close()", html);
            Assert.Contains("frame-ancestors 'none'", response.Headers.GetValues("Content-Security-Policy").Single());
        }
        else
        {
            Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
            var query = QueryHelpers.ParseQuery(response.Headers.Location!.Query);
            Assert.Equal("notes", query["view"].ToString());
            Assert.Equal("protocol_required", query["error"].ToString());
            Assert.Equal(State, query["state"].ToString());
            Assert.Equal(1, query["state"].Count);
            Assert.False(query.ContainsKey("code"));
            Assert.False(query.ContainsKey("codeChallenge"));
        }
        Assert.Same(intent, intents.Find(AppId, pendingId, Cookie(pending).Split('=')[1]));
        var code = Assert.Single((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
        Assert.Equal(previous.Code, code.Code);
        Assert.Null(code.ConsumedAt);
        Assert.Empty((await host.Services.GetRequiredService<AppSessionGrantStore>().ReadAsync()).Grants);
        Assert.Equal(sessions, (await host.Services.GetRequiredService<UserDirectoryStore>().ReadAsync()).Sessions);
        var audit = await File.ReadAllTextAsync(host.Services.GetRequiredService<CoreDataPaths>().AuditLogPath);
        Assert.Contains("protocol_required", audit);
        foreach (var secret in new[] { previous.Code, State, AuthCodeProof.Challenge, AuthCodeProof.Verifier, Cookie(pending).Split('=')[1] })
            Assert.DoesNotContain(secret, audit);
    }

    [Theory]
    [InlineData("missing-state")]
    [InlineData("short-state")]
    [InlineData("callback-state")]
    [InlineData("duplicate-callback-state")]
    [InlineData("missing-challenge")]
    [InlineData("plain-method")]
    [InlineData("noncanonical-challenge")]
    [InlineData("unknown-field")]
    [InlineData("duplicate-field")]
    [InlineData("foreign-redirect")]
    [InlineData("unknown-app")]
    [InlineData("wrong-prompt")]
    [InlineData("wrong-response-mode")]
    [InlineData("both-modes")]
    [InlineData("empty-selector")]
    [InlineData("wrong-destination")]
    [InlineData("no-navigation")]
    [InlineData("foreign-origin")]
    [InlineData("null-origin")]
    public async Task LegacyGet_MalformedOrForeignAttemptStillFailsClosed(string mutation)
    {
        await using var host = await HostAsync();
        using var browser = Browser(host);
        using var request = LegacyRequest();
        var query = QueryHelpers.ParseQuery(request.RequestUri!.Query).ToDictionary(field => field.Key, field => field.Value.ToString());
        switch (mutation)
        {
            case "missing-state": query.Remove("state"); break;
            case "short-state": query["state"] = "short"; break;
            case "callback-state": query["redirectUri"] += "?state=" + new string('b', 64); break;
            case "duplicate-callback-state": query["redirectUri"] += "?state=" + State + "&state=" + State; break;
            case "missing-challenge": query.Remove("codeChallenge"); break;
            case "plain-method": query["codeChallengeMethod"] = "plain"; break;
            case "noncanonical-challenge": query["codeChallenge"] = new string('_', 43); break;
            case "unknown-field": query["userId"] = "user"; break;
            case "foreign-redirect": query["redirectUri"] = "http://evil.example.test/callback"; break;
            case "wrong-prompt": query["prompt"] = "login"; break;
            case "wrong-response-mode": query["responseMode"] = "native"; break;
            case "both-modes": query["prompt"] = "none"; query["responseMode"] = "web_message"; break;
            case "empty-selector": query["prompt"] = ""; break;
            case "wrong-destination": request.Headers.Remove("Sec-Fetch-Dest"); request.Headers.Add("Sec-Fetch-Dest", "iframe"); break;
            case "no-navigation": request.Headers.Remove("Sec-Fetch-Mode"); break;
            case "foreign-origin": request.Headers.Add("Origin", "http://evil.example.test"); break;
            case "null-origin": request.Headers.Add("Origin", "null"); break;
        }
        var path = $"/api/apps/{(mutation == "unknown-app" ? "unknown.app" : AppId)}/open";
        request.RequestUri = new Uri(QueryHelpers.AddQueryString("http://127.0.0.1:7070" + path, query.Select(field =>
            new KeyValuePair<string, string?>(field.Key, field.Value))) + (mutation == "duplicate-field" ? "&state=" + State : ""));
        using var response = await browser.SendAsync(request);
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal("sign_in_intent_invalid", await ErrorAsync(response));
        Assert.Null(response.Headers.Location);
        Assert.False(response.Headers.Contains("Set-Cookie"));
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
        Assert.Empty((await host.Services.GetRequiredService<AppSessionGrantStore>().ReadAsync()).Grants);
    }

    [Theory]
    [InlineData("/api/auth/apps/authorize")]
    [InlineData("/api/apps/example.app/launch-code")]
    public async Task AuthenticatedIssuer_RequiresProof_AndPreservesSessionBinding(string route)
    {
        await using var host = await HostAsync();
        using var client = Browser(host);
        client.DefaultRequestHeaders.Authorization = new("Bearer", SessionId);
        using var absent = await client.PostAsJsonAsync(route, new { appId = AppId, redirectUri = AppOrigin + "/callback" });
        Assert.Equal(HttpStatusCode.BadRequest, absent.StatusCode);
        Assert.Equal("code_challenge_invalid", await ErrorAsync(absent));
        using var downgraded = await client.PostAsJsonAsync(route, new { appId = AppId, redirectUri = AppOrigin + "/callback", codeChallenge = AuthCodeProof.Challenge, codeChallengeMethod = "plain" });
        Assert.Equal(HttpStatusCode.BadRequest, downgraded.StatusCode);
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
        using var bound = await client.PostAsJsonAsync(route, new { appId = AppId, redirectUri = AppOrigin + "/callback?state=" + State, codeChallenge = AuthCodeProof.Challenge, codeChallengeMethod = "S256" });
        bound.EnsureSuccessStatusCode();
        var result = await bound.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(State, QueryHelpers.ParseQuery(new Uri(result.GetProperty("redirectUri").GetString()!).Query)["state"].ToString());
        var record = Assert.Single((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
        Assert.Equal(AuthCodeProof.Challenge, record.CodeChallenge);
        Assert.Equal(SessionId, record.AuthorizingSessionId);
    }

    [Theory]
    [InlineData("cookie", 403)]
    [InlineData("manual", 403)]
    [InlineData("device", 403)]
    [InlineData("oauth", 403)]
    [InlineData("scoped", 403)]
    [InlineData("legacy", 403)]
    [InlineData("service", 401)]
    [InlineData("delegated", 401)]
    [InlineData("app", 401)]
    public async Task NativeInteractiveRenewal_RejectsAmbientAndNonPrimaryCredentials(string credential, int status)
    {
        await using var host = await HostAsync();
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        await users.UpdateAsync(state => state with
        {
            Sessions = state.Sessions.Select(session => session with
            {
                Kind = credential is "manual" or "device" or "oauth" ? credential : null,
                Audience = credential is "scoped" or "oauth" ? "hosty:core" : null,
                BrowserOrigin = credential == "legacy" ? null : session.BrowserOrigin,
            }).ToArray(),
        });
        using var client = Browser(host);
        if (credential == "cookie")
        {
            client.DefaultRequestHeaders.Add("Cookie", "hosty_session=" + SessionId + "; hosty_csrf=test-csrf");
            client.DefaultRequestHeaders.Add(CoreSessionAuthorization.CsrfHeaderName, "test-csrf");
        }
        else
        {
            var token = credential switch
            {
                "service" => host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(AppId),
                "delegated" => host.Services.GetRequiredService<DelegatedTokenService>().CreateToken(AppId, "user", "host.user").Token,
                "app" => (await host.Services.GetRequiredService<AppIdentityService>().CreateLaunchTokenAsync(AppId, "user")).AccessToken,
                _ => SessionId,
            };
            client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        }
        using var response = await client.PostAsJsonAsync($"/api/apps/{AppId}/launch-code", new
        { redirectUri = AppOrigin + "/callback", codeChallenge = AuthCodeProof.Challenge, codeChallengeMethod = "S256", interactiveRenewal = true });
        Assert.Equal(status, (int)response.StatusCode);
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
    }

    [Theory]
    [InlineData("expires", "reauth_required")]
    [InlineData("logout", "token_revoked")]
    [InlineData("recovery", "token_revoked")]
    [InlineData("unassigned", "app_access_denied")]
    public async Task NativeInteractiveRenewal_BoundsActivityByParentSessionAccessAndRevision(string change, string expected)
    {
        var clock = new Clock();
        await using var host = await HostAsync(clock);
        using var native = Browser(host);
        native.DefaultRequestHeaders.Authorization = new("Bearer", SessionId);
        using var response = await native.PostAsJsonAsync($"/api/apps/{AppId}/launch-code", new
        { redirectUri = AppOrigin + "/callback", codeChallenge = AuthCodeProof.Challenge, codeChallengeMethod = "S256", interactiveRenewal = true });
        response.EnsureSuccessStatusCode();
        var code = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString()!;
        var stored = Assert.Single((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
        Assert.True(stored.ActivityAuthorized);
        Assert.Equal(SessionId, stored.AuthorizingSessionId);
        var identity = host.Services.GetRequiredService<AppIdentityService>();
        var grant = await identity.ExchangeCodeAsync(code, AppId, AuthCodeProof.Verifier);
        Assert.True(grant.ActiveUntil > clock.UtcNow);
        await identity.RequireActivityAsync(grant.AccessToken, AppId, default);
        if (change == "logout")
        {
            using var browser = Browser(host);
            browser.DefaultRequestHeaders.Add("Cookie", "hosty_session=" + SessionId + "; hosty_csrf=test-csrf");
            browser.DefaultRequestHeaders.Add(CoreSessionAuthorization.CsrfHeaderName, "test-csrf");
            using var logout = await browser.PostAsync("/api/auth/logout", null);
            logout.EnsureSuccessStatusCode();
        }
        else await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(state => state with
        {
            Sessions = state.Sessions.Select(session => session with { ExpiresAt = change == "expires" ? clock.UtcNow : session.ExpiresAt }).ToArray(),
            Users = state.Users.Select(user => user with { AuthRevision = change == "recovery" ? "new-revision" : user.AuthRevision }).ToArray(),
            Assignments = change == "unassigned" ? [] : state.Assignments,
        });
        Assert.Equal(expected, (await Assert.ThrowsAsync<AppIdentityException>(() => identity.RequireActivityAsync(grant.AccessToken, AppId, default))).Code);
        if (change == "expires") Assert.True((await identity.RevalidateAsync(grant.AccessToken, AppId)).Active);
    }

    [Theory]
    [InlineData("/api/auth/apps/authorize", false)]
    [InlineData("/api/auth/apps/authorize", true)]
    [InlineData("/api/apps/example.app/launch-code", false)]
    public async Task GenericAuthenticatedLaunch_RemainsIdentityOnly(string route, bool interactiveRenewal)
    {
        await using var host = await HostAsync();
        using var native = Browser(host);
        native.DefaultRequestHeaders.Authorization = new("Bearer", SessionId);
        using var response = await native.PostAsJsonAsync(route, new
        { appId = AppId, redirectUri = AppOrigin + "/callback", codeChallenge = AuthCodeProof.Challenge, codeChallengeMethod = "S256", interactiveRenewal });
        response.EnsureSuccessStatusCode();
        var code = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString()!;
        var identity = host.Services.GetRequiredService<AppIdentityService>();
        var grant = await identity.ExchangeCodeAsync(code, AppId, AuthCodeProof.Verifier);
        Assert.Null(grant.ActiveUntil);
        Assert.Equal("reauth_required", (await Assert.ThrowsAsync<AppIdentityException>(() => identity.RequireActivityAsync(grant.AccessToken, AppId, default))).Code);
    }

    private static HttpClient Browser(CoreHttpHarness host, string origin = "http://127.0.0.1:7070")
    { var client = host.CreateClient(); client.BaseAddress = new Uri(origin); return client; }
    private static HttpRequestMessage LegacyRequest(string mode = "standalone", string redirect = AppOrigin + "/callback")
    {
        var fields = new Dictionary<string, string?>
        { ["redirectUri"] = redirect, ["state"] = State, ["codeChallenge"] = AuthCodeProof.Challenge, ["codeChallengeMethod"] = "S256" };
        if (mode == "silent") fields["prompt"] = "none";
        if (mode == "popup") fields["responseMode"] = "web_message";
        var request = new HttpRequestMessage(HttpMethod.Get, QueryHelpers.AddQueryString("http://127.0.0.1:7070/api/apps/" + AppId + "/open", fields));
        request.Headers.Add("Sec-Fetch-Mode", "navigate");
        request.Headers.Add("Sec-Fetch-Dest", mode == "silent" ? "iframe" : "document");
        return request;
    }
    private static async Task<HttpResponseMessage> IntentAsync(HttpClient client, string? origin = AppOrigin, string redirect = AppOrigin + "/callback")
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/apps/{AppId}/sign-in-intent");
        request.Content = new FormUrlEncodedContent(new Dictionary<string, string>
        { ["redirectUri"] = redirect, ["state"] = State, ["codeChallenge"] = AuthCodeProof.Challenge, ["codeChallengeMethod"] = "S256" });
        if (origin is not null) request.Headers.Add("Origin", origin);
        request.Headers.Add("Sec-Fetch-Mode", "navigate"); request.Headers.Add("Sec-Fetch-Dest", "document");
        return await client.SendAsync(request);
    }
    private static async Task<HttpResponseMessage> OpenAsync(HttpClient client, Uri location, string cookies)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, location);
        request.Headers.Add("Cookie", cookies); request.Headers.Add("Sec-Fetch-Mode", "navigate"); request.Headers.Add("Sec-Fetch-Dest", "document");
        return await client.SendAsync(request);
    }
    private static string Cookie(HttpResponseMessage response) => response.Headers.GetValues("Set-Cookie").Single().Split(';')[0];
    private static async Task<string?> ErrorAsync(HttpResponseMessage response)
        => (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString();
    private static async Task<CoreHttpHarness> HostAsync(IClock? clock = null, string appOrigin = AppOrigin)
    {
        var host = await CoreHttpHarness.StartAsync(clock);
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1,
            [new("user", "user@example.test", "User", "host.user", false, now, now)], [], [new(AppId, "user", now)],
            [new(SessionId, "user", now, now.AddHours(8), null, now, BrowserOrigin: "http://127.0.0.1:7070")]));
        await AddAppAsync(host, AppId, appOrigin);
        return host;
    }
    private static async Task AddAppAsync(CoreHttpHarness host, string id, string origin)
    {
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        await host.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(new AppRecord(id, "App", null, "1.0.0", "runtime", false,
            "manifest", null, null, "dev", "installed", "stopped", null, null, [], new Dictionary<string, AppSettingValue>(), [], [],
            [new("web", "http", origin, true)], now, now));
    }
    private sealed class Clock : IClock { public DateTimeOffset UtcNow { get; set; } = DateTimeOffset.UtcNow; }
}
