using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task WorkspaceWorkflow_RequiresExplicitCompletionAndSupportsResumeWithoutDeletingPreview()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        Assert.Equal("in-progress", (await service.WorkflowAsync(owner, default)).State);
        var sandbox = Guid.NewGuid().ToString("N");
        await service.SetSandboxConsumerAsync(tree.Id, sandbox, true, default);
        var command = new WorkspaceWorkflowCommand(Guid.NewGuid().ToString(), 0);
        var completed = await service.ChangeWorkflowAsync(owner, "admin", "complete", command, new Dictionary<string, string>(), default);
        Assert.Equal("completed", completed.State);
        Assert.NotNull(completed.CompletedAt);
        Assert.True(Directory.Exists(tree.Path));
        Assert.Contains(sandbox, (await service.Read(tree.Id, owner, default)).SandboxConsumers);
        service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        Assert.Equal(completed.Revision, (await service.ChangeWorkflowAsync(owner, "admin", "complete", command, new Dictionary<string, string>(), default)).Revision);
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.PrepareAsync(owner, WorkspaceRequest(), default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.CommandAsync(tree.Id, owner, "lease", new(Guid.NewGuid().ToString(), LeaseId: Guid.NewGuid().ToString()), default));
        var resumed = await service.ChangeWorkflowAsync(owner, "admin", "resume", new(Guid.NewGuid().ToString(), 1), new Dictionary<string, string>(), default);
        Assert.Equal("in-progress", resumed.State);
        Assert.Null(resumed.CompletedAt);
        Assert.True(Directory.Exists(tree.Path));
    }

    [Fact]
    public async Task WorkspaceWorkflow_PreservesDirtyUnmergedAndLeasedWorkAcrossAllRepositories()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        var app = (await f.Apps.GetAppAsync(SourceTestApp))!;
        var other = await CreateGitRepositoryAsync(Path.Combine(f.Root, "workflow-other"));
        await f.Apps.UpsertAppAsync(app with { Id = "example.other", SourceState = app.SourceState! with { Repository = other, LocalOverridePath = other } });
        var second = await service.PrepareAsync(owner, WorkspaceRequest() with { AppId = "example.other" }, default);
        Task<WorkspaceWorkflow> Complete() => service.ChangeWorkflowAsync(owner, "admin", "complete", new(Guid.NewGuid().ToString(), 0), new Dictionary<string, string>(), default);
        await File.WriteAllTextAsync(Path.Combine(second.Path, "README.md"), "unfinished");
        Assert.Equal("workspace_dirty", (await Assert.ThrowsAsync<AppLifecycleException>(Complete)).Code);
        await service.CommandAsync(second.Id, owner, "commit", WorkspaceCommit(second.Observation!.Head!, "unmerged", "README.md"), default);
        Assert.Equal("workspace_unmerged", (await Assert.ThrowsAsync<AppLifecycleException>(Complete)).Code);
        var lease = Guid.NewGuid().ToString();
        await service.CommandAsync(tree.Id, owner, "lease", new(Guid.NewGuid().ToString(), LeaseId: lease), default);
        Assert.Equal("workspace_in_use", (await Assert.ThrowsAsync<AppLifecycleException>(Complete)).Code);
        Assert.True(Directory.Exists(second.Path));
        Assert.Equal("in-progress", (await service.WorkflowAsync(owner, default)).State);
    }

    [Fact]
    public async Task WorkspaceWorkflow_NewEditsInvalidateCompletionAndPreventDeletion()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        await service.ChangeWorkflowAsync(owner, "admin", "complete", new(Guid.NewGuid().ToString(), 0), new Dictionary<string, string>(), default);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "README.md"), "new work");
        await service.ObserveAsync(tree.Id, owner, default);
        var state = await service.WorkflowAsync(owner, default);
        Assert.Equal("in-progress", state.State);
        Assert.Null(state.CompletedAt);
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.ChangeWorkflowAsync(owner, "admin", "delete", new(Guid.NewGuid().ToString(), state.Revision), new Dictionary<string, string>(), default));
        Assert.True(File.Exists(Path.Combine(tree.Path, "README.md")));
    }

    [Fact]
    public async Task WorkspaceWorkflow_InterruptedDeleteRetainsIdentityAndRecoversAfterConsumerRelease()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        var sandbox = Guid.NewGuid().ToString("N");
        await service.SetSandboxConsumerAsync(tree.Id, sandbox, true, default);
        await service.ChangeWorkflowAsync(owner, "admin", "complete", new(Guid.NewGuid().ToString(), 0), new Dictionary<string, string>(), default);
        var delete = new WorkspaceWorkflowCommand(Guid.NewGuid().ToString(), 1);
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.ChangeWorkflowAsync(owner, "admin", "delete", delete, new Dictionary<string, string>(), default));
        Assert.True(Directory.Exists(tree.Path));
        service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        Assert.Equal("deleting", (await service.WorkflowAsync(owner, default)).State);
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.ChangeWorkflowAsync(owner, "admin", "resume", new(Guid.NewGuid().ToString(), 1), new Dictionary<string, string>(), default));
        await service.SetSandboxConsumerAsync(tree.Id, sandbox, false, default);
        var done = await service.ChangeWorkflowAsync(owner, "admin", "delete", delete, new Dictionary<string, string>(), default);
        Assert.Equal("deleted", done.State);
        Assert.False(Directory.Exists(tree.Path));
        Assert.Equal("released", (await service.Read(tree.Id, owner, default)).State);
        Assert.Equal(CoreJson.Text(done), CoreJson.Text(await service.ChangeWorkflowAsync(owner, "admin", "delete", delete, new Dictionary<string, string>(), default)));
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.ChangeWorkflowAsync(owner, "admin", "resume", delete, new Dictionary<string, string>(), default));
    }

    [Fact]
    public async Task WorkspaceWorkflow_LegacyReleasedMergedSourceCanBeExplicitlyCompletedAndDeleted()
    {
        var (f, _) = await SourceFixtureAsync(); var owner = WorkspaceTestOwner(f);
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        await service.CommandAsync(tree.Id, owner, "cleanup", new(Guid.NewGuid().ToString(), ExpectedHead: tree.Observation!.Head), default);
        Assert.Equal("in-progress", (await service.WorkflowAsync(owner, default)).State);
        var done = await service.ChangeWorkflowAsync(owner, "admin", "complete", new(Guid.NewGuid().ToString(), 0), new Dictionary<string, string>(), default);
        Assert.Equal("completed", done.State);
        Assert.Equal("deleted", (await service.ChangeWorkflowAsync(owner, "admin", "delete", new(Guid.NewGuid().ToString(), done.Revision), new Dictionary<string, string>(), default)).State);
    }

    [Fact]
    public async Task WorkspaceWorkflow_DeletingFencesContextOnlyResourcesAndRequiresOriginalRequest()
    {
        var (f, _) = await SourceFixtureAsync(); var owner = WorkspaceTestOwner(f);
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        await service.ChangeWorkflowAsync(owner, "admin", "complete", new(Guid.NewGuid().ToString(), 0), new Dictionary<string, string>(), default);
        var request = new WorkspaceWorkflowCommand(Guid.NewGuid().ToString(), 1);
        await service.ChangeWorkflowAsync(owner, "admin", "delete", request, new Dictionary<string, string>(), default, prepareOnly: true);
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.ChangeWorkflowAsync(owner, "admin", "delete", new(Guid.NewGuid().ToString(), 1), new Dictionary<string, string>(), default));
        var calls = 0;
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.WithResourceContextAsync(new(owner.UserId), new(WorkspaceId: tree.WorkspaceId), () => Task.FromResult(++calls), default));
        Assert.Equal(0, calls);
        Assert.Equal(1, await service.WithResourceContextAsync(new(owner.UserId), null, () => Task.FromResult(++calls), default));
        await service.ChangeWorkflowAsync(owner, "admin", "delete", request, new Dictionary<string, string>(), default);
    }
}
