using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task WorkspaceNames_AggregateMetadataSurvivesRestartAndPreparationReplayWithoutSourceMutation()
    {
        var (f, _) = await SourceFixtureAsync();
        var events = new CoreEventHub();
        var observation = new WorkspaceObservationState(events);
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock, observationState: observation);
        var owner = WorkspaceTestOwner(f);
        var request = WorkspaceRequest() with { Name = "Simplify runtime switching" };
        var first = await service.PrepareAsync(owner, request, default);
        Assert.Equal(request.Name, first.Name);
        var beforeRecord = await File.ReadAllTextAsync(Path.Combine(f.Paths.CoreRoot, "development/workspaces", first.Id + ".json"));
        var beforeSource = await RunGitAsync(first.Path, ["status", "--porcelain=v1"]);
        using var listener = events.Subscribe(owner.UserId, false, workspaces: true);
        var rename = new WorkspaceNameCommand(Guid.NewGuid().ToString(), "Unify package and workspace selection");
        var named = await service.RenameAsync(owner, rename, default);
        Assert.Equal(rename.Name, named.Name);
        Assert.Equal("*", (await listener.Reader.ReadAsync()).Data);
        Assert.Equal(beforeRecord, await File.ReadAllTextAsync(Path.Combine(f.Paths.CoreRoot, "development/workspaces", first.Id + ".json")));
        Assert.Equal(beforeSource, await RunGitAsync(first.Path, ["status", "--porcelain=v1"]));
        var restarted = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        Assert.Equal(rename.Name, (await restarted.Read(first.Id, owner, default)).Name);
        Assert.Equal(CoreJson.Text(named), CoreJson.Text(await restarted.RenameAsync(owner, rename, default)));
        var newest = await restarted.RenameAsync(owner, new(Guid.NewGuid().ToString(), "Improve runtime selection"), default);
        Assert.Equal(newest.Name, (await restarted.RenameAsync(owner, rename, default)).Name);
        Assert.Equal(newest.Name, (await restarted.PrepareAsync(owner, request, default)).Name);
        var after = await restarted.Read(first.Id, owner, default);
        Assert.Equal(first.Id, after.Id);
        Assert.Equal(first.Branch, after.Branch);
        Assert.Equal(first.SourceStamp, after.SourceStamp);
        Assert.Equal(first.Leases, after.Leases);
        Assert.Equal(first.Operations, after.Operations);
        var inspected = Assert.Single((await new WorkspaceInspectionService(restarted, f.Apps, f.Clock).ListAsync(owner.UserId, default)).Workspaces);
        Assert.Equal(newest.Name, inspected.Name);
        Assert.Equal(owner.SessionId, inspected.Owner.Reference);
    }

    [Fact]
    public async Task WorkspaceNames_ShareAcrossWorktreesAndDoNotRevertOnLaterAppPreparation()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var first = await service.PrepareAsync(owner, WorkspaceRequest() with { Name = "Fix playback" }, default);
        var app = (await f.Apps.GetAppAsync(SourceTestApp))!;
        var repository = await CreateGitRepositoryAsync(Path.Combine(f.Root, "additional-source"));
        await f.Apps.UpsertAppAsync(app with { Id = "example.other", SourceState = app.SourceState! with { Repository = repository, LocalOverridePath = repository } });
        var second = await service.PrepareAsync(owner, WorkspaceRequest() with { AppId = "example.other", Name = "A stale task name" }, default);
        Assert.Equal(first.WorkspaceId, second.WorkspaceId);
        Assert.Equal(first.Name, second.Name);
        await service.RenameAsync(owner, new(Guid.NewGuid().ToString(), "Improve media playback"), default);
        Assert.All((await service.ListAsync(owner, true, default)).Workspaces, tree => Assert.Equal("Improve media playback", tree.Name));
    }

    [Fact]
    public async Task WorkspaceNames_ValidateOwnerPlainTextAndExactReplayWithoutBlockingActiveLeases()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = ExternalOwner();
        var tree = await service.PrepareAsync(owner, ExternalPrepare() with { Name = "Fix source selection" }, default);
        Assert.NotEmpty(tree.Leases);
        foreach (var invalid in new[] { "", " ", " leading", "trailing ", "line\nbreak", new string('x', 121) })
            Assert.Equal("workspace_name_invalid", (await Assert.ThrowsAsync<AppLifecycleException>(() => service.RenameAsync(owner, new(Guid.NewGuid().ToString(), invalid), default))).Code);
        var rename = new WorkspaceNameCommand(Guid.NewGuid().ToString(), "Fix runtime selection");
        await service.RenameAsync(owner, rename, default);
        Assert.Equal("workspace_request_conflict", (await Assert.ThrowsAsync<AppLifecycleException>(() => service.RenameAsync(owner, rename with { Name = "Different arguments" }, default))).Code);
        var other = ExternalOwner(principal: "oauth:another");
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.RenameAsync(other, rename, default));
        Assert.Equal(rename.Name, (await service.Read(tree.Id, owner, default)).Name);
    }

    [Fact]
    public async Task WorkspaceNames_LegacyLabelsRemainReadableAndDuplicateNamesDoNotChangeIdentity()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var firstOwner = ExternalOwner(label: "Repair playback");
        var first = await service.PrepareAsync(firstOwner, ExternalPrepare(), default);
        Assert.Equal("Repair playback", first.Name);
        var secondOwner = ExternalOwner("second-task");
        var second = await service.PrepareAsync(secondOwner, ExternalPrepare("second-task"), default);
        Assert.Equal("Workspace", second.Name);
        await service.RenameAsync(secondOwner, new(Guid.NewGuid().ToString(), first.Name!), default);
        Assert.NotEqual(first.WorkspaceId, second.WorkspaceId);
        Assert.Equal(first.Name, (await service.Read(second.Id, secondOwner, default)).Name);
    }
}
