using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task WorkspaceActivity_ObservationsAndReplayDoNotAdvanceButEditsAndOperationsDo()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var request = WorkspaceRequest();
        var tree = await service.PrepareAsync(owner, request, default);
        var initial = tree.UpdatedAt;
        Assert.Equal(f.Clock.UtcNow, initial);
        f.Clock.UtcNow += TimeSpan.FromHours(1);
        Assert.Equal(initial, (await service.ObserveAsync(tree.Id, owner, default)).UpdatedAt);
        Assert.Equal(initial, (await service.PrepareAsync(owner, request, default)).UpdatedAt);
        var file = Path.Combine(tree.Path, "README.md");
        await File.WriteAllTextAsync(file, "first change");
        var changed = await service.ObserveAsync(tree.Id, owner, default);
        Assert.Equal(f.Clock.UtcNow, changed.UpdatedAt);
        f.Clock.UtcNow += TimeSpan.FromHours(1);
        await File.WriteAllTextAsync(file, "second edit!");
        File.SetLastWriteTimeUtc(file, File.GetLastWriteTimeUtc(file).AddSeconds(1));
        changed = await service.ObserveAsync(tree.Id, owner, default);
        Assert.Equal(f.Clock.UtcNow, changed.UpdatedAt);
        f.Clock.UtcNow += TimeSpan.FromHours(1);
        Assert.Equal(changed.UpdatedAt, (await service.ObserveAsync(tree.Id, owner, default)).UpdatedAt);
        var command = new WorkspaceCommand(Guid.NewGuid().ToString(), LeaseId: Guid.NewGuid().ToString());
        await service.CommandAsync(tree.Id, owner, "lease", command, default);
        Assert.Equal(f.Clock.UtcNow, (await service.Read(tree.Id, owner, default)).UpdatedAt);
        var last = f.Clock.UtcNow;
        f.Clock.UtcNow += TimeSpan.FromHours(1);
        await service.CommandAsync(tree.Id, owner, "lease", command, default);
        Assert.Equal(last, (await service.Read(tree.Id, owner, default)).UpdatedAt);
    }

    [Fact]
    public async Task WorkspaceActivity_LegacyObservationAndUnavailableReadsDoNotBecomeNewActivity()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        var previous = tree.Observation!.At;
        await JsonStorage.WriteAsync(Path.Combine(f.Paths.CoreRoot, "development/workspaces", tree.Id + ".json"), tree with { UpdatedAt = null, SourceStamp = null });
        f.Clock.UtcNow += TimeSpan.FromDays(1);
        var restarted = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        tree = await restarted.ObserveAsync(tree.Id, owner, default);
        Assert.Equal(previous, tree.UpdatedAt);
        Directory.Move(tree.Path, tree.Path + "-unavailable");
        f.Clock.UtcNow += TimeSpan.FromDays(1);
        Assert.Equal(previous, (await restarted.ObserveAsync(tree.Id, owner, default)).UpdatedAt);
    }

    [Fact]
    public async Task WorkspaceActivity_InventoryUsesLatestRepositoryOrWorkflowChange()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var first = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        f.Clock.UtcNow += TimeSpan.FromHours(1);
        var repository = await CreateGitRepositoryAsync(Path.Combine(f.Root, "other-repository"));
        var app = (await f.Apps.GetAppAsync(SourceTestApp))!;
        await f.Apps.UpsertAppAsync(app with { Id = "example.other", SourceState = app.SourceState! with { Repository = repository, LocalOverridePath = repository } });
        var second = await service.PrepareAsync(owner, WorkspaceRequest() with { AppId = "example.other" }, default);
        var inspection = new WorkspaceInspectionService(service, f.Apps, f.Clock);
        Assert.Equal(second.UpdatedAt, Assert.Single((await inspection.ListAsync("admin", default)).Workspaces).UpdatedAt);
        f.Clock.UtcNow += TimeSpan.FromHours(1);
        var request = new WorkspaceWorkflowCommand(Guid.NewGuid().ToString(), 0);
        await service.ChangeWorkflowAsync(owner, "admin", "defer", request, new Dictionary<string, string>(), default);
        var workflowAt = f.Clock.UtcNow;
        Assert.Equal(workflowAt, Assert.Single((await inspection.ListAsync("admin", default)).Workspaces).UpdatedAt);
        f.Clock.UtcNow += TimeSpan.FromHours(1);
        await service.ChangeWorkflowAsync(owner, "admin", "defer", request, new Dictionary<string, string>(), default);
        await inspection.ReadAsync(first.WorkspaceId, first.Id, "admin", default);
        Assert.Equal(workflowAt, Assert.Single((await inspection.ListAsync("admin", default)).Workspaces).UpdatedAt);
    }
}
