using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task LeaseRecovery_PreservesDirtySourceCloseReceiptAndOtherLeasesAcrossReplay()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = ExternalOwner();
        var tree = await service.PrepareAsync(owner, ExternalPrepare(), default);
        var other = Guid.NewGuid().ToString();
        await service.CommandAsync(tree.Id, owner, "lease", new(Guid.NewGuid().ToString(), LeaseId: other), default);
        var close = new WorkspaceWorkflowCommand(Guid.NewGuid().ToString(), 0);
        await service.ChangeWorkflowAsync(owner, "admin", "close", close, new Dictionary<string, string>(), default, prepareOnly: true);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "unfinished.txt"), "keep unfinished work");
        var request = new WorkspaceLeaseRecovery(Guid.NewGuid().ToString(), tree.Observation!.Head!, tree.Leases[0], true);
        var inspection = new WorkspaceInspectionService(service, f.Apps, f.Clock);
        var result = await inspection.RecoverLeaseAsync(tree.WorkspaceId, tree.Id, "admin", request, default);
        Assert.Equal([other], result.Leases);
        Assert.Equal("keep unfinished work", await File.ReadAllTextAsync(Path.Combine(tree.Path, "unfinished.txt")));
        var restarted = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var replay = await restarted.RecoverExternalLeaseAsync(tree.Id, owner, "admin", request, default);
        Assert.Single(replay.Operations, o => o.Kind == "recover-lease");
        var workflow = await restarted.WorkflowAsync(owner, default);
        Assert.Equal("closing", workflow.Closure);
        Assert.Equal(close.RequestId, Assert.Single(workflow.Operations!).Id);
        Assert.Equal("pending", workflow.Operations![0].State);
        Assert.Equal("workspace_request_conflict", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            restarted.RecoverExternalLeaseAsync(tree.Id, owner, "admin", request with { LeaseId = other }, default))).Code);
        await restarted.RecoverExternalLeaseAsync(tree.Id, owner, "admin", request with { RequestId = Guid.NewGuid().ToString(), LeaseId = other }, default);
        Assert.Equal("closed", (await restarted.ChangeWorkflowAsync(owner, "admin", "close", close, new Dictionary<string, string>(), default)).Closure);
        Assert.Equal("workspace_dirty", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            restarted.ChangeWorkflowAsync(owner, "admin", "complete", new(Guid.NewGuid().ToString(), 1), new Dictionary<string, string>(), default))).Code);
    }

    [Fact]
    public async Task LeaseRecovery_InternalOwnerRecoversOnlyConfirmedClaimAfterPause()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var lease = Guid.NewGuid().ToString();
        var tree = await service.PrepareAsync(owner, WorkspaceRequest() with { LeaseId = lease }, default);
        var state = await service.ParticipationAsync(tree.WorkspaceId, owner.UserId, default);
        var other = owner with { UserId = "contributor", SessionId = "parallel" };
        state = await service.ChangeMemberAsync(state.Id, owner.UserId, "grant", new(Guid.NewGuid().ToString(), state.Revision, other.UserId, [tree.Id]), default);
        await service.ChangeSessionAsync(state.Id, other, "attach", new(Guid.NewGuid().ToString(), state.Revision, "Parallel", "/parallel"), default);
        var otherLease = Guid.NewGuid().ToString();
        await service.CommandAsync(tree.Id, other, "lease", new(Guid.NewGuid().ToString(), LeaseId: otherLease), default);
        var inspection = new WorkspaceInspectionService(service, f.Apps, f.Clock);
        var request = new WorkspaceLeaseRecovery(Guid.NewGuid().ToString(), tree.OriginalBase, otherLease, true);
        await Assert.ThrowsAsync<AppLifecycleException>(() => inspection.RecoverLeaseAsync(tree.WorkspaceId, tree.Id, other.UserId, request, default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => inspection.RecoverLeaseAsync(tree.WorkspaceId, tree.Id, owner.UserId, request, default));
        await service.ChangeWorkflowAsync(owner, owner.UserId, "close", new(Guid.NewGuid().ToString(), 0), new Dictionary<string, string>(), default, prepareOnly: true);
        await Assert.ThrowsAsync<AppLifecycleException>(() => inspection.RecoverLeaseAsync(tree.WorkspaceId, tree.Id, owner.UserId, request with { ConsumerExitConfirmed = false }, default));
        var result = await inspection.RecoverLeaseAsync(tree.WorkspaceId, tree.Id, owner.UserId, request, default);
        Assert.Equal([lease], result.Leases);
        Assert.DoesNotContain((await service.Read(tree.Id, null, default)).LeaseClaims!, c => c.Id == otherLease);
        Assert.Equal([lease], (await inspection.RecoverLeaseAsync(tree.WorkspaceId, tree.Id, owner.UserId, request, default)).Leases);
    }

    [Theory]
    [InlineData("unconfirmed", "workspace_exit_unconfirmed")]
    [InlineData("open", "workspace_close_required")]
    [InlineData("stale", "workspace_stale_head")]
    [InlineData("other-user", "workspace_forbidden")]
    [InlineData("sandbox", "workspace_in_use")]
    [InlineData("source", "workspace_in_use")]
    [InlineData("native", "workspace_in_use")]
    [InlineData("unknown-native", "workspace_consumer_unavailable")]
    [InlineData("unknown-operation", "workspace_operation_pending")]
    public async Task LeaseRecovery_RefusesUnverifiedOrUnauthorizedRecovery(string scenario, string code)
    {
        var (f, _) = await SourceFixtureAsync();
        var processes = new LocalCommandProcessRegistry();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock, processes);
        var owner = scenario == "assistant" ? WorkspaceTestOwner(f) : ExternalOwner();
        var input = scenario == "assistant" ? WorkspaceRequest() with { LeaseId = Guid.NewGuid().ToString() } : ExternalPrepare();
        var tree = await service.PrepareAsync(owner, input, default);
        if (scenario == "sandbox") await service.SetSandboxConsumerAsync(tree.Id, new string('b', 32), true, default);
        if (scenario != "open") await service.ChangeWorkflowAsync(owner, "admin", "close",
            new(Guid.NewGuid().ToString(), 0), new Dictionary<string, string>(), default, prepareOnly: true);
        using var process = System.Diagnostics.Process.GetCurrentProcess();
        if (scenario == "native") processes.Set(SourceTestApp, "fixture", new(process, "unused", tree.Path, new Dictionary<string, int>(), false, null));
        if (scenario == "unknown-native") processes.Block(SourceTestApp, "Unverified process identity");
        if (scenario == "source")
        {
            var app = (await f.Apps.GetAppAsync(SourceTestApp))!;
            await f.Apps.UpsertAppAsync(app with { SourceState = app.SourceState! with { LocalOverridePath = tree.Path } });
        }
        if (scenario == "unknown-operation")
            await JsonStorage.WriteAsync(Path.Combine(f.Paths.CoreRoot, "development/workspaces", tree.Id + ".json"),
                tree with { Operations = [.. tree.Operations, new(Guid.NewGuid().ToString(), "commit", "unknown", "unknown")] });
        var request = new WorkspaceLeaseRecovery(Guid.NewGuid().ToString(), scenario == "stale" ? "old" : tree.Observation!.Head!, tree.Leases[0], scenario != "unconfirmed");
        var inspection = new WorkspaceInspectionService(service, f.Apps, f.Clock);
        Assert.Equal(code, (await Assert.ThrowsAsync<AppLifecycleException>(() => inspection.RecoverLeaseAsync(tree.WorkspaceId,
            tree.Id, scenario == "other-user" ? "another-admin" : "admin", request, default))).Code);
        Assert.Equal(tree.Leases, (await service.Read(tree.Id, owner, default)).Leases);
        Assert.DoesNotContain((await service.Read(tree.Id, owner, default)).Operations, o => o.Kind == "recover-lease");
    }
}
