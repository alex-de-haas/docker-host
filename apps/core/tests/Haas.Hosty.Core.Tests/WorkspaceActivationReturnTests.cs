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
        var data = Path.Combine(f.Paths.AppsRoot, "test.created", "data", "new-state");
        Directory.CreateDirectory(Path.GetDirectoryName(data)!); await File.WriteAllTextAsync(data, "candidate writes");
        var request = new WorkspaceReturnRequest(Guid.NewGuid().ToString(), ["test.created"], false, true);
        await service.PrepareReturnAsync(id, request, default);
        await service.ReturnAppsAsync(id, default);
        var restored = (await f.Apps.GetAppAsync("test.created"))!;
        Assert.Equal(original!.SourceState, restored.SourceState); Assert.Equal(original.SelectedRuntime, restored.SelectedRuntime);
        Assert.Equal(running, AppRuntimeStates.IsUp(restored.RuntimeState));
        Assert.Equal("candidate writes", await File.ReadAllTextAsync(data));
        Assert.Equal(new[] { "test.created" }, WorkspaceRuntimeFiles.Read(f.Paths.DataRoot, id).ReturnedApps);
        var starts = f.Adapter.StartCount;
        await service.ReturnAppsAsync(id, default);
        Assert.Equal(starts, f.Adapter.StartCount);
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
