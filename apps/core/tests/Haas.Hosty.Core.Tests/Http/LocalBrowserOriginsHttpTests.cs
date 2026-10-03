using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class LocalBrowserOriginsHttpTests
{
    [Theory]
    [InlineData("approve", "succeeded")]
    [InlineData("deny", "denied")]
    public async Task DefaultLocalReview_LogsInOnIsolatedHost_AndCompletesDecision(string decision, string expected)
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var users = harness.Services.GetRequiredService<UserDirectoryStore>();
        var passwords = harness.Services.GetRequiredService<LocalPasswordAuthService>();
        var now = DateTimeOffset.UtcNow;
        const string password = "local-browser-test-password";
        var user = new HostUserRecord("admin", "admin@example.test", "Admin", "host.admin", false, now, now);
        await users.WriteAsync(new UserDirectoryState(1, [user], [], [],
            [new AuthSessionRecord("old-session", user.Id, now, now.AddHours(1), null, now, BrowserOrigin: "http://localhost:7070")],
            passwords.UpsertCredential(null, user.Id, password, now)));
        var apps = harness.Services.GetRequiredService<AppRegistryStore>();
        await apps.UpsertAppAsync(App("hosty.shell", "http://localhost:7171"));
        using var api = harness.CreateClient();
        api.DefaultRequestHeaders.Authorization = new("Bearer", "old-session");
        using var prepared = await api.PostAsJsonAsync("/api/installations", new { permissionsAppId = "hosty.shell" });
        prepared.EnsureSuccessStatusCode();
        var view = await prepared.Content.ReadFromJsonAsync<JsonElement>();
        var id = view.GetProperty("id").GetString()!;
        var url = view.GetProperty("approvalUrl").GetString()!;
        Assert.Equal($"http://core.hosty.localhost:7070/install/confirm/{id}", url);
        (await api.PostAsJsonAsync($"/api/installations/{id}/submit", new { })).EnsureSuccessStatusCode();

        using var browser = harness.CreateClient();
        browser.BaseAddress = new Uri("http://core.hosty.localhost:7070");
        browser.DefaultRequestHeaders.Add("Cookie", "hosty_session=old-session");
        using var unsigned = await browser.GetAsync(url);
        Assert.Equal(HttpStatusCode.Redirect, unsigned.StatusCode);
        Assert.StartsWith("/login?returnTo=", unsigned.Headers.Location!.ToString());
        using var login = await browser.PostAsync("/login", new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["email"] = user.Email!, ["password"] = password, ["returnTo"] = new Uri(url).AbsolutePath,
        }));
        Assert.Equal(HttpStatusCode.Redirect, login.StatusCode);
        Assert.Equal(new Uri(url).AbsolutePath, login.Headers.Location!.ToString());
        var sessionCookie = login.Headers.GetValues("Set-Cookie").Single(c => c.StartsWith("hosty_session=", StringComparison.Ordinal));
        Assert.DoesNotContain("domain=", sessionCookie, StringComparison.OrdinalIgnoreCase);
        browser.DefaultRequestHeaders.Remove("Cookie");
        browser.DefaultRequestHeaders.Add("Cookie", sessionCookie.Split(';')[0]);
        using var page = await browser.GetAsync(url);
        page.EnsureSuccessStatusCode();
        var html = await page.Content.ReadAsStringAsync();
        var nonce = Regex.Match(html, "name=nonce value=\"([^\"]+)\"").Groups[1].Value;
        Assert.NotEmpty(nonce);
        using var submitted = new HttpRequestMessage(HttpMethod.Post, url)
        {
            Content = new FormUrlEncodedContent(new Dictionary<string, string>
            {
                ["nonce"] = nonce, ["decision"] = decision, ["optionalPermission"] = CoreAppPermissions.SpeechProviders,
            }),
        };
        submitted.Headers.Add("Origin", browser.BaseAddress.GetLeftPart(UriPartial.Authority));
        (await browser.SendAsync(submitted)).EnsureSuccessStatusCode();
        var store = harness.Services.GetRequiredService<InstallationApprovalStore>();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (store.Get(id).Status == "executing") await Task.Delay(10, timeout.Token);
        Assert.Equal(expected, store.Get(id).Status);
        var app = (await apps.GetAppAsync("hosty.shell"))!;
        Assert.Equal(decision == "approve", app.GrantedCorePermissions!.Contains(CoreAppPermissions.SpeechProviders));
        Assert.Equal("stopped", app.RuntimeState);
        using var shared = await browser.GetAsync($"http://localhost:7070/install/confirm/{id}");
        Assert.Equal(HttpStatusCode.Conflict, shared.StatusCode);
    }

    [Fact]
    public async Task ExistingRunningAppsRequireOriginMigration_AndTrackLaterCoreOriginEdits()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var apps = harness.Services.GetRequiredService<AppRegistryStore>();
        var lifecycle = harness.Services.GetRequiredService<CoreLifecycleService>();
        var app = App("example.app", "http://127.0.0.1:3200") with { RuntimeState = "running" };
        await apps.UpsertAppAsync(app);
        Assert.True(Assert.Single(await lifecycle.ListAppsAsync()).RestartRequired);
        // Model the persisted successful runtime transition; a Core reload reads the same marker.
        var origins = harness.Services.GetRequiredService<CorePublicOriginResolver>();
        await apps.UpdateAppAsync(app.Id, current => current with { AppliedBrowserOrigin = origins.Effective });
        Assert.False(Assert.Single(await lifecycle.ListAppsAsync()).RestartRequired);
        await harness.Services.GetRequiredService<CoreSettingsService>().UpdateAsync(
            new Dictionary<string, string?> { ["HOSTY_CORE_PUBLIC_ORIGIN"] = "https://core.example.test" });
        Assert.True(Assert.Single(await lifecycle.ListAppsAsync()).RestartRequired);
        await apps.UpdateAppAsync(app.Id, current => current with { RuntimeState = "stopped" });
        Assert.False(Assert.Single(await lifecycle.ListAppsAsync()).RestartRequired);
    }

    [Fact]
    public async Task PublicOriginOverrides_RejectCoreAndOtherAppHosts_AndResetToLocalDefault()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var apps = harness.Services.GetRequiredService<AppRegistryStore>();
        var app = App("example.app", "http://127.0.0.1:3200");
        await apps.UpsertAppAsync(app);
        await apps.UpsertAppAsync(App("example.other", "http://127.0.0.1:3201"));
        var lifecycle = harness.Services.GetRequiredService<CoreLifecycleService>();
        foreach (var origin in new[] { "http://core.hosty.localhost:3200", $"http://{LocalBrowserOrigins.AppHost("example.other")}:3200" })
        {
            var error = await Assert.ThrowsAsync<AppLifecycleException>(() => lifecycle.ConfigureAsync(app.Id,
                new AppConfigureRequest(new Dictionary<string, string?> { ["HOSTY_PUBLIC_ORIGIN_WEB"] = origin })));
            Assert.Equal("origin_host_conflict", error.Code);
        }
        var configured = await lifecycle.ConfigureAsync(app.Id,
            new AppConfigureRequest(new Dictionary<string, string?> { ["HOSTY_PUBLIC_ORIGIN_WEB"] = "http://photos.hosty.localhost:3200" }));
        Assert.Equal("http://photos.hosty.localhost:3200", configured.App!.Endpoints.Single().BrowserOrigin);
        var settings = harness.Services.GetRequiredService<CoreSettingsService>();
        var conflict = await Assert.ThrowsAsync<AppLifecycleException>(() => settings.UpdateAsync(
            new Dictionary<string, string?> { ["HOSTY_CORE_PUBLIC_ORIGIN"] = "http://photos.hosty.localhost:7070" }));
        Assert.Equal("origin_host_conflict", conflict.Code);
        var reset = await lifecycle.ConfigureAsync(app.Id,
            new AppConfigureRequest(new Dictionary<string, string?> { ["HOSTY_PUBLIC_ORIGIN_WEB"] = "" }));
        Assert.Equal($"http://{LocalBrowserOrigins.AppHost(app.Id)}:3200", reset.App!.Endpoints.Single().BrowserOrigin);
        Assert.Null(reset.App!.Endpoints.Single().PublicOrigin);
        Assert.Equal("http://127.0.0.1:3200", reset.App!.Endpoints.Single().Url);
    }

    [Theory]
    [InlineData("localhost")]
    [InlineData("127.0.0.1")]
    public async Task LegacyBrowserEntryRedirects_ButApiAndPostKeepTheirTransport(string host)
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        using var browser = harness.CreateClient();
        browser.BaseAddress = new Uri($"http://{host}:7070");
        browser.DefaultRequestHeaders.Add("Sec-Fetch-Mode", "navigate");
        browser.DefaultRequestHeaders.Add("Sec-Fetch-Dest", "document");
        using var page = await browser.GetAsync("/login?password=must-not-forward");
        Assert.Equal(HttpStatusCode.Redirect, page.StatusCode);
        Assert.Equal("http://core.hosty.localhost:7070/login", page.Headers.Location!.ToString());
        using var health = await browser.GetAsync("/healthz");
        Assert.Equal(HttpStatusCode.OK, health.StatusCode);
        using var post = await browser.PostAsync("/login", new FormUrlEncodedContent(new Dictionary<string, string> { ["email"] = "nobody", ["password"] = "incorrect" }));
        Assert.Null(post.Headers.Location);
    }

    private static AppRecord App(string id, string url) => new(id, id, null, "1.0.0", "runtime", false,
        "manifest", null, null, "dev", "installed", "stopped", null, null, [], new Dictionary<string, AppSettingValue>(),
        [], [], [new AppEndpointContract("web", "http", url, true)], DateTimeOffset.UtcNow, DateTimeOffset.UtcNow,
        GrantedCorePermissions: [], RequiredCorePermissions: [], OptionalCorePermissions: [CoreAppPermissions.SpeechProviders]);
}
