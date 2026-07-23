using System.Net;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

// C-L2 over real HTTP: the CSRF cookie mirrors the request's HTTPS state, logout requires CSRF, and
// GET /logout no longer mutates.
public sealed class AuthCsrfLogoutHttpTests
{
    [Fact]
    public async Task CsrfCookie_IsSecureOnlyOverHttps()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        using var client = harness.CreateClient();

        // Plain HTTP: a Secure cookie would be dropped by the browser, so it must not be marked Secure.
        using var httpResponse = await client.GetAsync("http://localhost/api/auth/csrf");
        Assert.DoesNotContain(SetCookie(httpResponse), value => value.Contains("secure", StringComparison.OrdinalIgnoreCase));

        // HTTPS: the CSRF cookie must be Secure, like the session cookie it protects.
        using var httpsResponse = await client.GetAsync("https://localhost/api/auth/csrf");
        Assert.Contains(SetCookie(httpsResponse), value => value.Contains("secure", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task Logout_RequiresCsrf()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        using var client = harness.CreateClient();

        // No CSRF token: rejected.
        using var noCsrf = await client.PostAsync("/api/auth/logout", EmptyJson());
        Assert.Equal(HttpStatusCode.Forbidden, noCsrf.StatusCode);

        // Matching cookie+header (the double-submit pair the /csrf endpoint hands out): accepted.
        const string token = "csrf-token-value";
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/auth/logout") { Content = EmptyJson() };
        request.Headers.Add("Cookie", $"{CoreSessionAuthorization.CsrfCookieName}={token}");
        request.Headers.Add(CoreSessionAuthorization.CsrfHeaderName, token);
        using var withCsrf = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, withCsrf.StatusCode);
    }

    [Fact]
    public async Task GetLogout_RedirectsToLoginWithoutRevokingTheSession()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var users = harness.Services.GetRequiredService<UserDirectoryStore>();
        var now = harness.Services.GetRequiredService<IClock>().UtcNow;

        var user = new HostUserRecord("user_1", "user@example.test", "User", "host.admin", false, now, now);
        var session = new AuthSessionRecord("sess_1", user.Id, now, now.AddHours(1), null, now);
        await users.WriteAsync(new UserDirectoryState(1, [user], [], [], [session]));

        using var client = harness.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/logout");
        request.Headers.Add("Cookie", $"{CoreSessionAuthorization.SessionCookieName}={session.Id}");
        using var response = await client.SendAsync(request);

        // Redirect to login, and — critically — a GET must not have revoked the session (CSRF-via-GET).
        Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
        Assert.StartsWith("/login", response.Headers.Location?.OriginalString ?? "");
        var stored = Assert.Single((await users.ReadAsync()).Sessions);
        Assert.Null(stored.RevokedAt);
    }

    private static IEnumerable<string> SetCookie(HttpResponseMessage response)
        => response.Headers.TryGetValues("Set-Cookie", out var values) ? values : [];

    private static StringContent EmptyJson()
        => new("{}", System.Text.Encoding.UTF8, "application/json");
}
