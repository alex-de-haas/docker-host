using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Haas.Hosty.Core;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class PrivateSourceTests
{
    private const string Url = "https://raw.githubusercontent.com/team/private/main/manifest.json";
    private const string Repository = "https://github.com/team/private.git";
    private const string Manifest = """
        {"schemaVersion":"app.0.1","id":"example.private","name":"Private fixture","version":"1.0.0",
        "source":{"repository":"https://github.com/team/private.git","branch":"main"},
        "runtimeProfiles":[{"key":"dev","type":"localCommand","default":true}],"defaultRuntime":"dev",
        "services":[{"key":"app","runtimes":{"dev":{"type":"localCommand","command":"echo unused","workingDirectory":"."}}}]}
        """;

    [Theory]
    [InlineData("https://raw.githubusercontent.com/Team/Private/main/apps/test/manifest.json", "https://api.github.com/repos/team/private/contents/apps/test/manifest.json?ref=main")]
    [InlineData("https://github.com/team/private/blob/v1/manifest.json", "https://api.github.com/repos/team/private/contents/manifest.json?ref=v1")]
    [InlineData("https://dev.azure.com/acme/Project/_git/Repo?path=/app/manifest.json&version=GBfeature%2Ftest", "https://dev.azure.com/acme/Project/_apis/git/repositories/Repo/items?path=%2Fapp%2Fmanifest.json&versionDescriptor.version=feature%2Ftest&versionDescriptor.versionType=branch&download=true&api-version=7.1")]
    public void ProviderFileUrlsMapToFixedApis(string input, string expected)
        => Assert.Equal(expected, PrivateSourceService.ParseManifest(input).ApiUrl);

    [Theory]
    [InlineData("http://raw.githubusercontent.com/team/private/main/manifest.json")]
    [InlineData("https://token@raw.githubusercontent.com/team/private/main/manifest.json")]
    [InlineData("https://github.com.evil.test/team/private/blob/main/manifest.json")]
    [InlineData("https://github.com/team/private/releases/download/v1/manifest.json")]
    [InlineData("https://dev.azure.com/acme/Project/_git/Repo?path=/manifest.json")]
    [InlineData("https://dev.azure.com/acme/Project/_git/Repo?path=/../secret&version=GBmain")]
    [InlineData("https://raw.githubusercontent.com/team/private/main/manifest.json?token=secret")]
    public void UntrustedOrUnsupportedFileUrlsAreRejected(string input)
        => Assert.Throws<AppLifecycleException>(() => PrivateSourceService.ParseManifest(input));

    [Fact]
    public async Task ReadsUseEachOwnersAccountAndNeverExportTokens()
    {
        using var provider = new FakeHttp();
        await using var h = await Start(provider);
        var reader = h.Services.GetRequiredService<PrivateSourceService>();
        var github = await reader.BindAsync("alice", "github-a", Url, true, default);
        var azureUrl = "https://dev.azure.com/acme/Project/_git/Repo?path=/manifest.json&version=GBmain";
        var azure = await reader.BindAsync("bob", "azure-b", azureUrl, true, default);
        Assert.Equal(Manifest, Encoding.UTF8.GetString(await reader.ReadAsync(github, Url, 1024 * 1024, default)));
        await reader.ReadAsync(azure, azureUrl, 1024 * 1024, default);
        Assert.Equal("Bearer github-secret", provider.Calls[0].Authorization);
        Assert.Equal("Basic " + Convert.ToBase64String(Encoding.UTF8.GetBytes(":azure-secret")), provider.Calls[1].Authorization);
        Assert.All(provider.Calls, call => Assert.DoesNotContain("secret", call.Url));
        Assert.DoesNotContain("secret", CoreJson.Text(new PrivateSourceAccess(github, azure)));
        await Assert.ThrowsAsync<AppLifecycleException>(() => reader.BindAsync("bob", "github-a", Url, true, default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => reader.BindAsync("bob", "azure-b", azureUrl.Replace("acme", "other"), true, default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => reader.ReadAsync(github, Url.Replace("private/", "another/"), 1024, default));
        Assert.Equal(2, provider.Calls.Count);
    }

    [Theory]
    [InlineData("disconnect")]
    [InlineData("disable")]
    [InlineData("delete")]
    public async Task GrantsSurviveLogoutButNotOwnerOrConnectionRevocation(string revoke)
    {
        using var provider = new FakeHttp(); await using var h = await Start(provider);
        var users = h.Services.GetRequiredService<UserDirectoryStore>();
        var reader = h.Services.GetRequiredService<PrivateSourceService>();
        var grant = await reader.BindAsync("alice", "github-a", Url, true, default);
        await users.UpdateAsync(s => s with { Sessions = [] });
        await reader.ReadAsync(grant, Url, 1024 * 1024, default);
        await users.UpdateAsync(s => revoke switch
        {
            "disconnect" => s with { ProviderConnections = [] },
            "delete" => s with { Users = s.Users.Where(u => u.Id != "alice").ToArray() },
            _ => s with { Users = s.Users.Select(u => u.Id == "alice" ? u with { Disabled = true } : u).ToArray() },
        });
        await Assert.ThrowsAsync<AppLifecycleException>(() => reader.ReadAsync(grant, Url, 1024 * 1024, default));
        Assert.Single(provider.Calls);
    }

    [Theory]
    [InlineData(302)]
    [InlineData(401)]
    [InlineData(403)]
    [InlineData(404)]
    [InlineData(500)]
    public async Task ProviderFailuresDoNotExposeBodiesOrFollowRedirects(int status)
    {
        using var provider = new FakeHttp { Status = (HttpStatusCode)status, Body = "github-secret provider details" };
        await using var h = await Start(provider);
        var reader = h.Services.GetRequiredService<PrivateSourceService>();
        var grant = await reader.BindAsync("alice", "github-a", Url, true, default);
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => reader.ReadAsync(grant, Url, 1024, default));
        Assert.DoesNotContain("secret", error.Message); Assert.Single(provider.Calls);
    }

    [Fact]
    public async Task SizeLimitAlsoAppliesToUnannouncedContentAndAssetsStayInsideManifestFolder()
    {
        using var provider = new FakeHttp(); await using var h = await Start(provider);
        var reader = h.Services.GetRequiredService<PrivateSourceService>();
        var grant = await reader.BindAsync("alice", "github-a", Url, true, default);
        await Assert.ThrowsAsync<AppLifecycleException>(() => reader.ReadAsync(grant, Url, 10, default));
        Assert.Null(await reader.ReadAssetAsync(grant, "../secret", 1024, default));
        Assert.Null(await reader.ReadAssetAsync(grant, "https://evil.test/icon.svg", 1024, default));
        Assert.Single(provider.Calls);
    }

    [Fact]
    public async Task ReviewedInstallPersistsExactContentAndBindingsWithoutRefetchingManifest()
    {
        using var provider = new FakeHttp(); await using var h = await Start(provider);
        var approvals = h.Services.GetRequiredService<InstallationApprovalService>();
        var entry = await approvals.PrepareAsync(new("alice", null, null, "Alice"), new(ManifestPath: Url,
            SourceConnections: new("github-a", "github-a")), default);
        Assert.Equal("github-a", entry.InstallPlan!.PrivateSources!.Git!.ConnectionId);
        provider.Body = Manifest.Replace("1.0.0", "9.0.0");
        entry.Autostart = false;
        await approvals.ExecuteAsync(entry, default);
        Assert.Null(entry.Error); Assert.Equal("succeeded", entry.Status);
        var installed = await h.Services.GetRequiredService<AppRegistryStore>().GetAppAsync("example.private");
        Assert.Equal("1.0.0", installed!.Version);
        Assert.Equal(entry.InstallPlan.PrivateSources, installed.PrivateSources);
        Assert.DoesNotContain("secret", await File.ReadAllTextAsync(installed.ManifestPath!));
        Assert.Equal(2, provider.Calls.Count); // initial source binding and frozen plan; no apply refetch
    }

    [Fact]
    public async Task RevokedInstallReviewDoesNotCreateApp()
    {
        using var provider = new FakeHttp(); await using var h = await Start(provider);
        var approvals = h.Services.GetRequiredService<InstallationApprovalService>();
        var entry = await approvals.PrepareAsync(new("alice", null, null, "Alice"), new(ManifestPath: Url, SourceConnections: new("github-a")), default);
        await h.Services.GetRequiredService<UserConnectionService>().DisconnectAsync("alice", "github-a", default);
        await approvals.ExecuteAsync(entry, default);
        Assert.Equal("failed", entry.Status);
        Assert.Null(await h.Services.GetRequiredService<AppRegistryStore>().GetAppAsync("example.private"));
    }

    [Fact]
    public async Task CrossUserAndDelegatedSelectionsAreDeniedAndOwnerSeesDurableReview()
    {
        using var provider = new FakeHttp(); await using var h = await Start(provider);
        using var client = h.CreateClient();
        client.DefaultRequestHeaders.Add("Cookie", "hosty_session=bob-browser; hosty_csrf=test");
        client.DefaultRequestHeaders.Add("X-Hosty-CSRF", "test");
        var input = new { manifestPath = Url, sourceConnections = new { manifestConnectionId = "github-a" } };
        using var denied = await client.PostAsJsonAsync("/api/installations", input);
        Assert.False(denied.IsSuccessStatusCode); Assert.Empty(provider.Calls);
        client.DefaultRequestHeaders.Remove("Cookie");
        client.DefaultRequestHeaders.Add("Cookie", "hosty_session=alice-browser; hosty_csrf=test");
        using var prepared = await client.PostAsJsonAsync("/api/installations", input);
        Assert.True(prepared.IsSuccessStatusCode, await prepared.Content.ReadAsStringAsync());
        using var body = JsonDocument.Parse(await prepared.Content.ReadAsStringAsync());
        var id = body.RootElement.GetProperty("id").GetString();
        using var submit = await client.PostAsJsonAsync($"/api/installations/{id}/submit", new { autostart = false });
        Assert.True(submit.IsSuccessStatusCode);
        using var page = await client.GetAsync($"/install/confirm/{id}");
        var html = await page.Content.ReadAsStringAsync();
        Assert.Contains("Private source access", html); Assert.Contains("after you sign out", html);
        Assert.Contains("Personal", html); Assert.DoesNotContain("github-secret", html);
        var service = h.Services.GetRequiredService<InstallationApprovalService>();
        // The caller permission check runs first; a delegated app with no grant is still denied.
        await Assert.ThrowsAsync<AppIdentityException>(() => service.PrepareAsync(new("alice", "marketplace", null, "Marketplace"),
            new(ManifestPath: Url, SourceConnections: new("github-a")), default));
    }

    [Fact]
    public async Task FailedPrivateUpdatesAndRevokedCachedPlansPreserveRunningInstallation()
    {
        using var provider = new FakeHttp { Body = Manifest.Replace("\"branch\":\"main\"", "\"commit\":\"" + new string('a', 40) + "\"") };
        await using var h = await Start(provider);
        var approvals = h.Services.GetRequiredService<InstallationApprovalService>();
        var lifecycle = h.Services.GetRequiredService<CoreLifecycleService>();
        var apps = h.Services.GetRequiredService<AppRegistryStore>();
        var entry = await approvals.PrepareAsync(new("alice", null, null, "Alice"), new(ManifestPath: Url, SourceConnections: new("github-a")), default);
        entry.Autostart = false; await approvals.ExecuteAsync(entry, default); Assert.Null(entry.Error);
        await apps.UpdateAppAsync("example.private", app => app with { RuntimeState = "running" });
        provider.Status = HttpStatusCode.Forbidden;
        await Assert.ThrowsAsync<AppLifecycleException>(() => lifecycle.CreateUpdatePlanAsync("example.private", new()));
        Assert.Equal("running", (await apps.GetAppAsync("example.private"))!.RuntimeState);
        provider.Status = HttpStatusCode.OK; provider.Body = provider.Body.Replace("1.0.0", "1.1.0");
        var plan = await lifecycle.CreateUpdatePlanAsync("example.private", new());
        await h.Services.GetRequiredService<UserConnectionService>().DisconnectAsync("alice", "github-a", default);
        await Assert.ThrowsAsync<AppLifecycleException>(() => lifecycle.ApplyUpdateAsync("example.private", new(plan.PlanDigest)));
        var preserved = await apps.GetAppAsync("example.private");
        Assert.Equal("running", preserved!.RuntimeState); Assert.Equal("1.0.0", preserved.Version);
        Assert.Contains("1.0.0", await File.ReadAllTextAsync(preserved.ManifestPath!));
    }

    [Fact]
    public async Task ChangedSourceRepositoryCannotReuseItsOldGrant()
    {
        using var provider = new FakeHttp(); await using var h = await Start(provider);
        var approvals = h.Services.GetRequiredService<InstallationApprovalService>();
        var entry = await approvals.PrepareAsync(new("alice", null, null, "Alice"), new(ManifestPath: Url,
            SourceConnections: new("github-a", "github-a")), default);
        entry.Autostart = false; await approvals.ExecuteAsync(entry, default); Assert.Null(entry.Error);
        var apps = h.Services.GetRequiredService<AppRegistryStore>();
        await apps.UpdateAppAsync("example.private", app => app with { SourceState = app.SourceState! with { Repository = "https://github.com/team/another.git" } });
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => h.Services.GetRequiredService<AppSourceService>().ResolveManagedAsync("example.private", new(Fetch: true)));
        Assert.Equal("source_access_required", error.Code);
        await Assert.ThrowsAsync<AppLifecycleException>(() => h.Services.GetRequiredService<DevelopmentWorkspaceService>().PrepareAsync(
            new("assistant", DateTimeOffset.UtcNow, "alice", "session"), new(Guid.NewGuid().ToString(), "session", "example.private", "/session"), default));
        Assert.Equal(2, provider.Calls.Count);
    }

    [Fact]
    public async Task OtherUsersCannotRebindOrCreatePrivateWorkspaces()
    {
        using var provider = new FakeHttp(); await using var h = await Start(provider);
        var approvals = h.Services.GetRequiredService<InstallationApprovalService>();
        var entry = await approvals.PrepareAsync(new("alice", null, null, "Alice"), new(ManifestPath: Url,
            SourceConnections: new("github-a", "github-a")), default);
        entry.Autostart = false; await approvals.ExecuteAsync(entry, default); Assert.Null(entry.Error);
        await Assert.ThrowsAsync<AppLifecycleException>(() => approvals.PrepareAsync(new("bob", null, null, "Bob"),
            new(UpdateAppId: "example.private", SourceConnections: new("azure-b")), default));
        var workspaces = h.Services.GetRequiredService<DevelopmentWorkspaceService>();
        await Assert.ThrowsAsync<AppLifecycleException>(() => workspaces.PrepareAsync(new("assistant", DateTimeOffset.UtcNow, "bob", "session"),
            new(Guid.NewGuid().ToString(), "session", "example.private", "/sessions/session"), default));
        using var client = h.CreateClient(); client.DefaultRequestHeaders.Add("Cookie", "hosty_session=bob-browser");
        using var response = await client.GetAsync("/api/apps/example.private/source-access");
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    [Fact]
    public async Task GitAuthenticationIsTransientUrlScopedAndDisablesHelpersAndRedirects()
    {
        var directory = Path.Combine(Path.GetTempPath(), "hosty-private-git-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var init = AppSourceService.CreateGitStartInfo(directory, ["init"]);
            Assert.Equal(0, (await ProcessRunner.RunAsync(init, TimeSpan.FromSeconds(10))).ExitCode);
            var start = AppSourceService.CreateGitStartInfo(directory, ["config", "--get-urlmatch", "http.extraHeader", Repository]);
            start.Environment["GIT_TRACE_CURL"] = "1";
            PrivateSourceService.ConfigureGit(start, Repository, "Bearer synthetic-secret");
            Assert.DoesNotContain("synthetic-secret", string.Join(' ', start.ArgumentList));
            Assert.False(start.Environment.ContainsKey("GIT_TRACE_CURL"));
            var result = await ProcessRunner.RunAsync(start, TimeSpan.FromSeconds(10));
            Assert.Equal(0, result.ExitCode); Assert.Contains("Authorization: Bearer synthetic-secret", result.StandardOutput);
            start.ArgumentList.Clear();
            foreach (var arg in new[] { "config", "--get-urlmatch", "http.extraHeader", "https://github.com/team/other.git" }) start.ArgumentList.Add(arg);
            var other = await ProcessRunner.RunAsync(start, TimeSpan.FromSeconds(10));
            Assert.DoesNotContain("synthetic-secret", other.StandardOutput);
            Assert.DoesNotContain("synthetic-secret", await File.ReadAllTextAsync(Path.Combine(directory, ".git", "config")));
        }
        finally { Directory.Delete(directory, true); }
    }

    [Theory]
    [InlineData("credential.https://github.com.helper", "!echo should-not-run")]
    [InlineData("url.https://evil.test/.insteadOf", "https://github.com/")]
    [InlineData("include.path", "untrusted-config")]
    [InlineData("http.extraHeader", "unsafe-header")]
    [InlineData("extensions.worktreeConfig", "true")]
    public async Task PrivateReadsRejectLocalTransportOverridesWithoutChangingTheCheckout(string key, string value)
    {
        var root = Path.Combine(Path.GetTempPath(), "hosty-private-config-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            Assert.Equal(0, (await ProcessRunner.RunAsync(AppSourceService.CreateGitStartInfo(root, ["init"]))).ExitCode);
            await PrivateSourceService.ValidateGitConfigAsync(root, Repository, default);
            Assert.Equal(0, (await ProcessRunner.RunAsync(AppSourceService.CreateGitStartInfo(root, ["config", "--local", key, value]))).ExitCode);
            var before = await File.ReadAllTextAsync(Path.Combine(root, ".git", "config"));
            await Assert.ThrowsAsync<AppLifecycleException>(() => PrivateSourceService.ValidateGitConfigAsync(root, Repository, default));
            Assert.Equal(before, await File.ReadAllTextAsync(Path.Combine(root, ".git", "config")));
        }
        finally { Directory.Delete(root, true); }
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task PrepareUpdate_ClearGrants_RequiresOwnerReviewAndPersistsPublicAccess(bool clearManifest, bool clearGit)
    {
        using var provider = new FakeHttp();
        await using var h = await Start(provider);
        var checkout = Path.Combine(h.Services.GetRequiredService<CoreDataPaths>().DataRoot, "fixture-checkout");
        Directory.CreateDirectory(checkout);
        Assert.Equal(0, (await ProcessRunner.RunAsync(AppSourceService.CreateGitStartInfo(checkout, ["init"]))).ExitCode);
        Assert.Equal(0, (await ProcessRunner.RunAsync(AppSourceService.CreateGitStartInfo(checkout,
            ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Fixture"])) ).ExitCode);
        var commit = (await ProcessRunner.RunAsync(AppSourceService.CreateGitStartInfo(checkout, ["rev-parse", "HEAD"]))).StandardOutput.Trim();
        provider.Body = Manifest.Replace("\"branch\":\"main\"", "\"commit\":\"" + commit + "\"");
        var approvals = h.Services.GetRequiredService<InstallationApprovalService>();
        var apps = h.Services.GetRequiredService<AppRegistryStore>();
        var entry = await approvals.PrepareAsync(new("alice", null, null, "Alice"), new(ManifestPath: Url,
            SourceConnections: new("github-a", "github-a")), default);
        entry.Autostart = false;
        await approvals.ExecuteAsync(entry, default);
        Assert.Null(entry.Error);
        await apps.UpdateAppAsync("example.private", app => app with { SourceState = app.SourceState! with { ManagedCheckoutPath = checkout } });
        var original = (await apps.GetAppAsync("example.private"))!.PrivateSources;
        var choice = new PrivateSourceChoice(ClearManifestConnection: clearManifest, ClearGitConnection: clearGit);
        await Assert.ThrowsAsync<AppLifecycleException>(() => approvals.PrepareAsync(new("bob", null, null, "Bob"),
            new(UpdateAppId: "example.private", SourceConnections: choice), default));
        if (clearManifest && clearGit)
            await h.Services.GetRequiredService<UserConnectionService>().DisconnectAsync("alice", "github-a", default);
        provider.Calls.Clear();
        var review = await approvals.PrepareAsync(new("alice", null, null, "Alice"),
            new(UpdateAppId: "example.private", SourceConnections: choice), default);
        Assert.Contains(review.UpdatePlan!.Changes, change => change.StartsWith("source-access:"));
        Assert.Equal(original, (await apps.GetAppAsync("example.private"))!.PrivateSources);
        Assert.All(provider.Calls, call => Assert.Equal(clearManifest ? null : "Bearer github-secret", call.Authorization));
        using var client = h.CreateClient();
        client.DefaultRequestHeaders.Add("Cookie", "hosty_session=alice-browser; hosty_csrf=test");
        client.DefaultRequestHeaders.Add("X-Hosty-CSRF", "test");
        using var submit = await client.PostAsJsonAsync($"/api/installations/{review.Id}/submit", new { autostart = false });
        Assert.True(submit.IsSuccessStatusCode);
        var html = await client.GetStringAsync($"/install/confirm/{review.Id}");
        if (clearManifest) Assert.Contains("Manifest: no personal connection", html);
        if (clearGit) Assert.Contains("Git source: no personal connection", html);
        await approvals.ExecuteAsync(review, default);
        Assert.Null(review.Error);
        var updated = (await apps.GetAppAsync("example.private"))!.PrivateSources!;
        Assert.Equal(clearManifest ? null : original!.Manifest, updated.Manifest);
        Assert.Equal(clearGit ? null : original!.Git, updated.Git);
        // A subsequent update keeps the reviewed public state rather than reviving old grants.
        var next = await approvals.PrepareAsync(new("alice", null, null, "Alice"), new(UpdateAppId: "example.private"), default);
        Assert.Equal(updated, next.UpdatePlan!.PrivateSources);
    }

    [Fact]
    public async Task PrepareUpdate_ConflictingClearAndSelection_IsRejectedBeforeProviderRead()
    {
        using var provider = new FakeHttp(); await using var h = await Start(provider);
        await Assert.ThrowsAsync<AppLifecycleException>(() => h.Services.GetRequiredService<InstallationApprovalService>()
            .PrepareAsync(new("alice", null, null, "Alice"), new(ManifestPath: Url,
                SourceConnections: new("github-a", ClearManifestConnection: true)), default));
        Assert.Empty(provider.Calls);
    }

    [Fact]
    public async Task SourceAccess_LocalManifest_HidesHostPathAndSupportsGitRebinding()
    {
        using var provider = new FakeHttp(); await using var h = await Start(provider);
        var directory = Path.Combine(Path.GetTempPath(), "hosty-local-private-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var path = Path.Combine(directory, "manifest.json");
            await File.WriteAllTextAsync(path, Manifest.Replace("\"branch\":\"main\"", "\"commit\":\"" + new string('a', 40) + "\""));
            var approvals = h.Services.GetRequiredService<InstallationApprovalService>();
            var install = await approvals.PrepareAsync(new("alice", null, null, "Alice"), new(ManifestPath: path), default);
            install.Autostart = false; await approvals.ExecuteAsync(install, default); Assert.Null(install.Error);
            using var client = h.CreateClient(); client.DefaultRequestHeaders.Add("Cookie", "hosty_session=alice-browser");
            var json = await client.GetStringAsync("/api/apps/example.private/source-access");
            Assert.DoesNotContain(directory, json);
            using var response = JsonDocument.Parse(json);
            Assert.False(response.RootElement.TryGetProperty("manifestUrl", out var url) && url.ValueKind == JsonValueKind.String);
            Assert.True(response.RootElement.GetProperty("hasGitSource").GetBoolean());
            var review = await approvals.PrepareAsync(new("alice", null, null, "Alice"),
                new(UpdateAppId: "example.private", SourceConnections: new(GitConnectionId: "github-a")), default);
            Assert.Null(review.UpdatePlan!.PrivateSources!.Manifest);
            Assert.Equal("github-a", review.UpdatePlan.PrivateSources.Git!.ConnectionId);
            Assert.Empty(provider.Calls);
        }
        finally { Directory.Delete(directory, true); }
    }

    private static async Task<CoreHttpHarness> Start(FakeHttp handler)
    {
        var h = await CoreHttpHarness.StartAsync(configure: services =>
        {
            services.AddSingleton(sp => new PrivateSourceService(sp.GetRequiredService<UserConnectionService>(), new HttpClient(handler)));
            services.AddSingleton(sp => new AppManifestService(new HttpClient(handler), sp.GetRequiredService<PrivateSourceService>()));
        });
        var now = DateTimeOffset.UtcNow;
        var users = h.Services.GetRequiredService<UserDirectoryStore>();
        await users.WriteAsync(new UserDirectoryState(1,
            [new("alice", "alice@example.test", "Alice", "host.admin", false, now, now), new("bob", "bob@example.test", "Bob", "host.admin", false, now, now)], [], [],
            [new("alice-browser", "alice", now, now.AddHours(1), null, now, BrowserOrigin: "http://localhost"),
             new("bob-browser", "bob", now, now.AddHours(1), null, now, BrowserOrigin: "http://localhost")],
            ProviderConnections: [
                new("github-a", "alice", "Personal", "github", "", "", "42", "alice-github", "pat", "github-secret", null, null, null, now, now, "connected", "1"),
                new("azure-b", "bob", "Work", "azure-devops", "acme", "", "43", "bob-azure", "pat", "azure-secret", null, null, null, now, now, "connected", "1")]));
        return h;
    }

    private sealed class FakeHttp : HttpMessageHandler
    {
        public string Body { get; set; } = Manifest;
        public HttpStatusCode Status { get; set; } = HttpStatusCode.OK;
        public List<(string Url, string? Authorization)> Calls { get; } = [];
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Calls.Add((request.RequestUri!.AbsoluteUri, request.Headers.Authorization?.ToString()));
            var response = new HttpResponseMessage(Status) { Content = new StreamContent(new MemoryStream(Encoding.UTF8.GetBytes(Body))) };
            if (Status == HttpStatusCode.Redirect) response.Headers.Location = new("https://evil.test/steal");
            return Task.FromResult(response);
        }
    }
}
