using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static async Task<DevelopmentWorkspace> DeletedTree(DevelopmentWorkspaceService service, WorkspaceOwner owner, string session)
    {
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(session), default);
        var complete = await service.ChangeWorkflowAsync(owner, owner.UserId, "complete", new(Guid.NewGuid().ToString(), 0), new Dictionary<string, string>(), default);
        await service.ChangeWorkflowAsync(owner, owner.UserId, "delete", new(Guid.NewGuid().ToString(), complete.Revision), new Dictionary<string, string>(), default);
        return await service.Read(tree.Id, owner, default);
    }

    [Fact]
    public async Task WorkspaceDeletion_RemovesOnlyCompletedOwnersAndAllTheirMetadata()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var tree = await DeletedTree(service, owner, owner.SessionId);
        var activeOwner = WorkspaceTestOwner(f, "active");
        var active = await service.PrepareAsync(activeOwner, WorkspaceRequest("active"), default);
        var root = Path.Combine(f.Paths.CoreRoot, "development");
        var publication = Path.Combine(root, "publications", tree.Id + ".json");
        var external = Path.Combine(root, "publications", "external", tree.Id + ".json");
        var review = Path.Combine(root, "publications", "review-operations", tree.Id + ".json");
        var activeReview = Path.Combine(root, "publications", "review-operations", active.Id + ".json");
        Directory.CreateDirectory(Path.GetDirectoryName(external)!);
        Directory.CreateDirectory(Path.GetDirectoryName(review)!);
        await File.WriteAllTextAsync(publication, "{}"); await File.WriteAllTextAsync(external, "{}");
        await File.WriteAllTextAsync(review, "private review request metadata");
        await File.WriteAllTextAsync(activeReview, "active owner's review request metadata");
        var job = new WorkspaceCleanupJob(tree.WorkspaceId, owner.UserId, new(Guid.NewGuid().ToString(), 1), []);
        var jobPath = Path.Combine(root, "cleanup", job.Input.RequestId + ".json");
        await JsonStorage.WriteAsync(jobPath, job);
        Assert.Equal(owner, Assert.Single(await service.DeletedOwnersAsync(default)));
        Assert.False(await service.CanObservePublicationAsync(tree.Id, default));
        await service.FinalizeDeletionAsync(owner, default);
        Assert.Empty((await service.ListAsync(owner, true, default)).Workspaces);
        Assert.Empty(await service.DeletedOwnersAsync(default));
        Assert.False(File.Exists(publication)); Assert.False(File.Exists(external)); Assert.False(File.Exists(review)); Assert.False(File.Exists(jobPath));
        Assert.Equal("active owner's review request metadata", await File.ReadAllTextAsync(activeReview));
        Assert.Empty(Directory.EnumerateFiles(Path.Combine(root, "workflows"), "*.json"));
        Assert.Empty(Directory.EnumerateFiles(Path.Combine(root, "deletions"), "*.json"));
        Assert.True(Directory.Exists(Path.Combine(root, "repositories", tree.RepositoryId + ".git")));
        Assert.True(Directory.Exists(active.Path));
        Assert.Equal("active", (await service.Read(active.Id, activeOwner, default)).State);
        Assert.True(await service.CanObservePublicationAsync(active.Id, default));
        Assert.True(await service.SessionWorkspaceAbsentAsync(owner, default));
        var invoked = false;
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.WithResourceContextAsync(new(owner.UserId),
            new(WorkspaceId: tree.WorkspaceId), () => { invoked = true; return Task.FromResult(true); }, default));
        Assert.False(invoked);
    }

    [Fact]
    public async Task WorkspaceDeletion_RestartRecoversAfterWorktreeRecordsAreAlreadyGone()
    {
        var (f, _) = await SourceFixtureAsync(); var owner = WorkspaceTestOwner(f);
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var tree = await DeletedTree(service, owner, owner.SessionId);
        var root = Path.Combine(f.Paths.CoreRoot, "development");
        var jobPath = Path.Combine(root, "cleanup", Guid.NewGuid().ToString() + ".json");
        Directory.CreateDirectory(Path.GetDirectoryName(jobPath)!);
        await File.WriteAllTextAsync(jobPath, "invalid cleanup journal");
        // Failure after the durable deletion journal and worktree removal.
        await Assert.ThrowsAsync<System.Text.Json.JsonException>(() => service.FinalizeDeletionAsync(owner, default));
        Assert.Empty((await service.ListAsync(owner, true, default)).Workspaces);
        Assert.NotNull(await service.ReadDeletionAsync(tree.WorkspaceId, default));
        Assert.False(await service.SessionWorkspaceAbsentAsync(owner, default));
        var reinstalled = owner with { Installation = owner.Installation.AddSeconds(1) };
        Assert.False(await service.SessionWorkspaceAbsentAsync(reinstalled, default));
        Assert.True(await service.SessionWorkspaceAbsentAsync(reinstalled with { SessionId = "other-session" }, default));
        Assert.True(await service.SessionWorkspaceAbsentAsync(reinstalled with { UserId = "other-user" }, default));
        Assert.True(await service.SessionWorkspaceAbsentAsync(reinstalled with { AppId = "other-app" }, default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.PrepareAsync(owner, WorkspaceRequest(), default));
        File.Delete(jobPath);
        service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        Assert.Equal(owner, Assert.Single(await service.DeletedOwnersAsync(default)));
        await service.FinalizeDeletionAsync(owner, default);
        Assert.Null(await service.ReadDeletionAsync(tree.WorkspaceId, default));
        Assert.Empty(await service.DeletedOwnersAsync(default));
        Assert.True(await service.SessionWorkspaceAbsentAsync(reinstalled, default));
    }

    [Theory]
    [InlineData("source")]
    [InlineData("lease")]
    [InlineData("branch")]
    [InlineData("consumer")]
    [InlineData("operation")]
    public async Task WorkspaceDeletion_PreservesLegacyEvidenceWhenCleanupCannotBeVerified(string reason)
    {
        var (f, _) = await SourceFixtureAsync(); var owner = WorkspaceTestOwner(f);
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var tree = await DeletedTree(service, owner, owner.SessionId);
        var root = Path.Combine(f.Paths.CoreRoot, "development");
        if (reason == "source") Directory.CreateDirectory(tree.Path);
        if (reason == "branch") await RunGitAsync(Path.Combine(root, "repositories", tree.RepositoryId + ".git"), ["branch", tree.Branch, tree.OriginalBase]);
        if (reason == "lease") tree = tree with { Leases = [Guid.NewGuid().ToString()] };
        if (reason == "consumer") tree = tree with { SandboxConsumers = [Guid.NewGuid().ToString("N")] };
        if (reason == "operation") tree = tree with { Operations = [.. tree.Operations, new(Guid.NewGuid().ToString(), "commit", "args", "unknown")] };
        await JsonStorage.WriteAsync(Path.Combine(root, "workspaces", tree.Id + ".json"), tree);
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.FinalizeDeletionAsync(owner, default));
        Assert.NotNull(await service.Read(tree.Id, owner, default));
        Assert.Null(await service.ReadDeletionAsync(tree.WorkspaceId, default));
        Assert.Equal("deleted", (await service.WorkflowAsync(owner, default)).State);
    }

    [Theory]
    [InlineData("")]
    [InlineData("review-operations")]
    public async Task WorkspaceDeletion_LatePublicationWriteCannotRecreateRemovedRecords(string folder)
    {
        var (f, _) = await SourceFixtureAsync(); var owner = WorkspaceTestOwner(f);
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        var cache = Path.Combine(f.Paths.CoreRoot, "development", "publications", folder, tree.Id + ".json");
        var entered = new TaskCompletionSource(); var release = new TaskCompletionSource();
        var writing = service.WritePublicationAsync(tree.Id, async () => {
            entered.SetResult(); await release.Task;
            Directory.CreateDirectory(Path.GetDirectoryName(cache)!); await File.WriteAllTextAsync(cache, "{}");
        }, default);
        await entered.Task;
        await service.ChangeWorkflowAsync(owner, owner.UserId, "complete", new(Guid.NewGuid().ToString(), 0), new Dictionary<string, string>(), default);
        await service.ChangeWorkflowAsync(owner, owner.UserId, "delete", new(Guid.NewGuid().ToString(), 1), new Dictionary<string, string>(), default);
        var deleting = service.FinalizeDeletionAsync(owner, default);
        Assert.False(deleting.IsCompleted);
        release.SetResult(); Assert.True(await writing); await deleting;
        Assert.False(File.Exists(cache));
        Assert.False(await service.WritePublicationAsync(tree.Id, () => File.WriteAllTextAsync(cache, "late"), default));
        Assert.False(File.Exists(cache));
    }
    [Fact]
    public async Task WorkspaceDeletion_PartialMultiRepositoryPurgeRecoversWithoutLosingOwnership()
    {
        var (f, _) = await SourceFixtureAsync(); var owner = WorkspaceTestOwner(f);
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var first = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        var other = await CreateGitRepositoryAsync(Path.Combine(f.Root, "other-repository"));
        var app = (await f.Apps.GetAppAsync(SourceTestApp))!;
        await f.Apps.UpsertAppAsync(app with { Id = "example.other", SourceState = app.SourceState! with { Repository = other, LocalOverridePath = other } });
        var second = await service.PrepareAsync(owner, WorkspaceRequest() with { AppId = "example.other" }, default);
        await service.ChangeWorkflowAsync(owner, owner.UserId, "complete", new(Guid.NewGuid().ToString(), 0), new Dictionary<string, string>(), default);
        await service.ChangeWorkflowAsync(owner, owner.UserId, "delete", new(Guid.NewGuid().ToString(), 1), new Dictionary<string, string>(), default);
        var root = Path.Combine(f.Paths.CoreRoot, "development");
        var records = (await service.ListAsync(owner, true, default)).Workspaces;
        var blockedCache = Path.Combine(root, "publications", "external", records[1].Id + ".json");
        Directory.CreateDirectory(blockedCache);
        await Assert.ThrowsAsync<UnauthorizedAccessException>(() => service.FinalizeDeletionAsync(owner, default));
        Assert.Single((await service.ListAsync(owner, true, default)).Workspaces);
        Assert.Equal(2, (await service.ReadDeletionAsync(first.WorkspaceId, default))!.Worktrees.Length);
        Assert.False(Directory.Exists(first.Path)); Assert.False(Directory.Exists(second.Path));
        Directory.Delete(blockedCache);
        service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        await service.FinalizeDeletionAsync(owner, default);
        Assert.Empty((await service.ListAsync(owner, true, default)).Workspaces);
        Assert.Null(await service.ReadDeletionAsync(first.WorkspaceId, default));
    }

}
