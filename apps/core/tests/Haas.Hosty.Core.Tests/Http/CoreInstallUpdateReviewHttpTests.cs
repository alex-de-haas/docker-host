using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class CoreInstallUpdateReviewHttpTests
{
    [Fact]
    public async Task RuntimeSelectionReviewsFrozenManifestAndAutostart_BeforeClaimingConsent()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var session = await SeedAdmin(harness);
        var paths = harness.Services.GetRequiredService<CoreDataPaths>();
        var manifestPath = Path.Combine(paths.DataRoot, "runtime-choice.json");
        var manifest = Fixture("example.runtime-choice", "1.0.0", "[]", "[]");
        await File.WriteAllTextAsync(manifestPath, manifest);
        using var api = harness.CreateClient();
        api.DefaultRequestHeaders.Authorization = new("Bearer", session);
        using var prepared = await api.PostAsJsonAsync("/api/installations", new { manifestPath });
        prepared.EnsureSuccessStatusCode();
        var id = (await prepared.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        (await api.PostAsJsonAsync($"/api/installations/{id}/submit", new { })).EnsureSuccessStatusCode();
        using var browser = Browser(harness, session);
        var page = await browser.GetStringAsync($"/install/confirm/{id}");
        Assert.Contains("name=runtime", page);
        Assert.Contains("name=autostart", page);
        Assert.DoesNotContain("name=settings", page);
        Assert.DoesNotContain("name=feed", page);
        Assert.DoesNotContain("name=mount", page);
        await File.WriteAllTextAsync(manifestPath, manifest.Replace("\"corePermissions\":[]", "\"corePermissions\":[\"apps.install\"]")
            .Replace("1.0.0", "2.0.0"));
        var firstNonce = Nonce(page);
        using var selection = await Decide(browser, id, firstNonce, "approve", "second", false);
        selection.EnsureSuccessStatusCode();
        var changedHtml = await selection.Content.ReadAsStringAsync();
        Assert.Contains("Review the selected runtime", changedHtml);
        Assert.DoesNotContain("window.close()", changedHtml);
        Assert.DoesNotContain("apps.install", changedHtml);
        var store = harness.Services.GetRequiredService<InstallationApprovalStore>();
        Assert.Equal("pending", store.Get(id).Status);
        Assert.Equal("second", store.Get(id).InstallPlan!.TargetRuntime);
        Assert.False(store.Get(id).Autostart);
        Assert.Null(await harness.Services.GetRequiredService<AppRegistryStore>().GetAppAsync("example.runtime-choice"));
        using var stale = await Decide(browser, id, firstNonce, "approve", "second", false);
        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
        using var approved = await Decide(browser, id, Nonce(changedHtml), "approve", "second", false);
        approved.EnsureSuccessStatusCode();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (store.Get(id).Status == "executing") await Task.Delay(10, timeout.Token);
        Assert.Equal("succeeded", store.Get(id).Status);
        var installed = (await harness.Services.GetRequiredService<AppRegistryStore>().GetAppAsync("example.runtime-choice"))!;
        Assert.Equal("1.0.0", installed.Version);
        Assert.Equal("second", installed.SelectedRuntime);
        Assert.False(installed.Autostart);
        Assert.Empty(installed.GrantedCorePermissions!);
        Assert.Equal("stopped", installed.RuntimeState);
    }

    [Theory]
    [InlineData("unlisted")]
    [InlineData("first,second")]
    public async Task UnreviewedRuntimeCannotConsumeNonceOrInstall(string runtime)
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var session = await SeedAdmin(harness);
        var path = Path.Combine(harness.Services.GetRequiredService<CoreDataPaths>().DataRoot, "invalid-runtime.json");
        await File.WriteAllTextAsync(path, Fixture("example.invalid-runtime", "1.0.0", "[]", "[]"));
        var service = harness.Services.GetRequiredService<InstallationApprovalService>();
        var entry = await service.PrepareAsync(new("review-admin", null, null, "Test client"), new(ManifestPath: path), default);
        await service.SubmitAsync(entry, new(Autostart: false), default);
        using var browser = Browser(harness, session);
        var nonce = Nonce(await browser.GetStringAsync($"/install/confirm/{entry.Id}"));
        using var rejected = await Decide(browser, entry.Id, nonce, "approve", runtime, false);
        Assert.Equal(HttpStatusCode.Conflict, rejected.StatusCode);
        Assert.Equal("pending", entry.Status);
        using var cancelled = await Decide(browser, entry.Id, nonce, "deny", "first", false);
        cancelled.EnsureSuccessStatusCode();
        Assert.Equal("denied", entry.Status);
        Assert.Null(await harness.Services.GetRequiredService<AppRegistryStore>().GetAppAsync("example.invalid-runtime"));
    }

    [Fact]
    public async Task CustomClientCanSubmitLaunchSettings_WithoutExposingValuesOrEditorsInConfirmation()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var session = await SeedAdmin(harness);
        var path = Path.Combine(harness.Services.GetRequiredService<CoreDataPaths>().DataRoot, "custom-settings.json");
        await File.WriteAllTextAsync(path, Fixture("example.custom-settings", "1.0.0", "[]",
            """[{"key":"TOKEN","type":"string","secret":true,"required":true}]"""));
        using var api = harness.CreateClient();
        api.DefaultRequestHeaders.Authorization = new("Bearer", session);
        using var prepared = await api.PostAsJsonAsync("/api/installations", new { manifestPath = path });
        prepared.EnsureSuccessStatusCode();
        var preparedBody = await prepared.Content.ReadFromJsonAsync<JsonElement>();
        Assert.True(preparedBody.GetProperty("plan").GetProperty("configurationReadiness").GetProperty("required").GetBoolean());
        var id = preparedBody.GetProperty("id").GetString()!;
        using var submitted = await api.PostAsJsonAsync($"/api/installations/{id}/submit", new
        {
            settings = new Dictionary<string, string> { ["TOKEN"] = "custom-private-token" }, autostart = false,
        });
        submitted.EnsureSuccessStatusCode();
        var body = await submitted.Content.ReadAsStringAsync();
        Assert.DoesNotContain("custom-private-token", body);
        var store = harness.Services.GetRequiredService<InstallationApprovalStore>();
        Assert.False(store.Get(id).InstallPlan!.ConfigurationReadiness!.Required);
        using var browser = Browser(harness, session);
        var page = await browser.GetStringAsync($"/install/confirm/{id}");
        Assert.DoesNotContain("Configuration required", page);
        Assert.DoesNotContain("custom-private-token", page);
        Assert.DoesNotContain("TOKEN", page);
        Assert.DoesNotContain("name=settings", page);
        using var approved = await Decide(browser, id, Nonce(page), "approve", "first", false);
        approved.EnsureSuccessStatusCode();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (store.Get(id).Status == "executing") await Task.Delay(10, timeout.Token);
        Assert.Equal("succeeded", store.Get(id).Status);
        var installed = (await harness.Services.GetRequiredService<AppRegistryStore>().GetAppAsync("example.custom-settings"))!;
        Assert.Equal("custom-private-token", installed.Settings["TOKEN"].Value);
        Assert.True(installed.Settings["TOKEN"].Secret);
        Assert.False(installed.Autostart);
        Assert.Equal("stopped", installed.RuntimeState);
    }

    [Fact]
    public async Task UpdateSnapshotKeepsDeclarationsSeparateAndShowsSafeSettingDeltas()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var lifecycle = harness.Services.GetRequiredService<CoreLifecycleService>();
        var apps = harness.Services.GetRequiredService<AppRegistryStore>();
        var path = Path.Combine(harness.Services.GetRequiredService<CoreDataPaths>().DataRoot, "update-review.json");
        const string oldSettings = """[{"key":"TOKEN","type":"string","secret":true,"default":"old-private-secret"},{"key":"REMOVED","type":"string","secret":true,"default":"removed-private-secret"}]""";
        await File.WriteAllTextAsync(path, Fixture("example.update-review", "1.0.0", "[\"apps.read\"]", oldSettings));
        await lifecycle.InstallAsync(new(path, "first", Autostart: false));
        await apps.UpdateAppAsync("example.update-review", app => app with
        {
            GrantedCorePermissions = [], OptionalCorePermissions = [CoreAppPermissions.Install],
            PermissionRevision = "revoked",
        });
        const string targetSettings = """[{"key":"TOKEN","type":"string","secret":true,"required":true,"default":"new-private-secret"},{"key":"ADDED","type":"string","label":"<script>label</script>"}]""";
        await File.WriteAllTextAsync(path, Fixture("example.update-review", "2.0.0", "[\"apps.read\"]", targetSettings));
        var plan = await lifecycle.CreateUpdatePlanAsync("example.update-review", new(path));
        Assert.Equal([CoreAppPermissions.ReadApps], plan.PreviousRequiredCorePermissions);
        Assert.Equal([CoreAppPermissions.Install], plan.PreviousOptionalCorePermissions);
        Assert.Empty(plan.CurrentCorePermissions);
        Assert.Contains(plan.SettingChanges, change => change.Key == "TOKEN" && change.Change == "default");
        Assert.Contains(plan.SettingChanges, change => change.Key == "TOKEN" && change.Change == "required");
        Assert.True(plan.RequiresReview);
        var frozen = await lifecycle.GetReviewedUpdatePlanAsync(plan.AppId, plan.PlanDigest);
        Assert.Equal(CoreJson.Text(plan), CoreJson.Text(frozen));
        var entry = new InstallationApproval
        {
            UserId = "review-admin", CallerName = "<img src=x onerror=bad()>", ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(15),
            UpdatePlan = plan, Status = "pending",
        };
        var html = InstallationApprovalEndpoints.Render(entry, "nonce");
        Assert.Contains("1.0.0 → 2.0.0", html);
        Assert.Contains("currently not granted", html);
        Assert.DoesNotContain("(new declaration)", html);
        Assert.Contains("Settings changes", html);
        Assert.Contains("REMOVED", html);
        Assert.Contains("Type: string; sensitive value; optional at launch; default provided", html);
        Assert.Contains("Type: string; plain value; optional at launch; no usable default", html);
        Assert.Contains("&lt;script&gt;label&lt;/script&gt;", html);
        Assert.DoesNotContain("<script>label", html);
        Assert.DoesNotContain("private-secret", html);
        var serialized = CoreJson.Text(plan);
        Assert.DoesNotContain("private-secret", serialized);
    }

    [Fact]
    public void LegacyReviewDoesNotInventPermissionBaseline_AndEscapesUnknownChanges()
    {
        var plan = new AppUpdatePlan("legacy.app", "1", "2", "old", "new", "https://source.test/a", "manifest", "plan", false,
            ["setting:REMOVED:removed", "unrecognized:<script>bad()</script>"], SourceConfigured: false)
        {
            TargetCorePermissions = [CoreAppPermissions.ReadApps], TargetOptionalCorePermissions = [CoreAppPermissions.Install],
            CurrentCorePermissions = [CoreAppPermissions.Install], Error = "<img src=x>",
        };
        var entry = new InstallationApproval { UserId = "admin", CallerName = "Client", ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(15),
            UpdatePlan = plan, Status = "pending" };
        var html = InstallationApprovalEndpoints.Render(entry, "nonce");
        Assert.Contains("Previous permission declarations are unavailable", html);
        Assert.DoesNotContain("(new declaration)", html);
        Assert.Contains("value=\"apps.install\" checked", html);
        Assert.Contains("setting:REMOVED:removed", html);
        Assert.Contains("unrecognized:&lt;script&gt;bad()&lt;/script&gt;", html);
        Assert.DoesNotContain("<script>", html);
        Assert.DoesNotContain("<h2>Settings changes</h2>", html);
        Assert.DoesNotContain("<h2>Provider roles</h2>", html);
    }

    [Fact]
    public void UpdateReviewLabelsDeclarationTransitionsAndRemovedRevokedRights()
    {
        var plan = new AppUpdatePlan("app", "1", "2", "runtime", "runtime", "manifest", "digest", "plan", true, [])
        {
            PreviousRequiredCorePermissions = [CoreAppPermissions.ReadCore, CoreAppPermissions.AppLogs],
            PreviousOptionalCorePermissions = [CoreAppPermissions.Install], CurrentCorePermissions = [CoreAppPermissions.ReadCore],
            TargetCorePermissions = [CoreAppPermissions.Install, CoreAppPermissions.ReadApps],
            TargetOptionalCorePermissions = [CoreAppPermissions.ReadCore],
        };
        var entry = new InstallationApproval { UserId = "admin", CallerName = "Client", ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(15),
            UpdatePlan = plan, Status = "pending" };
        var html = InstallationApprovalEndpoints.Render(entry, "nonce");
        Assert.Contains("optional → required", html);
        Assert.Contains("required → optional", html);
        Assert.Contains("new declaration", html);
        Assert.Contains("Removed: Read application logs", html);
        Assert.Contains("value=\"core.read\" checked", html);
        Assert.Contains("backed up before updating", html);
    }

    [Theory]
    [InlineData("{\"files\":{\"mode\":\"rw\",\"service\":\"app\"}}")]
    [InlineData("{\"files\":{\"mode\":\"ro\"}}")]
    public async Task AppDelegatedUpdateCannotSilentlyExpandMountAccess(string targetMounts)
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        using var client = await AppManagementHttpTests.CreateAppClient(harness, "example.market", [CoreAppPermissions.Install]);
        var lifecycle = harness.Services.GetRequiredService<CoreLifecycleService>();
        var apps = harness.Services.GetRequiredService<AppRegistryStore>();
        var path = Path.Combine(harness.Services.GetRequiredService<CoreDataPaths>().DataRoot, "delegated-mount-review.json");
        static string WithMounts(string manifest, string slots) => manifest.TrimEnd()[..^1] + ",\"externalMounts\":" + slots + "}";
        var initial = WithMounts(Fixture("example.mount-review", "1.0.0", "[]", "[]"), "{\"files\":{\"mode\":\"ro\",\"service\":\"app\"}}");
        await File.WriteAllTextAsync(path, initial);
        await lifecycle.InstallAsync(new(path, Autostart: false));
        var folder = Path.Combine(Path.GetTempPath(), "hosty-mount-review-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(folder);
        try
        {
            await lifecycle.ConfigureMountsAsync("example.mount-review", new([new("files", "documents", folder)]));
            await File.WriteAllTextAsync(path, WithMounts(Fixture("example.mount-review", "2.0.0", "[]", "[]"), targetMounts));
            var plan = await lifecycle.CreateUpdatePlanAsync("example.mount-review", new(path));
            Assert.True(plan.RequiresReview);
            Assert.False(plan.ConfigurationReadiness!.Required);
            using var response = await client.PostAsJsonAsync("/api/apps/example.mount-review/update", new
            {
                planDigest = plan.PlanDigest, requiresReview = false,
            });
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            Assert.Equal("approval_required", (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
            Assert.Equal("1.0.0", (await apps.GetAppAsync("example.mount-review"))!.Version);
            Assert.Null(lifecycle.TryGetRunningBackgroundUpdate("example.mount-review"));
        }
        finally { Directory.Delete(folder, true); }
    }

    [Theory]
    [InlineData("hosty.shell", true)]
    [InlineData("other.app", false)]
    public void ConfigurationWarningExplainsOfflineShellRecovery(string appId, bool shell)
    {
        var plan = new AppUpdatePlan(appId, "1", "2", "runtime", "runtime", "manifest", "digest", "plan", false, [])
        {
            ConfigurationReadiness = new(true, ["REQUIRED_TOKEN"], []),
        };
        var entry = new InstallationApproval { UserId = "admin", CallerName = "Client", ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(15),
            UpdatePlan = plan, Status = "pending" };
        var html = InstallationApprovalEndpoints.Render(entry, "nonce");
        Assert.Equal(shell, html.Contains("Shell stays offline after confirmation"));
        Assert.Equal(shell, html.Contains("local Core control API"));
        Assert.Equal(shell, html.Contains("hosty apps start hosty.shell"));
        Assert.Equal(!shell, html.Contains("Open app settings in Shell"));
    }

    private static HttpClient Browser(CoreHttpHarness harness, string session)
    {
        var browser = harness.CreateClient(); browser.DefaultRequestHeaders.Add("Cookie", $"hosty_session={session}"); return browser;
    }
    private static string Nonce(string html) => Regex.Match(html, "name=nonce value=\"([^\"]+)\"").Groups[1].Value;
    private static Task<HttpResponseMessage> Decide(HttpClient browser, string id, string nonce, string decision, string runtime, bool autostart)
    {
        var fields = new Dictionary<string, string> { ["nonce"] = nonce, ["decision"] = decision, ["runtime"] = runtime, ["installOptions"] = "true" };
        if (autostart) fields["autostart"] = "true";
        var request = new HttpRequestMessage(HttpMethod.Post, $"/install/confirm/{id}")
            { Content = new FormUrlEncodedContent(fields), Headers = { { "Origin", "http://localhost" } } };
        return browser.SendAsync(request);
    }
    private static async Task<string> SeedAdmin(CoreHttpHarness harness)
    {
        var now = DateTimeOffset.UtcNow;
        var user = new HostUserRecord("review-admin", "review@example.test", "Review", "host.admin", false, now, now);
        var session = new AuthSessionRecord("review-session", user.Id, now, now.AddHours(1), null, now, BrowserOrigin: "http://localhost");
        await harness.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new UserDirectoryState(1, [user], [], [], [session]));
        return session.Id;
    }
    private static string Fixture(string id, string version, string permissions, string settings) => $$$$"""
        {"schemaVersion":"app.0.1","id":"{{{{id}}}}","name":"Review fixture","version":"{{{{version}}}}",
         "corePermissions":{{{{permissions}}}},"settings":{{{{settings}}}},"defaultRuntime":"first",
         "runtimeProfiles":[{"key":"first","type":"localCommand","default":true},{"key":"second","type":"localCommand"}],
         "services":[{"key":"app","runtimes":{
           "first":{"type":"localCommand","command":"echo first","workingDirectory":"."},
           "second":{"type":"localCommand","command":"echo second","workingDirectory":"."}}}]}
        """;
}
