using System.Net;
using System.Text;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task UpdateSnapshot_RestoresExactDockerPlanOfflineAndConsumesIt()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        fixture.Adapter.RemoteDigest = "sha256:" + new string('a', 64);
        var v1 = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(v1));
        var v2 = await fixture.WriteManifestAsync("1.1.0");
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(v2));
        var before = Assert.Single(await fixture.Service.ListAppsAsync()).UpdateCheck!;
        await fixture.CoreSettings.UpdateAsync(new Dictionary<string, string?> { ["HOSTY_UPDATE_CHECK_INTERVAL_MINUTES"] = "0" });
        await fixture.Apps.UpdateAppAsync(plan.AppId, app => app with { RuntimeState = "unknown", LastOperation = "reconcile" });
        File.Delete(v2); // Restore and apply must use the reviewed selection, not fetch the target again.
        var restarted = fixture.RecreateService();
        var after = Assert.Single(await restarted.ListAppsAsync()).UpdateCheck!;
        Assert.Equal(before.CheckedAt, after.CheckedAt);
        Assert.Equal(before.TargetVersion, after.TargetVersion);
        Assert.Equal(plan.PlanDigest, after.PlanDigest);
        Assert.True(after.UpdateAvailable);
        Assert.Equal(plan.PlanDigest, (await restarted.GetPendingUpdatePlanAsync(plan.AppId)).Plan?.PlanDigest);
        var result = await restarted.ApplyUpdateAsync(plan.AppId, new AppUpdateApplyRequest(plan.PlanDigest));
        Assert.Equal("1.1.0", result.App?.Version);
        Assert.Null((await fixture.RecreateService().GetPendingUpdatePlanAsync(plan.AppId)).Plan);
        Assert.Null(Assert.Single(await fixture.RecreateService().ListAppsAsync()).UpdateCheck);
    }

    [Fact]
    public async Task UpdateSnapshot_RestartDoesNotExtendPlanTtlOrDiscardLastVerdict()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(await fixture.WriteManifestAsync("1.1.0")));
        fixture.Clock.UtcNow += TimeSpan.FromMinutes(59);
        Assert.NotNull((await fixture.RecreateService().GetPendingUpdatePlanAsync(plan.AppId)).Plan);
        fixture.Clock.UtcNow += TimeSpan.FromMinutes(2);
        var restarted = fixture.RecreateService();
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => restarted.ApplyUpdateAsync(plan.AppId, new AppUpdateApplyRequest(plan.PlanDigest)));
        Assert.Equal("update_plan_expired", error.Code);
        Assert.Null((await fixture.RecreateService().GetPendingUpdatePlanAsync(plan.AppId)).Plan);
        Assert.True(Assert.Single(await fixture.RecreateService().ListAppsAsync()).UpdateCheck!.UpdateAvailable);
    }

    [Theory]
    [InlineData("version")]
    [InlineData("runtime")]
    [InlineData("manifest")]
    [InlineData("feed")]
    [InlineData("source")]
    [InlineData("reinstall")]
    public async Task UpdateSnapshot_RejectsChangedBase(string change)
    {
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(await fixture.WriteManifestAsync("1.1.0")));
        var app = (await fixture.Apps.GetAppAsync(plan.AppId))!;
        app = change switch
        {
            "version" => app with { Version = "2.0.0" },
            "runtime" => app with { SelectedRuntime = "another-runtime" },
            "feed" => app with { FeedsUrl = "https://other.example/feeds.json", FollowedFeedId = "other" },
            "source" => app with { ManifestUrl = "https://other.example/manifest.json" },
            "reinstall" => app with { InstalledAt = app.InstalledAt.AddSeconds(1) },
            _ => app,
        };
        if (change == "manifest") await File.AppendAllTextAsync(app.ManifestPath!, "\n ");
        await fixture.Apps.UpsertAppAsync(app);
        var restarted = fixture.RecreateService();
        Assert.Null(Assert.Single(await restarted.ListAppsAsync()).UpdateCheck);
        Assert.Null((await restarted.GetPendingUpdatePlanAsync(plan.AppId)).Plan);
        Assert.Null(Assert.Single(await fixture.RecreateService().ListAppsAsync()).UpdateCheck);
    }

    [Theory]
    [InlineData("{")]
    [InlineData("null")]
    [InlineData("{\"schemaVersion\":999,\"base\":\"unknown\"}")]
    [InlineData("{\"schemaVersion\":1,\"base\":\"unknown\",\"plan\":{}}")]
    public async Task UpdateSnapshot_MalformedOrIncompatibleStateDoesNotPreventListing(string content)
    {
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));
        var path = Path.Combine(fixture.Paths.CoreRoot, "update-checks", "com.example.notes.json");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        await File.WriteAllTextAsync(path, content);
        Assert.Null(Assert.Single(await fixture.RecreateService().ListAppsAsync()).UpdateCheck);
        await fixture.RecreateService().CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(await fixture.WriteManifestAsync("1.1.0")));
        Assert.True(Assert.Single(await fixture.RecreateService().ListAppsAsync()).UpdateCheck!.UpdateAvailable);
        if (!OperatingSystem.IsWindows())
            Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(path));
    }

    [Fact]
    public async Task UpdateSnapshot_FailureRetainsReviewedPlanAndPruningRemovesBoth()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        fixture.Adapter.RemoteDigest = "sha256:" + new string('a', 64);
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(await fixture.WriteManifestAsync("1.1.0")));
        var successful = Assert.Single(await fixture.Service.ListAppsAsync()).UpdateCheck!;
        await fixture.RecreateService().RecordUpdateCheckFailure(plan.AppId, "Source unavailable");
        var restarted = fixture.RecreateService();
        var failed = Assert.Single(await restarted.ListAppsAsync()).UpdateCheck!;
        Assert.Equal("Source unavailable", failed.Error);
        Assert.True(failed.UpdateAvailable);
        Assert.Equal(successful.TargetVersion, failed.TargetVersion);
        Assert.Equal(successful.CheckedAt, failed.LastSuccessfulCheckAt);
        await restarted.RecordUpdateCheckFailure(plan.AppId, "Still unavailable");
        Assert.Equal(successful.CheckedAt, Assert.Single(await fixture.RecreateService().ListAppsAsync()).UpdateCheck?.LastSuccessfulCheckAt);
        Assert.Equal(plan.PlanDigest, (await restarted.GetPendingUpdatePlanAsync(plan.AppId)).Plan?.PlanDigest);
        await restarted.PruneUpdateAvailability(new HashSet<string>());
        Assert.Null(Assert.Single(await fixture.RecreateService().ListAppsAsync()).UpdateCheck);
        Assert.Null((await fixture.RecreateService().GetPendingUpdatePlanAsync(plan.AppId)).Plan);
    }

    [Fact]
    public async Task UpdateSnapshot_InterruptedApplyRequiresFreshReviewAfterBootRecovery()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(await fixture.WriteManifestAsync("1.1.0")));
        await fixture.Apps.UpdateAppAsync(plan.AppId, app => app with { OperationStatus = "updating" });
        var restarted = fixture.RecreateService();
        Assert.Equal(1, await restarted.RecoverInterruptedUpdatesAsync());
        Assert.Null((await fixture.RecreateService().GetPendingUpdatePlanAsync(plan.AppId)).Plan);
        Assert.Null(Assert.Single(await fixture.RecreateService().ListAppsAsync()).UpdateCheck);
    }

    [Fact]
    public async Task UpdateSnapshot_RemovalDoesNotLeaveAnOfferForReinstall()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(await fixture.WriteManifestAsync("1.1.0")));
        await fixture.RecreateService().RemoveAsync(plan.AppId, new AppRemoveRequest());
        Assert.False(File.Exists(Path.Combine(fixture.Paths.CoreRoot, "update-checks", plan.AppId + ".json")));
        var restarted = fixture.RecreateService();
        await restarted.InstallAsync(new AppInstallRequest(manifest));
        Assert.Null(Assert.Single(await restarted.ListAppsAsync()).UpdateCheck);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task UpdateSnapshot_LocalRevisionSurvivesRestartAndFailedPostBootProbeIsUnknown(bool apply)
    {
        string? repository = null;
        var offline = false;
        var manifests = new AppManifestService(new HttpClient(new StubHttpMessageHandler(_ =>
            offline ? throw new HttpRequestException("offline") : new HttpResponseMessage(HttpStatusCode.OK)
            { Content = new StringContent(CreateRemoteLocalCommandManifestJson(repository!, "1.0.0"), Encoding.UTF8, "application/json") })));
        var fixture = await LifecycleFixture.CreateAsync(manifests);
        repository = await CreateLocalCommandGitRepositoryAsync(fixture.Root);
        await fixture.Service.InstallAsync(new AppInstallRequest("https://apps.example.test/local/manifest.json", SelectedRuntime: "dev"));
        await fixture.Sources.EnsurePinnedCommitAsync("com.example.remote-local");
        await File.WriteAllTextAsync(Path.Combine(repository, "advance.txt"), "new source, same version");
        await RunGitAsync(repository, ["add", "advance.txt"]);
        await RunGitAsync(repository, ["-c", "user.name=Hosty Test", "-c", "user.email=hosty@example.test", "commit", "-m", "Advance"]);
        var commit = await RunGitAsync(repository, ["rev-parse", "HEAD"]);
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.remote-local", new AppUpdatePlanRequest());
        offline = true;
        var restarted = fixture.RecreateService();
        var summary = Assert.Single(await restarted.ListAppsAsync());
        Assert.True(summary.UpdateCheck!.UpdateAvailable);
        Assert.Equal(commit, summary.UpdateCheck.TargetSourceCommit);
        Assert.Equal("1.0.0", summary.UpdateCheck.TargetVersion);
        Assert.Equal(plan.PlanDigest, (await restarted.GetPendingUpdatePlanAsync(plan.AppId)).Plan?.PlanDigest);
        if (apply)
        {
            var result = await restarted.ApplyUpdateAsync(plan.AppId, new AppUpdateApplyRequest(plan.PlanDigest));
            Assert.Equal("1.0.0", result.App?.Version);
            var registry = new AppRegistryStore(fixture.Paths);
            Assert.Equal(commit, (await registry.GetAppAsync(plan.AppId))?.SourceState?.Commit);
            Assert.Null(Assert.Single(await fixture.RecreateService().ListAppsAsync()).UpdateCheck);
            return;
        }
        // The first post-boot check can read the manifest but its git remote is unavailable.
        offline = false;
        Directory.Move(repository, repository + "-offline");
        await restarted.CreateUpdatePlanAsync(plan.AppId, new AppUpdatePlanRequest());
        var failed = Assert.Single(await fixture.RecreateService().ListAppsAsync()).UpdateCheck!;
        Assert.True(failed.UpdateAvailable);
        Assert.NotNull(failed.Error);
        Assert.Equal(commit, failed.TargetSourceCommit);
        Assert.Equal(summary.UpdateCheck.LastSuccessfulCheckAt, failed.LastSuccessfulCheckAt);
        await fixture.Apps.UpdateAppAsync(plan.AppId, app => app with
        {
            DevelopmentModes = new Dictionary<string, bool> { ["dev"] = true },
        });
        var live = Assert.Single(await fixture.RecreateService().ListAppsAsync());
        Assert.True(live.Live);
        Assert.Null(live.UpdateCheck);
        Assert.Null((await fixture.RecreateService().GetPendingUpdatePlanAsync(plan.AppId)).Plan);
    }
}
