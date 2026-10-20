using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class ProtectedSettingsHttpTests
{
    private static object Change(string value) => new { settings = new Dictionary<string, string> { ["HOSTY_CORE_PORT"] = value } };

    [Fact]
    public async Task AppCannotApprove_ExactReviewedRequestAppliesOnce_AndMismatchedReplayFails()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var app = await AppManagementHttpTests.CreateAppClient(host, "example.settings", [CoreAppPermissions.ConfigureCore]);
        await NormalizeBrowser(host);
        using var first = await app.PutAsJsonAsync("/api/core/settings", Change("7171"));
        Assert.Equal(428, (int)first.StatusCode);
        var review = await first.Content.ReadFromJsonAsync<SettingsChangeView>();
        using var repeated = await app.PutAsJsonAsync("/api/core/settings", Change("7171"));
        Assert.Equal(review!.Id, (await repeated.Content.ReadFromJsonAsync<SettingsChangeView>())!.Id);
        Assert.Equal(HttpStatusCode.Forbidden, (await app.GetAsync("/settings/confirm/" + review.Id)).StatusCode);
        using var browser = Browser(host);
        var html = await browser.GetStringAsync("/settings/confirm/" + review.Id);
        Assert.Contains("7070", html); Assert.Contains("7171", html); Assert.Contains("Management client", html);
        await Decide(browser, review.Id, html, "approve");
        app.DefaultRequestHeaders.Add(ProtectedSettingsChanges.Header, review.Id);
        using var changedPayload = await app.PutAsJsonAsync("/api/core/settings", Change("7272"));
        Assert.Equal(HttpStatusCode.Forbidden, changedPayload.StatusCode);
        using var applied = await app.PutAsJsonAsync("/api/core/settings", Change("7171"));
        applied.EnsureSuccessStatusCode();
        var body = await applied.Content.ReadAsStringAsync();
        using var replay = await app.PutAsJsonAsync("/api/core/settings", Change("7171"));
        Assert.Equal(body, await replay.Content.ReadAsStringAsync());
        Assert.Equal("succeeded", (await app.GetFromJsonAsync<SettingsChangeView>("/api/settings/changes/" + review.Id))!.Status);
    }

    [Fact]
    public async Task ReviewDisambiguatesSessionPolicyGroupsAndUnits()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var app = await AppManagementHttpTests.CreateAppClient(host, "example.settings", [CoreAppPermissions.ConfigureCore]);
        await NormalizeBrowser(host);
        using var prepared = await app.PutAsJsonAsync("/api/core/settings", new { settings = new Dictionary<string, string> {
            ["HOSTY_AUTH_CORE_SESSION_IDLE_HOURS"] = "167", ["HOSTY_AUTH_APP_GRANT_IDLE_HOURS"] = "166" } });
        var review = (await prepared.Content.ReadFromJsonAsync<SettingsChangeView>())!;
        using var browser = Browser(host);
        var html = WebUtility.HtmlDecode(await browser.GetStringAsync("/settings/confirm/" + review.Id));
        Assert.Contains("Admin session · Idle timeout (h)", html);
        Assert.Contains("App sessions · Idle timeout (h)", html);
    }

    [Theory]
    [InlineData("deny")]
    [InlineData("stale")]
    [InlineData("revoke")]
    public async Task CancelStaleOrRevokedAuthorityCannotApply(string scenario)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var app = await AppManagementHttpTests.CreateAppClient(host, "example.settings", [CoreAppPermissions.ConfigureCore]);
        await NormalizeBrowser(host);
        using var prepared = await app.PutAsJsonAsync("/api/core/settings", Change("7171"));
        Assert.Equal(428, (int)prepared.StatusCode);
        var review = (await prepared.Content.ReadFromJsonAsync<SettingsChangeView>())!;
        using var browser = Browser(host);
        var html = await browser.GetStringAsync("/settings/confirm/" + review.Id);
        await Decide(browser, review.Id, html, scenario == "deny" ? "deny" : "approve");
        if (scenario == "stale")
        {
            using var control = host.CreateClient();
            control.DefaultRequestHeaders.Add("X-Hosty-Control-Secret", host.Services.GetRequiredService<ControlSecret>().Value);
            (await control.PutAsJsonAsync("/control/v1/settings", Change("7373"))).EnsureSuccessStatusCode();
        }
        if (scenario == "revoke")
        {
            var apps = host.Services.GetRequiredService<AppRegistryStore>();
            await apps.UpsertAppAsync((await apps.GetAppAsync("example.settings"))! with { GrantedCorePermissions = [] });
        }
        app.DefaultRequestHeaders.Add(ProtectedSettingsChanges.Header, review.Id);
        using var response = await app.PutAsJsonAsync("/api/core/settings", Change("7171"));
        Assert.Equal(scenario == "revoke" ? HttpStatusCode.Forbidden : HttpStatusCode.Conflict, response.StatusCode);
    }

    [Fact]
    public async Task InvitationAcceptanceRemainsPublic_AndAccountPagesContainOnlyTheirAction()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var app = await AppManagementHttpTests.CreateAppClient(host, "example.settings", []);
        await NormalizeBrowser(host);
        using var anonymous = host.CreateClient();
        using var response = await anonymous.PostAsJsonAsync("/api/auth/invitations/accept", new { token = "missing", password = "test-password", displayName = "Test" });
        Assert.NotEqual(428, (int)response.StatusCode);
        using var browser = Browser(host);
        var html = await browser.GetStringAsync("/account/tokens");
        Assert.Contains("Create access token", html);
        Assert.DoesNotContain("Tokens and devices</a>", html);
        Assert.Contains("font-src 'self'", string.Join(";", (await browser.GetAsync("/account/tokens")).Headers.GetValues("Content-Security-Policy")));
    }

    internal static async Task NormalizeBrowser(CoreHttpHarness host) =>
        await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(state => state with {
            Sessions = state.Sessions.Select(session => session with { BrowserOrigin = "http://localhost" }).ToArray(),
        });
    internal static HttpClient Browser(CoreHttpHarness host)
    {
        var browser = host.CreateClient(); browser.DefaultRequestHeaders.Add("Cookie", "hosty_session=operator; hosty_csrf=csrf");
        return browser;
    }
    internal static async Task Decide(HttpClient browser, string id, string html, string decision)
    {
        var nonce = Regex.Match(html, "name=nonce value=\\\"([^\\\"]+)\\\"").Groups[1].Value;
        Assert.NotEmpty(nonce);
        using var request = new HttpRequestMessage(HttpMethod.Post, "/settings/confirm/" + id) {
            Content = new FormUrlEncodedContent(new Dictionary<string, string> { ["nonce"] = nonce, ["decision"] = decision }),
        };
        request.Headers.Add("Origin", "http://localhost");
        (await browser.SendAsync(request)).EnsureSuccessStatusCode();
    }
}
