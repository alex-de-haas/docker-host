using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class WorkspaceManifestApprovalHttpTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task WorkspaceAccessReviewRequiresSourceAndLifecycleWithoutPackageInstallAuthority(bool approve)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var caller = await AppManagementHttpTests.CreateAppClient(host, "example.shell",
            [CoreAppPermissions.Sources, CoreAppPermissions.AppLifecycle]);
        var paths = host.Services.GetRequiredService<CoreDataPaths>();
        var source = Directory.CreateDirectory(Path.Combine(paths.DataRoot, "workspace-candidate")).FullName;
        var installed = Path.Combine(paths.DataRoot, "installed-manifest.json");
        var json = """
            {"schemaVersion":"app.0.1","id":"example.target","name":"Target","version":"1.0.0",
             "runtimeProfiles":[{"key":"dev","type":"localCommand","default":true,"development":true}],"defaultRuntime":"dev",
             "services":[{"key":"app","runtimes":{"dev":{"type":"localCommand","command":"echo reviewed","workingDirectory":"."}}}]}
            """;
        await File.WriteAllTextAsync(installed, json);
        var modified = JsonNode.Parse(json)!.AsObject();
        modified["version"] = "1.0.1";
        modified["corePermissions"] = new JsonArray("apps.read");
        await File.WriteAllTextAsync(Path.Combine(source, "manifest.json"), modified.ToJsonString());
        var now = DateTimeOffset.UtcNow;
        var app = new AppRecord("example.target", "Target", null, "1.0.0", "runtime", false, installed, installed, null,
            "dev", "installed", "stopped", null, null, [], new Dictionary<string, AppSettingValue>(), [], [], [], now, now,
            SourceState: new("git", "https://github.com/example/target", null, null, null, null, now),
            RuntimeProfiles: [new("dev", "localCommand", true, true)], GrantedCorePermissions: [],
            RequiredCorePermissions: [], OptionalCorePermissions: [], PermissionRevision: "initial");
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        await apps.UpsertAppAsync(app);
        var lifecycle = host.Services.GetRequiredService<CoreLifecycleService>();
        var candidate = await lifecycle.PrepareExecutionCandidateAsync(app, source, "dev", new("actor", "app:example.shell"), default);
        var request = new InstallationPrepare(WorkspaceManifest: candidate.Review);
        using var response = await caller.PostAsJsonAsync("/api/installations", request);
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
        var id = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        (await caller.PostAsJsonAsync($"/api/installations/{id}/submit", new { })).EnsureSuccessStatusCode();
        var store = host.Services.GetRequiredService<InstallationApprovalStore>();
        var entry = store.Get(id);
        Assert.Equal(CoreAppPermissions.AppLifecycle, entry.Permission);
        var html = InstallationApprovalEndpoints.Render(entry, "unused");
        Assert.Contains("Approve workspace access", html);
        Assert.Contains("apps.read", html);
        Assert.DoesNotContain("Confirm app update", html);
        store.Decide(entry, store.IssueNonce(entry, "operator"), "operator", approve);
        if (approve)
        {
            await host.Services.GetRequiredService<InstallationApprovalService>().ExecuteAsync(entry, default);
            Assert.True(entry.Status == "succeeded", entry.Error);
            await lifecycle.EnsureExecutionCandidateApprovedAsync(candidate, app, default);
        }
        else
        {
            Assert.Equal("denied", entry.Status);
            Assert.Equal("dev_review_required", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
                lifecycle.EnsureExecutionCandidateApprovedAsync(candidate, app, default))).Code);
        }
        Assert.Empty((await apps.GetAppAsync(app.Id))!.GrantedCorePermissions!);
        Assert.Equal(json, await File.ReadAllTextAsync(installed));
        Assert.DoesNotContain(CoreAppPermissions.Install, (await apps.GetAppAsync("example.shell"))!.GrantedCorePermissions!);
    }
}
