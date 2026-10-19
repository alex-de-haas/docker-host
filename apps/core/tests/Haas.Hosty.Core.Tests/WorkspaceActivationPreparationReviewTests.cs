using Haas.Hosty.Core;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static async Task<(LifecycleFixture Fixture, DevelopmentWorkspace Tree, WorkspaceActivationService Service,
        WorkspaceActivationRequest Input)> PreparationReviewFixture(bool authority = false, bool release = true)
    {
        var (fixture, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        var service = ActivationService(fixture, workspaces);
        WorkspaceActivationActor? actor = null;
        if (authority)
        {
            var users = new UserDirectoryStore(fixture.Paths);
            var now = fixture.Clock.UtcNow;
            string[] scopes = [AccessTokenScopes.McpRead, AccessTokenScopes.McpWorkspaces, AccessTokenScopes.McpLifecycle];
            var sessions = new[] { "first-credential", "second-credential" }.Select(id =>
                new AuthSessionRecord(id, owner.UserId, now, now.AddHours(1), null, now,
                    Kind: AccessTokenKinds.Manual, Audience: AccessTokenScopes.CoreAudience, Scopes: scopes)).ToArray();
            await users.WriteAsync(new(1, [new(owner.UserId, null, "Admin", "host.admin", false, now, now)], [], [], sessions));
            var identity = new AppIdentityService(users, new(fixture.Paths), fixture.Apps, new(fixture.Paths),
                fixture.CoreSettings, new(fixture.Paths), fixture.Clock);
            var access = new WorkspaceActivationAccess(users, new(fixture.Paths, fixture.Clock), fixture.Apps,
                fixture.CoreSettings, fixture.Clock, identity);
            var core = CoreSourceService(fixture);
            service = new(fixture.Paths, new(workspaces, new(workspaces, fixture.Apps, fixture.Clock), fixture.Apps, core),
                core, fixture.Service, workspaces, access);
            actor = new(owner.UserId, "direct-mcp", Principal: "manual:" + DevelopmentWorkspaceService.Hash(sessions[0].Id));
        }
        var review = await service.ReviewAsync(tree.WorkspaceId, owner.UserId, new(false), default);
        var input = new WorkspaceActivationRequest(Guid.NewGuid().ToString(), owner.UserId, new(false), review.PlanDigest,
            actor is null ? null : actor with { Review = review.PlanDigest });
        await service.PrepareAsync(tree.WorkspaceId, input, default);
        if (release) await service.ReleasePreparationAsync(input.RequestId, default);
        return (fixture, tree, service, input);
    }

    private static WorkspaceActivationRequest ReviewedRepair(WorkspaceActivationRequest input, string digest)
        => input with { PlanDigest = digest, Authority = input.Authority is null ? null : input.Authority with { Review = digest } };

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ActivationPreparationReview_ReleasedSourceRepairAcceptsFreshDigestUnderOriginalRequestId(bool authority)
    {
        var (fixture, tree, service, input) = await PreparationReviewFixture(authority);
        var released = WorkspaceRuntimeFiles.Read(fixture.Paths.DataRoot, input.RequestId);
        Assert.True(released.PreparationReleased);
        var file = Path.Combine(tree.Path, "repair.txt");
        await File.WriteAllTextAsync(file, "fixed preparation source");
        var review = await service.ReviewAsync(tree.WorkspaceId, input.UserId, input.Selection, default);
        Assert.NotEqual(input.PlanDigest, review.PlanDigest);
        var repaired = await service.PrepareAsync(tree.WorkspaceId, ReviewedRepair(input, review.PlanDigest), default);
        Assert.Equal(input.RequestId, repaired.Id);
        Assert.Equal("prepared", repaired.Phase);
        Assert.False(repaired.PreparationReleased);
        Assert.NotEqual(released.Fingerprint, repaired.Fingerprint);
        Assert.NotNull(released.PreparationFingerprint);
        Assert.Equal(released.PreparationFingerprint, repaired.PreparationFingerprint);
        Assert.Equal("fixed preparation source", await File.ReadAllTextAsync(file));
        Assert.Equal(0, fixture.Adapter.StartCount);
        Assert.Equal(0, fixture.Adapter.StopCount);
    }

    [Theory]
    [InlineData("selection")]
    [InlineData("principal")]
    public async Task ActivationPreparationReview_FreshDigestCannotChangeReleasedSelectionOrPrincipal(string changed)
    {
        var (fixture, tree, service, input) = await PreparationReviewFixture(authority: true);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "repair.txt"), "fixed source");
        // Explicitly selecting the same tree preserves resolved targets but changes the immutable
        // caller selection. Review that changed selection so a stale digest cannot mask the check.
        WorkspaceActivationSelection selection = changed == "selection" ? new(false, Apps: [new("test.created", WorktreeId: tree.Id)])
            : input.Selection;
        var review = await service.ReviewAsync(tree.WorkspaceId, input.UserId, selection, default);
        var repair = ReviewedRepair(input with { Selection = selection }, review.PlanDigest);
        if (changed == "principal")
            repair = repair with { Authority = repair.Authority! with { Principal = "manual:" + DevelopmentWorkspaceService.Hash("second-credential") } };
        var path = WorkspaceRuntimeFiles.PathFor(fixture.Paths.DataRoot, input.RequestId);
        var retained = await File.ReadAllTextAsync(path);
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => service.PrepareAsync(tree.WorkspaceId, repair, default));
        Assert.Equal("activation_request_conflict", error.Code);
        Assert.Equal(retained, await File.ReadAllTextAsync(path));
        Assert.Equal(0, fixture.Adapter.StartCount);
        Assert.Equal(0, fixture.Adapter.StopCount);
    }

    [Fact]
    public async Task ActivationPreparationReview_StaleRepairDigestLeavesReleasedReceiptUnchanged()
    {
        var (fixture, tree, service, input) = await PreparationReviewFixture();
        var file = Path.Combine(tree.Path, "repair.txt");
        await File.WriteAllTextAsync(file, "reviewed repair");
        var review = await service.ReviewAsync(tree.WorkspaceId, input.UserId, input.Selection, default);
        await File.WriteAllTextAsync(file, "later unreviewed repair");
        var path = WorkspaceRuntimeFiles.PathFor(fixture.Paths.DataRoot, input.RequestId);
        var retained = await File.ReadAllTextAsync(path);
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => service.PrepareAsync(tree.WorkspaceId,
            ReviewedRepair(input, review.PlanDigest), default));
        Assert.Equal("activation_review_changed", error.Code);
        Assert.Equal(retained, await File.ReadAllTextAsync(path));
        Assert.Equal("later unreviewed repair", await File.ReadAllTextAsync(file));
        Assert.Equal(0, fixture.Adapter.StartCount);
        Assert.Equal(0, fixture.Adapter.StopCount);
    }

    [Fact]
    public async Task ActivationPreparationReview_UnreleasedPreparationCannotAdoptAnotherDigest()
    {
        var (fixture, tree, service, input) = await PreparationReviewFixture(release: false);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "repair.txt"), "source edit without release");
        var review = await service.ReviewAsync(tree.WorkspaceId, input.UserId, input.Selection, default);
        var path = WorkspaceRuntimeFiles.PathFor(fixture.Paths.DataRoot, input.RequestId);
        var retained = await File.ReadAllTextAsync(path);
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => service.PrepareAsync(tree.WorkspaceId,
            ReviewedRepair(input, review.PlanDigest), default));
        Assert.Equal("activation_request_conflict", error.Code);
        Assert.Equal(retained, await File.ReadAllTextAsync(path));
        Assert.Equal("prepared", WorkspaceRuntimeFiles.Read(fixture.Paths.DataRoot, input.RequestId).Phase);
    }

    [Fact]
    public async Task ActivationPreparationReview_InterruptedUnreleasedAppsPreparationRejectsAnotherDigest()
    {
        var (fixture, tree, service, input) = await PreparationReviewFixture(release: false);
        var record = WorkspaceRuntimeFiles.Read(fixture.Paths.DataRoot, input.RequestId);
        Assert.False(record.PreparationReleased);
        // Model a process exit with the apps-only child already reserved, before the final prepared
        // phase is saved. CoreReserved=false alone does not mean those children were released.
        WorkspaceRuntimeFiles.Save(fixture.Paths.DataRoot, record with { Phase = "preparing" });
        var child = await AppDevStore.ReadAsync(fixture.Paths, (await fixture.Apps.GetAppAsync("test.created"))!, default);
        Assert.Equal("prepared", child!.Phase);
        var childPath = AppDevStore.Record(fixture.Paths, "test.created", child.Id);
        var retainedChild = await File.ReadAllTextAsync(childPath);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "repair.txt"), "repair after interruption");
        var review = await service.ReviewAsync(tree.WorkspaceId, input.UserId, input.Selection, default);
        var path = WorkspaceRuntimeFiles.PathFor(fixture.Paths.DataRoot, input.RequestId);
        var retained = await File.ReadAllTextAsync(path);
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => service.PrepareAsync(tree.WorkspaceId,
            ReviewedRepair(input, review.PlanDigest), default));
        Assert.Equal("activation_request_conflict", error.Code);
        Assert.Equal(retained, await File.ReadAllTextAsync(path));
        Assert.Equal(retainedChild, await File.ReadAllTextAsync(childPath));
        Assert.Equal(0, fixture.Adapter.StartCount);
        Assert.Equal(0, fixture.Adapter.StopCount);
    }

    [Fact]
    public async Task ActivationPreparationReview_ImplicitParticipantDriftCannotReuseReleasedRequest()
    {
        var (fixture, tree, service, input) = await PreparationReviewFixture();
        var second = NewApp("test.review-second");
        await fixture.Service.CreateLocalAppAsync(tree.Owner, second, null, default);
        var workspaces = new DevelopmentWorkspaceService(fixture.Paths, fixture.Apps, fixture.Clock);
        await workspaces.PrepareAsync(tree.Owner, new(second.RequestId, tree.Owner.SessionId, second.AppId, "/assistant", "main"), default);
        var review = await service.ReviewAsync(tree.WorkspaceId, input.UserId, input.Selection, default);
        Assert.Equal(new[] { "test.created", "test.review-second" }, review.Plan.Participants
            .Where(participant => participant.Kind == "app" && participant.Selected).Select(participant => participant.Id).Order(StringComparer.Ordinal));
        var path = WorkspaceRuntimeFiles.PathFor(fixture.Paths.DataRoot, input.RequestId);
        var retained = await File.ReadAllTextAsync(path);
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => service.PrepareAsync(tree.WorkspaceId,
            ReviewedRepair(input, review.PlanDigest), default));
        Assert.Equal("activation_request_conflict", error.Code);
        Assert.Equal(retained, await File.ReadAllTextAsync(path));
        Assert.Null((await fixture.Apps.GetAppAsync(second.AppId))!.DevModeId);
        Assert.Equal(0, fixture.Adapter.StartCount);
        Assert.Equal(0, fixture.Adapter.StopCount);
    }

    [Fact]
    public async Task ActivationPreparationReview_LegacyReceiptWithoutStableFingerprintRemainsStrict()
    {
        var (fixture, tree, service, input) = await PreparationReviewFixture();
        var record = WorkspaceRuntimeFiles.Read(fixture.Paths.DataRoot, input.RequestId);
        WorkspaceRuntimeFiles.Save(fixture.Paths.DataRoot, record with { PreparationFingerprint = null });
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "repair.txt"), "fixed legacy source");
        var review = await service.ReviewAsync(tree.WorkspaceId, input.UserId, input.Selection, default);
        var path = WorkspaceRuntimeFiles.PathFor(fixture.Paths.DataRoot, input.RequestId);
        var retained = await File.ReadAllTextAsync(path);
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => service.PrepareAsync(tree.WorkspaceId,
            ReviewedRepair(input, review.PlanDigest), default));
        Assert.Equal("activation_request_conflict", error.Code);
        Assert.Equal(retained, await File.ReadAllTextAsync(path));
    }
}
