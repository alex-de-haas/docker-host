using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Theory]
    [InlineData("pause")]
    [InlineData("close")]
    [InlineData("defer")]
    public async Task WorkspacePause_AliasesPreserveCompletionAndReplay(string action)
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        var heads = new Dictionary<string, string>();
        var completed = await service.ChangeWorkflowAsync(owner, "admin", "complete", new(Guid.NewGuid().ToString(), 0), heads, default);
        var request = new WorkspaceWorkflowCommand(Guid.NewGuid().ToString(), completed.Revision);
        var pausing = await service.ChangeWorkflowAsync(owner, "admin", action, request, heads, default, prepareOnly: true);
        Assert.Equal("closing", pausing.Closure);
        var paused = await service.ChangeWorkflowAsync(owner, "admin", action, request, heads, default);
        Assert.Equal("closed", paused.Closure);
        Assert.Equal("completed", paused.State);
        Assert.Equal(completed.CompletedAt, paused.CompletedAt);
        Assert.Equal(completed.Heads, paused.Heads);
        Assert.Equal(action, paused.Operations!.Last().Kind);
        service = new(f.Paths, f.Apps, f.Clock);
        Assert.Equal(CoreJson.Text(paused), CoreJson.Text(await service.ChangeWorkflowAsync(owner, "admin", action, request, heads, default)));
        Assert.True(Directory.Exists(tree.Path));
    }

    [Theory]
    [InlineData("in-progress", null, true)]
    [InlineData("completed", null, false)]
    [InlineData("deferred", null, false)]
    [InlineData("in-progress", "closing", false)]
    [InlineData("in-progress", "closed", false)]
    [InlineData("completed", "closed", false)]
    [InlineData("deleting", null, false)]
    public async Task WorkspacePause_BackgroundTickLeavesInactiveRecordsUntouched(string state, string? closure, bool active)
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        await JsonStorage.WriteAsync(Path.Combine(f.Paths.CoreRoot, "development/workflows", DevelopmentWorkspaceService.Hash(DevelopmentWorkspaceService.OwnerIdentity(owner)) + ".json"),
            new WorkspaceWorkflow(State: state, Closure: closure));
        var path = Path.Combine(f.Paths.CoreRoot, "development/workspaces", tree.Id + ".json");
        var before = await File.ReadAllTextAsync(path);
        Directory.Move(tree.Path, tree.Path + "-missing");
        f.Clock.UtcNow += TimeSpan.FromMinutes(1);
        await service.ObserveAvailableAsync(tree.Id, default);
        if (active) Assert.Equal("unavailable", (await service.Read(tree.Id, owner, default)).Observation!.State);
        else Assert.Equal(before, await File.ReadAllTextAsync(path));
        Assert.Equal(state, (await service.WorkflowAsync(owner, default)).State);
    }

    [Fact]
    public async Task WorkspacePause_ResumeFetchesTargetAndObservesDirtySourceBeforeOpening()
    {
        var (f, repository) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        var heads = new Dictionary<string, string>();
        var paused = await service.ChangeWorkflowAsync(owner, "admin", "pause", new(Guid.NewGuid().ToString(), 0), heads, default);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "unfinished.txt"), "preserve this work");
        await File.WriteAllTextAsync(Path.Combine(repository, "upstream.txt"), "new target");
        await RunGitAsync(repository, ["add", "upstream.txt"]);
        await RunGitAsync(repository, ["commit", "-m", "Advance target"]);
        f.Clock.UtcNow += TimeSpan.FromMinutes(1);
        await service.ObserveAvailableAsync(tree.Id, default);
        Assert.DoesNotContain((await service.Read(tree.Id, owner, default)).Observation!.Local!.Files, file => file.Path == "unfinished.txt");
        var resumed = await service.ChangeWorkflowAsync(owner, "admin", "resume", new(Guid.NewGuid().ToString(), paused.Revision), heads, default);
        Assert.Equal("in-progress", resumed.State); Assert.Null(resumed.Closure);
        var observed = (await service.Read(tree.Id, owner, default)).Observation!;
        Assert.Equal(f.Clock.UtcNow, observed.At);
        Assert.NotEqual(tree.Observation!.TargetHead, observed.TargetHead);
        Assert.Contains(observed.Local!.Files, file => file.Path == "unfinished.txt");
        Assert.Equal("preserve this work", await File.ReadAllTextAsync(Path.Combine(tree.Path, "unfinished.txt")));
    }

    [Fact]
    public async Task WorkspacePause_UnavailableResumeKeepsFenceAndCanRetryAfterRepair()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        var heads = new Dictionary<string, string>();
        var paused = await service.ChangeWorkflowAsync(owner, "admin", "pause", new(Guid.NewGuid().ToString(), 0), heads, default);
        Directory.Move(tree.Path, tree.Path + "-missing");
        var request = new WorkspaceWorkflowCommand(Guid.NewGuid().ToString(), paused.Revision);
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.ChangeWorkflowAsync(owner, "admin", "resume", request, heads, default));
        Assert.Equal("closed", (await service.WorkflowAsync(owner, default)).Closure);
        Directory.Move(tree.Path + "-missing", tree.Path);
        Assert.Null((await service.ChangeWorkflowAsync(owner, "admin", "resume", request, heads, default)).Closure);
    }

    [Fact]
    public async Task WorkspacePause_CompleteAndDeleteRecheckInactiveSourceWithoutReopening()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        var heads = new Dictionary<string, string>();
        var paused = await service.ChangeWorkflowAsync(owner, "admin", "pause", new(Guid.NewGuid().ToString(), 0), heads, default);
        var complete = new WorkspaceWorkflowCommand(Guid.NewGuid().ToString(), paused.Revision);
        var file = Path.Combine(tree.Path, "late.txt");
        await File.WriteAllTextAsync(file, "late edit");
        Assert.Equal("workspace_dirty", (await Assert.ThrowsAsync<AppLifecycleException>(() => service.ChangeWorkflowAsync(owner, "admin", "complete", complete, heads, default))).Code);
        File.Delete(file);
        var completed = await service.ChangeWorkflowAsync(owner, "admin", "complete", complete, heads, default);
        await File.WriteAllTextAsync(file, "another late edit");
        Assert.Equal("workspace_dirty", (await Assert.ThrowsAsync<AppLifecycleException>(() => service.ChangeWorkflowAsync(owner, "admin", "delete",
            new(Guid.NewGuid().ToString(), completed.Revision), heads, default))).Code);
        Assert.Equal("completed", (await service.WorkflowAsync(owner, default)).State);
        Assert.Equal("closed", (await service.WorkflowAsync(owner, default)).Closure);
        Assert.True(File.Exists(file));
    }
    [Theory]
    [InlineData("completed", null)]
    [InlineData("deferred", null)]
    [InlineData("in-progress", "closing")]
    [InlineData("in-progress", "closed")]
    public async Task WorkspacePause_BackgroundPublicationSkipsInactiveButExplicitEvidenceIsFresh(string state, string? closure)
    {
        var f = await PublicationFixture();
        await f.Service.CommandAsync(f.W.Id, f.W.Owner, "publish", new(Guid.NewGuid().ToString(), f.W.Observation!.Head!, Title: "Contribution"), default);
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development/workflows", DevelopmentWorkspaceService.Hash(DevelopmentWorkspaceService.OwnerIdentity(f.W.Owner)) + ".json"),
            new WorkspaceWorkflow(State: state, Closure: closure));
        var before = f.Provider.Observed;
        await f.Service.ObserveInBackgroundAsync(f.W.Id, default);
        Assert.Equal(before, f.Provider.Observed);
        await f.Service.MergedWorkspaceHeadsAsync(f.W.Owner, default);
        Assert.True(f.Provider.Observed > before);
    }

    [Fact]
    public async Task WorkspacePause_ExternalBatchStopsQueuedRequestsAfterPause()
    {
        var f = await ExternalPublicationFixture();
        var tree = f.W with { PullRequests = [.. f.W.PullRequests, "https://github.com/owner/repo/pull/43"] };
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development/workspaces", tree.Id + ".json"), tree);
        f.Provider.BeforeObserve = (_, _) => JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development/workflows",
            DevelopmentWorkspaceService.Hash(DevelopmentWorkspaceService.OwnerIdentity(tree.Owner)) + ".json"), new WorkspaceWorkflow(Closure: "closing"));
        await f.Service.RefreshExternalReferencesAsync(default);
        Assert.Equal(1, f.Provider.Observed);
        await f.Service.RefreshExternalReferencesAsync(default);
        Assert.Equal(1, f.Provider.Observed);
        f.Provider.BeforeObserve = null;
        await f.Service.MergedWorkspaceHeadsAsync(tree.Owner, default);
        Assert.Equal(3, f.Provider.Observed);
    }

    [Fact]
    public async Task WorkspacePause_CompletionEvidenceUsesFreshHeadAcrossMultiplePullRequests()
    {
        var f = await ExternalPublicationFixture();
        var tree = f.W with { PullRequests = [.. f.W.PullRequests, "https://github.com/owner/repo/pull/43"] };
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development/workspaces", tree.Id + ".json"), tree);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "later.txt"), "new source");
        await RunGitAsync(tree.Path, ["add", "later.txt"]);
        await RunGitAsync(tree.Path, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "Later work"]);
        var currentHead = (await DevelopmentWorkspaceService.Git(tree.Path, ["rev-parse", "HEAD"], default)).StandardOutput.Trim();
        f.Provider.BeforeObserve = (record, _) => {
            f.Provider.Head = record.Number == 42 ? currentHead : tree.Observation!.Head!;
            return Task.CompletedTask;
        };
        f.Provider.State = "merged"; f.Provider.Complete = true;
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development/workflows",
            DevelopmentWorkspaceService.Hash(DevelopmentWorkspaceService.OwnerIdentity(tree.Owner)) + ".json"), new WorkspaceWorkflow(Closure: "closed"));
        var heads = await f.Service.MergedWorkspaceHeadsAsync(tree.Owner, default);
        Assert.NotEqual(currentHead, tree.Observation!.Head);
        Assert.Equal(currentHead, heads[tree.Id]);
        Assert.Equal("closed", (await f.Workspaces.WorkflowAsync(tree.Owner, default)).Closure);
    }

    [Fact]
    public async Task WorkspacePause_BackgroundCleanupDoesNotScanAfterPauseDuringProviderRequest()
    {
        var f = await PublicationFixture();
        var head = f.W.Observation!.Head!;
        await f.Service.CommandAsync(f.W.Id, f.W.Owner, "publish", new(Guid.NewGuid().ToString(), head, Title: "Contribution"), default);
        await f.Service.CommandAsync(f.W.Id, f.W.Owner, "complete", new(Guid.NewGuid().ToString(), head, Outcome: "submitted", Cleanup: true), default);
        var before = CoreJson.Text((await f.Workspaces.Read(f.W.Id, f.W.Owner, default)).Observation);
        f.Provider.BeforeObserve = async (_, _) => {
            await f.Workspaces.ChangeWorkflowAsync(f.W.Owner, "admin", "pause", new(Guid.NewGuid().ToString(), 0), new Dictionary<string, string>(), default);
            Directory.Move(f.W.Path, f.W.Path + "-unavailable");
        };
        await f.Service.CleanupAsync(f.W.Id, default, background: true);
        Assert.Equal(before, CoreJson.Text((await f.Workspaces.Read(f.W.Id, f.W.Owner, default)).Observation));
        Assert.True(Directory.Exists(f.W.Path + "-unavailable"));
    }

    [Fact]
    public async Task WorkspacePause_LegacyDeferredRecordsUseTheSameAdmissionFence()
    {
        var f = await PublicationFixture();
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development/workflows",
            DevelopmentWorkspaceService.Hash(DevelopmentWorkspaceService.OwnerIdentity(f.W.Owner)) + ".json"), new WorkspaceWorkflow(State: "deferred"));
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Workspaces.CommandAsync(f.W.Id, f.W.Owner, "lease",
            new(Guid.NewGuid().ToString(), LeaseId: Guid.NewGuid().ToString()), default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Workspaces.WithResourceContextAsync(new(f.W.Owner.UserId), new(WorkspaceId: f.W.WorkspaceId), () => Task.FromResult(true), default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Workspaces.SetSandboxConsumerAsync(f.W.Id, Guid.NewGuid().ToString("N"), true, default));
        await Assert.ThrowsAsync<PublicationException>(() => f.Service.CommandAsync(f.W.Id, f.W.Owner, "ready",
            new(Guid.NewGuid().ToString(), f.W.Observation!.Head!), default));
        var resumed = await f.Workspaces.ChangeWorkflowAsync(f.W.Owner, "admin", "resume", new(Guid.NewGuid().ToString(), 0), new Dictionary<string, string>(), default);
        Assert.Equal("in-progress", resumed.State);
        Assert.Null(resumed.Closure);
    }

}
