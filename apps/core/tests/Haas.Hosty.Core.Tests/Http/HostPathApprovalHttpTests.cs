using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class HostPathApprovalHttpTests
{
    private static async Task<(AppRecord App, string Source)> Target(CoreHttpHarness host)
    {
        var paths = host.Services.GetRequiredService<CoreDataPaths>();
        var source = Directory.CreateDirectory(Path.Combine(paths.DataRoot, "operator-source")).FullName;
        var manifest = Path.Combine(source, "manifest.json");
        await File.WriteAllTextAsync(manifest, """
            {"schemaVersion":"app.0.1","id":"example.target","name":"Target","version":"1.0.0",
             "runtimeProfiles":[{"key":"dev","type":"localCommand","default":true,"development":true}],"defaultRuntime":"dev",
             "services":[{"key":"app","runtimes":{"dev":{"type":"localCommand","command":"echo reviewed-command","workingDirectory":"."}}}]}
            """);
        var now = DateTimeOffset.UtcNow;
        var app = new AppRecord("example.target", "Target", null, "1.0.0", "runtime", false, manifest, null, null, "dev",
            "installed", "stopped", null, null, [], new Dictionary<string, AppSettingValue>(), [], [], [], now, now,
            SourceState: new("git", "https://github.com/example/target", null, null, null, null, now),
            MountSlots: [new("files", "rw", false, false, "app")], RuntimeProfiles: [new("dev", "localCommand", true, true)]);
        await host.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(app);
        return (app, source);
    }

    private static async Task<InstallationApproval> Prepare(CoreHttpHarness host, HttpClient client, object change)
    {
        using var response = await client.PostAsJsonAsync("/api/installations", new { hostPathChange = change });
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        var id = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        (await client.PostAsJsonAsync($"/api/installations/{id}/submit", new { })).EnsureSuccessStatusCode();
        return host.Services.GetRequiredService<InstallationApprovalStore>().Get(id);
    }

    private static async Task Decide(CoreHttpHarness host, InstallationApproval entry, bool approve)
    {
        var store = host.Services.GetRequiredService<InstallationApprovalStore>();
        store.Decide(entry, store.IssueNonce(entry, "operator"), "operator", approve);
        if (approve) await host.Services.GetRequiredService<InstallationApprovalService>().ExecuteAsync(entry, default);
    }

    [Fact]
    public async Task AppOverride_RequiresCoreReview_AndApprovesWithLifecycleOnly()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await AppManagementHttpTests.CreateAppClient(host, "example.shell", [CoreAppPermissions.AppLifecycle]);
        var (target, source) = await Target(host);
        var response = await client.PostAsJsonAsync($"/api/apps/{target.Id}/source/override", new { path = source });
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Contains("source_override_confirmation_required", await response.Content.ReadAsStringAsync());
        var entry = await Prepare(host, client, new { kind = "source-override", appId = target.Id, source = new { path = source } });
        var html = InstallationApprovalEndpoints.Render(entry, "nonce");
        Assert.Contains("echo reviewed-command", html);
        Assert.Contains("future changes", html);
        Assert.DoesNotContain("fingerprint", CoreJson.Text(host.Services.GetRequiredService<InstallationApprovalStore>().View(entry, "http://core.test")), StringComparison.OrdinalIgnoreCase);
        await Decide(host, entry, true);
        Assert.True(entry.Status == "succeeded", entry.Error);
        Assert.Equal(MountPathPolicy.ResolveRealPath(source), (await host.Services.GetRequiredService<AppRegistryStore>().GetAppAsync(target.Id))!.SourceState!.LocalOverridePath);
    }

    [Fact]
    public async Task AppSourceOverride_AlwaysRequiresReview_AndClearRemainsDirect()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await AppManagementHttpTests.CreateAppClient(host, "example.shell", [CoreAppPermissions.AppLifecycle]);
        var (target, source) = await Target(host);
        foreach (var args in new[] {
            new[] { "init", "-b", "main" }, new[] { "add", "manifest.json" },
            new[] { "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "Initial source" },
        })
        {
            var start = new ProcessStartInfo("git") { WorkingDirectory = source };
            foreach (var arg in args) start.ArgumentList.Add(arg);
            var result = await ProcessRunner.RunAsync(start, TimeSpan.FromSeconds(20));
            Assert.True(result.ExitCode == 0, result.StandardError);
        }
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        await apps.UpdateAppAsync(target.Id, a => a with { SourceState = a.SourceState! with { Repository = source } });
        var caller = (await apps.GetAppAsync("example.shell"))!;
        var workspace = await host.Services.GetRequiredService<DevelopmentWorkspaceService>().PrepareAsync(
            new(caller.Id, caller.InstalledAt, "actor", "review-test"),
            new(Guid.NewGuid().ToString(), "review-test", target.Id, "/assistant", "main"), default);
        var workspacePath = workspace.Path;
        // The HTTP boundary is unconditional: directory kind, existence and client claims cannot
        // select an automatic path. No target mutation happens before a Core decision.
        foreach (var path in new[] { source, workspacePath, source + "-missing" })
        {
            using var response = await client.PostAsJsonAsync($"/api/apps/{target.Id}/source/override", new { path });
            Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
            Assert.Contains("source_override_confirmation_required", await response.Content.ReadAsStringAsync());
            Assert.Null((await host.Services.GetRequiredService<AppRegistryStore>().GetAppAsync(target.Id))!.SourceState!.LocalOverridePath);
        }
        var review = await Prepare(host, client, new { kind = "source-override", appId = target.Id, source = new { path = workspacePath } });
        await Decide(host, review, true);
        Assert.True(review.Status == "succeeded", review.Error);
        Assert.Equal(MountPathPolicy.ResolveRealPath(workspacePath), (await apps.GetAppAsync(target.Id))!.SourceState!.LocalOverridePath);
        (await client.DeleteAsync($"/api/apps/{target.Id}/source/override")).EnsureSuccessStatusCode();
        Assert.Null((await host.Services.GetRequiredService<AppRegistryStore>().GetAppAsync(target.Id))!.SourceState!.LocalOverridePath);
    }

    [Theory]
    [InlineData("manifest")]
    [InlineData("installation")]
    [InlineData("symlink")]
    [InlineData("revoked")]
    public async Task SourceReview_RejectsChangedAuthority(string change)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await AppManagementHttpTests.CreateAppClient(host, "example.shell", [CoreAppPermissions.AppLifecycle]);
        var (target, source) = await Target(host);
        var path = source;
        if (change == "symlink") { path = source + "-link"; Directory.CreateSymbolicLink(path, source); }
        var entry = await Prepare(host, client, new { kind = "source-override", appId = target.Id, source = new { path } });
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        if (change == "manifest") await File.AppendAllTextAsync(Path.Combine(source, "manifest.json"), "\n");
        if (change == "installation") await apps.UpdateAppAsync(target.Id, a => a with { InstalledAt = a.InstalledAt.AddSeconds(1) });
        if (change == "revoked") await apps.UpdateAppAsync("example.shell", a => a with { GrantedCorePermissions = [] });
        if (change == "symlink")
        {
            var other = Directory.CreateDirectory(source + "-other").FullName;
            File.Copy(Path.Combine(source, "manifest.json"), Path.Combine(other, "manifest.json"));
            Directory.Delete(path); Directory.CreateSymbolicLink(path, other);
        }
        await Decide(host, entry, true);
        Assert.Equal("failed", entry.Status);
        Assert.Null((await apps.GetAppAsync(target.Id))!.SourceState!.LocalOverridePath);
    }

    [Fact]
    public async Task DeniedSourceReview_AndProtectedPaths_DoNotChangeSource()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await AppManagementHttpTests.CreateAppClient(host, "example.shell", [CoreAppPermissions.AppLifecycle]);
        var (target, source) = await Target(host);
        var entry = await Prepare(host, client, new { kind = "source-override", appId = target.Id, source = new { path = source } });
        await Decide(host, entry, false);
        Assert.Equal("denied", entry.Status);
        var paths = host.Services.GetRequiredService<CoreDataPaths>();
        var storage = Directory.CreateDirectory(Path.Combine(paths.AppsRoot, "example.shell", "data")).FullName;
        var link = Path.Combine(paths.DataRoot, "storage-link"); Directory.CreateSymbolicLink(link, storage);
        foreach (var path in new[] { storage, link })
        {
            using var denied = await client.PostAsJsonAsync($"/api/apps/{target.Id}/source/override", new { path });
            Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
            Assert.Contains("source_override_confirmation_required", await denied.Content.ReadAsStringAsync());
            using var review = await client.PostAsJsonAsync("/api/installations", new {
                hostPathChange = new { kind = "source-override", appId = target.Id, source = new { path } },
            });
            Assert.False(review.IsSuccessStatusCode);
            Assert.Contains("source_override_path_forbidden", await review.Content.ReadAsStringAsync());
            var error = await Assert.ThrowsAsync<AppLifecycleException>(() => host.Services.GetRequiredService<AppSourceService>().SetLocalOverrideAsync(target.Id, new(path)));
            Assert.Equal("source_override_path_forbidden", error.Code);
        }
        Assert.Null((await host.Services.GetRequiredService<AppRegistryStore>().GetAppAsync(target.Id))!.SourceState!.LocalOverridePath);
    }

    [Fact]
    public async Task AppMounts_AndSharedRegistry_RequireReview_ButRegisteredBindingsDoNot()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await AppManagementHttpTests.CreateAppClient(host, "example.shell", [CoreAppPermissions.ConfigureApps, CoreAppPermissions.ConfigureCore]);
        var (target, _) = await Target(host);
        var outside = Path.Combine(Path.GetTempPath(), "hosty-shared-" + Guid.NewGuid().ToString("N"));
        var input = new { name = "shared", hostPath = outside, mode = "rw" };
        using var direct = await client.PostAsJsonAsync("/api/global-mounts", input);
        Assert.Equal(HttpStatusCode.Forbidden, direct.StatusCode);
        var entry = await Prepare(host, client, new { kind = "global-mount", globalMount = input });
        await Decide(host, entry, true);
        Assert.True(entry.Status == "succeeded", entry.Error);
        (await client.PostAsJsonAsync($"/api/apps/{target.Id}/mounts", new { mounts = new[] { new { key = "files", globalMountName = "shared" } } })).EnsureSuccessStatusCode();
        var mounts = new { mounts = new[] { new { key = "files", label = "private", hostPath = outside + "-inline" } } };
        using var inline = await client.PostAsJsonAsync($"/api/apps/{target.Id}/mounts", mounts);
        Assert.Equal(HttpStatusCode.Forbidden, inline.StatusCode);
        entry = await Prepare(host, client, new { kind = "app-mounts", appId = target.Id, mounts });
        await Decide(host, entry, true);
        Assert.True(entry.Status == "succeeded", entry.Error);
        Assert.Equal(outside + "-inline", Assert.Single((await host.Services.GetRequiredService<AppRegistryStore>().GetAppAsync(target.Id))!.Mounts!).HostPath);
    }
    private sealed class ReviewClock : IClock { public DateTimeOffset UtcNow { get; set; } = DateTimeOffset.UtcNow; }

    [Fact]
    public async Task SourceReview_ExpiryAndReplayCannotApplySource()
    {
        var clock = new ReviewClock();
        await using var host = await CoreHttpHarness.StartAsync(clock);
        using var client = await AppManagementHttpTests.CreateAppClient(host, "example.shell", [CoreAppPermissions.AppLifecycle]);
        var (target, source) = await Target(host);
        var entry = await Prepare(host, client, new { kind = "source-override", appId = target.Id, source = new { path = source } });
        var store = host.Services.GetRequiredService<InstallationApprovalStore>();
        var nonce = store.IssueNonce(entry, "operator");
        clock.UtcNow = clock.UtcNow.AddMinutes(16);
        Assert.Equal("approval_expired", Assert.Throws<AppLifecycleException>(() => store.Decide(entry, nonce, "operator", true)).Code);
        Assert.Null((await host.Services.GetRequiredService<AppRegistryStore>().GetAppAsync(target.Id))!.SourceState!.LocalOverridePath);
        // A consumed denial nonce cannot be replayed as approval on a still-live request.
        clock.UtcNow = clock.UtcNow.AddMinutes(-16);
        store.Decide(entry, nonce, "operator", false);
        Assert.Equal("approval_invalid", Assert.Throws<AppLifecycleException>(() => store.Decide(entry, nonce, "operator", true)).Code);
        Assert.Null((await host.Services.GetRequiredService<AppRegistryStore>().GetAppAsync(target.Id))!.SourceState!.LocalOverridePath);
    }

}
