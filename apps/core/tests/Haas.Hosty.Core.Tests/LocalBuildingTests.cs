using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task LocalBuilding_ReusesExistingTreeAndStartsNewTreeFromAcceptedMainWithoutLosingWork()
    {
        var (f, owner, service, tree, created, request) = await LocalHandoffFixture();
        await f.Service.HandoffLocalAppAsync(owner, "test.created", "accept", request, service, default);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "unfinished.txt"), "keep the old work");
        var same = await service.PrepareAsync(owner, new(Guid.NewGuid().ToString(), owner.SessionId, "test.created", "/assistant"), default);
        Assert.Equal(tree.Path, same.Path);
        var next = owner with { SessionId = "next" };
        var prepared = await service.PrepareAsync(next, new(Guid.NewGuid().ToString(), next.SessionId, "test.created", "/assistant",
            ExpectedLocalHead: request.ExpectedHead), default);
        Assert.NotEqual(tree.Id, prepared.Id);
        Assert.Equal(request.ExpectedHead, prepared.OriginalBase);
        Assert.Equal("accepted source", await File.ReadAllTextAsync(Path.Combine(prepared.Path, "feature.txt")));
        Assert.False(File.Exists(Path.Combine(prepared.Path, "unfinished.txt")));
        Assert.Equal("keep the old work", await File.ReadAllTextAsync(Path.Combine(tree.Path, "unfinished.txt")));
        var app = Assert.Single(await f.Service.ReadLocalBuildingAppsAsync(owner.UserId, service, default));
        Assert.False(app.Work.Single(w => w.WorktreeId == tree.Id).Accepted);
        Assert.True(app.Work.Single(w => w.WorktreeId == prepared.Id).Accepted);
        Assert.Empty(Assert.Single(await f.Service.ReadLocalBuildingAppsAsync("other-user", service, default)).Work);
        var stale = owner with { SessionId = "stale" };
        Assert.Equal("workspace_local_head_changed", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            service.PrepareAsync(stale, new(Guid.NewGuid().ToString(), stale.SessionId, "test.created", "/assistant",
                ExpectedLocalHead: created.Operation.Commit), default))).Code);
        Assert.Equal(2, (await service.ListAsync(null, false, default)).Workspaces.Length);
    }

    [Fact]
    public async Task LocalBuilding_SourceReplacementAndClearingPreserveCanonicalAndOutstandingWork()
    {
        var (f, owner, service, tree, created, _) = await LocalHandoffFixture();
        var alternate = f.Paths.DataRoot + "-alternate";
        Directory.CreateDirectory(alternate);
        try
        {
        await File.WriteAllTextAsync(Path.Combine(alternate, "alternate.txt"), "operator source");
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "unfinished.txt"), "unfinished");
        await f.Sources.SetLocalOverrideAsync("test.created", new(alternate));
        Assert.Contains("Another source", Assert.Single(await f.Service.ReadLocalBuildingAppsAsync(owner.UserId, service, default)).Unavailable);
        var next = owner with { SessionId = "next" };
        Assert.Equal("workspace_local_source_unavailable", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            service.PrepareAsync(next, new(Guid.NewGuid().ToString(), next.SessionId, "test.created", "/assistant"), default))).Code);
        // Existing work remains the same repository even when the runtime source changes.
        Assert.Equal(tree.Path, (await service.PrepareAsync(owner,
            new(Guid.NewGuid().ToString(), owner.SessionId, "test.created", "/assistant"), default)).Path);
        await f.Sources.ClearLocalOverrideAsync("test.created");
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        Assert.Equal(created.Operation.SourcePath, app.SourceState!.LocalOverridePath);
        Assert.Equal(created.Operation.SourcePath, app.SourceState.Repository);
        Assert.Equal(created.Operation.Commit, (await DevelopmentWorkspaceService.Git(created.Operation.SourcePath, ["rev-parse", "HEAD"], default)).StandardOutput.Trim());
        Assert.Equal("unfinished", await File.ReadAllTextAsync(Path.Combine(tree.Path, "unfinished.txt")));
        Assert.Equal("operator source", await File.ReadAllTextAsync(Path.Combine(alternate, "alternate.txt")));
        Assert.Null(Assert.Single(await f.Service.ReadLocalBuildingAppsAsync(owner.UserId, service, default)).Unavailable);
        await service.PrepareAsync(next, new(Guid.NewGuid().ToString(), next.SessionId, "test.created", "/assistant"), default);
        }
        finally { Directory.Delete(alternate, true); }
    }

    [Fact]
    public async Task LocalBuilding_CompletedWorktreeDeletionRetainsSourceAndAllowsAnotherSession()
    {
        var (f, owner, service, tree, created, request) = await LocalHandoffFixture();
        await f.Service.HandoffLocalAppAsync(owner, "test.created", "accept", request, service, default);
        var complete = await service.ChangeWorkflowAsync(owner, owner.UserId, "complete",
            new(Guid.NewGuid().ToString(), 0), new Dictionary<string, string>(), default);
        var deleted = await service.ChangeWorkflowAsync(owner, owner.UserId, "delete",
            new(Guid.NewGuid().ToString(), complete.Revision), new Dictionary<string, string>(), default);
        Assert.Equal("deleted", deleted.State);
        Assert.False(Directory.Exists(tree.Path));
        Assert.Equal("accepted source", await File.ReadAllTextAsync(Path.Combine(created.Operation.SourcePath, "feature.txt")));
        var app = Assert.Single(await f.Service.ReadLocalBuildingAppsAsync(owner.UserId, service, default));
        Assert.Empty(app.Work);
        var next = owner with { SessionId = "after-chat-deletion" };
        Assert.Equal(request.ExpectedHead, (await service.PrepareAsync(next,
            new(Guid.NewGuid().ToString(), next.SessionId, "test.created", "/assistant", ExpectedLocalHead: app.AcceptedHead), default)).OriginalBase);
    }
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task LocalBuilding_UninstallKeepingSourcePreservesDirtyCanonicalAndUnacceptedWork(bool deleteData)
    {
        var (f, owner, service, tree, created, _) = await LocalHandoffFixture();
        var canonicalFile = Path.Combine(created.Operation.SourcePath, "operator.txt");
        var worktreeFile = Path.Combine(tree.Path, "unfinished.txt");
        await File.WriteAllTextAsync(canonicalFile, "operator changes");
        await File.WriteAllTextAsync(worktreeFile, "uncommitted agent changes");
        var head = tree.Observation!.Head;
        await f.Service.RemoveAsync("test.created", new(DeleteData: deleteData, DeleteSource: false));
        Assert.Equal("operator changes", await File.ReadAllTextAsync(canonicalFile));
        Assert.Equal("uncommitted agent changes", await File.ReadAllTextAsync(worktreeFile));
        Assert.Equal("accepted source", await File.ReadAllTextAsync(Path.Combine(tree.Path, "feature.txt")));
        Assert.Equal(head, (await DevelopmentWorkspaceService.Git(tree.Path, ["rev-parse", "HEAD"], default)).StandardOutput.Trim());
        Assert.Equal(created.Operation.Commit, (await DevelopmentWorkspaceService.Git(created.Operation.SourcePath, ["rev-parse", "HEAD"], default)).StandardOutput.Trim());
        var restarted = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        await Assert.ThrowsAsync<AppLifecycleException>(() => restarted.ChangeWorkflowAsync(owner, owner.UserId, "delete",
            new(Guid.NewGuid().ToString(), 0), new Dictionary<string, string>(), default));
        Assert.True(Directory.Exists(tree.Path));
    }

}
