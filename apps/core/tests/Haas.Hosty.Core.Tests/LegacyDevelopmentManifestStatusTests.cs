using System.Text.Json.Nodes;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task LegacyDevelopmentManifest_FreshRestartClearsVersionOnlyDriftWithoutChangingPackage(bool managed)
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        var actor = DevActor(owner);
        var installed = (await f.Apps.GetAppAsync("test.created"))!;
        var packageBytes = await File.ReadAllBytesAsync(installed.ManifestPath!);
        await ApplyReviewedDev(f.Service, DevRequest("enter", tree.Id), actor);
        var active = (await f.Apps.GetAppAsync(installed.Id))!;
        Assert.Null((await AppDevStore.ReadAsync(f.Paths, active, default))!.ExecutionManifest);
        var service = f.RecreateService();
        foreach (var version in new[] { "0.2.0", "0.2.1" })
        {
            var manifestPath = Path.Combine(tree.Path, "manifest.json");
            var timestamp = File.GetLastWriteTimeUtc(manifestPath);
            await EditDevManifest(tree.Path, manifest => manifest["version"] = version);
            File.SetLastWriteTimeUtc(manifestPath, timestamp);
            var before = Assert.Single(await service.ListAppsAsync());
            Assert.True(before.RestartRequired);
            Assert.Equal("changed", before.Development!.ManifestState);
            var restarted = managed
                ? (await ApplyReviewedDev(service, DevRequest("restart"), actor)).App
                : (await service.RestartAsync(installed.Id)).App!;
            Assert.False(restarted.RestartRequired);
            Assert.Equal("current", restarted.Development!.ManifestState);
            var record = (await f.Apps.GetAppAsync(installed.Id))!;
            var source = await f.Manifests.LoadAsync(manifestPath, "dev", forceRead: true);
            Assert.Equal(source.ManifestDigest, record.AppliedSourceManifestDigest);
            Assert.Equal(installed.Version, record.Version);
            Assert.Equal(packageBytes, await File.ReadAllBytesAsync(installed.ManifestPath!));
            Assert.Null((await AppDevStore.ReadAsync(f.Paths, record, default))!.ExecutionManifest);
            Assert.False(Assert.Single(await f.RecreateService().ListAppsAsync()).RestartRequired);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task LegacyDevelopmentManifest_PermissionEditStillFailsBeforeStop(bool managed)
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        var actor = DevActor(owner);
        await ApplyReviewedDev(f.Service, DevRequest("enter", tree.Id), actor);
        var before = (await f.Apps.GetAppAsync("test.created"))!;
        var stops = f.Adapter.StopCount;
        var starts = f.Adapter.StartCount;
        await EditDevManifest(tree.Path, manifest =>
        {
            manifest["version"] = "0.2.0";
            manifest["optionalCorePermissions"] = new JsonArray("apps.read");
        });
        var error = await Assert.ThrowsAsync<AppLifecycleException>(async () =>
        {
            if (managed) await ApplyReviewedDev(f.Service, DevRequest("restart"), actor);
            else await f.Service.RestartAsync(before.Id);
        });
        Assert.Equal("dev_contract_changed", error.Code);
        Assert.Equal(stops, f.Adapter.StopCount);
        Assert.Equal(starts, f.Adapter.StartCount);
        var after = (await f.Apps.GetAppAsync(before.Id))!;
        Assert.Equal("running", after.RuntimeState);
        Assert.Equal(before.AppliedSourceManifestDigest, after.AppliedSourceManifestDigest);
    }

    [Fact]
    public async Task LegacyDevelopmentManifest_AdoptionKeepsOldAppliedDigestUntilFreshRestart()
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        await ApplyReviewedDev(f.Service, DevRequest("enter", tree.Id), DevActor(owner));
        var applied = (await f.Apps.GetAppAsync("test.created"))!.AppliedSourceManifestDigest;
        await EditDevManifest(tree.Path, manifest => manifest["version"] = "0.2.0");
        f.Adapter.CreatedServices = [];
        Assert.True((await f.Service.StartAsync("test.created")).App!.RestartRequired);
        Assert.Equal(applied, (await f.Apps.GetAppAsync("test.created"))!.AppliedSourceManifestDigest);
        f.Adapter.CreatedServices = f.Adapter.LastContext!.Manifest.Services.Select(service => service.Key).ToArray();
        Assert.False((await f.Service.RestartAsync("test.created")).App!.RestartRequired);
        var source = await f.Manifests.LoadAsync(Path.Combine(tree.Path, "manifest.json"), "dev", forceRead: true);
        Assert.Equal(source.ManifestDigest, (await f.Apps.GetAppAsync("test.created"))!.AppliedSourceManifestDigest);
    }
}
