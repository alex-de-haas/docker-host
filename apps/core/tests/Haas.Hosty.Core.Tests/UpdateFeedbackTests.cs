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
        fixture.Adapter.StopProbe = async () =>
        {
            var row = Assert.Single(await fixture.RecreateService().ListAppsAsync());
            Assert.Equal("stopping", row.UpdateProgress?.Stage);
            Assert.Equal("updating", row.OperationStatus);
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
            await report("starting", "app");
        };
        fixture.Adapter.Health = context =>
        {
            var row = fixture.Apps.GetAppAsync(context.App.Id).GetAwaiter().GetResult()!;
            Assert.Equal("checking", row.UpdateProgress?.Stage);
            Assert.Equal("updating", row.OperationStatus);
            return new AppRuntimeHealthResult("healthy", [ServiceHealth("app", health: "healthy")]);
        };
        var result = await fixture.Service.ApplyUpdateAsync(plan.AppId, new AppUpdateApplyRequest(plan.PlanDigest));
        Assert.Equal("started", result.App?.OperationStatus);
        Assert.Equal("update", result.App?.LastOperation);
        Assert.Equal("completed", result.App?.UpdateProgress?.Stage);
        Assert.Equal("1.1.0", result.App?.Version);
    }

    [Fact]
    public async Task UpdateProgress_SynchronousFailureSettlesRatherThanLeavingUpdating()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        fixture.Adapter.RemoteDigest = "sha256:" + new string('a', 64);
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));
        await fixture.Service.StartAsync("com.example.notes");
        fixture.Adapter.FailOnStopCount = 1;
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(await fixture.WriteManifestAsync("1.1.0")));
        await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Service.ApplyUpdateAsync(plan.AppId, new AppUpdateApplyRequest(plan.PlanDigest)));
        var row = Assert.Single(await fixture.RecreateService().ListAppsAsync());
        Assert.Equal("failed", row.OperationStatus);
        Assert.Equal("failed", row.UpdateProgress?.Stage);
        Assert.NotNull(row.LastError);
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
