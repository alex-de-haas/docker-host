using Haas.Hosty.Core;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static async Task<(LifecycleFixture Fixture, DevelopmentWorkspaceService Workspaces,
        WorkspaceActivationService Service, DevelopmentWorkspace First, DevelopmentWorkspace Second,
        WorkspaceRuntimeActivation Active)> DirectCoreSwitchFixture()
    {
        var (f, remote) = await SourceFixtureAsync();
        await AddCoreProject(remote);
        var git = new RemoteGitFixture(remote);
        var initial = CoreSourceService(f, git);
        var source = await initial.SaveAsync(new(null, "initial", new(RemoteGitFixture.Url, "main", ConnectionId: "connection")), default, "admin");
        var workspaces = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock, privateSources: git, coreDevelopment: initial);
        async Task<DevelopmentWorkspace> Prepare(string session)
        {
            var owner = ExternalOwner(session);
            var lease = Guid.NewGuid().ToString();
            var tree = await workspaces.PrepareCoreSourceAsync(owner, new(Guid.NewGuid().ToString(), owner.SessionId, lease, source.Revision), default);
            await workspaces.CommandAsync(tree.Id, owner, "release-lease", new(Guid.NewGuid().ToString(), LeaseId: lease), default);
            return tree;
        }
        var first = await Prepare("direct-first");
        var second = await Prepare("direct-second");
        var launch = new CoreLaunchIdentity("dev", CoreDevelopmentService.Project(first.Path), Path.Combine(f.Root, "first-generation"), 123, DateTimeOffset.UnixEpoch);
        var core = new CoreDevelopmentService(new(f.Paths.DataRoot, Path.Combine(f.Paths.CoreRoot, "run"),
            Path.Combine(f.Paths.CoreRoot, "run/control.json"), 7070, "http://localhost:7070", null, "localhost", null, false), launch, git);
        workspaces = new(f.Paths, f.Apps, f.Clock, privateSources: git, coreDevelopment: core);
        var baseline = Path.Combine(f.Root, "captured-release");
        await File.WriteAllTextAsync(baseline, "original release");
        var active = new WorkspaceRuntimeActivation(Guid.NewGuid().ToString(), first.WorkspaceId, first.Owner.UserId,
            "first-review", "old-instance", source.Revision, first.Id, launch.ProjectPath,
            new("release", null, null, 122, DateTimeOffset.UnixEpoch), [], "active",
            PreparedExecutable: Path.Combine(launch.GenerationPath!, "core"), Generation: launch.GenerationPath,
            ActivatedCore: launch, PreviousExecutable: baseline, PreviousExecutableHash: WorkspaceActivationReturn.ExecutableHash(baseline), CoreReserved: true);
        WorkspaceRuntimeFiles.Save(f.Paths.DataRoot, active);
        var planner = new WorkspaceActivationPlanner(workspaces, new(workspaces, f.Apps, f.Clock, privateSources: git), f.Apps, core);
        return (f, workspaces, new(f.Paths, planner, core, f.Service, workspaces), first, second, active);
    }

    [Fact]
    public async Task DirectCoreSwitch_PreparesNextWorkspaceWhileCurrentOwnerAndApplicationsRemainUntouched()
    {
        var (f, _, service, _, next, active) = await DirectCoreSwitchFixture();
        var retained = await File.ReadAllTextAsync(WorkspaceRuntimeFiles.PathFor(f.Paths.DataRoot, active.Id));
        var selection = new WorkspaceActivationSelection(CoreWorktreeId: next.Id, Apps: []);
        var review = await service.ReviewAsync(next.WorkspaceId, next.Owner.UserId, selection, default);
        var prepared = await service.PrepareAsync(next.WorkspaceId,
            new(Guid.NewGuid().ToString(), next.Owner.UserId, selection, review.PlanDigest), default);

        Assert.Equal("prepared", prepared.Phase);
        Assert.Equal(active.Id, prepared.ReplacesCoreActivationId);
        Assert.Equal(active.ActivatedCore, prepared.PreviousCore);
        Assert.Equal(WorkspaceActivationReturn.ImmediateTarget(active), prepared.CoreReturnTarget);
        Assert.Empty(prepared.Apps);
        Assert.Equal(retained, await File.ReadAllTextAsync(WorkspaceRuntimeFiles.PathFor(f.Paths.DataRoot, active.Id)));
        Assert.Equal(0, f.Adapter.StopCount);
        Assert.Equal(0, f.Adapter.StartCount);
    }

    [Theory]
    [InlineData("generation")]
    [InlineData("process")]
    [InlineData("return")]
    [InlineData("preparing")]
    [InlineData("another-owner")]
    [InlineData("unreserved")]
    public async Task DirectCoreSwitch_UnprovenOrUnfinishedOwnerRefusesBeforeReservation(string changed)
    {
        var (f, _, service, _, next, active) = await DirectCoreSwitchFixture();
        var altered = changed switch
        {
            "generation" => active with { Generation = "unrelated-generation" },
            "process" => active with { ActivatedCore = active.ActivatedCore! with { ProcessId = 999 } },
            "return" => active with { Returns = [new(new(Guid.NewGuid().ToString(), [], true, true), "pending")] },
            "preparing" => active with { Phase = "prepared" },
            "unreserved" => active with { CoreReserved = false },
            _ => active
        };
        WorkspaceRuntimeFiles.Save(f.Paths.DataRoot, altered);
        if (changed == "another-owner") WorkspaceRuntimeFiles.Save(f.Paths.DataRoot, active with { Id = Guid.NewGuid().ToString() });
        var request = Guid.NewGuid().ToString();

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => service.PrepareAsync(next.WorkspaceId,
            new(request, next.Owner.UserId, new(CoreWorktreeId: next.Id, Apps: [])), default));

        Assert.Equal("activation_core_owned", error.Code);
        Assert.False(File.Exists(WorkspaceRuntimeFiles.PathFor(f.Paths.DataRoot, request)));
        Assert.False(WorkspaceRuntimeFiles.Read(f.Paths.DataRoot, active.Id).CoreReturned);
        Assert.Equal(0, f.Adapter.StopCount);
    }

    [Fact]
    public async Task DirectCoreSwitch_ReviewBindsTheExactPreviousOwnershipAndReturnTarget()
    {
        var (f, _, service, _, next, active) = await DirectCoreSwitchFixture();
        var selection = new WorkspaceActivationSelection(CoreWorktreeId: next.Id, Apps: []);
        var review = await service.ReviewAsync(next.WorkspaceId, next.Owner.UserId, selection, default);
        WorkspaceRuntimeFiles.Save(f.Paths.DataRoot, active with { CoreReturnTarget =
            WorkspaceActivationReturn.ImmediateTarget(active) with { ExecutableHash = "changed-baseline" } });
        var request = Guid.NewGuid().ToString();

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => service.PrepareAsync(next.WorkspaceId,
            new(request, next.Owner.UserId, selection, review.PlanDigest), default));

        Assert.Equal("activation_review_changed", error.Code);
        Assert.False(File.Exists(WorkspaceRuntimeFiles.PathFor(f.Paths.DataRoot, request)));
        Assert.Equal(0, f.Adapter.StopCount);
    }

    [Fact]
    public async Task DirectCoreSwitch_ChangedCapturedBaselineRefusesWithoutStoppingCurrentCore()
    {
        var (f, _, service, _, next, active) = await DirectCoreSwitchFixture();
        await File.WriteAllTextAsync(active.PreviousExecutable!, "replaced executable");
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => service.PrepareAsync(next.WorkspaceId,
            new(Guid.NewGuid().ToString(), next.Owner.UserId, new(CoreWorktreeId: next.Id, Apps: [])), default));
        Assert.Equal("activation_core_return_unavailable", error.Code);
        Assert.False(WorkspaceRuntimeFiles.Read(f.Paths.DataRoot, active.Id).CoreReturned);
        Assert.Equal(0, f.Adapter.StopCount);
    }

    [Fact]
    public async Task DirectCoreSwitch_ReleasedPreStopRequestDoesNotKeepExclusiveOwnership()
    {
        var (_, workspaces, service, _, next, active) = await DirectCoreSwitchFixture();
        var prepared = await service.PrepareAsync(next.WorkspaceId,
            new(Guid.NewGuid().ToString(), next.Owner.UserId, new(CoreWorktreeId: next.Id, Apps: [])), default);
        await service.ReleasePreparationAsync(prepared.Id, default);
        var owner = ExternalOwner("direct-third");
        var lease = Guid.NewGuid().ToString();
        var third = await workspaces.PrepareCoreSourceAsync(owner,
            new(Guid.NewGuid().ToString(), owner.SessionId, lease, active.CoreSourceRevision), default);
        await workspaces.CommandAsync(third.Id, owner, "release-lease", new(Guid.NewGuid().ToString(), LeaseId: lease), default);

        var replacement = await service.PrepareAsync(third.WorkspaceId,
            new(Guid.NewGuid().ToString(), owner.UserId, new(CoreWorktreeId: third.Id, Apps: [])), default);

        Assert.Equal("prepared", replacement.Phase);
        Assert.Equal(active.Id, replacement.ReplacesCoreActivationId);
        Assert.Equal(third.Id, replacement.CoreWorktreeId);
    }

    [Fact]
    public async Task DirectCoreSwitch_ReleasedPreparationKeepsPreviousOwnerAndItsRecoveryTarget()
    {
        var (f, _, service, _, next, active) = await DirectCoreSwitchFixture();
        var prepared = await service.PrepareAsync(next.WorkspaceId,
            new(Guid.NewGuid().ToString(), next.Owner.UserId, new(CoreWorktreeId: next.Id, Apps: [])), default);
        var released = await service.ReleasePreparationAsync(prepared.Id, default);
        Assert.True(released.PreparationReleased);
        Assert.False(released.CoreReserved);
        Assert.Equal(active.Id, released.ReplacesCoreActivationId);
        Assert.Equal("active", WorkspaceRuntimeFiles.Read(f.Paths.DataRoot, active.Id).Phase);
        Assert.False(WorkspaceRuntimeFiles.Read(f.Paths.DataRoot, active.Id).CoreReturned);
        Assert.Equal(0, f.Adapter.StopCount);
    }
}
