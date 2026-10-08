using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class CoreInstallUpdateReviewHttpTests
{
    private const string EscapingFeedId = "beta\"><img src=x onerror=alert(1)>";

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task InstallConfirmationShowsFrozenSystemAccessWarningOnlyForSystemApps(bool system)
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var session = await SeedAdmin(harness);
        var path = Path.Combine(harness.Services.GetRequiredService<CoreDataPaths>().DataRoot, "system-review.json");
        var manifest = Fixture("example.system-review", "1.0.0", "[]", "[]")
            .Replace("\"name\":\"Review fixture\"", "\"name\":\"<img src=x onerror=alert(1)>\"");
        if (system) manifest = manifest.Replace("\"version\":\"1.0.0\"", "\"version\":\"1.0.0\",\"role\":\"system\"");
        await File.WriteAllTextAsync(path, manifest);
        using var api = harness.CreateClient();
        api.DefaultRequestHeaders.Authorization = new("Bearer", session);
        using var prepared = await api.PostAsJsonAsync("/api/installations", new { manifestPath = path });
        prepared.EnsureSuccessStatusCode();
        var draft = await prepared.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(system, draft.GetProperty("plan").GetProperty("system").GetBoolean());
        var id = draft.GetProperty("id").GetString()!;
        using var submitted = await api.PostAsJsonAsync($"/api/installations/{id}/submit", new { });
        submitted.EnsureSuccessStatusCode();
        using var browser = Browser(harness, session);
        var html = await browser.GetStringAsync($"/install/confirm/{id}");
        const string warning = "<strong>System app.</strong> Administrators have access; other users need an explicit assignment. App permissions still apply.";
        Assert.Equal(system, html.Contains(warning, StringComparison.Ordinal));
        Assert.Contains("&lt;img src=x onerror=alert(1)&gt;", html);
        Assert.DoesNotContain("<img src=x", html);
        Assert.DoesNotContain("name=system", html);
        Assert.Contains("name=runtime", html);
        // A publisher changing the source role cannot change the already reviewed warning.
        await File.WriteAllTextAsync(path, Fixture("example.system-review", "9.0.0", "[]", "[]"));
        using var selection = await Decide(browser, id, Nonce(html), "runtime", "second", false);
        selection.EnsureSuccessStatusCode();
        var renewed = await selection.Content.ReadAsStringAsync();
        Assert.Equal(system, renewed.Contains(warning, StringComparison.Ordinal));
        var frozen = harness.Services.GetRequiredService<InstallationApprovalStore>().Get(id).InstallPlan!;
        Assert.Equal(system, frozen.System);
        Assert.Equal("1.0.0", frozen.TargetVersion);
        Assert.Equal("second", frozen.TargetRuntime);
        Assert.Null(await harness.Services.GetRequiredService<AppRegistryStore>().GetAppAsync("example.system-review"));
    }

    [Theory]
    [InlineData("stable", "1.0.0")]
    [InlineData("beta", "2.0.0")]
    [InlineData(EscapingFeedId, "2.0.0")]
    public async Task FeedInstallConfirmationShowsExactFrozenSelectionAndReferenceWithoutFeedControls(string feedId, string version)
    {
        const string appId = "example.feed-review";
        const string feedsUrl = "https://apps.example.test/review/feeds.json?catalog=one&view=install";
        const string stableRef = "https://apps.example.test/review/stable/manifest.json?channel=stable&review=one";
        const string betaRef = "https://apps.example.test/review/beta/manifest.json?channel=beta&review=one";
        const string movedRef = "https://apps.example.test/review/moved/manifest.json";
        var betaId = feedId == EscapingFeedId ? EscapingFeedId : "beta";
        using var publisher = new FeedReviewDocuments();
        string FeedDocument(string stable, string beta) => JsonSerializer.Serialize(new
        {
            schemaVersion = "app-feeds.0.1", appId,
            feeds = new[] { new { id = "stable", manifestRef = stable, @default = true }, new { id = betaId, manifestRef = beta, @default = false } },
        });
        publisher.Documents[feedsUrl] = FeedDocument(stableRef, betaRef);
        publisher.Documents[stableRef] = Fixture(appId, "1.0.0", "[]", "[]");
        publisher.Documents[betaRef] = Fixture(appId, "2.0.0", "[]", "[]");
        await using var harness = await CoreHttpHarness.StartAsync(configure: services =>
        {
            services.AddSingleton(new AppManifestService(new HttpClient(publisher, disposeHandler: false)));
            services.AddSingleton(new AppFeedService(new HttpClient(publisher, disposeHandler: false)));
        });
        var session = await SeedAdmin(harness);
        using var api = harness.CreateClient();
        api.DefaultRequestHeaders.Authorization = new("Bearer", session);
        using var prepared = await api.PostAsJsonAsync("/api/installations", new { feedsUrl, feedId });
        prepared.EnsureSuccessStatusCode();
        var draft = await prepared.Content.ReadFromJsonAsync<JsonElement>();
        var id = draft.GetProperty("id").GetString()!;
        Assert.Equal(version, draft.GetProperty("plan").GetProperty("targetVersion").GetString());
        using var submitted = await api.PostAsJsonAsync($"/api/installations/{id}/submit", new { });
        submitted.EnsureSuccessStatusCode();
        var entry = harness.Services.GetRequiredService<InstallationApprovalStore>().Get(id);
        var selectedRef = feedId == "stable" ? stableRef : betaRef;
        var otherRef = feedId == "stable" ? betaRef : stableRef;
        Assert.Equal(feedsUrl, entry.FeedsUrl);
        Assert.Equal(feedId, entry.FeedId);
        Assert.Equal(selectedRef, entry.InstallPlan!.ManifestPath);
        var requestsBeforeReview = publisher.Requests.Count;
        using var browser = Browser(harness, session);
        var html = await browser.GetStringAsync($"/install/confirm/{id}");
        void AssertFrozenSource(string page)
        {
            Assert.Contains("<p class=source>Feed: " + WebUtility.HtmlEncode(feedsUrl) + "</p>", page);
            Assert.Contains("<p class=source>Selected feed: " + WebUtility.HtmlEncode(feedId) + "</p>", page);
            Assert.Contains("<p class=source>Manifest: " + WebUtility.HtmlEncode(selectedRef) + "</p>", page);
            Assert.DoesNotContain(WebUtility.HtmlEncode(otherRef), page);
            Assert.DoesNotContain(movedRef, page);
            Assert.DoesNotContain("name=feed", page);
            Assert.DoesNotContain("name=\"feed", page);
            Assert.DoesNotContain("<img src=x", page);
            Assert.Contains("name=runtime", page);
            Assert.Contains("name=autostart", page);
        }
        AssertFrozenSource(html);
        publisher.Documents[feedsUrl] = FeedDocument(movedRef, movedRef);
        publisher.Documents[selectedRef] = Fixture(appId, "9.0.0", "[\"apps.install\"]", "[]");
        publisher.Documents[movedRef] = Fixture(appId, "9.0.0", "[]", "[]");
        using var selection = await Decide(browser, id, Nonce(html), "runtime", "second", false);
        selection.EnsureSuccessStatusCode();
        AssertFrozenSource(await selection.Content.ReadAsStringAsync());
        Assert.Equal(requestsBeforeReview, publisher.Requests.Count);
        Assert.Equal(feedId, entry.FeedId);
        Assert.Equal(selectedRef, entry.InstallPlan.ManifestPath);
        Assert.Equal(version, entry.InstallPlan.TargetVersion);
        Assert.Equal("second", entry.InstallPlan.TargetRuntime);
        Assert.Empty(Assert.IsAssignableFrom<IReadOnlyList<string>>(entry.InstallPlan.CorePermissions));
        Assert.Null(await harness.Services.GetRequiredService<AppRegistryStore>().GetAppAsync(appId));
    }

    [Theory]
    [InlineData(null, null, true)]
    [InlineData(false, null, false)]
    [InlineData(true, null, true)]
    [InlineData(false, true, true)]
    [InlineData(true, false, false)]
    [InlineData(null, false, false)]
    public async Task DefaultsSubmissionPreservesEffectiveAutostartThroughPlanConfirmationAndApply(
        bool? retainedAutostart, bool? submittedAutostart, bool expectedAutostart)
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var session = await SeedAdmin(harness);
        var paths = harness.Services.GetRequiredService<CoreDataPaths>();
        var apps = harness.Services.GetRequiredService<AppRegistryStore>();
        var lifecycle = harness.Services.GetRequiredService<CoreLifecycleService>();
        const string appId = "example.autostart-defaults";
        var manifestPath = Path.Combine(paths.DataRoot, "autostart-defaults.json");
        // Incomplete configuration makes preference persistence independent of a real process launch.
        await File.WriteAllTextAsync(manifestPath, Fixture(appId, "1.0.0", "[]",
            """[{"key":"APP_TOKEN","type":"string","required":true}]"""));
        if (retainedAutostart is { } retained)
        {
            await lifecycle.InstallAsync(new(manifestPath, Autostart: retained));
            await lifecycle.RemoveAsync(appId, new(DeleteData: false, DeleteSource: false));
            Assert.Null(await apps.GetAppAsync(appId));
        }
        using var api = harness.CreateClient();
        api.DefaultRequestHeaders.Authorization = new("Bearer", session);
        using var prepared = await api.PostAsJsonAsync("/api/installations", new { manifestPath });
        prepared.EnsureSuccessStatusCode();
        var draft = await prepared.Content.ReadFromJsonAsync<JsonElement>();
        var id = draft.GetProperty("id").GetString()!;
        Assert.Equal(retainedAutostart ?? true, draft.GetProperty("plan").GetProperty("defaultAutostart").GetBoolean());
        object submit = submittedAutostart is { } selected ? new { autostart = selected } : new { };
        // This exercises the SDK default flow's actual empty JSON body through Core's source-generated model.
        using var submitted = await api.PostAsJsonAsync($"/api/installations/{id}/submit", submit);
        submitted.EnsureSuccessStatusCode();
        var store = harness.Services.GetRequiredService<InstallationApprovalStore>();
        Assert.Equal(expectedAutostart, store.Get(id).Autostart);
        using var browser = Browser(harness, session);
        var html = await browser.GetStringAsync($"/install/confirm/{id}");
        Assert.Equal(expectedAutostart, html.Contains("name=autostart value=true checked", StringComparison.Ordinal));
        var runtime = "first";
        if (retainedAutostart == false && submittedAutostart is null)
        {
            // A runtime change renews the review, not the retained automatic-start preference.
            runtime = "second";
            using var changed = await Decide(browser, id, Nonce(html), "runtime", runtime, expectedAutostart);
            changed.EnsureSuccessStatusCode();
            html = await changed.Content.ReadAsStringAsync();
            Assert.Equal("pending", store.Get(id).Status);
            Assert.False(store.Get(id).Autostart);
            Assert.False(store.Get(id).InstallPlan!.DefaultAutostart);
            Assert.DoesNotContain("name=autostart value=true checked", html);
        }
        using var accepted = await Decide(browser, id, Nonce(html), "approve", runtime, expectedAutostart);
        accepted.EnsureSuccessStatusCode();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (store.Get(id).Status == "executing") await Task.Delay(10, timeout.Token);
        Assert.Equal("succeeded", store.Get(id).Status);
        var installed = (await apps.GetAppAsync(appId))!;
        Assert.Equal(expectedAutostart, installed.Autostart);
        Assert.Equal(runtime, installed.SelectedRuntime);
        Assert.Equal("stopped", installed.RuntimeState);
        Assert.True(Assert.Single(await lifecycle.ListAppsAsync()).ConfigurationReadiness!.Required);
    }

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

    private sealed class FeedReviewDocuments : HttpMessageHandler
    {
        internal Dictionary<string, string> Documents { get; } = new(StringComparer.Ordinal);
        internal List<string> Requests { get; } = [];
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var url = request.RequestUri!.AbsoluteUri;
            Requests.Add(url);
            return Task.FromResult(Documents.TryGetValue(url, out var document)
                ? new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(document, Encoding.UTF8, "application/json") }
                : new HttpResponseMessage(HttpStatusCode.NotFound));
        }
    }
}
