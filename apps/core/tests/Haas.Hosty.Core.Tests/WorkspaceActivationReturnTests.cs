using Haas.Hosty.Core;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ActivationReturn_RestoresCapturedRunningStateWithoutDiscardingCurrentData(bool running)
    {
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        if (running) await f.Service.StartAsync("test.created");
        var original = await f.Apps.GetAppAsync("test.created");
        var service = ActivationService(f, workspaces);
        var id = Guid.NewGuid().ToString();
        await service.PrepareAsync(tree.WorkspaceId, new(id, owner.UserId, new(false)), default);
        await service.ApplyAppsAsync(id, default);
        Assert.Equal(id, f.Adapter.LastContext!.WorkspaceActivationId);
        Assert.NotNull(f.Adapter.LastContext.PreparedSetupServices);
        var restart = new AppDevRequest(Guid.NewGuid().ToString(), "restart");
        var actor = new AppDevActor(owner.UserId, "workspace-local", TrustedLocalOperator: true);
        var review = await f.Service.PlanDevModeAsync("test.created", restart, actor);
        await f.Service.ApplyDevModeAsync("test.created", restart with { PlanDigest = review.PlanDigest }, actor);
        Assert.Equal(id, f.Adapter.LastContext.WorkspaceActivationId);
        Assert.Null(f.Adapter.LastContext.PreparedSetupServices);
        var data = Path.Combine(f.Paths.AppsRoot, "test.created", "data", "new-state");
        Directory.CreateDirectory(Path.GetDirectoryName(data)!); await File.WriteAllTextAsync(data, "candidate writes");
        var request = new WorkspaceReturnRequest(Guid.NewGuid().ToString(), ["test.created"], false, true);
        await service.PrepareReturnAsync(id, request, default);
        await service.ReturnAppsAsync(id, default);
        var restored = (await f.Apps.GetAppAsync("test.created"))!;
        Assert.Equal(original!.SourceState, restored.SourceState); Assert.Equal(original.SelectedRuntime, restored.SelectedRuntime);
        Assert.Equal(running, AppRuntimeStates.IsUp(restored.RuntimeState));
        if (running) Assert.Null(f.Adapter.LastContext!.WorkspaceActivationId);
        Assert.Equal("candidate writes", await File.ReadAllTextAsync(data));
        Assert.Equal(new[] { "test.created" }, WorkspaceRuntimeFiles.Read(f.Paths.DataRoot, id).ReturnedApps);
        var starts = f.Adapter.StartCount;
        await service.ReturnAppsAsync(id, default);
        Assert.Equal(starts, f.Adapter.StartCount);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ActivationReturn_RetainsRemoteConnectedWhileActiveAndReconcilesReturnedChild(bool running)
    {
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        if (running) await f.Service.StartAsync("test.created");
        var original = (await f.Apps.GetAppAsync("test.created"))!;
        var service = ActivationService(f, workspaces);
        var id = Guid.NewGuid().ToString();
        await service.PrepareAsync(tree.WorkspaceId, new(id, owner.UserId, new(false)), default);
        await service.ApplyAppsAsync(id, default);
        var remotePath = Path.Combine(f.Root, "publication.git");
        Directory.CreateDirectory(remotePath);
        await DevelopmentWorkspaceService.Git(remotePath, ["init", "--bare"], default);
        var remoteWorkspaces = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock, privateSources: new RemoteGitFixture(remotePath));
        var active = (await f.Apps.GetAppAsync(original.Id))!;
        var starts = f.Adapter.StartCount;
        var stops = f.Adapter.StopCount;
        var connected = await remoteWorkspaces.RemoteCommandAsync(tree.Id, owner, "connect", RemoteRequest(), default);
        Assert.NotNull(connected.Remote);
        Assert.Equal(active.SourceState! with { Remote = connected.Remote }, (await f.Apps.GetAppAsync(original.Id))!.SourceState);
        Assert.Equal(starts, f.Adapter.StartCount); Assert.Equal(stops, f.Adapter.StopCount);
        var data = Path.Combine(f.Paths.AppsRoot, original.Id, "data", "sentinel.txt");
        await File.WriteAllTextAsync(data, "current ordinary data");
        var edit = Path.Combine(tree.Path, "unfinished.txt");
        await File.WriteAllTextAsync(edit, "keep current source edit");
        var request = new WorkspaceReturnRequest(Guid.NewGuid().ToString(), [original.Id], false, true);
        var pending = await service.PrepareReturnAsync(id, request, default);
        await service.ReturnAppsAsync(id, default);
        var restored = (await f.Apps.GetAppAsync(original.Id))!;
        Assert.Equal(original.SourceState! with { Remote = connected.Remote }, restored.SourceState);
        Assert.Equal(original.SelectedRuntime, restored.SelectedRuntime);
        Assert.Equal(running, AppRuntimeStates.IsUp(restored.RuntimeState));
        Assert.Equal("returned", (await f.Service.GetDevModeAsync(original.Id)).Phase);
        Assert.Equal(new[] { original.Id }, WorkspaceRuntimeFiles.Read(f.Paths.DataRoot, id).ReturnedApps);

        // Reconcile process loss after the child Return completed but before group progress persisted.
        starts = f.Adapter.StartCount; stops = f.Adapter.StopCount;
        WorkspaceRuntimeFiles.Save(f.Paths.DataRoot, pending);
        await service.ReturnAppsAsync(id, default);
        await service.ReturnAppsAsync(id, default);
        Assert.Equal(new[] { original.Id }, WorkspaceRuntimeFiles.Read(f.Paths.DataRoot, id).ReturnedApps);
        Assert.Equal(starts, f.Adapter.StartCount); Assert.Equal(stops, f.Adapter.StopCount);
        Assert.Equal(restored.SourceState, (await f.Apps.GetAppAsync(original.Id))!.SourceState);
        Assert.Equal("current ordinary data", await File.ReadAllTextAsync(data));
        Assert.Equal("keep current source edit", await File.ReadAllTextAsync(edit));
        Assert.Equal(connected.Remote, (await remoteWorkspaces.RemoteStatusAsync(tree.Id, owner, original.Id, default)).Remote);
    }

    [Fact]
    public async Task ActivationReview_SourceContentDriftInvalidatesDigestBeforePreparation()
    {
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        var service = ActivationService(f, workspaces);
        var review = await service.ReviewAsync(tree.WorkspaceId, owner.UserId, new(false), default);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "changed.txt"), "first");
        var next = await service.ReviewAsync(tree.WorkspaceId, owner.UserId, new(false), default);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "changed.txt"), "second");
        var id = Guid.NewGuid().ToString();
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => service.PrepareAsync(tree.WorkspaceId,
            new(id, owner.UserId, new(false), next.PlanDigest), default));
        Assert.Equal("activation_review_changed", error.Code);
        Assert.False(File.Exists(WorkspaceRuntimeFiles.PathFor(f.Paths.DataRoot, id)));
        Assert.NotEqual(review.PlanDigest, next.PlanDigest);
    }

    [Fact]
    public async Task RunningCore_RemainsConsumerWithoutAnUnreturnedActivation()
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        var core = new CoreDevelopmentService(new(f.Paths.DataRoot, Path.Combine(f.Paths.CoreRoot, "run"),
            Path.Combine(f.Paths.CoreRoot, "run/control.json"), 7070, "http://localhost:7070", null, "localhost", null, false),
            new("dev", Path.Combine(tree.Path, "Core.csproj"), null, 123, DateTimeOffset.UtcNow));
        var workspaces = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock, coreDevelopment: core);
        Assert.Contains("hosty:core", await workspaces.DevConsumerAppsAsync(tree, default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => workspaces.CommandAsync(tree.Id, owner, "cleanup",
            new(Guid.NewGuid().ToString(), ExpectedHead: tree.Observation!.Head), default));
        var lease = Guid.NewGuid().ToString();
        await workspaces.CommandAsync(tree.Id, owner, "lease", new(Guid.NewGuid().ToString(), LeaseId: lease), default);
        await workspaces.CommandAsync(tree.Id, owner, "release-lease", new(Guid.NewGuid().ToString(), LeaseId: lease), default);
    }

    [Fact]
    public async Task CoreConsumer_BlocksDestructiveGitAndTransitionWritersUntilReturn()
    {
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        var id = Guid.NewGuid().ToString();
        var a = new WorkspaceRuntimeActivation(id, tree.WorkspaceId, owner.UserId, "review", "instance", "revision", tree.Id,
            Path.Combine(tree.Path, "Core.csproj"), new("release", null, null, 1, DateTimeOffset.UtcNow), [], "core-starting");
        WorkspaceRuntimeFiles.Save(f.Paths.DataRoot, a);
        Assert.Contains("hosty:core", await workspaces.DevConsumerAppsAsync(tree, default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => workspaces.CommandAsync(tree.Id, owner, "lease",
            new(Guid.NewGuid().ToString(), LeaseId: Guid.NewGuid().ToString()), default));
        WorkspaceRuntimeFiles.Save(f.Paths.DataRoot, a with { Phase = "active" });
        var lease = Guid.NewGuid().ToString();
        await workspaces.CommandAsync(tree.Id, owner, "lease", new(Guid.NewGuid().ToString(), LeaseId: lease), default);
        await workspaces.CommandAsync(tree.Id, owner, "release-lease", new(Guid.NewGuid().ToString(), LeaseId: lease), default);
        await Assert.ThrowsAsync<AppLifecycleException>(() => workspaces.CommandAsync(tree.Id, owner, "cleanup", new(Guid.NewGuid().ToString(), ExpectedHead: tree.Observation!.Head), default));
        WorkspaceRuntimeFiles.Save(f.Paths.DataRoot, a with { Phase = "returned", CoreReturned = true });
        Assert.DoesNotContain("hosty:core", await workspaces.DevConsumerAppsAsync(tree, default));
    }
}
