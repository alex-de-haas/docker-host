using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class InstallationApprovalHttpTests
{
    [Fact]
    public async Task CorePageIsTheOnlyDecisionSurface_AndDenialLeavesTheHostUnchanged()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var session = await SeedAdmin(harness);
        var store = harness.Services.GetRequiredService<InstallationApprovalStore>();
        var entry = store.Add(new InstallationApproval
        {
            UserId = "admin", CallerName = "Third-party marketplace", ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(15),
        });
        store.Submit(entry, new());
        using var client = harness.CreateClient();
        client.DefaultRequestHeaders.Add("Cookie", $"hosty_session={session}");
        var path = $"/install/confirm/{entry.Id}";
        using var page = await client.GetAsync(path);
        Assert.Equal(HttpStatusCode.OK, page.StatusCode);
        Assert.Equal("DENY", page.Headers.GetValues("X-Frame-Options").Single());
        Assert.Equal("same-origin", page.Headers.GetValues("Referrer-Policy").Single());
        Assert.Contains("frame-ancestors 'none'", page.Headers.GetValues("Content-Security-Policy").Single());
        Assert.DoesNotContain("script-src", page.Headers.GetValues("Content-Security-Policy").Single());
        var html = await page.Content.ReadAsStringAsync();
        var nonce = Regex.Match(html, "name=nonce value=\"([^\"]+)\"").Groups[1].Value;
        Assert.NotEmpty(nonce);

        using var hostile = new HttpRequestMessage(HttpMethod.Post, path)
        {
            Content = new FormUrlEncodedContent(new Dictionary<string, string> { ["nonce"] = nonce, ["decision"] = "approve" }),
        };
        hostile.Headers.Add("Origin", "https://marketplace.example");
        using var rejected = await client.SendAsync(hostile);
        Assert.Equal(HttpStatusCode.Forbidden, rejected.StatusCode);
        Assert.Equal("pending", entry.Status);

        using var decision = new HttpRequestMessage(HttpMethod.Post, path)
        {
            Content = new FormUrlEncodedContent(new Dictionary<string, string> { ["nonce"] = nonce, ["decision"] = "deny" }),
        };
        decision.Headers.Add("Origin", "http://localhost");
        using var denied = await client.SendAsync(decision);
        Assert.Equal(HttpStatusCode.OK, denied.StatusCode);
        await AssertClosesAcceptedDecisionWindow(denied);
        Assert.Equal("denied", entry.Status);
        using var replay = new HttpRequestMessage(HttpMethod.Post, path)
        {
            Content = new FormUrlEncodedContent(new Dictionary<string, string> { ["nonce"] = nonce, ["decision"] = "approve" }),
        };
        replay.Headers.Add("Origin", "http://localhost");
        using var replayed = await client.SendAsync(replay);
        Assert.Equal(HttpStatusCode.Conflict, replayed.StatusCode);
    }

    [Fact]
    public async Task InstallationCannotUseTheLegacyApplyRoute_EvenWithAnAdminCredential()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var session = await SeedAdmin(harness);
        using var client = harness.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", session);
        using var response = await client.PostAsJsonAsync("/api/apps/install", new { manifestPath = "/unused", planId = "stolen-plan" });
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Contains("approval_required", await response.Content.ReadAsStringAsync());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task AppCredentialsNeedAnApprovedGrant_AndCannotReadTheDecisionPage(bool granted)
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        _ = await SeedAdmin(harness);
        var apps = harness.Services.GetRequiredService<AppRegistryStore>();
        await apps.UpsertAppAsync(new AppRecord("example.market", "Other marketplace", null, "1.0.0", "runtime", false,
            "manifest", null, null, "dev", "installed", "stopped", null, null, [], new Dictionary<string, AppSettingValue>(),
            [], [], [], DateTimeOffset.UtcNow, DateTimeOffset.UtcNow,
            GrantedCorePermissions: granted ? [CoreAppPermissions.Install] : []));
        var identity = harness.Services.GetRequiredService<AppIdentityService>();
        var grant = await identity.CreateLaunchTokenAsync("example.market", "admin");
        using var client = harness.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", harness.Services.GetRequiredService<AppServiceTokenService>().CreateToken("example.market"));
        client.DefaultRequestHeaders.Add("X-Hosty-App-Identity", grant.AccessToken);
        using var response = await client.PostAsJsonAsync("/api/internal/apps/example.market/installations", new { });
        Assert.Equal(granted ? HttpStatusCode.Conflict : HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Contains(granted ? "manifest_path_required" : "app_permission_required", await response.Content.ReadAsStringAsync());
        using var page = await client.GetAsync("/install/confirm/" + new string('a', 48));
        Assert.Equal(HttpStatusCode.Redirect, page.StatusCode);
        Assert.StartsWith("/login?", page.Headers.Location!.ToString());
    }

    [Fact]
    public async Task CoreConfirmationInstallsOnlyTheFrozenManifest_AndRecordsApprovedPermissions()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var session = await SeedAdmin(harness);
        var paths = harness.Services.GetRequiredService<CoreDataPaths>();
        var manifestPath = Path.Combine(paths.DataRoot, "fixture.json");
        const string manifest = """
            {"schemaVersion":"app.0.1","id":"example.fixture","name":"Fixture","version":"1.0.0",
             "corePermissions":["apps.install"],
             "runtimeProfiles":[{"key":"dev","type":"localCommand","default":true}],"defaultRuntime":"dev",
             "services":[{"key":"app","runtimes":{"dev":{"type":"localCommand","command":"echo unused","workingDirectory":"."}}}]}
            """;
        await File.WriteAllTextAsync(manifestPath, manifest);
        using var api = harness.CreateClient();
        api.DefaultRequestHeaders.Authorization = new("Bearer", session);
        using var prepared = await api.PostAsJsonAsync("/api/installations", new { manifestPath });
        Assert.True(prepared.IsSuccessStatusCode, await prepared.Content.ReadAsStringAsync());
        var draft = await prepared.Content.ReadFromJsonAsync<JsonElement>();
        var id = draft.GetProperty("id").GetString()!;
        using var submitted = await api.PostAsJsonAsync($"/api/installations/{id}/submit", new { autostart = false });
        Assert.True(submitted.IsSuccessStatusCode, await submitted.Content.ReadAsStringAsync());
        // The publisher changes its source while the user reads the plan. This cannot add rights.
        await File.WriteAllTextAsync(manifestPath, manifest.Replace("[\"apps.install\"]", "[\"apps.install\",\"apps.update\"]"));
        using var browser = harness.CreateClient();
        browser.DefaultRequestHeaders.Add("Cookie", $"hosty_session={session}");
        var path = $"/install/confirm/{id}";
        using var page = await browser.GetAsync(path);
        var html = await page.Content.ReadAsStringAsync();
        Assert.DoesNotContain("Request updates", html);
        var nonce = Regex.Match(html, "name=nonce value=\"([^\"]+)\"").Groups[1].Value;
        Assert.NotEmpty(nonce);
        using var decision = new HttpRequestMessage(HttpMethod.Post, path)
        {
            Content = new FormUrlEncodedContent(new Dictionary<string, string> { ["nonce"] = nonce, ["decision"] = "approve" }),
        };
        decision.Headers.Add("Origin", "http://localhost");
        using var applied = await browser.SendAsync(decision);
        Assert.Equal(HttpStatusCode.OK, applied.StatusCode);
        await AssertClosesAcceptedDecisionWindow(applied);
        var approvals = harness.Services.GetRequiredService<InstallationApprovalStore>();
        using var completionTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (approvals.Get(id).Status == "executing")
            await Task.Delay(10, completionTimeout.Token);
        Assert.Equal("succeeded", approvals.Get(id).Status);
        var installed = await harness.Services.GetRequiredService<AppRegistryStore>().GetAppAsync("example.fixture");
        Assert.NotNull(installed);
        Assert.Equal([CoreAppPermissions.Install], installed.GrantedCorePermissions);
        Assert.False(installed.Autostart);
        using var status = await api.GetAsync($"/api/installations/{id}");
        Assert.Contains("succeeded", await status.Content.ReadAsStringAsync());

        var lifecycle = harness.Services.GetRequiredService<CoreLifecycleService>();
        var update = await lifecycle.CreateUpdatePlanAsync("example.fixture", new(manifestPath));
        Assert.Contains(CoreAppPermissions.Update, update.TargetCorePermissions);
        var refused = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            lifecycle.EnqueueUpdateAsync("example.fixture", new(update.PlanDigest)));
        Assert.Equal("approval_required", refused.Code);
        Assert.Equal([CoreAppPermissions.Install], (await harness.Services.GetRequiredService<AppRegistryStore>().GetAppAsync("example.fixture"))!.GrantedCorePermissions);
    }

    [Fact]
    public async Task SharedCookieHostIsRefusedEvenWhenTheAppUsesAnotherPort()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var apps = harness.Services.GetRequiredService<AppRegistryStore>();
        await apps.UpsertAppAsync(new AppRecord("example.app", "App", null, "1.0.0", "runtime", false,
            "manifest", null, null, "dev", "installed", "stopped", null, null, [], new Dictionary<string, AppSettingValue>(),
            [], [], [new AppEndpointContract("web", "http", "http://localhost:3200", true)], DateTimeOffset.UtcNow, DateTimeOffset.UtcNow));
        var request = new Microsoft.AspNetCore.Http.DefaultHttpContext().Request;
        request.Host = new Microsoft.AspNetCore.Http.HostString("localhost", 7070);
        Assert.False(await InstallationApprovalEndpoints.HasIsolatedCookieHostAsync(request, apps, default));
        request.Host = new Microsoft.AspNetCore.Http.HostString("core.hosty.localhost", 7070);
        Assert.True(await InstallationApprovalEndpoints.HasIsolatedCookieHostAsync(request, apps, default));
    }

    [Fact]
    public async Task BrowserSessionIssuedOnAnotherOriginCannotReadTheConfirmationNonce()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var session = await SeedAdmin(harness);
        using var browser = harness.CreateClient();
        browser.DefaultRequestHeaders.Add("Cookie", $"hosty_session={session}");
        using var request = new HttpRequestMessage(HttpMethod.Get, "http://core.example/install/confirm/" + new string('a', 48));
        using var response = await browser.SendAsync(request);
        Assert.Equal(HttpStatusCode.Redirect, response.StatusCode);
        Assert.StartsWith("/login?", response.Headers.Location!.ToString());
    }

    private static async Task AssertClosesAcceptedDecisionWindow(HttpResponseMessage response)
    {
        var html = await response.Content.ReadAsStringAsync();
        var script = Regex.Match(html, "<script>(.*?)</script>").Groups[1].Value;
        Assert.Equal("window.close();", script);
        var hash = Convert.ToBase64String(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(script)));
        var csp = response.Headers.GetValues("Content-Security-Policy").Single();
        Assert.Contains($"script-src 'sha256-{hash}'", csp);
        Assert.DoesNotContain("script-src 'unsafe-inline'", csp);
        Assert.Contains("frame-ancestors 'none'", csp);
        Assert.Contains("You can close this window.", html);
    }

    private static async Task<string> SeedAdmin(CoreHttpHarness harness)
    {
        var now = DateTimeOffset.UtcNow;
        var user = new HostUserRecord("admin", "admin@example.test", "Admin", "host.admin", false, now, now);
        var session = new AuthSessionRecord("operator-session", user.Id, now, now.AddHours(1), null, now, BrowserOrigin: "http://localhost");
        await harness.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new UserDirectoryState(1, [user], [], [], [session]));
        return session.Id;
    }
}
