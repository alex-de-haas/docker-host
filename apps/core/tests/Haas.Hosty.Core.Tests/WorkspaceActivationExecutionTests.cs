using Haas.Hosty.Core;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task ActivationExecution_OrdersSelectedDependenciesAndRejectsStoppedOrMissingProviders()
    {
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        var second = NewApp("test.provider");
        await f.Service.CreateLocalAppAsync(owner, second, null, default);
        await f.Apps.UpdateAppAsync("test.created", a => a with { Dependencies = [new("test.provider", null, true, [])] });
        Assert.Equal(new[] { "test.provider", "test.created" }, await f.Service.OrderActivationAppsAsync(["test.created", "test.provider"], default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.OrderActivationAppsAsync(["test.created"], default));
        await f.Apps.UpdateAppAsync("test.created", a => a with { Dependencies = [new("test.absent", null, true, [])] });
        var service = ActivationService(f, workspaces);
        var stops = f.Adapter.StopCount;
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.PrepareAsync(tree.WorkspaceId,
            new(Guid.NewGuid().ToString(), owner.UserId, new(false)), default));
        Assert.Equal(stops, f.Adapter.StopCount);
    }

    private static WorkspaceActivationService ActivationService(LifecycleFixture f, DevelopmentWorkspaceService workspaces)
    {
        var core = CoreSourceService(f);
        return new(f.Paths, new(workspaces, new(workspaces, f.Apps, f.Clock), f.Apps, core), core, f.Service, workspaces);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ActivationExecution_PreparesSystemAndOrdinaryBeforeStopAndKeepsData(bool system)
    {
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        await f.Apps.UpdateAppAsync("test.created", a => a with { System = system });
        await f.Service.StartAsync("test.created");
        var stops = f.Adapter.StopCount;
        var starts = f.Adapter.StartCount;
        var data = Path.Combine(f.Paths.AppsRoot, "test.created/data/sentinel");
        Directory.CreateDirectory(Path.GetDirectoryName(data)!); await File.WriteAllTextAsync(data, "ordinary data");
        var source = Path.Combine(tree.Path, "dirty.txt"); await File.WriteAllTextAsync(source, "uncommitted");
        f.Adapter.PreparationProbe = context =>
        {
            Assert.Equal(stops, f.Adapter.StopCount);
            Assert.Equal(starts, f.Adapter.StartCount);
            Assert.NotEqual(Path.GetDirectoryName(data), context.AppDataPath);
            Assert.True(context.PreparationOnly);
            return Task.CompletedTask;
        };
        var service = ActivationService(f, workspaces);
        var input = new WorkspaceActivationRequest(Guid.NewGuid().ToString(), owner.UserId, new(CoreSelected: false));
        var prepared = await service.PrepareAsync(tree.WorkspaceId, input, default);
        Assert.Equal("prepared", prepared.Phase);
        Assert.Equal(stops, f.Adapter.StopCount);
        var active = await service.ApplyAppsAsync(input.RequestId, default);
        Assert.Equal("active", active.Phase);
        Assert.Equal("ordinary data", await File.ReadAllTextAsync(data));
        Assert.Equal("uncommitted", await File.ReadAllTextAsync(source));
        Assert.Single(await f.Backups.ListBackupsAsync("test.created"));
        Assert.Equal(input.RequestId, (await AppDevStore.ReadAsync(f.Paths, (await f.Apps.GetAppAsync("test.created"))!, default))!.ActivationId);
        var finalStarts = f.Adapter.StartCount;
        Assert.Equal(active.Id, (await service.ApplyAppsAsync(input.RequestId, default)).Id);
        Assert.Equal(finalStarts, f.Adapter.StartCount);

    }

    [Fact]
    public async Task ActivationExecution_PreparationFailureLeavesRunningAppsAndCanRetryAfterSourceFix()
    {
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        var second = NewApp("test.second");
        await f.Service.CreateLocalAppAsync(owner, second, null, default);
        await workspaces.PrepareAsync(owner, new(second.RequestId, owner.SessionId, second.AppId, "/assistant", "main"), default);
        await f.Service.StartAsync("test.created"); await f.Service.StartAsync("test.second");
        var stops = f.Adapter.StopCount;
        f.Adapter.PreparationProbe = c => c.App.Id == "test.second" ? throw new IOException("build failed") : Task.CompletedTask;
        var service = ActivationService(f, workspaces);
        var input = new WorkspaceActivationRequest(Guid.NewGuid().ToString(), owner.UserId, new(false));
        await Assert.ThrowsAsync<IOException>(() => service.PrepareAsync(tree.WorkspaceId, input, default));
        Assert.Equal(stops, f.Adapter.StopCount);
        Assert.All(await f.Apps.ListAppRecordsAsync(), app => Assert.Equal("running", app.RuntimeState));
        Assert.Empty(await f.Backups.ListBackupsAsync("test.created"));
        var repairLease = Guid.NewGuid().ToString();
        await workspaces.CommandAsync(tree.Id, owner, "lease", new(Guid.NewGuid().ToString(), LeaseId: repairLease), default);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "fix.txt"), "retained fix");
        await workspaces.CommandAsync(tree.Id, owner, "release-lease", new(Guid.NewGuid().ToString(), LeaseId: repairLease), default);
        f.Adapter.PreparationProbe = null;
        Assert.Equal("prepared", (await service.PrepareAsync(tree.WorkspaceId, input, default)).Phase);
        Assert.Equal("active", (await service.ApplyAppsAsync(input.RequestId, default)).Phase);
        Assert.Equal("retained fix", await File.ReadAllTextAsync(Path.Combine(tree.Path, "fix.txt")));
    }

    [Theory]
    [InlineData("source")]
    [InlineData("lease")]
    [InlineData("backup")]
    public async Task ActivationExecution_RefusesDriftOrUnsafeBackupBeforeStop(string failure)
    {
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        await f.Service.StartAsync("test.created");
        var service = ActivationService(f, workspaces);
        var input = new WorkspaceActivationRequest(Guid.NewGuid().ToString(), owner.UserId, new(false));
        var stops = f.Adapter.StopCount;
        if (failure == "backup")
        {
            var data = Path.Combine(f.Paths.AppsRoot, "test.created/data"); Directory.CreateDirectory(data);
            File.CreateSymbolicLink(Path.Combine(data, "external"), Path.Combine(tree.Path, "feature.txt"));
            await Assert.ThrowsAsync<AppLifecycleException>(() => service.PrepareAsync(tree.WorkspaceId, input, default));
        }
        else
        {
            await service.PrepareAsync(tree.WorkspaceId, input, default);
            if (failure == "source") await File.WriteAllTextAsync(Path.Combine(tree.Path, "later.txt"), "keep");
            else
            {
                // Models a legacy external writer that already owns a durable lease.
                var record = await workspaces.Read(tree.Id, null, default);
                await JsonStorage.WriteAsync(Path.Combine(f.Paths.CoreRoot, "development/workspaces", tree.Id + ".json"), record with { Leases = [Guid.NewGuid().ToString()] });
            }
            await Assert.ThrowsAsync<AppLifecycleException>(() => service.ApplyAppsAsync(input.RequestId, default));
        }
        Assert.Equal(stops, f.Adapter.StopCount);
        Assert.Equal("running", (await f.Apps.GetAppAsync("test.created"))!.RuntimeState);
        Assert.True(File.Exists(Path.Combine(tree.Path, "feature.txt")));
    }

    [Fact]
    public async Task ActivationExecution_ReleaseBeforeStopAllowsRepairsButRefusesAnActiveRuntime()
    {
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        var service = ActivationService(f, workspaces);
        var input = new WorkspaceActivationRequest(Guid.NewGuid().ToString(), owner.UserId, new(false));
        await service.PrepareAsync(tree.WorkspaceId, input, default);
        var stops = f.Adapter.StopCount;
        await service.ReleasePreparationAsync(input.RequestId, default);
        Assert.Equal(stops, f.Adapter.StopCount);
        Assert.Null((await f.Apps.GetAppAsync("test.created"))!.DevModeId);
        await service.PrepareAsync(tree.WorkspaceId, input, default);
        await service.ApplyAppsAsync(input.RequestId, default);
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.ReleasePreparationAsync(input.RequestId, default));
        Assert.Equal("active", WorkspaceRuntimeFiles.Read(f.Paths.DataRoot, input.RequestId).Phase);
    }

    [Fact]
    public async Task ActivationExecution_StartFailureRetainsVerifiedBackupAndReplaysSameParticipant()
    {
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        var service = ActivationService(f, workspaces);
        var input = new WorkspaceActivationRequest(Guid.NewGuid().ToString(), owner.UserId, new(false));
        await service.PrepareAsync(tree.WorkspaceId, input, default);
        f.Adapter.FailOnStartCount = f.Adapter.StartCount + 1;
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.ApplyAppsAsync(input.RequestId, default));
        Assert.Equal("applying", WorkspaceRuntimeFiles.Read(f.Paths.DataRoot, input.RequestId).Phase);
        Assert.Single(await f.Backups.ListBackupsAsync("test.created"));
        Assert.True(File.Exists(Path.Combine(tree.Path, "feature.txt")));
        f.Adapter.FailOnStartCount = null;
        Assert.Equal("active", (await service.ApplyAppsAsync(input.RequestId, default)).Phase);
        Assert.Single(await f.Backups.ListBackupsAsync("test.created"));
    }
}
