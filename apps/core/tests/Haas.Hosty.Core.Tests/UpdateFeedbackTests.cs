using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task UpdateProgress_RemainsUpdatingThroughRuntimePreparationAndReadiness()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        fixture.Adapter.RemoteDigest = "sha256:" + new string('a', 64);
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));
        await fixture.Service.StartAsync("com.example.notes");
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(await fixture.WriteManifestAsync("1.1.0")));
        var snapshots = new List<AppRecord>();
        fixture.Apps.Changed += id => snapshots.Add(fixture.Apps.GetAppAsync(id).GetAwaiter().GetResult()!);
        fixture.Adapter.StopProbe = async () =>
        {
            var row = Assert.Single(await fixture.RecreateService().ListAppsAsync());
            Assert.Equal(AppRuntimeStates.Stopping, row.RuntimeState);
            Assert.Equal("stopping", row.UpdateProgress?.Stage);
            Assert.Equal("updating", row.OperationStatus);
            Assert.Equal("update", row.LastOperation);
        };
        fixture.Adapter.StartProbe = async () =>
        {
            var report = fixture.Adapter.LastContext!.ReportUpdateProgress!;
            Assert.NotNull(report);
            await report("downloading", "app");
            var row = Assert.Single(await fixture.RecreateService().ListAppsAsync());
            Assert.Equal("downloading", row.UpdateProgress?.Stage);
            Assert.Equal("app", row.UpdateProgress?.Service);
            Assert.Equal("updating", row.OperationStatus);
            Assert.Equal(AppRuntimeStates.Starting, row.RuntimeState);
            Assert.Equal("starting", row.Health?.Status);
            await report("starting", "app");
        };
        fixture.Adapter.Health = context =>
        {
            var row = fixture.Apps.GetAppAsync(context.App.Id).GetAwaiter().GetResult()!;
            Assert.Equal("checking", row.UpdateProgress?.Stage);
            Assert.Equal("updating", row.OperationStatus);
            Assert.Equal(AppRuntimeStates.Starting, row.RuntimeState);
            return new AppRuntimeHealthResult("healthy", [ServiceHealth("app", health: "healthy")]);
        };
        var result = await fixture.Service.ApplyUpdateAsync(plan.AppId, new AppUpdateApplyRequest(plan.PlanDigest));
        Assert.Equal("started", result.App?.OperationStatus);
        Assert.Equal("update", result.App?.LastOperation);
        Assert.Equal("completed", result.App?.UpdateProgress?.Stage);
        Assert.Equal("1.1.0", result.App?.Version);
        Assert.Equal(AppRuntimeStates.Running, result.App?.RuntimeState);
        Assert.Equal("healthy", result.App?.Health?.Status);
        Assert.DoesNotContain(snapshots, row => row.UpdateProgress?.Stage == "stopping" && row.RuntimeState == AppRuntimeStates.Running);
        Assert.Contains(snapshots, row => row.UpdateProgress?.Stage == "stopping" && row.RuntimeState == AppRuntimeStates.Stopped && row.Health is null);
        Assert.Contains(snapshots, row => row.UpdateProgress?.Stage == "checking" && row.RuntimeState == AppRuntimeStates.Running && row.Health?.Status == "healthy");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task UpdateProgress_SynchronousFailureSettlesRatherThanLeavingUpdating(bool unconfirmedStop)
    {
        var fixture = await LifecycleFixture.CreateAsync();
        fixture.Adapter.RemoteDigest = "sha256:" + new string('a', 64);
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));
        await fixture.Service.StartAsync("com.example.notes");
        if (unconfirmedStop) fixture.Adapter.StopRuntimeState = AppRuntimeStates.Running;
        else fixture.Adapter.FailOnStopCount = 1;
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(await fixture.WriteManifestAsync("1.1.0")));
        await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Service.ApplyUpdateAsync(plan.AppId, new AppUpdateApplyRequest(plan.PlanDigest)));
        var row = Assert.Single(await fixture.RecreateService().ListAppsAsync());
        Assert.Equal("failed", row.OperationStatus);
        Assert.Equal("failed", row.UpdateProgress?.Stage);
        Assert.NotNull(row.LastError);
        Assert.Equal(AppRuntimeStates.Unknown, row.RuntimeState);
        Assert.Null(row.Health);
        Assert.Equal("1.0.0", row.Version);
        Assert.Equal(1, fixture.Adapter.StartCount);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task UpdateProgress_CancelledStopSettlesLifecycleAndRetainsInterruptedRecovery(bool throwInsideStop)
    {
        var fixture = await LifecycleFixture.CreateAsync();
        fixture.Adapter.RemoteDigest = "sha256:" + new string('a', 64);
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));
        await fixture.Service.StartAsync("com.example.notes");
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(await fixture.WriteManifestAsync("1.1.0")));
        using var cancellation = new CancellationTokenSource();
        fixture.Adapter.StopProbe = async () =>
        {
            var stopping = Assert.Single(await fixture.RecreateService().ListAppsAsync());
            Assert.Equal(AppRuntimeStates.Stopping, stopping.RuntimeState);
            Assert.Equal("updating", stopping.OperationStatus);
            cancellation.Cancel();
            if (throwInsideStop) cancellation.Token.ThrowIfCancellationRequested();
        };

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            fixture.Service.ApplyUpdateAsync(plan.AppId, new AppUpdateApplyRequest(plan.PlanDigest), cancellation.Token));

        var abandoned = Assert.Single(await fixture.RecreateService().ListAppsAsync());
        Assert.Equal(AppRuntimeStates.Unknown, abandoned.RuntimeState);
        Assert.Null(abandoned.Health);
        Assert.Equal("updating", abandoned.OperationStatus);
        Assert.Equal("stopping", abandoned.UpdateProgress?.Stage);
        Assert.Equal("1.0.0", abandoned.Version);
        Assert.Equal(1, fixture.Adapter.StartCount);
        Assert.Equal(1, await fixture.RecreateService().RecoverInterruptedUpdatesAsync());
        var recovered = Assert.Single(await fixture.RecreateService().ListAppsAsync());
        Assert.Equal(AppRuntimeStates.Unknown, recovered.RuntimeState);
        Assert.Equal("failed", recovered.OperationStatus);
        Assert.Equal("interrupted", recovered.UpdateProgress?.Stage);
    }

    [Fact]
    public async Task UpdateCheck_UnknownRegistryKeepsSuccessfulTargetThenRecovers()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        fixture.Adapter.RemoteDigest = "sha256:" + new string('a', 64);
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));
        var target = await fixture.WriteManifestAsync("1.1.0");
        await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(target));
        var before = Assert.Single(await fixture.Service.ListAppsAsync()).UpdateCheck!;
        fixture.Adapter.RemoteDigest = null;
        await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(target));
        var failed = Assert.Single(await fixture.RecreateService().ListAppsAsync()).UpdateCheck!;
        Assert.NotNull(failed.Error);
        Assert.True(failed.UpdateAvailable);
        Assert.Equal(before.TargetVersion, failed.TargetVersion);
        Assert.Equal(before.CheckedAt, failed.LastSuccessfulCheckAt);
        Assert.Null(failed.PlanDigest);
        fixture.Adapter.RemoteDigest = "sha256:" + new string('a', 64);
        await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(target));
        Assert.Null(Assert.Single(await fixture.Service.ListAppsAsync()).UpdateCheck?.Error);
    }
}
