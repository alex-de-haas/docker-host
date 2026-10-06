using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class PasswordLoginHttpTests
{
    private const string Password = "isolated-test-password";

    [Theory]
    [InlineData("Development")]
    [InlineData("Production")]
    public async Task Login_RequiresPasswordAndCreatesUsableSession(string environment)
    {
        await using var harness = await CoreHttpHarness.StartAsync(environmentName: environment);
        await SeedUserAsync(harness);
        using var client = harness.CreateClient();

        var html = await client.GetStringAsync("/login");
        Assert.Contains("autocomplete=\"username\"", html);
        Assert.Contains("autocomplete=\"current-password\"", html);
        Assert.DoesNotContain("<select", html);
        Assert.DoesNotContain("admin@example.test", html);

        using var login = await client.PostAsync("/login", Form("admin@example.test", Password));
        Assert.Equal(HttpStatusCode.Redirect, login.StatusCode);
        Assert.Equal("/install/permissions/example.app", login.Headers.Location!.ToString());
        var cookie = Assert.Single(login.Headers.GetValues("Set-Cookie"), c => c.StartsWith("hosty_session="));
        Assert.Contains("httponly", cookie, StringComparison.OrdinalIgnoreCase);
        client.DefaultRequestHeaders.Add("Cookie", cookie.Split(';')[0]);
        var session = await client.GetFromJsonAsync<JsonElement>("/api/auth/session");
        Assert.True(session.GetProperty("authenticated").GetBoolean());
        Assert.Equal("admin", session.GetProperty("user").GetProperty("id").GetString());
    }

    [Theory]
    [InlineData("Development")]
    [InlineData("Production")]
    public async Task DirectSessionCreationAndUserSelectorPost_CannotAuthenticate(string environment)
    {
        await using var harness = await CoreHttpHarness.StartAsync(environmentName: environment);
        await SeedUserAsync(harness);
        using var client = harness.CreateClient();

        using var direct = await client.PostAsJsonAsync("/api/auth/session", new { userId = "admin", secureCookie = false });
        Assert.Equal(HttpStatusCode.MethodNotAllowed, direct.StatusCode);
        Assert.False(direct.Headers.Contains("Set-Cookie"));
        using var selector = await client.PostAsync("/login",
            new FormUrlEncodedContent(new Dictionary<string, string> { ["userId"] = "admin" }));
        Assert.Equal(HttpStatusCode.Forbidden, selector.StatusCode);
        Assert.False(selector.Headers.Contains("Set-Cookie"));
        Assert.Empty((await harness.Services.GetRequiredService<UserDirectoryStore>().ReadAsync()).Sessions);
    }

    [Theory]
    [InlineData("Development", "wrong-password")]
    [InlineData("Production", "wrong-password")]
    [InlineData("Development", "disabled")]
    [InlineData("Production", "disabled")]
    [InlineData("Development", "no-credential")]
    [InlineData("Production", "no-credential")]
    public async Task InvalidCredentials_DoNotCreateSession(string environment, string scenario)
    {
        await using var harness = await CoreHttpHarness.StartAsync(environmentName: environment);
        await SeedUserAsync(harness, disabled: scenario == "disabled", credential: scenario != "no-credential");
        using var client = harness.CreateClient();

        using var login = await client.PostAsync("/login",
            Form("admin@example.test", scenario == "wrong-password" ? "incorrect-password" : Password));
        Assert.Equal(HttpStatusCode.Forbidden, login.StatusCode);
        Assert.Contains("Email or password is invalid.", await login.Content.ReadAsStringAsync());
        Assert.False(login.Headers.Contains("Set-Cookie"));
        Assert.Empty((await harness.Services.GetRequiredService<UserDirectoryStore>().ReadAsync()).Sessions);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task StandaloneLogin_ReturnsToAssignedApp_WithoutShellAccess(bool system, bool popup)
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        await SeedUserAsync(harness);
        var users = harness.Services.GetRequiredService<UserDirectoryStore>();
        var now = DateTimeOffset.UtcNow;
        await users.UpdateAsync(s => s with { Users = s.Users.Select(u => u with { Role = "host.user" }).ToArray(),
            Assignments = [new("example.app", "admin", now)] });
        var apps = harness.Services.GetRequiredService<AppRegistryStore>();
        await apps.UpsertAppAsync(new AppRecord("example.app", "Standalone app", null, "1.0.0", "runtime", system,
            "manifest", null, null, "dev", "installed", "stopped", null, null, [], new Dictionary<string, AppSettingValue>(),
            [], [], [new("web", "http", "http://app.example.test", true)], now, now));
        using var client = harness.CreateClient();
        client.BaseAddress = new Uri("http://127.0.0.1:7070");
        client.DefaultRequestHeaders.Add("Sec-Fetch-Mode", "navigate");
        client.DefaultRequestHeaders.Add("Sec-Fetch-Dest", "document");
        async Task<HttpResponseMessage> StartAsync(string state, string redirect = "http://app.example.test/page")
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "/api/apps/example.app/sign-in-intent");
            request.Headers.Add("Origin", "http://app.example.test");
            request.Content = new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["redirectUri"] = redirect, ["state"] = state,
                ["codeChallenge"] = AuthCodeProof.Challenge, ["codeChallengeMethod"] = "S256",
                ["responseMode"] = popup ? "web_message" : "",
            });
            return await client.SendAsync(request);
        }
        using var started = await StartAsync(new string('a', 64));
        Assert.Equal(HttpStatusCode.SeeOther, started.StatusCode);
        var nonceCookie = started.Headers.GetValues("Set-Cookie").Single().Split(';')[0];
        client.DefaultRequestHeaders.Add("Cookie", nonceCookie);
        var continuation = started.Headers.Location!.OriginalString;
        using var first = await client.GetAsync(continuation);
        Assert.Equal(HttpStatusCode.Redirect, first.StatusCode);
        Assert.StartsWith("/login?returnTo=", first.Headers.Location!.ToString());
        using var login = await client.PostAsync("/login", new FormUrlEncodedContent(new Dictionary<string, string>
            { ["email"] = "admin@example.test", ["password"] = Password, ["returnTo"] = continuation }));
        Assert.Equal(continuation, login.Headers.Location!.OriginalString);
        var cookie = Assert.Single(login.Headers.GetValues("Set-Cookie"), c => c.StartsWith("hosty_session="));
        client.DefaultRequestHeaders.Remove("Cookie");
        client.DefaultRequestHeaders.Add("Cookie", nonceCookie + "; " + cookie.Split(';')[0]);
        using var opened = await client.GetAsync(login.Headers.Location);
        string code;
        if (popup)
        {
            opened.EnsureSuccessStatusCode();
            var html = await opened.Content.ReadAsStringAsync();
            Assert.Contains("window.opener.postMessage", html);
            Assert.Contains("\"http://app.example.test\"", html);
            Assert.Contains(new string('a', 64), html);
            Assert.Equal("no-store", opened.Headers.CacheControl!.ToString());
            Assert.Contains("frame-ancestors 'none'", opened.Headers.GetValues("Content-Security-Policy").Single());
            code = System.Text.RegularExpressions.Regex.Match(html, "code:\"([^\"]+)\"").Groups[1].Value;
        }
        else
        {
            Assert.Equal(HttpStatusCode.Redirect, opened.StatusCode);
            var target = opened.Headers.Location!;
            Assert.Equal("app.example.test", target.Host);
            code = Microsoft.AspNetCore.WebUtilities.QueryHelpers.ParseQuery(target.Query)["code"].ToString();
        }
        Assert.NotEmpty(code);
        using var appClient = harness.CreateClient();
        appClient.DefaultRequestHeaders.Authorization = new("Bearer", harness.Services.GetRequiredService<AppServiceTokenService>().CreateToken("example.app"));
        using var exchanged = await appClient.PostAsJsonAsync("/api/auth/apps/token", new { code, codeVerifier = AuthCodeProof.Verifier });
        exchanged.EnsureSuccessStatusCode();
        Assert.True((await exchanged.Content.ReadFromJsonAsync<System.Text.Json.JsonElement>()).GetProperty("activeUntil").GetDateTimeOffset() > now);
        if (popup)
        {
            using var replay = await appClient.PostAsJsonAsync("/api/auth/apps/token", new { code, codeVerifier = AuthCodeProof.Verifier });
            Assert.Equal(HttpStatusCode.Unauthorized, replay.StatusCode);
            using var badState = await StartAsync("short");
            Assert.Equal(HttpStatusCode.BadRequest, badState.StatusCode);
            using var foreignPopup = await StartAsync(new string('a', 64), "http://evil.example.test/page");
            Assert.Equal(HttpStatusCode.Forbidden, foreignPopup.StatusCode);
        }
        using var foreign = await client.GetAsync("/api/apps/example.app/open?redirectUri=https%3A%2F%2Fother.example.test%2Fcallback");
        Assert.Equal(HttpStatusCode.Forbidden, foreign.StatusCode);
        await users.UpdateAsync(s => s with { Assignments = [] });
        using var revokedStart = await StartAsync(new string('b', 64));
        var revokedNonce = revokedStart.Headers.GetValues("Set-Cookie").Single().Split(';')[0];
        client.DefaultRequestHeaders.Remove("Cookie");
        client.DefaultRequestHeaders.Add("Cookie", revokedNonce + "; " + cookie.Split(';')[0]);
        using var revoked = await client.GetAsync(revokedStart.Headers.Location);
        Assert.Equal(HttpStatusCode.Forbidden, revoked.StatusCode);
    }

    [Theory]
    [InlineData("/account")]
    [InlineData("/account/sources")]
    public async Task ProfileSettings_AreNotServedAsCorePages(string path)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = host.CreateClient();
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(path)).StatusCode);
    }

    [Theory]
    [InlineData("/account/tokens")]
    [InlineData("/oauth/consent?request=example")]
    public async Task CoreAccountPages_UsePasswordLoginWithoutShell_AndRejectCrossOriginReads(string path)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await SeedUserAsync(host);
        using var client = host.CreateClient();
        using var entry = await client.GetAsync(path);
        Assert.Equal(HttpStatusCode.Redirect, entry.StatusCode);
        Assert.Equal("/login?returnTo=" + Uri.EscapeDataString(path), entry.Headers.Location!.OriginalString);
        using var login = await client.PostAsync("/login", new FormUrlEncodedContent(new Dictionary<string, string>
            { ["email"] = "admin@example.test", ["password"] = Password, ["returnTo"] = path }));
        Assert.Equal(path, login.Headers.Location!.OriginalString);
        var cookie = Assert.Single(login.Headers.GetValues("Set-Cookie"), c => c.StartsWith("hosty_session="));
        client.DefaultRequestHeaders.Add("Cookie", cookie.Split(';')[0]);
        using var page = await client.GetAsync(path);
        page.EnsureSuccessStatusCode();
        Assert.Contains("HOSTY CORE", await page.Content.ReadAsStringAsync());
        Assert.Equal("DENY", Assert.Single(page.Headers.GetValues("X-Frame-Options")));
        Assert.Contains("frame-ancestors 'none'", Assert.Single(page.Headers.GetValues("Content-Security-Policy")));
        Assert.False(page.Headers.Contains("Access-Control-Allow-Origin"));
        using var script = await client.GetAsync("/account/assets/account.js");
        script.EnsureSuccessStatusCode();
        Assert.Equal("text/javascript", script.Content.Headers.ContentType!.MediaType);
        using var foreign = new HttpRequestMessage(HttpMethod.Get, path);
        foreign.Headers.Add("Sec-Fetch-Mode", "cors"); foreign.Headers.Add("Origin", "http://shell.example.test");
        using var denied = await client.SendAsync(foreign);
        Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
    }

    [Theory]
    [InlineData("/api/auth/csrf")]
    [InlineData("/api/profile")]
    [InlineData("/api/auth/credentials")]
    public async Task CorePersonalApis_DoNotGrantCredentialedCorsToShell(string path)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        await SeedUserAsync(host);
        using var client = host.CreateClient();
        using var login = await client.PostAsync("/login", Form("admin@example.test", Password));
        var cookie = Assert.Single(login.Headers.GetValues("Set-Cookie"), c => c.StartsWith("hosty_session="));
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        request.Headers.Add("Cookie", cookie.Split(';')[0]);
        request.Headers.Add("Origin", "http://ahosty-dshellz.hosty.localhost:7171");
        using var response = await client.SendAsync(request);
        Assert.False(response.Headers.Contains("Access-Control-Allow-Origin"));
        Assert.False(response.Headers.Contains("Access-Control-Allow-Credentials"));
    }

    private static FormUrlEncodedContent Form(string email, string password) => new(new Dictionary<string, string>
    {
        ["email"] = email, ["password"] = password, ["returnTo"] = "/install/permissions/example.app",
    });

    // Fixture data stays inside the test host's isolated store; no test-only HTTP route is exposed.
    private static async Task SeedUserAsync(CoreHttpHarness harness, bool disabled = false, bool credential = true)
    {
        var now = DateTimeOffset.UtcNow;
        var user = new HostUserRecord("admin", "admin@example.test", "Test Admin", "host.admin", disabled, now, now);
        var passwords = harness.Services.GetRequiredService<LocalPasswordAuthService>();
        await harness.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new UserDirectoryState(
            1, [user], [], [], [], credential ? passwords.UpsertCredential(null, user.Id, Password, now) : []));
    }
}
