using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Haas.Hosty.Core;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

// The public origin end to end: editable over both admin surfaces, live in everything Core hands a
// browser or an agent client, and — the property this whole feature stands on — never able to lock the
// operator out. Core answers on its listen URL whatever this value says, so an origin naming a host that
// does not exist is a correctable mistake rather than a dead host.
//
// The recovery tests are deliberately written as "sign in over loopback while the setting is wrong, then
// fix it with the session that produced" rather than as unit assertions on the cookie flags. The property
// is the whole loop; a later refactor that unified the session cookie on the public origin would leave
// every flag assertion passing and the loop broken.
public sealed class CorePublicOriginHttpTests
{
    private const string Unreachable = "https://core.does-not-resolve.invalid";
    private const string Password = "correct-horse-battery-staple";

    [Fact]
    public async Task PublicOrigin_IsListedAndEditableOverTheControlPlane()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var client = harness.CreateClient();
        var secret = harness.Services.GetRequiredService<ControlSecret>().Value;

        var listed = await ReadSettingAsync(client, secret);
        // The harness boots with the environment baseline set, which is what an unedited host reports.
        Assert.Equal("http://localhost:7070", listed.Value);
        Assert.False(listed.Overridden);

        using var saved = await PutSettingAsync(client, secret, "https://core.example.test");
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);

        var after = await ReadSettingAsync(client, secret);
        Assert.Equal("https://core.example.test", after.Value);
        Assert.True(after.Overridden);
        // `Default` is what a reset lands on: the environment baseline, not a hardcoded fallback.
        Assert.Equal("http://localhost:7070", after.Default);

        // `hosty core settings reset HOSTY_CORE_PUBLIC_ORIGIN` — the headless escape hatch.
        using var reset = await PutSettingAsync(client, secret, null);
        Assert.Equal(HttpStatusCode.OK, reset.StatusCode);
        var cleared = await ReadSettingAsync(client, secret);
        Assert.Equal("http://localhost:7070", cleared.Value);
        Assert.False(cleared.Overridden);
    }

    [Fact]
    public async Task PublicOrigin_RefusesAMalformedValue()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var client = harness.CreateClient();
        var secret = harness.Services.GetRequiredService<ControlSecret>().Value;

        using var response = await PutSettingAsync(client, secret, "https://core.example.test/admin");

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal("http://localhost:7070", (await ReadSettingAsync(client, secret)).Value);
    }

    // Every browser- and client-facing document is built per request, so a save is in effect immediately.
    [Fact]
    public async Task PublicOrigin_ReachesTheProtocolDocumentsWithoutARestart()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var client = harness.CreateClient();
        var secret = harness.Services.GetRequiredService<ControlSecret>().Value;

        using var saved = await PutSettingAsync(client, secret, "https://core.example.test");
        Assert.Equal(HttpStatusCode.OK, saved.StatusCode);

        using var metadata = await client.GetAsync("/.well-known/oauth-authorization-server");
        var document = JsonDocument.Parse(await metadata.Content.ReadAsStringAsync());
        Assert.Equal("https://core.example.test", document.RootElement.GetProperty("issuer").GetString());
        Assert.Equal(
            "https://core.example.test/api/auth/oauth/authorize",
            document.RootElement.GetProperty("authorization_endpoint").GetString());

        using var resource = await client.GetAsync("/.well-known/oauth-protected-resource/api/mcp");
        var resourceDocument = JsonDocument.Parse(await resource.Content.ReadAsStringAsync());
        Assert.Equal("https://core.example.test/api/mcp", resourceDocument.RootElement.GetProperty("resource").GetString());

        // The MCP 401 pointer is how a stock agent client discovers the flow at all. It needs a bearer
        // credential to reach: an anonymous browser-shaped POST is answered by the CSRF gate first.
        var probe = new HttpRequestMessage(HttpMethod.Post, "/api/mcp")
        {
            Content = new StringContent("{}", System.Text.Encoding.UTF8, "application/json"),
        };
        probe.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", "not-a-session");
        using var mcp = await client.SendAsync(probe);
        Assert.Equal(HttpStatusCode.Unauthorized, mcp.StatusCode);
        Assert.Contains(
            "https://core.example.test/.well-known/oauth-protected-resource/api/mcp",
            mcp.Headers.WwwAuthenticate.ToString(),
            StringComparison.Ordinal);
    }

    // The recovery property. With the setting naming a host that does not exist, a password sign-in over
    // the loopback listen URL still succeeds and still issues a usable session — and that session can
    // correct the setting. If this ever fails, a single typo bricks the host.
    [Fact]
    public async Task AnUnreachableOrigin_LeavesLoopbackSignInAndCorrectionWorking()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var client = harness.CreateClient();
        var secret = harness.Services.GetRequiredService<ControlSecret>().Value;
        await SeedAdminWithPasswordAsync(harness);

        using var broken = await PutSettingAsync(client, secret, Unreachable);
        Assert.Equal(HttpStatusCode.OK, broken.StatusCode);

        // Core still serves its own sign-in page over loopback.
        using var page = await client.GetAsync("/login");
        Assert.Equal(HttpStatusCode.OK, page.StatusCode);

        using var signIn = await PostLoginAsync(client);
        Assert.Equal(HttpStatusCode.OK, signIn.StatusCode);
        var session = ReadSessionCookie(signIn);
        Assert.False(string.IsNullOrWhiteSpace(session));

        // The signed-in page reports the live origin — proof the reader is live, and that the page it is
        // printed on was reached over loopback all the same.
        Assert.Contains(Unreachable, await signIn.Content.ReadAsStringAsync(), StringComparison.Ordinal);

        // And the session just issued can put the value right, from the admin surface rather than the
        // control plane: the browser recovery path, not just the headless one.
        using var repaired = await PutAdminSettingAsync(client, session!, "http://localhost:7070");
        Assert.Equal(HttpStatusCode.OK, repaired.StatusCode);
        Assert.Equal("http://localhost:7070", (await ReadSettingAsync(client, secret)).Value);
    }

    // The session cookie's Secure flag follows the request scheme, not the public origin. A cookie marked
    // Secure is silently dropped by the browser over plain HTTP, so tying it to an https public origin
    // would make loopback sign-in fail with no error anywhere — the exact failure the loop above exists
    // to prevent, pinned here at the mechanism so a refactor cannot pass the loop by accident.
    [Fact]
    public async Task TheSessionCookieFollowsTheRequestScheme_NotThePublicOrigin()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var client = harness.CreateClient();
        var secret = harness.Services.GetRequiredService<ControlSecret>().Value;
        await SeedAdminWithPasswordAsync(harness);
        using var broken = await PutSettingAsync(client, secret, Unreachable);
        Assert.Equal(HttpStatusCode.OK, broken.StatusCode);

        using var signIn = await PostLoginAsync(client);

        var cookie = Assert.Single(
            signIn.Headers.GetValues("Set-Cookie"),
            value => value.StartsWith($"{CoreSessionAuthorization.SessionCookieName}=", StringComparison.Ordinal));
        Assert.DoesNotContain("secure", cookie, StringComparison.OrdinalIgnoreCase);
    }

    private static async Task<HttpResponseMessage> PostLoginAsync(HttpClient client)
        => await client.PostAsync("/login", new FormUrlEncodedContent(
            [
                new KeyValuePair<string, string>("email", "admin@example.test"),
                new KeyValuePair<string, string>("password", Password),
            ]));

    private static string? ReadSessionCookie(HttpResponseMessage response)
        => response.Headers.TryGetValues("Set-Cookie", out var cookies)
            ? cookies
                .FirstOrDefault(value => value.StartsWith($"{CoreSessionAuthorization.SessionCookieName}=", StringComparison.Ordinal))?
                .Split(';')[0]
                .Split('=', 2)[1]
            : null;

    private static async Task SeedAdminWithPasswordAsync(CoreHttpHarness harness)
    {
        var users = harness.Services.GetRequiredService<UserDirectoryStore>();
        var passwords = harness.Services.GetRequiredService<LocalPasswordAuthService>();
        var now = harness.Services.GetRequiredService<IClock>().UtcNow;
        var admin = new HostUserRecord("user_admin", "admin@example.test", "Admin", "host.admin", false, now, now);
        await users.WriteAsync(new UserDirectoryState(
            1,
            [admin],
            [],
            [],
            [],
            passwords.UpsertCredential(null, admin.Id, Password, now)));
    }

    private static Task<HttpResponseMessage> PutSettingAsync(HttpClient client, string secret, string? value)
    {
        var request = new HttpRequestMessage(HttpMethod.Put, "/control/v1/settings")
        {
            Content = JsonContent.Create(new
            {
                settings = new Dictionary<string, string?>(StringComparer.Ordinal) { ["HOSTY_CORE_PUBLIC_ORIGIN"] = value },
            }),
        };
        request.Headers.Add("X-Hosty-Control-Secret", secret);
        return client.SendAsync(request);
    }

    private static Task<HttpResponseMessage> PutAdminSettingAsync(HttpClient client, string session, string? value)
    {
        var request = new HttpRequestMessage(HttpMethod.Put, "/api/core/settings")
        {
            Content = JsonContent.Create(new
            {
                settings = new Dictionary<string, string?>(StringComparer.Ordinal) { ["HOSTY_CORE_PUBLIC_ORIGIN"] = value },
            }),
        };
        // Double-submit CSRF: the cookie and the header have to carry the same value, which is what a
        // browser does with the pair Core issued at sign-in.
        const string csrf = "csrf-token";
        request.Headers.Add(
            "Cookie",
            $"{CoreSessionAuthorization.SessionCookieName}={session}; {CoreSessionAuthorization.CsrfCookieName}={csrf}");
        request.Headers.Add(CoreSessionAuthorization.CsrfHeaderName, csrf);
        return client.SendAsync(request);
    }

    private static async Task<(string Value, string Default, bool Overridden)> ReadSettingAsync(HttpClient client, string secret)
    {
        var request = new HttpRequestMessage(HttpMethod.Get, "/control/v1/settings");
        request.Headers.Add("X-Hosty-Control-Secret", secret);
        using var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var row = document.RootElement.GetProperty("settings")
            .EnumerateArray()
            .Single(entry => entry.GetProperty("key").GetString() == "HOSTY_CORE_PUBLIC_ORIGIN");
        return (
            row.GetProperty("value").GetString()!,
            row.GetProperty("default").GetString()!,
            row.GetProperty("overridden").GetBoolean());
    }
}
