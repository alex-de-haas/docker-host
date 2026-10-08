using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.AspNetCore.WebUtilities;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class AppSignInIntentHttpTests
{
    private const string AppId = "example.app";
    private const string AppOrigin = "http://app.example.test";
    private const string SessionId = "browser-session";
    private const string NamedCore = "http://core.hosty.localhost:7070";
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
    [InlineData("http://localhost:7070", "http://app.localhost:3100", 200)]
    [InlineData("http://CORE.HOSTY.LOCALHOST.:7070", "http://app.hosty.localhost:3100", 200)]
    [InlineData("http://core.i-1234.hosty.localhost:7070", "http://app.i-1234.hosty.localhost:3100", 200)]
    [InlineData("http://core.hosty.localhost:7070", "http://hosty.localhost:3100", 200)]
    [InlineData("http://localhost:7070", "http://localhost:3100", 409)]
    [InlineData("http://CORE.HOSTY.LOCALHOST.:7070", "http://core.hosty.localhost:3100", 409)]
    [InlineData("http://xlocalhost:7070", "http://app.example.test", 409)]
    [InlineData("http://core.localhost.example.test:7070", "http://app.example.test", 409)]
    [InlineData("http://localhost.example.test:7070", "http://app.example.test", 409)]
    public async Task Intent_EnforcesCookieHostTopologyAndCanonicalAliases(string core, string app, int status)
    {
        await using var host = await HostAsync(appOrigin: app);
        using var browser = Browser(host, core);
        using var started = await IntentAsync(browser, app, app + "/callback");
        Assert.Equal(status, (int)started.StatusCode);
        if (status == 409) Assert.Equal("sign_in_cookie_host_unsafe", await ErrorAsync(started));
        else if (status == 200)
        {
            Assert.False(started.Headers.Contains("Set-Cookie"));
            Assert.Equal("text/html", started.Content.Headers.ContentType!.MediaType);
            Assert.NotEmpty((await StorageAttemptAsync(started)).Nonce);
        }
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

    [Theory]
    [InlineData("localhost", true)]
    [InlineData("LOCALHOST.", true)]
    [InlineData("core.hosty.localhost", true)]
    [InlineData("CORE.HOSTY.LOCALHOST.", true)]
    [InlineData("core.localhost..", false)]
    [InlineData("core..localhost", false)]
    [InlineData("xlocalhost", false)]
    [InlineData("localhost.example", false)]
    [InlineData("127.0.0.1", false)]
    [InlineData("[::1]", false)]
    [InlineData("core%2elocalhost", false)]
    public void StorageHost_UsesOnlyCanonicalLocalhostNames(string host, bool expected)
    {
        var request = new DefaultHttpContext().Request;
        request.Scheme = "http";
        request.Host = new HostString(host);
        Assert.Equal(expected, AppSignInCookieHost.UsesBrowserStorage(request));
        request.Scheme = "https";
        Assert.False(AppSignInCookieHost.UsesBrowserStorage(request));
    }

    [Fact]
    public async Task NamedHttp_RelayedGetAndParentCookiesCannotInitializeStorageOrIssue()
    {
        await using var host = await HostAsync(coreOrigin: NamedCore);
        using var browser = Browser(host, NamedCore);
        using var started = await IntentAsync(browser);
        var attempt = await StorageAttemptAsync(started);
        Assert.Equal(HttpStatusCode.OK, started.StatusCode);
        Assert.False(started.Headers.Contains("Set-Cookie"));
        Assert.Equal("same-origin", started.Headers.GetValues("Referrer-Policy").Single());
        Assert.Contains("script-src 'nonce-", started.Headers.GetValues("Content-Security-Policy").Single());
        var forged = $"hosty_session={SessionId}; hosty_signin_{attempt.Id}={attempt.Nonce}; __Host-hosty-signin-{attempt.Id}={attempt.Nonce}";
        using var reader = await OpenAsync(browser, attempt.Location, forged);
        Assert.Equal(HttpStatusCode.OK, reader.StatusCode);
        var html = await reader.Content.ReadAsStringAsync();
        Assert.Contains("const requestId = \"" + attempt.Id + "\";", html);
        Assert.DoesNotContain(attempt.Nonce, html);
        Assert.Contains("const initialNonce = null;", html);
        Assert.False(reader.Headers.Contains("Set-Cookie"));
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
        using var wrong = await StorageOpenAsync(browser, attempt, nonce: new string('b', 64), cookies: forged);
        Assert.Equal(HttpStatusCode.Forbidden, wrong.StatusCode);
        Assert.Equal("sign_in_intent_invalid", await ErrorAsync(wrong));
        Assert.NotNull(host.Services.GetRequiredService<AppSignInIntentStore>().Find(AppId, attempt.Id, attempt.Nonce));
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("null")]
    [InlineData("http://app.hosty.localhost:3100")]
    [InlineData("http://core.hosty.localhost:7171")]
    [InlineData("https://core.hosty.localhost:7070")]
    public async Task NamedHttp_PostRequiresTheExactCoreOriginWithoutConsuming(string? origin)
    {
        await using var host = await HostAsync(coreOrigin: NamedCore);
        using var browser = Browser(host, NamedCore);
        using var started = await IntentAsync(browser);
        var attempt = await StorageAttemptAsync(started);
        using var refused = await StorageOpenAsync(browser, attempt, origin: origin);
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        Assert.Equal("sign_in_intent_invalid", await ErrorAsync(refused));
        Assert.NotNull(host.Services.GetRequiredService<AppSignInIntentStore>().Find(AppId, attempt.Id, attempt.Nonce));
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
    }

    [Theory]
    [InlineData("array")]
    [InlineData("nested")]
    [InlineData("duplicate")]
    [InlineData("uppercase-id")]
    [InlineData("invalid-nonce")]
    [InlineData("too-many")]
    [InlineData("oversized")]
    [InlineData("malformed")]
    [InlineData("missing-nonce")]
    [InlineData("duplicate-nonce")]
    [InlineData("extra-field")]
    [InlineData("duplicate-query")]
    [InlineData("extra-query")]
    [InlineData("wrong-navigation")]
    [InlineData("cross-site")]
    public async Task NamedHttp_RejectsMalformedBoundedContinuationProofs(string mutation)
    {
        await using var host = await HostAsync(coreOrigin: NamedCore);
        using var browser = Browser(host, NamedCore);
        using var started = await IntentAsync(browser);
        var attempt = await StorageAttemptAsync(started);
        var proofId = new string('c', 64);
        var nonce = new string('d', 64);
        var proofs = mutation switch
        {
            "array" => "[]",
            "nested" => "{\"" + proofId + "\":{\"nonce\":\"" + nonce + "\"}}",
            "duplicate" => "{\"" + proofId + "\":\"" + nonce + "\",\"" + proofId + "\":\"" + nonce + "\"}",
            "uppercase-id" => "{\"" + proofId.ToUpperInvariant() + "\":\"" + nonce + "\"}",
            "invalid-nonce" => "{\"" + proofId + "\":\"short\"}",
            "too-many" => JsonSerializer.Serialize(Enumerable.Range(0, 17).ToDictionary(index => index.ToString("x64"), _ => nonce)),
            "oversized" => new string(' ', 2301),
            "malformed" => "{",
            _ => "{}",
        };
        var fields = new List<KeyValuePair<string, string>> { new("nonce", attempt.Nonce), new("browserProofs", proofs) };
        if (mutation == "missing-nonce") fields.RemoveAt(0);
        if (mutation == "duplicate-nonce") fields.Add(new("nonce", attempt.Nonce));
        if (mutation == "extra-field") fields.Add(new("state", State));
        var location = attempt.Location.OriginalString + (mutation == "duplicate-query" ? "&requestId=" + attempt.Id : mutation == "extra-query" ? "&nonce=" + attempt.Nonce : "");
        using var request = new HttpRequestMessage(HttpMethod.Post, location) { Content = new FormUrlEncodedContent(fields) };
        request.Headers.Add("Origin", NamedCore);
        request.Headers.Add("Cookie", "hosty_session=" + SessionId + "; hosty_signin_" + attempt.Id + "=" + attempt.Nonce);
        request.Headers.Add("Sec-Fetch-Mode", mutation == "wrong-navigation" ? "cors" : "navigate");
        request.Headers.Add("Sec-Fetch-Dest", "document");
        if (mutation == "cross-site") request.Headers.Add("Sec-Fetch-Site", "cross-site");
        using var refused = await browser.SendAsync(request);
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        Assert.Equal("sign_in_intent_invalid", await ErrorAsync(refused));
        Assert.NotNull(host.Services.GetRequiredService<AppSignInIntentStore>().Find(AppId, attempt.Id, attempt.Nonce));
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
    }

    [Theory]
    [InlineData("chunked-oversized")]
    [InlineData("multipart")]
    public async Task NamedHttp_BoundsActualBodyAndRejectsMultipartWithoutConsuming(string mutation)
    {
        await using var host = await HostAsync(coreOrigin: NamedCore);
        using var browser = Browser(host, NamedCore);
        using var started = await IntentAsync(browser);
        var attempt = await StorageAttemptAsync(started);
        using var request = new HttpRequestMessage(HttpMethod.Post, attempt.Location);
        if (mutation == "multipart")
        {
            var multipart = new MultipartFormDataContent();
            multipart.Add(new StringContent(attempt.Nonce), "nonce");
            multipart.Add(new StringContent("{}"), "browserProofs");
            multipart.Add(new ByteArrayContent(new byte[10000]), "file", "payload.bin");
            request.Content = multipart;
        }
        else
        {
            request.Content = new UnknownLengthContent("nonce=" + attempt.Nonce + "&browserProofs=" + new string('x', 8200));
            request.Headers.TransferEncodingChunked = true;
        }
        request.Headers.Add("Origin", NamedCore);
        request.Headers.Add("Cookie", "hosty_session=" + SessionId);
        request.Headers.Add("Sec-Fetch-Mode", "navigate");
        request.Headers.Add("Sec-Fetch-Dest", "document");
        using var refused = await browser.SendAsync(request);
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        Assert.Equal("sign_in_intent_invalid", await ErrorAsync(refused));
        Assert.NotNull(host.Services.GetRequiredService<AppSignInIntentStore>().Find(AppId, attempt.Id, attempt.Nonce));
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
    }

    [Fact]
    public async Task NamedHttp_AcceptsAValidBoundedChunkedCoreForm()
    {
        await using var host = await HostAsync(coreOrigin: NamedCore);
        using var browser = Browser(host, NamedCore);
        using var started = await IntentAsync(browser);
        var attempt = await StorageAttemptAsync(started);
        using var request = new HttpRequestMessage(HttpMethod.Post, attempt.Location)
        { Content = new UnknownLengthContent("nonce=" + attempt.Nonce + "&browserProofs=%7B%7D") };
        request.Headers.TransferEncodingChunked = true;
        request.Headers.Add("Origin", NamedCore);
        request.Headers.Add("Cookie", "hosty_session=" + SessionId);
        request.Headers.Add("Sec-Fetch-Mode", "navigate");
        request.Headers.Add("Sec-Fetch-Dest", "document");
        using var result = await browser.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, result.StatusCode);
        Assert.Single((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
    }

    [Fact]
    public async Task NamedHttp_NonceSurvivesLoginAndSuccessfulPostClaimsOnceDespiteForgedCookies()
    {
        await using var host = await HostAsync(coreOrigin: NamedCore);
        using var browser = Browser(host, NamedCore);
        using var started = await IntentAsync(browser);
        var attempt = await StorageAttemptAsync(started);
        using var login = await StorageOpenAsync(browser, attempt, cookies: "");
        Assert.Equal(HttpStatusCode.OK, login.StatusCode);
        Assert.Contains("/login?returnTo=", await login.Content.ReadAsStringAsync());
        Assert.NotNull(host.Services.GetRequiredService<AppSignInIntentStore>().Find(AppId, attempt.Id, attempt.Nonce));
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
        using var reader = await OpenAsync(browser, attempt.Location, "hosty_session=" + SessionId);
        Assert.Equal(HttpStatusCode.OK, reader.StatusCode);
        Assert.DoesNotContain(attempt.Nonce, await reader.Content.ReadAsStringAsync());
        var cookies = $"hosty_session={SessionId}; hosty_signin_{attempt.Id}={new string('b', 64)}; __Host-hosty-signin-{attempt.Id}={new string('b', 64)}";
        var responses = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => StorageOpenAsync(browser, attempt, cookies: cookies)));
        try
        {
            var success = Assert.Single(responses, response => response.StatusCode == HttpStatusCode.OK);
            var html = await success.Content.ReadAsStringAsync();
            Assert.Contains("sessionStorage.removeItem", html);
            Assert.Contains("location.replace", html);
            Assert.Contains(AppOrigin + "/callback", html);
            Assert.False(success.Headers.Contains("Set-Cookie"));
            Assert.Equal(7, responses.Count(response => response.StatusCode == HttpStatusCode.Forbidden));
        }
        finally { foreach (var response in responses) response.Dispose(); }
        var code = Assert.Single((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
        Assert.Equal(SessionId, code.AuthorizingSessionId);
        Assert.Equal(AuthCodeProof.Challenge, code.CodeChallenge);
        Assert.True(code.ActivityAuthorized);
        var audit = await File.ReadAllTextAsync(host.Services.GetRequiredService<CoreDataPaths>().AuditLogPath);
        foreach (var secret in new[] { attempt.Nonce, code.Code, AuthCodeProof.Verifier, AuthCodeProof.Challenge })
            Assert.DoesNotContain(secret, audit);
    }

    [Fact]
    public async Task NamedHttp_CapacityCountsOnlyValidLiveEarlierProofsAndRefusesWithoutEviction()
    {
        await using var host = await HostAsync(coreOrigin: NamedCore);
        var store = host.Services.GetRequiredService<AppSignInIntentStore>();
        var earlier = Enumerable.Range(0, 16).Select(index => store.Create(AppId, AppOrigin + "/callback", State,
            AuthCodeProof.Challenge, AppSignInMode.Standalone, index.ToString(), 0)!).ToArray();
        using var browser = Browser(host, NamedCore);
        using var started = await IntentAsync(browser);
        var attempt = await StorageAttemptAsync(started);
        var proofs = JsonSerializer.Serialize(earlier.ToDictionary(value => value.Intent.Id, value => value.Nonce));
        using var capacity = await StorageOpenAsync(browser, attempt, proofs: proofs);
        Assert.Equal(HttpStatusCode.TooManyRequests, capacity.StatusCode);
        Assert.Contains("Too many pending sign-in attempts", await capacity.Content.ReadAsStringAsync());
        Assert.Contains("sessionStorage.removeItem", await capacity.Content.ReadAsStringAsync());
        Assert.False(store.Contains(attempt.Id));
        foreach (var value in earlier) Assert.Same(value.Intent, store.Find(AppId, value.Intent.Id, value.Nonce));
        var first = new StorageAttempt(earlier[0].Intent.Id, earlier[0].Nonce);
        using var rightful = await StorageOpenAsync(browser, first);
        Assert.Equal(HttpStatusCode.OK, rightful.StatusCode);
        using var nextStarted = await IntentAsync(browser);
        var next = await StorageAttemptAsync(nextStarted);
        // A consumed record and incorrect nonces cannot count as live browser evidence.
        var invalidProofs = JsonSerializer.Serialize(earlier.ToDictionary(value => value.Intent.Id,
            value => value == earlier[0] ? value.Nonce : new string('b', 64)));
        using var nextSuccess = await StorageOpenAsync(browser, next, proofs: invalidProofs);
        Assert.Equal(HttpStatusCode.OK, nextSuccess.StatusCode);
        Assert.Equal(2, (await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes.Count);
    }

    [Fact]
    public async Task NamedHttp_StorageFailuresReleaseSourceAdmissionImmediatelyWithoutIssuingCodes()
    {
        await using var host = await HostAsync(coreOrigin: NamedCore);
        using var browser = Browser(host, NamedCore);
        var store = host.Services.GetRequiredService<AppSignInIntentStore>();
        var attempts = new List<StorageAttempt>();
        var failureCount = OAuthAuthorizationStore.MaxPendingPerSource * 2;
        for (var index = 0; index < failureCount; index++)
        {
            using var started = await IntentAsync(browser);
            Assert.Equal(HttpStatusCode.OK, started.StatusCode);
            var attempt = await StorageAttemptAsync(started);
            attempts.Add(attempt);
            using var failed = await StorageFailureAsync(browser, attempt, "sign_in_storage_unavailable", cookies: "");
            Assert.Equal(HttpStatusCode.ServiceUnavailable, failed.StatusCode);
            Assert.False(store.Contains(attempt.Id));
            Assert.False(failed.Headers.Contains("Set-Cookie"));
        }

        using var next = await IntentAsync(browser);
        Assert.Equal(HttpStatusCode.OK, next.StatusCode);
        var nextAttempt = await StorageAttemptAsync(next);
        Assert.NotNull(store.Find(AppId, nextAttempt.Id, nextAttempt.Nonce));
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
        var auditRecords = await host.Services.GetRequiredService<AuditStore>().ReadRecentAsync();
        Assert.Equal(failureCount, auditRecords.Count(record => record.Outcome == "sign_in_storage_unavailable"));
        var audit = await File.ReadAllTextAsync(host.Services.GetRequiredService<CoreDataPaths>().AuditLogPath);
        foreach (var secret in attempts.Select(attempt => attempt.Nonce).Append(nextAttempt.Nonce)
            .Concat([AuthCodeProof.Verifier, AuthCodeProof.Challenge, State, SessionId]))
            Assert.DoesNotContain(secret, audit);
    }

    [Fact]
    public async Task NamedHttp_ClientReportedCapacityRetiresOnlyItsAttemptWithoutNeedingOtherProofs()
    {
        await using var host = await HostAsync(coreOrigin: NamedCore);
        var store = host.Services.GetRequiredService<AppSignInIntentStore>();
        var earlier = Enumerable.Range(0, AppSignInIntentStore.MaxPerBrowser).Select(index => store.Create(AppId,
            AppOrigin + "/callback", State, AuthCodeProof.Challenge, AppSignInMode.Standalone, index.ToString(), 0)!).ToArray();
        using var browser = Browser(host, NamedCore);
        using var started = await IntentAsync(browser);
        var attempt = await StorageAttemptAsync(started);
        using var failed = await StorageFailureAsync(browser, attempt, "sign_in_intent_capacity");
        Assert.Equal(HttpStatusCode.TooManyRequests, failed.StatusCode);
        var html = await failed.Content.ReadAsStringAsync();
        Assert.Contains("Too many pending sign-in attempts", html);
        Assert.Contains("hosty.core.signin." + attempt.Id, html);
        Assert.False(store.Contains(attempt.Id));
        foreach (var value in earlier)
        {
            Assert.Same(value.Intent, store.Find(AppId, value.Intent.Id, value.Nonce));
            Assert.DoesNotContain("hosty.core.signin." + value.Intent.Id, html);
        }
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
        using var rightful = await StorageOpenAsync(browser, new(earlier[0].Intent.Id, earlier[0].Nonce));
        Assert.Equal(HttpStatusCode.OK, rightful.StatusCode);
        Assert.Single((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
        using var next = await IntentAsync(browser);
        Assert.Equal(HttpStatusCode.OK, next.StatusCode);
    }

    [Theory]
    [InlineData("sign_in_storage_unavailable", 503)]
    [InlineData("sign_in_intent_capacity", 429)]
    public async Task NamedHttp_ConcurrentFailureReportsClaimOnceAndReplayCannotAffectAnotherAttempt(string failureCode, int terminalStatus)
    {
        await using var host = await HostAsync(coreOrigin: NamedCore);
        using var browser = Browser(host, NamedCore);
        using var started = await IntentAsync(browser);
        var attempt = await StorageAttemptAsync(started);
        using var otherStarted = await IntentAsync(browser);
        var other = await StorageAttemptAsync(otherStarted);
        var responses = await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => StorageFailureAsync(browser, attempt, failureCode)));
        try
        {
            Assert.Single(responses, response => (int)response.StatusCode == terminalStatus);
            Assert.Equal(7, responses.Count(response => response.StatusCode == HttpStatusCode.Forbidden));
            Assert.All(responses, response => Assert.False(response.Headers.Contains("Set-Cookie")));
        }
        finally { foreach (var response in responses) response.Dispose(); }

        using var replay = await StorageFailureAsync(browser, attempt, failureCode);
        Assert.Equal(HttpStatusCode.Forbidden, replay.StatusCode);
        Assert.Equal("sign_in_intent_invalid", await ErrorAsync(replay));
        var store = host.Services.GetRequiredService<AppSignInIntentStore>();
        Assert.False(store.Contains(attempt.Id));
        Assert.NotNull(store.Find(AppId, other.Id, other.Nonce));
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
        Assert.Single(await host.Services.GetRequiredService<AuditStore>().ReadRecentAsync(), record => record.Outcome == failureCode);
    }

    [Theory]
    [InlineData("standalone", "sign_in_storage_unavailable", 503)]
    [InlineData("standalone", "sign_in_intent_capacity", 429)]
    [InlineData("silent", "sign_in_storage_unavailable", 200)]
    [InlineData("silent", "sign_in_intent_capacity", 200)]
    [InlineData("popup", "sign_in_storage_unavailable", 200)]
    [InlineData("popup", "sign_in_intent_capacity", 200)]
    public async Task NamedHttp_StorageFailureReturnsOnlyTheModeSpecificTerminalError(string mode, string failureCode, int expectedStatus)
    {
        await using var host = await HostAsync(coreOrigin: NamedCore);
        using var browser = Browser(host, NamedCore);
        using var started = await IntentAsync(browser, mode: mode);
        var attempt = await StorageAttemptAsync(started);
        using var failed = await StorageFailureAsync(browser, attempt, failureCode,
            destination: mode == "silent" ? "iframe" : "document");
        Assert.Equal(expectedStatus, (int)failed.StatusCode);
        Assert.Equal("text/html", failed.Content.Headers.ContentType!.MediaType);
        Assert.Null(failed.Headers.Location);
        Assert.False(failed.Headers.Contains("Set-Cookie"));
        Assert.Equal("no-store", failed.Headers.CacheControl!.ToString());
        var html = await failed.Content.ReadAsStringAsync();
        Assert.Contains("sessionStorage.removeItem", html);
        Assert.Contains("hosty.core.signin." + attempt.Id, html);
        Assert.DoesNotContain(attempt.Nonce, html);
        Assert.DoesNotContain(AuthCodeProof.Challenge, html);
        Assert.DoesNotContain("/login?returnTo=", html);
        if (mode == "silent")
        {
            var destination = JsonSerializer.Deserialize<string>(Regex.Match(html, "const destination = (\"[^\"]+\");").Groups[1].Value)!;
            var callback = new Uri(destination);
            Assert.Equal(AppOrigin + "/callback", callback.GetLeftPart(UriPartial.Path));
            var query = QueryHelpers.ParseQuery(callback.Query);
            Assert.Equal("login_required", query["error"].ToString());
            Assert.Equal(State, query["state"].ToString());
            Assert.False(query.ContainsKey("code"));
            Assert.Equal(2, query.Count);
            Assert.False(failed.Headers.Contains("X-Frame-Options"));
        }
        else if (mode == "popup")
        {
            Assert.Contains("postMessage({type:\"hosty:app-auth-code\",state:\"" + State + "\",[\"error\"]:\"" + failureCode + "\"},\"" + AppOrigin + "\")", html);
            Assert.DoesNotContain("[\"code\"]", html);
            Assert.DoesNotContain("window.close()", html);
        }
        else Assert.DoesNotContain("location.replace", html);
        Assert.False(host.Services.GetRequiredService<AppSignInIntentStore>().Contains(attempt.Id));
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
    }

    [Theory]
    [InlineData("missing-nonce")]
    [InlineData("duplicate-nonce")]
    [InlineData("short-nonce")]
    [InlineData("uppercase-nonce")]
    [InlineData("wrong-nonce")]
    [InlineData("missing-failure")]
    [InlineData("duplicate-failure")]
    [InlineData("unknown-failure")]
    [InlineData("uppercase-failure")]
    [InlineData("empty-failure")]
    [InlineData("proofs-and-failure")]
    [InlineData("extra-field")]
    [InlineData("duplicate-query")]
    [InlineData("extra-query")]
    [InlineData("missing-origin")]
    [InlineData("null-origin")]
    [InlineData("app-origin")]
    [InlineData("other-port")]
    [InlineData("duplicate-origin")]
    [InlineData("wrong-mode")]
    [InlineData("wrong-destination")]
    [InlineData("cross-site")]
    public async Task NamedHttp_InvalidFailureReportsDoNotConsumeTheLegitimateAttempt(string mutation)
    {
        await using var host = await HostAsync(coreOrigin: NamedCore);
        using var browser = Browser(host, NamedCore);
        using var started = await IntentAsync(browser);
        var attempt = await StorageAttemptAsync(started);
        var nonce = mutation switch
        {
            "short-nonce" => "short",
            "uppercase-nonce" => new string('A', 64),
            "wrong-nonce" => new string('g', 64),
            _ => attempt.Nonce,
        };
        if (mutation == "wrong-nonce") nonce = attempt.Nonce[0] == '0' ? "1" + attempt.Nonce[1..] : "0" + attempt.Nonce[1..];
        var failureCode = mutation switch
        {
            "unknown-failure" => "login_required",
            "uppercase-failure" => "SIGN_IN_STORAGE_UNAVAILABLE",
            "empty-failure" => "",
            _ => "sign_in_storage_unavailable",
        };
        var fields = new List<KeyValuePair<string, string>> { new("nonce", nonce), new("failureCode", failureCode) };
        if (mutation == "missing-nonce") fields.RemoveAt(0);
        if (mutation == "duplicate-nonce") fields.Add(new("nonce", attempt.Nonce));
        if (mutation == "missing-failure") fields.RemoveAt(1);
        if (mutation == "duplicate-failure") fields.Add(new("failureCode", failureCode));
        if (mutation == "proofs-and-failure") fields.Add(new("browserProofs", "{}"));
        if (mutation == "extra-field") fields.Add(new("state", State));
        var location = attempt.Location.OriginalString + (mutation == "duplicate-query" ? "&requestId=" + attempt.Id
            : mutation == "extra-query" ? "&nonce=" + attempt.Nonce : "");
        using var request = new HttpRequestMessage(HttpMethod.Post, location) { Content = new FormUrlEncodedContent(fields) };
        if (mutation != "missing-origin")
            request.Headers.Add("Origin", mutation switch
            {
                "null-origin" => "null",
                "app-origin" => AppOrigin,
                "other-port" => "http://core.hosty.localhost:7171",
                _ => NamedCore,
            });
        if (mutation == "duplicate-origin") request.Headers.Add("Origin", NamedCore);
        request.Headers.Add("Cookie", "hosty_session=" + SessionId + "; hosty_signin_" + attempt.Id + "=" + attempt.Nonce);
        request.Headers.Add("Sec-Fetch-Mode", mutation == "wrong-mode" ? "cors" : "navigate");
        request.Headers.Add("Sec-Fetch-Dest", mutation == "wrong-destination" ? "iframe" : "document");
        if (mutation == "cross-site") request.Headers.Add("Sec-Fetch-Site", "cross-site");
        using var refused = await browser.SendAsync(request);
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        Assert.Equal("sign_in_intent_invalid", await ErrorAsync(refused));
        Assert.False(refused.Headers.Contains("Set-Cookie"));
        Assert.NotNull(host.Services.GetRequiredService<AppSignInIntentStore>().Find(AppId, attempt.Id, attempt.Nonce));
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
        using var rightful = await StorageOpenAsync(browser, attempt);
        Assert.Equal(HttpStatusCode.OK, rightful.StatusCode);
        Assert.Single((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
    }

    [Theory]
    [InlineData("content-length-oversized")]
    [InlineData("chunked-oversized")]
    [InlineData("multipart")]
    [InlineData("json")]
    [InlineData("missing-content-type")]
    public async Task NamedHttp_FailureReportsRequireBoundedUrlEncodedContentWithoutConsuming(string mutation)
    {
        await using var host = await HostAsync(coreOrigin: NamedCore);
        using var browser = Browser(host, NamedCore);
        using var started = await IntentAsync(browser);
        var attempt = await StorageAttemptAsync(started);
        var body = "nonce=" + attempt.Nonce + "&failureCode=sign_in_storage_unavailable";
        using var request = new HttpRequestMessage(HttpMethod.Post, attempt.Location);
        if (mutation == "multipart")
        {
            var content = new MultipartFormDataContent();
            content.Add(new StringContent(attempt.Nonce), "nonce");
            content.Add(new StringContent("sign_in_storage_unavailable"), "failureCode");
            request.Content = content;
        }
        else if (mutation == "chunked-oversized")
        {
            request.Content = new UnknownLengthContent(body + new string('x', 8193 - body.Length));
            request.Headers.TransferEncodingChunked = true;
        }
        else
        {
            request.Content = new StringContent(mutation == "content-length-oversized"
                ? body + new string('x', 8193 - body.Length) : body);
            request.Content.Headers.ContentType = mutation == "missing-content-type" ? null
                : new(mutation == "json" ? "application/json" : "application/x-www-form-urlencoded");
        }
        request.Headers.Add("Origin", NamedCore);
        request.Headers.Add("Sec-Fetch-Mode", "navigate");
        request.Headers.Add("Sec-Fetch-Dest", "document");
        using var refused = await browser.SendAsync(request);
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        Assert.Equal("sign_in_intent_invalid", await ErrorAsync(refused));
        Assert.NotNull(host.Services.GetRequiredService<AppSignInIntentStore>().Find(AppId, attempt.Id, attempt.Nonce));
        using var rightful = await StorageFailureAsync(browser, attempt, "sign_in_storage_unavailable");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, rightful.StatusCode);
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
    }

    [Fact]
    public async Task NamedHttp_ValidChunkedFailureReportRetiresTheAttempt()
    {
        await using var host = await HostAsync(coreOrigin: NamedCore);
        using var browser = Browser(host, NamedCore);
        using var started = await IntentAsync(browser);
        var attempt = await StorageAttemptAsync(started);
        using var request = new HttpRequestMessage(HttpMethod.Post, attempt.Location)
        { Content = new UnknownLengthContent("nonce=" + attempt.Nonce + "&failureCode=sign_in_storage_unavailable") };
        request.Headers.TransferEncodingChunked = true;
        request.Headers.Add("Origin", NamedCore);
        request.Headers.Add("Sec-Fetch-Mode", "navigate");
        request.Headers.Add("Sec-Fetch-Dest", "document");
        using var result = await browser.SendAsync(request);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, result.StatusCode);
        Assert.False(host.Services.GetRequiredService<AppSignInIntentStore>().Contains(attempt.Id));
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
    }

    [Theory]
    [InlineData("http://127.0.0.1:7070")]
    [InlineData("https://core.hosty.localhost:7070")]
    public async Task CookieHosts_FailureReportsCannotConsumeTheCookieBoundIntent(string core)
    {
        await using var host = await HostAsync(coreOrigin: core);
        using var browser = Browser(host, core);
        using var started = await IntentAsync(browser);
        var cookie = Cookie(started);
        var id = QueryHelpers.ParseQuery(started.Headers.Location!.OriginalString.Split('?')[1])["requestId"].ToString();
        var attempt = new StorageAttempt(id, cookie.Split('=')[1]);
        using var refused = await StorageFailureAsync(browser, attempt, "sign_in_storage_unavailable",
            origin: core, cookies: cookie + "; hosty_session=" + SessionId);
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        Assert.Equal("sign_in_intent_invalid", await ErrorAsync(refused));
        Assert.False(refused.Headers.Contains("Set-Cookie"));
        Assert.NotNull(host.Services.GetRequiredService<AppSignInIntentStore>().Find(AppId, id, attempt.Nonce));
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
        using var rightful = await OpenAsync(browser, started.Headers.Location, cookie + "; hosty_session=" + SessionId);
        Assert.Equal(HttpStatusCode.Redirect, rightful.StatusCode);
        Assert.Single((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
    }

    [Theory]
    [InlineData("ws://CORE.HOSTY.LOCALHOST.:9000")]
    [InlineData("wss://core.hosty.localhost:9000")]
    [InlineData("tcp://core.hosty.localhost:9000")]
    public async Task NamedHttp_RechecksPrivateSharedHostsBeforeIssuance(string endpoint)
    {
        await using var host = await HostAsync(coreOrigin: NamedCore);
        using var browser = Browser(host, NamedCore);
        using var started = await IntentAsync(browser);
        var attempt = await StorageAttemptAsync(started);
        await AddAppAsync(host, "other.app", endpoint);
        await host.Services.GetRequiredService<AppRegistryStore>().UpdateAppAsync("other.app", app => app with
        { Endpoints = app.Endpoints.Select(value => value with { Public = false, Protocol = new Uri(endpoint).Scheme }).ToArray() });
        using var reader = await OpenAsync(browser, attempt.Location, "hosty_session=" + SessionId);
        Assert.Equal(HttpStatusCode.Conflict, reader.StatusCode);
        Assert.NotNull(storeIntent());
        using var refused = await StorageOpenAsync(browser, attempt);
        Assert.Equal(HttpStatusCode.Conflict, refused.StatusCode);
        Assert.Contains("no longer isolated", await refused.Content.ReadAsStringAsync());
        Assert.Null(storeIntent());
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
        AppSignInIntent? storeIntent() => host.Services.GetRequiredService<AppSignInIntentStore>().Find(AppId, attempt.Id, attempt.Nonce);
    }

    [Theory]
    [InlineData("http://127.0.0.1:7070")]
    [InlineData("https://core.hosty.localhost:7070")]
    public async Task CookieHosts_RejectStoragePostWithoutConsumingTheirCookieIntent(string core)
    {
        await using var host = await HostAsync(coreOrigin: core);
        using var browser = Browser(host, core);
        using var started = await IntentAsync(browser);
        var cookie = Cookie(started);
        var id = QueryHelpers.ParseQuery(started.Headers.Location!.OriginalString.Split('?')[1])["requestId"].ToString();
        var attempt = new StorageAttempt(id, cookie.Split('=')[1]);
        using var refused = await StorageOpenAsync(browser, attempt, origin: core, cookies: cookie + "; hosty_session=" + SessionId);
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        Assert.NotNull(host.Services.GetRequiredService<AppSignInIntentStore>().Find(AppId, id, attempt.Nonce));
        using var rightful = await OpenAsync(browser, started.Headers.Location, cookie + "; hosty_session=" + SessionId);
        Assert.Equal(HttpStatusCode.Redirect, rightful.StatusCode);
    }

    [Theory]
    [InlineData("silent", false)]
    [InlineData("silent", true)]
    [InlineData("popup", true)]
    public async Task NamedHttp_PreservesSilentAndPopupResults(string mode, bool signedIn)
    {
        await using var host = await HostAsync(coreOrigin: NamedCore);
        using var browser = Browser(host, NamedCore);
        using var started = await IntentAsync(browser, mode: mode);
        var attempt = await StorageAttemptAsync(started);
        using var reader = await OpenAsync(browser, attempt.Location, "", destination: mode == "silent" ? "iframe" : "document");
        Assert.Equal(HttpStatusCode.OK, reader.StatusCode);
        if (mode == "silent")
        {
            Assert.DoesNotContain("frame-ancestors", reader.Headers.GetValues("Content-Security-Policy").Single());
            Assert.False(reader.Headers.Contains("X-Frame-Options"));
        }
        using var result = await StorageOpenAsync(browser, attempt, cookies: signedIn ? "hosty_session=" + SessionId : "",
            destination: mode == "silent" ? "iframe" : "document");
        Assert.Equal(HttpStatusCode.OK, result.StatusCode);
        var html = await result.Content.ReadAsStringAsync();
        Assert.Contains("sessionStorage.removeItem", html);
        if (signedIn)
        {
            var code = Assert.Single((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
            if (mode == "popup")
            {
                Assert.Contains("postMessage", html);
                Assert.Contains("code", html);
                Assert.Contains(AppOrigin, html);
                Assert.True(code.ActivityAuthorized);
            }
            else Assert.False(code.ActivityAuthorized);
        }
        else
        {
            Assert.Contains("login_required", html);
            Assert.Contains(State, html);
            Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
        }
    }

    [Fact]
    public async Task NamedHttp_ExpiredIntentAndDisabledUserCannotIssue()
    {
        var clock = new Clock();
        await using var host = await HostAsync(clock, coreOrigin: NamedCore);
        using var browser = Browser(host, NamedCore);
        using var started = await IntentAsync(browser);
        var expired = await StorageAttemptAsync(started);
        clock.UtcNow = clock.UtcNow.AddMinutes(5);
        using var refused = await StorageOpenAsync(browser, expired);
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        using var nextStarted = await IntentAsync(browser);
        var next = await StorageAttemptAsync(nextStarted);
        await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(state => state with
        { Users = state.Users.Select(value => value with { Disabled = true }).ToArray() });
        using var disabled = await StorageOpenAsync(browser, next);
        Assert.Equal(HttpStatusCode.Forbidden, disabled.StatusCode);
        var denied = await disabled.Content.ReadAsStringAsync();
        Assert.Contains("This Core session cannot authorize app sign-in", denied);
        Assert.Contains("sessionStorage.removeItem", denied);
        Assert.False(host.Services.GetRequiredService<AppSignInIntentStore>().Contains(next.Id));
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
    }

    [Theory]
    [InlineData("scoped")]
    [InlineData("unassigned")]
    [InlineData("redirect-changed")]
    public async Task NamedHttp_TerminalAuthorizationFailuresClearOnlyTheClaimedStorageEntry(string change)
    {
        await using var host = await HostAsync(coreOrigin: NamedCore);
        using var browser = Browser(host, NamedCore);
        using var started = await IntentAsync(browser);
        var attempt = await StorageAttemptAsync(started);
        using var otherStarted = await IntentAsync(browser);
        var other = await StorageAttemptAsync(otherStarted);
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        if (change == "scoped")
            await users.UpdateAsync(state => state with
            { Sessions = state.Sessions.Select(value => value with { Audience = "hosty:core" }).ToArray() });
        else if (change == "unassigned") await users.UpdateAsync(state => state with { Assignments = [] });
        else await host.Services.GetRequiredService<AppRegistryStore>().UpdateAppAsync(AppId, app => app with
        { Endpoints = app.Endpoints.Select(value => value with { Url = "http://changed.example.test" }).ToArray() });
        using var refused = await StorageOpenAsync(browser, attempt);
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        var html = await refused.Content.ReadAsStringAsync();
        Assert.Contains("sessionStorage.removeItem", html);
        Assert.Contains("hosty.core.signin." + attempt.Id, html);
        Assert.DoesNotContain("hosty.core.signin." + other.Id, html);
        var intents = host.Services.GetRequiredService<AppSignInIntentStore>();
        Assert.False(intents.Contains(attempt.Id));
        Assert.NotNull(intents.Find(AppId, other.Id, other.Nonce));
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
    }

    [Theory]
    [InlineData("standalone", false)]
    [InlineData("silent", false)]
    [InlineData("popup", false)]
    [InlineData("standalone", true)]
    public async Task NamedHttp_PostClaimPersistenceFailureClearsOnlyItsProofAndCannotIssueOnReplay(string mode, bool blockAudit)
    {
        await using var host = await HostAsync(coreOrigin: NamedCore);
        using var browser = Browser(host, NamedCore);
        using var started = await IntentAsync(browser, mode: mode);
        var attempt = await StorageAttemptAsync(started);
        using var otherStarted = await IntentAsync(browser);
        var other = await StorageAttemptAsync(otherStarted);
        var paths = host.Services.GetRequiredService<CoreDataPaths>();
        var statePath = Path.Combine(paths.AuthRoot, "app-auth-codes.json");
        // A directory at this exact state-file path blocks persistence on every OS, even as root.
        // The valid navigation and nonce pass first; the store failure occurs after intent claim.
        Directory.CreateDirectory(statePath);
        if (blockAudit) Directory.CreateDirectory(paths.AuditLogPath);
        try
        {
            using var failed = await StorageOpenAsync(browser, attempt, destination: mode == "silent" ? "iframe" : "document");
            Assert.Equal(HttpStatusCode.ServiceUnavailable, failed.StatusCode);
            Assert.Equal("text/html", failed.Content.Headers.ContentType!.MediaType);
            Assert.False(failed.Headers.Contains("Set-Cookie"));
            Assert.Null(failed.Headers.Location);
            var html = await failed.Content.ReadAsStringAsync();
            Assert.Contains("sessionStorage.removeItem", html);
            Assert.Contains("hosty.core.signin." + attempt.Id, html);
            Assert.DoesNotContain("hosty.core.signin." + other.Id, html);
            Assert.DoesNotContain("location.replace", html);
            Assert.DoesNotContain("postMessage", html);
            foreach (var sensitive in new[] { attempt.Nonce, other.Nonce, AuthCodeProof.Challenge,
                AuthCodeProof.Verifier, SessionId, statePath, paths.AuthRoot, paths.AuditLogPath,
                "IOException", "UnauthorizedAccessException", "Access to the path" })
                Assert.DoesNotContain(sensitive, html);
            Assert.False(host.Services.GetRequiredService<AppSignInIntentStore>().Contains(attempt.Id));
            Assert.NotNull(host.Services.GetRequiredService<AppSignInIntentStore>().Find(AppId, other.Id, other.Nonce));
            if (!blockAudit)
            {
                var record = Assert.Single(await host.Services.GetRequiredService<AuditStore>().ReadRecentAsync(),
                    value => value.Outcome == "sign_in_authorization_failed");
                Assert.Equal("auth.app-sign-in", record.Action);
                Assert.Equal("sign_in_authorization_failed", Assert.Single(record.Details).Value);
                var audit = await File.ReadAllTextAsync(paths.AuditLogPath);
                foreach (var sensitive in new[] { attempt.Nonce, other.Nonce, AuthCodeProof.Challenge,
                    AuthCodeProof.Verifier, SessionId, statePath, paths.AuthRoot,
                    "IOException", "UnauthorizedAccessException", "Access to the path" })
                    Assert.DoesNotContain(sensitive, audit);
            }
        }
        finally
        {
            Directory.Delete(statePath);
            if (blockAudit) Directory.Delete(paths.AuditLogPath);
        }

        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
        using var replay = await StorageOpenAsync(browser, attempt, destination: mode == "silent" ? "iframe" : "document");
        Assert.Equal(HttpStatusCode.Forbidden, replay.StatusCode);
        Assert.Equal("sign_in_intent_invalid", await ErrorAsync(replay));
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
        using var nextStarted = await IntentAsync(browser, mode: mode);
        Assert.Equal(HttpStatusCode.OK, nextStarted.StatusCode);
        var next = await StorageAttemptAsync(nextStarted);
        using var completed = await StorageOpenAsync(browser, next, destination: mode == "silent" ? "iframe" : "document");
        Assert.Equal(HttpStatusCode.OK, completed.StatusCode);
        Assert.Single((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
        Assert.NotNull(host.Services.GetRequiredService<AppSignInIntentStore>().Find(AppId, other.Id, other.Nonce));
    }

    [Fact]
    public async Task NamedHttp_RequestCancellationAfterClaimIsNotReportedAsAuthorizationFailure()
    {
        var clock = new CallbackClock();
        await using var host = await HostAsync(clock, coreOrigin: NamedCore);
        using var browser = Browser(host, NamedCore);
        using var started = await IntentAsync(browser);
        var attempt = await StorageAttemptAsync(started);
        var store = host.Services.GetRequiredService<AppSignInIntentStore>();
        using var cancellation = new CancellationTokenSource();
        // Cancel at the first clock read after the claim, before authorization-code persistence.
        clock.OnRead = () =>
        {
            if (!store.Contains(attempt.Id)) cancellation.Cancel();
        };
        var server = Assert.IsType<TestServer>(host.Services.GetRequiredService<IServer>());
        using var form = new FormUrlEncodedContent(new Dictionary<string, string>
        { ["nonce"] = attempt.Nonce, ["browserProofs"] = "{}" });
        var bytes = await form.ReadAsByteArrayAsync();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => server.SendAsync(context =>
        {
            context.Request.Method = "POST";
            context.Request.Scheme = "http";
            context.Request.Host = new HostString("core.hosty.localhost", 7070);
            context.Request.Path = $"/api/apps/{AppId}/open";
            context.Request.QueryString = new QueryString("?requestId=" + attempt.Id);
            context.Request.Headers.Origin = NamedCore;
            context.Request.Headers.Cookie = "hosty_session=" + SessionId;
            context.Request.Headers["Sec-Fetch-Mode"] = "navigate";
            context.Request.Headers["Sec-Fetch-Dest"] = "document";
            context.Request.ContentType = "application/x-www-form-urlencoded";
            context.Request.ContentLength = bytes.Length;
            context.Request.Body = new MemoryStream(bytes);
            context.RequestAborted = cancellation.Token;
        }));
        clock.OnRead = null;
        Assert.True(cancellation.IsCancellationRequested);
        Assert.False(store.Contains(attempt.Id));
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
        Assert.DoesNotContain(await host.Services.GetRequiredService<AuditStore>().ReadRecentAsync(),
            record => record.Outcome == "sign_in_authorization_failed");
    }

    [Fact]
    public async Task NamedHttp_PostClaimIdentityFailureStillClearsItsProofWhenAuditIsUnavailable()
    {
        var clock = new CallbackClock();
        await using var host = await HostAsync(clock, coreOrigin: NamedCore);
        using var browser = Browser(host, NamedCore);
        using var started = await IntentAsync(browser);
        var attempt = await StorageAttemptAsync(started);
        using var otherStarted = await IntentAsync(browser);
        var other = await StorageAttemptAsync(otherStarted);
        var store = host.Services.GetRequiredService<AppSignInIntentStore>();
        var paths = host.Services.GetRequiredService<CoreDataPaths>();
        Directory.CreateDirectory(paths.AuditLogPath);
        // Inject an access-policy exception only after nonce ownership has claimed this intent.
        clock.OnRead = () =>
        {
            if (store.Contains(attempt.Id)) return;
            clock.OnRead = null;
            throw new AppIdentityException("app_access_denied", "This app is no longer accessible.");
        };
        try
        {
            using var failed = await StorageOpenAsync(browser, attempt);
            Assert.Equal(HttpStatusCode.Forbidden, failed.StatusCode);
            Assert.Equal("text/html", failed.Content.Headers.ContentType!.MediaType);
            Assert.False(failed.Headers.Contains("Set-Cookie"));
            Assert.Null(failed.Headers.Location);
            var html = await failed.Content.ReadAsStringAsync();
            Assert.Contains("This app is no longer accessible.", html);
            Assert.Contains("sessionStorage.removeItem", html);
            Assert.Contains("hosty.core.signin." + attempt.Id, html);
            Assert.DoesNotContain("hosty.core.signin." + other.Id, html);
            foreach (var sensitive in new[] { attempt.Nonce, other.Nonce, AuthCodeProof.Challenge,
                AuthCodeProof.Verifier, SessionId, paths.AuditLogPath, paths.AuthRoot,
                "IOException", "UnauthorizedAccessException", "Access to the path" })
                Assert.DoesNotContain(sensitive, html);
            Assert.False(store.Contains(attempt.Id));
            Assert.NotNull(store.Find(AppId, other.Id, other.Nonce));
            Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
        }
        finally
        {
            clock.OnRead = null;
            Directory.Delete(paths.AuditLogPath);
        }

        using var replay = await StorageOpenAsync(browser, attempt);
        Assert.Equal(HttpStatusCode.Forbidden, replay.StatusCode);
        Assert.Equal("sign_in_intent_invalid", await ErrorAsync(replay));
        Assert.Empty((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
        using var nextStarted = await IntentAsync(browser);
        var next = await StorageAttemptAsync(nextStarted);
        using var completed = await StorageOpenAsync(browser, next);
        Assert.Equal(HttpStatusCode.OK, completed.StatusCode);
        Assert.Single((await host.Services.GetRequiredService<AppAuthCodeStore>().ReadAsync()).Codes);
        Assert.NotNull(store.Find(AppId, other.Id, other.Nonce));
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
    private static async Task<HttpResponseMessage> IntentAsync(HttpClient client, string? origin = AppOrigin, string redirect = AppOrigin + "/callback", string mode = "standalone")
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/apps/{AppId}/sign-in-intent");
        var fields = new Dictionary<string, string>
        { ["redirectUri"] = redirect, ["state"] = State, ["codeChallenge"] = AuthCodeProof.Challenge, ["codeChallengeMethod"] = "S256" };
        if (mode == "silent") fields["prompt"] = "none";
        if (mode == "popup") fields["responseMode"] = "web_message";
        request.Content = new FormUrlEncodedContent(fields);
        if (origin is not null) request.Headers.Add("Origin", origin);
        request.Headers.Add("Sec-Fetch-Mode", "navigate"); request.Headers.Add("Sec-Fetch-Dest", mode == "silent" ? "iframe" : "document");
        return await client.SendAsync(request);
    }
    private static async Task<HttpResponseMessage> OpenAsync(HttpClient client, Uri location, string cookies, string destination = "document")
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, location);
        if (cookies.Length > 0) request.Headers.Add("Cookie", cookies);
        request.Headers.Add("Sec-Fetch-Mode", "navigate"); request.Headers.Add("Sec-Fetch-Dest", destination);
        return await client.SendAsync(request);
    }
    private sealed record StorageAttempt(string Id, string Nonce)
    {
        internal Uri Location => new($"/api/apps/{AppId}/open?requestId={Id}", UriKind.Relative);
    }
    private sealed class UnknownLengthContent : HttpContent
    {
        private readonly byte[] bytes;
        public UnknownLengthContent(string value)
        {
            bytes = System.Text.Encoding.UTF8.GetBytes(value);
            Headers.ContentType = new("application/x-www-form-urlencoded");
        }
        protected override bool TryComputeLength(out long length) { length = 0; return false; }
        protected override Task SerializeToStreamAsync(Stream stream, TransportContext? context)
            => stream.WriteAsync(bytes, 0, bytes.Length);
    }
    private static async Task<StorageAttempt> StorageAttemptAsync(HttpResponseMessage response)
    {
        var html = await response.Content.ReadAsStringAsync();
        var id = Regex.Match(html, "const requestId = \"([0-9a-f]{64})\";");
        var nonce = Regex.Match(html, "const initialNonce = \"([0-9a-f]{64})\";");
        Assert.True(id.Success, html);
        Assert.True(nonce.Success, html);
        return new(id.Groups[1].Value, nonce.Groups[1].Value);
    }
    private static async Task<HttpResponseMessage> StorageOpenAsync(HttpClient client, StorageAttempt attempt,
        string? nonce = null, string proofs = "{}", string? origin = NamedCore, string cookies = "hosty_session=" + SessionId,
        string destination = "document")
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, attempt.Location)
        {
            Content = new FormUrlEncodedContent(new Dictionary<string, string>
            { ["nonce"] = nonce ?? attempt.Nonce, ["browserProofs"] = proofs }),
        };
        if (origin is not null) request.Headers.Add("Origin", origin);
        if (cookies.Length > 0) request.Headers.Add("Cookie", cookies);
        request.Headers.Add("Sec-Fetch-Mode", "navigate");
        request.Headers.Add("Sec-Fetch-Dest", destination);
        return await client.SendAsync(request);
    }
    private static async Task<HttpResponseMessage> StorageFailureAsync(HttpClient client, StorageAttempt attempt, string failureCode,
        string? origin = NamedCore, string cookies = "hosty_session=" + SessionId, string destination = "document")
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, attempt.Location)
        {
            Content = new FormUrlEncodedContent(new Dictionary<string, string>
            { ["nonce"] = attempt.Nonce, ["failureCode"] = failureCode }),
        };
        if (origin is not null) request.Headers.Add("Origin", origin);
        if (cookies.Length > 0) request.Headers.Add("Cookie", cookies);
        request.Headers.Add("Sec-Fetch-Mode", "navigate");
        request.Headers.Add("Sec-Fetch-Dest", destination);
        return await client.SendAsync(request);
    }
    private static string Cookie(HttpResponseMessage response) => response.Headers.GetValues("Set-Cookie").Single().Split(';')[0];
    private static async Task<string?> ErrorAsync(HttpResponseMessage response)
        => (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString();
    private static async Task<CoreHttpHarness> HostAsync(IClock? clock = null, string appOrigin = AppOrigin, string coreOrigin = "http://127.0.0.1:7070")
    {
        var host = await CoreHttpHarness.StartAsync(clock);
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1,
            [new("user", "user@example.test", "User", "host.user", false, now, now)], [], [new(AppId, "user", now)],
            [new(SessionId, "user", now, now.AddHours(8), null, now, BrowserOrigin: coreOrigin)]));
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
    private sealed class CallbackClock : IClock
    {
        private readonly DateTimeOffset utcNow = DateTimeOffset.UtcNow;
        private bool invokingCallback;
        internal Action? OnRead { get; set; }
        public DateTimeOffset UtcNow
        {
            get
            {
                if (invokingCallback) return utcNow;
                invokingCallback = true;
                try { OnRead?.Invoke(); }
                finally { invokingCallback = false; }
                return utcNow;
            }
        }
    }
}
