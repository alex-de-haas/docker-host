using Haas.Hosty.Core;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private sealed record PreparationUnwindCase(LifecycleFixture Fixture, WorkspaceActivationService Service,
        WorkspaceActivationRequest Input, DevelopmentWorkspace FirstTree, string HistoryId, string HistoryPath, string History);

    private static async Task<PreparationUnwindCase> FailedPreparationWithUnrelatedHistory()
    {
        var (fixture, owner, workspaces, firstTree, _, _) = await LocalHandoffFixture();
        DevelopmentWorkspace? historyTree = null;
        foreach (var id in new[] { "test.middle", "test.zz-history" })
        {
            var app = NewApp(id);
            await fixture.Service.CreateLocalAppAsync(owner, app, null, default);
            var tree = await workspaces.PrepareAsync(owner, new(app.RequestId, owner.SessionId, id, "/assistant", "main"), default);
            if (id == "test.zz-history") historyTree = tree;
        }
        var service = ActivationService(fixture, workspaces);
        var actor = DevActor(owner);
        var enter = DevRequest("enter", historyTree!.Id);
        var enterReview = await fixture.Service.PlanDevModeAsync("test.zz-history", enter, actor);
        await fixture.Service.ApplyDevModeAsync("test.zz-history", enter with { PlanDigest = enterReview.PlanDigest }, actor);
        var leave = DevRequest("return", accept: true);
        var leaveReview = await fixture.Service.PlanDevModeAsync("test.zz-history", leave, actor);
        await fixture.Service.ApplyDevModeAsync("test.zz-history", leave with { PlanDigest = leaveReview.PlanDigest }, actor);
        var prior = (await AppDevStore.ReadAsync(fixture.Paths, (await fixture.Apps.GetAppAsync("test.zz-history"))!, default))!;
        Assert.Equal("returned", prior.Phase);
        var historyPath = AppDevStore.Record(fixture.Paths, prior.AppId, prior.Id);
        var history = await File.ReadAllTextAsync(historyPath);
        var starts = fixture.Adapter.StartCount;
        var stops = fixture.Adapter.StopCount;
        var original = new IOException("middle participant preparation failed");
        fixture.Adapter.PreparationProbe = async context =>
        {
            if (context.App.Id != "test.middle") return;
            var prepared = await AppDevStore.ReadAsync(fixture.Paths, (await fixture.Apps.GetAppAsync("test.created"))!, default);
            Assert.Equal("prepared", prepared!.Phase);
            throw original;
        };
        var review = await service.ReviewAsync(firstTree.WorkspaceId, owner.UserId, new(false), default);
        var input = new WorkspaceActivationRequest(Guid.NewGuid().ToString(), owner.UserId, new(false), review.PlanDigest);
        var error = await Assert.ThrowsAsync<IOException>(() => service.PrepareAsync(firstTree.WorkspaceId, input, default));
        Assert.Same(original, error);
        var failed = WorkspaceRuntimeFiles.Read(fixture.Paths.DataRoot, input.RequestId);
        Assert.True(failed.PreparationReleased);
        Assert.False(failed.CoreReserved);
        foreach (var id in new[] { "test.created", "test.middle" })
        {
            Assert.Null((await fixture.Apps.GetAppAsync(id))!.DevModeId);
            var child = await AppDevStore.ReadAsync(fixture.Paths, id, WorkspaceRuntimeFiles.ChildId(input.RequestId, id), default);
            Assert.Equal("returned", child!.Phase);
        }
        Assert.Equal(prior.Id, (await fixture.Apps.GetAppAsync(prior.AppId))!.DevModeId);
        Assert.Equal(history, await File.ReadAllTextAsync(historyPath));
        Assert.Equal(starts, fixture.Adapter.StartCount);
        Assert.Equal(stops, fixture.Adapter.StopCount);
        return new(fixture, service, input, firstTree, prior.Id, historyPath, history);
    }

    [Fact]
    public async Task ActivationPreparationUnwind_UnrelatedReturnedJournalPreservesOriginalFailureAndAllowsReviewedRepair()
    {
        var state = await FailedPreparationWithUnrelatedHistory();
        var fixture = state.Fixture;
        fixture.Adapter.PreparationProbe = null;
        await File.WriteAllTextAsync(Path.Combine(state.FirstTree.Path, "repair.txt"), "reviewed preparation repair");
        var review = await state.Service.ReviewAsync(state.FirstTree.WorkspaceId, state.Input.UserId, state.Input.Selection, default);
        var repaired = await state.Service.PrepareAsync(state.FirstTree.WorkspaceId,
            state.Input with { PlanDigest = review.PlanDigest }, default);
        Assert.Equal("prepared", repaired.Phase);
        Assert.False(repaired.PreparationReleased);
        Assert.Equal(state.Input.RequestId, repaired.Id);
        Assert.Equal(state.History, await File.ReadAllTextAsync(state.HistoryPath));
        Assert.Equal("reviewed preparation repair", await File.ReadAllTextAsync(Path.Combine(state.FirstTree.Path, "repair.txt")));
    }

    [Fact]
    public async Task ActivationPreparationUnwind_ExplicitReleaseResumesOwnReturnedPointerAndPreservesUnrelatedHistory()
    {
        var state = await FailedPreparationWithUnrelatedHistory();
        var fixture = state.Fixture;
        var group = WorkspaceRuntimeFiles.Read(fixture.Paths.DataRoot, state.Input.RequestId);
        var childId = WorkspaceRuntimeFiles.ChildId(group.Id, "test.created");
        var childPath = AppDevStore.Record(fixture.Paths, "test.created", childId);
        var retainedChild = await File.ReadAllTextAsync(childPath);
        // A pre-Stop unwind already wrote its returned child journal, then exited before clearing
        // that app's pointer and publishing the group's successful release boundary.
        await fixture.Apps.UpdateAppAsync("test.created", app => app with { DevModeId = childId });
        WorkspaceRuntimeFiles.Save(fixture.Paths.DataRoot, group with { PreparationReleased = false });
        var starts = fixture.Adapter.StartCount;
        var stops = fixture.Adapter.StopCount;
        var released = await state.Service.ReleasePreparationAsync(group.Id, default);
        Assert.True(released.PreparationReleased);
        Assert.Null((await fixture.Apps.GetAppAsync("test.created"))!.DevModeId);
        Assert.Equal(retainedChild, await File.ReadAllTextAsync(childPath));
        Assert.Equal(state.HistoryId, (await fixture.Apps.GetAppAsync("test.zz-history"))!.DevModeId);
        Assert.Equal(state.History, await File.ReadAllTextAsync(state.HistoryPath));
        Assert.Equal(starts, fixture.Adapter.StartCount);
        Assert.Equal(stops, fixture.Adapter.StopCount);
    }

    [Theory]
    [InlineData("foreign-active")]
    [InlineData("own-stopped")]
    public async Task ActivationPreparationUnwind_UnsafeParticipantRefusesBeforeReleasingAnyOwnedChild(string changed)
    {
        var (fixture, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        var second = NewApp("test.middle");
        await fixture.Service.CreateLocalAppAsync(owner, second, null, default);
        await workspaces.PrepareAsync(owner, new(second.RequestId, owner.SessionId, second.AppId, "/assistant", "main"), default);
        var service = ActivationService(fixture, workspaces);
        var input = new WorkspaceActivationRequest(Guid.NewGuid().ToString(), owner.UserId, new(false));
        var prepared = await service.PrepareAsync(tree.WorkspaceId, input, default);
        var app = (await fixture.Apps.GetAppAsync(second.AppId))!;
        var unsafeChild = (await AppDevStore.ReadAsync(fixture.Paths, app, default))!;
        unsafeChild = changed == "foreign-active" ? unsafeChild with { ActivationId = Guid.NewGuid().ToString() }
            : unsafeChild with { Phase = "stopped" };
        await AppDevStore.SaveAsync(fixture.Paths, unsafeChild, default);
        var first = (await fixture.Apps.GetAppAsync("test.created"))!;
        var firstPath = AppDevStore.Record(fixture.Paths, first.Id, first.DevModeId!);
        var retainedFirst = await File.ReadAllTextAsync(firstPath);
        var groupPath = WorkspaceRuntimeFiles.PathFor(fixture.Paths.DataRoot, prepared.Id);
        var retainedGroup = await File.ReadAllTextAsync(groupPath);
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => service.ReleasePreparationAsync(prepared.Id, default));
        Assert.Equal("dev_preparation_in_use", error.Code);
        Assert.Equal(first.DevModeId, (await fixture.Apps.GetAppAsync(first.Id))!.DevModeId);
        Assert.Equal(retainedFirst, await File.ReadAllTextAsync(firstPath));
        Assert.Equal(retainedGroup, await File.ReadAllTextAsync(groupPath));
        Assert.Equal(0, fixture.Adapter.StartCount);
        Assert.Equal(0, fixture.Adapter.StopCount);
    }
}
