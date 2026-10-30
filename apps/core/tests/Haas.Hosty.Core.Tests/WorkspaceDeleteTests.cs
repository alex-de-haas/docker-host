using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static WorkspaceCleanupService DeleteCleanup(DiscardFixture f)
    {
        var store = new CoreEnvironmentStore(f.F.Paths);
        var environments = new CoreEnvironmentService(store, new ResourceControlRuntime(), f.F.Clock, f.Service);
        return new(f.F.Paths, new(f.Service, f.F.Apps, f.F.Clock), f.Service, null!, f.F.Apps,
            store, environments, new(store, environments));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task WorkspaceDelete_DifferentOperatorRemovesDirtyActiveWorkspaceWithoutReview(bool external)
    {
        using var f = await DiscardFixtureAsync(external);
        await AddDiscardableSource(f.Tree);
        var lease = Guid.NewGuid().ToString();
        await f.Service.CommandAsync(f.Tree.Id, f.Owner, "lease", new(Guid.NewGuid().ToString(), LeaseId: lease), default);
        var cleanup = DeleteCleanup(f);
        var details = await cleanup.DeleteDetailsAsync(f.Tree.WorkspaceId, "another-admin", null, default);
        Assert.Empty(details.Blockers);
        Assert.NotEmpty(details.Warnings!);
        Assert.NotEmpty(Assert.Single(details.Trees).ChangedFiles);
        var request = new WorkspaceDeleteCommand(Guid.NewGuid().ToString());
        var deleted = await cleanup.ApplyDeleteAsync(f.Tree.WorkspaceId, "another-admin", null, request, default);
        Assert.True(deleted.State == "removed", deleted.Error);
        Assert.Contains(deleted.Activity!, a => a.Reference == lease && a.State == "retired" && a.Detail!.Contains("unknown"));
        Assert.False(Directory.Exists(f.Tree.Path));
        Assert.True(Directory.Exists(f.Origin));
        Assert.Empty((await f.Service.ListAsync(null, true, default)).Workspaces);
        Assert.Equal("removed", (await cleanup.ApplyDeleteAsync(f.Tree.WorkspaceId, "third-admin", null, request, default)).State);
    }

    [Fact]
    public async Task WorkspaceDelete_SourceChangesAfterAdmissionDoNotRequireAnotherConfirmation()
    {
        using var f = await DiscardFixtureAsync();
        var id = Guid.NewGuid().ToString();
        await f.Service.AdmitDeleteAsync(f.Owner, "admin", id, [], default);
        await AddDiscardableSource(f.Tree);
        var deleted = await DeleteCleanup(f).ApplyDeleteAsync(f.Tree.WorkspaceId, "admin", null, new(id), default);
        Assert.True(deleted.State == "removed", deleted.Error);
    }

    [Fact]
    public async Task WorkspaceDelete_MissingDirectoryStillRemovesItsGitRegistrationAndBranch()
    {
        using var f = await DiscardFixtureAsync();
        Directory.Delete(f.Tree.Path, true);
        var deleted = await DeleteCleanup(f).ApplyDeleteAsync(f.Tree.WorkspaceId, "admin", null, new(Guid.NewGuid().ToString()), default);
        Assert.True(deleted.State == "removed", deleted.Error);
        Assert.Empty((await f.Service.ListAsync(null, true, default)).Workspaces);
    }

    [Theory]
    [InlineData("preparing")]
    [InlineData("failed")]
    public async Task WorkspaceDelete_RemovesPartialPreparationWithoutGitMetadata(string state)
    {
        using var f = await DiscardFixtureAsync();
        await RunGitAsync(Path.Combine(f.F.Paths.CoreRoot, "development", "repositories", f.Tree.RepositoryId + ".git"),
            ["worktree", "remove", "--force", f.Tree.Path]);
        Directory.CreateDirectory(f.Tree.Path);
        await File.WriteAllTextAsync(Path.Combine(f.Tree.Path, "partial.txt"), "incomplete preparation");
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development", "workspaces", f.Tree.Id + ".json"),
            f.Tree with { State = state });
        var removed = await DeleteCleanup(f).ApplyDeleteAsync(f.Tree.WorkspaceId, "another-admin", null,
            new(Guid.NewGuid().ToString()), default);
        Assert.True(removed.State == "removed", removed.Error);
        Assert.False(Directory.Exists(f.Tree.Path));
    }

    [Theory]
    [InlineData("detached")]
    [InlineData("missing-git")]
    [InlineData("nested-repository")]
    public async Task WorkspaceDelete_CheckoutStateDoesNotBlockRemoval(string state)
    {
        using var f = await DiscardFixtureAsync();
        if (state == "detached") await RunGitAsync(f.Tree.Path, ["checkout", "--detach"]);
        if (state == "missing-git") File.Delete(Path.Combine(f.Tree.Path, ".git"));
        if (state == "nested-repository")
        {
            Directory.CreateDirectory(Path.Combine(f.Tree.Path, "nested"));
            await RunGitAsync(Path.Combine(f.Tree.Path, "nested"), ["init"]);
        }
        var unrelated = Path.Combine(f.F.Root, "keep-outside-workspace");
        Directory.CreateDirectory(unrelated);
        await File.WriteAllTextAsync(Path.Combine(unrelated, "keep.txt"), "preserved");
        if (!OperatingSystem.IsWindows()) Directory.CreateSymbolicLink(Path.Combine(f.Tree.Path, "external-link"), unrelated);
        var removed = await DeleteCleanup(f).ApplyDeleteAsync(f.Tree.WorkspaceId, "another-admin", null,
            new(Guid.NewGuid().ToString()), default);
        Assert.True(removed.State == "removed", removed.Error);
        Assert.False(Directory.Exists(f.Tree.Path));
        Assert.True(File.Exists(Path.Combine(unrelated, "keep.txt")));
    }

    [Fact]
    public async Task WorkspaceDelete_RetryDoesNotDeleteRecreatedAllocationOrExpandBatch()
    {
        using var f = await DiscardFixtureAsync();
        var cleanup = DeleteCleanup(f);
        var command = new WorkspaceDeleteBatchCommand(Guid.NewGuid().ToString(), All: true);
        var first = await cleanup.DeleteBatchAsync("admin", null, command, default);
        Assert.Equal("removed", Assert.Single(first.Targets).State);
        var recreated = await f.Service.PrepareAsync(f.Owner, WorkspaceRequest() with { RequestId = Guid.NewGuid().ToString() }, default);
        var other = await f.Service.PrepareAsync(WorkspaceTestOwner(f.F, "later-session"), WorkspaceRequest("later-session"), default);
        await File.WriteAllTextAsync(Path.Combine(recreated.Path, "keep.txt"), "new work");
        var replay = await cleanup.DeleteBatchAsync("another-admin", null, command, default);
        Assert.Single(replay.Targets);
        Assert.True(File.Exists(Path.Combine(recreated.Path, "keep.txt")));
        Assert.True(Directory.Exists(other.Path));
        var singleReplay = await cleanup.ApplyDeleteAsync(recreated.WorkspaceId, "admin", null, new(first.Targets[0].RequestId), default);
        Assert.Equal("removed", singleReplay.State);
        Assert.True(Directory.Exists(recreated.Path));
    }

    [Fact]
    public async Task WorkspaceDelete_PathReplacementFailureRetainsRequestAndCanBeRetried()
    {
        if (OperatingSystem.IsWindows()) return;
        using var f = await DiscardFixtureAsync();
        var cleanup = DeleteCleanup(f);
        var request = new WorkspaceDeleteCommand(Guid.NewGuid().ToString());
        var saved = f.Tree.Path + ".saved";
        var unrelated = Path.Combine(f.F.Root, "unrelated-data");
        Directory.CreateDirectory(unrelated);
        await File.WriteAllTextAsync(Path.Combine(unrelated, "keep.txt"), "preserve");
        Directory.Move(f.Tree.Path, saved);
        Directory.CreateSymbolicLink(f.Tree.Path, unrelated);
        var pending = await cleanup.ApplyDeleteAsync(f.Tree.WorkspaceId, "admin", null, request, default);
        Assert.Equal("pending", pending.State);
        Assert.NotNull(pending.Error);
        Assert.Equal(request.RequestId, pending.RequestId);
        Assert.True(File.Exists(Path.Combine(unrelated, "keep.txt")));
        Directory.Delete(f.Tree.Path);
        Directory.Move(saved, f.Tree.Path);
        var deleted = await cleanup.ApplyDeleteAsync(f.Tree.WorkspaceId, "another-admin", null, request, default);
        Assert.True(deleted.State == "removed", deleted.Error);
        Assert.True(File.Exists(Path.Combine(unrelated, "keep.txt")));
    }
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task WorkspaceDelete_AnotherUserFinishesOnlyAcceptedResourcesAndRetriesRealFailure(bool legacySessionContext)
    {
        using var f = await DiscardFixtureAsync(external: !legacySessionContext);
        var resourceOwner = legacySessionContext ? new SandboxActor(f.Owner.UserId, f.Owner.AppId, f.Owner.Installation) : new("admin");
        var context = legacySessionContext ? new SandboxContext(SessionId: f.Owner.SessionId) : new(WorkspaceId: f.Tree.WorkspaceId);
        var store = new CoreEnvironmentStore(f.F.Paths);
        var runtime = new ResourceControlRuntime();
        var environments = new CoreEnvironmentService(store, runtime, f.F.Clock, f.Service);
        var cleanup = new WorkspaceCleanupService(f.F.Paths, new(f.Service, f.F.Apps, f.F.Clock), f.Service, null!, f.F.Apps,
            store, environments, new(store, environments));
        var child = await environments.CreateAsync(resourceOwner, new(Guid.NewGuid().ToString(), "Owned test data",
            Context: context, WorktreeIds: [f.Tree.Id]), default);
        var unrelated = await environments.CreateAsync(new("admin"), new(Guid.NewGuid().ToString(), "Unrelated data"), default);
        var command = new WorkspaceDeleteCommand(Guid.NewGuid().ToString());
        runtime.FailStop = true;
        var pending = await cleanup.ApplyDeleteAsync(f.Tree.WorkspaceId, "another-admin", null, command, default);
        Assert.Equal("pending", pending.State);
        Assert.True(Directory.Exists(f.Tree.Path));
        var accepted = await f.Service.ReadDiscardAsync(f.Tree.WorkspaceId, command.RequestId, "another-admin", default);
        Assert.Equal("another-admin", accepted!.Actor);
        var ids = accepted.Cleanup.Select(r => r.RequestId).ToArray();
        runtime.FailStop = false;
        var removed = await cleanup.ApplyDeleteAsync(f.Tree.WorkspaceId, "third-admin", null, command, default);
        Assert.True(removed.State == "removed", removed.Error);
        Assert.Equal("finished", (await environments.ReadAsync(new("admin"), child.Id, default)).State);
        Assert.True(Directory.Exists(unrelated.DataRoot));
        Assert.Single((await store.ReadAsync(child.Id, default))!.Operations!, op => ids.Contains(Guid.Parse(op.Id).ToString("D")));
        Assert.DoesNotContain("deletingWorkspace", CoreJson.Text(new SandboxActor("admin") { DeletingWorkspace = f.Tree.WorkspaceId }), StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task WorkspaceDelete_ReturnsActiveDevRuntimeAndPreservesChangedOrdinaryData(bool running)
    {
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture(shortPaths: true);
        try
        {
            if (running) await f.Service.StartAsync("test.created");
            var before = (await f.Apps.GetAppAsync("test.created"))!;
            var data = Path.Combine(f.Paths.AppsRoot, "test.created", "data", "notes.txt");
            Directory.CreateDirectory(Path.GetDirectoryName(data)!);
            await File.WriteAllTextAsync(data, "before development");
            await ApplyReviewedDev(f.Service, DevRequest("enter", tree.Id), DevActor(owner));
            await File.WriteAllTextAsync(data, "ordinary data changed during development");
            await File.WriteAllTextAsync(Path.Combine(tree.Path, "unfinished.txt"), "discard this source");
            var store = new CoreEnvironmentStore(f.Paths);
            var environments = new CoreEnvironmentService(store, new ResourceControlRuntime(), f.Clock, workspaces);
            var cleanup = new WorkspaceCleanupService(f.Paths, new(workspaces, f.Apps, f.Clock), workspaces, null!, f.Apps,
                store, environments, new(store, environments), f.Service);

            var removed = await cleanup.ApplyDeleteAsync(tree.WorkspaceId, "another-admin", null,
                new(Guid.NewGuid().ToString()), default);

            Assert.True(removed.State == "removed", removed.Error);
            Assert.False(Directory.Exists(tree.Path));
            Assert.Equal("returned", (await f.Service.GetDevModeAsync("test.created")).Phase);
            var after = (await f.Apps.GetAppAsync("test.created"))!;
            Assert.Equal(before.SourceState, after.SourceState);
            Assert.Equal(running ? "running" : "stopped", after.RuntimeState);
            Assert.Equal("ordinary data changed during development", await File.ReadAllTextAsync(data));
        }
        finally { CoreOwnedDirectoryCleanup.Delete(f.Root); }
    }

    [Fact]
    public async Task WorkspaceDelete_StopsManagedSourceConsumerAndKeepsOrdinaryData()
    {
        using var f = await DiscardFixtureAsync();
        var app = (await f.F.Apps.GetAppAsync(SourceTestApp))!;
        await f.F.Apps.UpsertAppAsync(app with { SourceState = app.SourceState! with { LocalOverridePath = f.Tree.Path } });
        var store = new CoreEnvironmentStore(f.F.Paths);
        var environments = new CoreEnvironmentService(store, new ResourceControlRuntime(), f.F.Clock, f.Service);
        var cleanup = new WorkspaceCleanupService(f.F.Paths, new(f.Service, f.F.Apps, f.F.Clock), f.Service, null!, f.F.Apps,
            store, environments, new(store, environments), f.F.Service);
        var command = new WorkspaceDeleteCommand(Guid.NewGuid().ToString());
        f.F.Adapter.FailOnStopCount = f.F.Adapter.StopCount + 1;
        var pending = await cleanup.ApplyDeleteAsync(f.Tree.WorkspaceId, "admin", null, command, default);
        Assert.Equal("pending", pending.State);
        Assert.True(Directory.Exists(f.Tree.Path));
        Assert.DoesNotContain(pending.Activity ?? [], a => a.Kind == "runtime" && a.State == "stopped");
        f.F.Adapter.FailOnStopCount = null;
        var removed = await cleanup.ApplyDeleteAsync(f.Tree.WorkspaceId, "admin", null, command, default);
        Assert.True(removed.State == "removed", removed.Error);
        Assert.Contains(removed.Activity!, a => a.Reference == SourceTestApp && a.State == "stopped");
        Assert.NotNull(await f.F.Apps.GetAppAsync(SourceTestApp));
    }

}
