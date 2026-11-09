using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task DevMode_RemoteConnectedWhileActiveSurvivesReturnAndRecovery(bool packageReturn, bool interruptReturn)
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        if (packageReturn) await AddManifestPackageRuntime(f, tree);
        await f.Service.StartAsync("test.created");
        var before = (await f.Apps.GetAppAsync("test.created"))!;
        var actor = DevActor(owner);
        if (packageReturn)
            Assert.Equal("completed", (await f.Service.ExecuteTargetAsync(
                await ExecutionRequest(f, owner, "workspace", tree), default)).State);
        else
            await ApplyReviewedDev(f.Service, DevRequest("enter", tree.Id), actor);

        var data = Path.Combine(f.Paths.AppsRoot, before.Id, "data", "sentinel.txt");
        await File.WriteAllTextAsync(data, "current ordinary data");
        var edit = Path.Combine(tree.Path, "unfinished.txt");
        await File.WriteAllTextAsync(edit, "keep current source edit");
        var remotePath = Path.Combine(f.Root, "publication.git");
        Directory.CreateDirectory(remotePath);
        await DevelopmentWorkspaceService.Git(remotePath, ["init", "--bare"], default);
        var git = new RemoteGitFixture(remotePath);
        var workspaces = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock, privateSources: git);
        var active = (await f.Apps.GetAppAsync(before.Id))!;
        var starts = f.Adapter.StartCount;
        var stops = f.Adapter.StopCount;
        var connected = await workspaces.RemoteCommandAsync(tree.Id, owner, "connect", RemoteRequest(), default);
        Assert.NotNull(connected.Remote);
        Assert.Equal(active.SourceState! with { Remote = connected.Remote },
            (await f.Apps.GetAppAsync(before.Id))!.SourceState);
        Assert.Equal(active.SelectedRuntime, (await f.Apps.GetAppAsync(before.Id))!.SelectedRuntime);
        Assert.Equal("active", (await f.Service.GetDevModeAsync(before.Id)).Phase);
        Assert.Equal(starts, f.Adapter.StartCount);
        Assert.Equal(stops, f.Adapter.StopCount);

        var returning = DevRequest("return", accept: true);
        returning = returning with { PlanDigest = (await f.Service.PlanDevModeAsync(before.Id, returning, actor)).PlanDigest };
        if (interruptReturn)
        {
            f.Adapter.StartContextProbe = (_, _) => throw new IOException("Interrupted Return start");
            await Assert.ThrowsAsync<IOException>(() => f.Service.ApplyDevModeAsync(before.Id, returning, actor));
            Assert.Equal("return-starting", (await f.Service.GetDevModeAsync(before.Id)).Phase);
            Assert.Equal(connected.Remote, (await f.Apps.GetAppAsync(before.Id))!.SourceState!.Remote);
            f.Adapter.StartContextProbe = null;
        }
        var returned = await f.RecreateService().ApplyDevModeAsync(before.Id, returning, actor);
        Assert.Equal("returned", returned.Phase);
        var after = (await f.Apps.GetAppAsync(before.Id))!;
        Assert.Equal(before.SourceState! with { Remote = connected.Remote }, after.SourceState);
        Assert.Equal(before.SelectedRuntime, after.SelectedRuntime);
        Assert.Equal("running", after.RuntimeState);
        Assert.Equal(before.InstalledAt, after.InstalledAt);
        Assert.Equal("current ordinary data", await File.ReadAllTextAsync(data));
        Assert.Equal("keep current source edit", await File.ReadAllTextAsync(edit));
        Assert.Equal(connected.Remote, (await workspaces.RemoteStatusAsync(tree.Id, owner, before.Id, default)).Remote);
    }
}
