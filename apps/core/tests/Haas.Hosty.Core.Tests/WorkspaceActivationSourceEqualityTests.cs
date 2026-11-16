using Haas.Hosty.Core;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public async Task ActivationReturn_CollectionValuedSourceRestoresAndReconcilesWithoutAcceptingDrift(bool running, bool drift)
    {
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        await f.Apps.UpdateAppAsync("test.created", app => app with { SourceState = app.SourceState! with { InspectionPaths = ["."] } });
        if (running) await f.Service.StartAsync("test.created");
        var original = (await f.Apps.GetAppAsync("test.created"))!;
        var service = ActivationService(f, workspaces); var id = Guid.NewGuid().ToString();
        await service.PrepareAsync(tree.WorkspaceId, new(id, owner.UserId, new(false)), default);
        await service.ApplyAppsAsync(id, default);
        var sentinel = Path.Combine(f.Paths.AppsRoot, original.Id, "data", "source-return-data");
        Directory.CreateDirectory(Path.GetDirectoryName(sentinel)!); await File.WriteAllTextAsync(sentinel, "retained current data");
        var request = new WorkspaceReturnRequest(Guid.NewGuid().ToString(), [original.Id], false, true);
        await service.PrepareReturnAsync(id, request, default);
        await f.Service.ReturnActivationAppAsync(WorkspaceRuntimeFiles.Read(f.Paths.DataRoot, id), original.Id, request, default);
        var restored = (await f.Apps.GetAppAsync(original.Id))!;
        Assert.NotSame(original.SourceState!.InspectionPaths, restored.SourceState!.InspectionPaths);
        Assert.Equal(CoreJson.Text(original.SourceState), CoreJson.Text(restored.SourceState));
        Assert.Equal(running, AppRuntimeStates.IsUp(restored.RuntimeState));
        var starts = f.Adapter.StartCount; var stops = f.Adapter.StopCount;
        if (drift)
        {
            await f.Apps.UpdateAppAsync(original.Id, app => app with { SourceState = app.SourceState! with { InspectionPaths = ["changed"] } });
            Assert.Equal("activation_return_partial", (await Assert.ThrowsAsync<AppLifecycleException>(() => service.ReturnAppsAsync(id, default))).Code);
            Assert.Equal(new[] { "changed" }, (await f.Apps.GetAppAsync(original.Id))!.SourceState!.InspectionPaths);
        }
        else
        {
            await service.ReturnAppsAsync(id, default);
            Assert.Equal(new[] { original.Id }, WorkspaceRuntimeFiles.Read(f.Paths.DataRoot, id).ReturnedApps);
            await service.ReturnAppsAsync(id, default);
        }
        Assert.Equal(starts, f.Adapter.StartCount); Assert.Equal(stops, f.Adapter.StopCount);
        Assert.Equal("retained current data", await File.ReadAllTextAsync(sentinel));
    }
}
