using Haas.Hosty.Core;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task AgentCleanupRecoversOnlyItsDurablePreEffectLeaseIntentAfterRestartAndRevocation()
    {
        var (f, _) = await SourceFixtureAsync();
        var workspaces = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var actor = WorkspaceTestOwner(f, Guid.NewGuid().ToString());
        var tree = await workspaces.PrepareAsync(actor, WorkspaceRequest(actor.SessionId), default);
        var known = Guid.NewGuid().ToString(); var unrelated = Guid.NewGuid().ToString();
        var provider = new AppRecord(actor.AppId, "Independent provider", null, "0.1.0", "runtime", false, "installed", null, null,
            "local", "installed", "stopped", null, null, [], new Dictionary<string, AppSettingValue>(), [], [], [], actor.Installation, actor.Installation);
        var store = new CoreAgentAuthorizationStore(f.Paths);
        var reference = new string('a', 64);
        var request = new CoreAgentAuthorizeRequest(new(provider.Id, PanelIdentity.Installation(provider), "native"), "runs.start", "PUT", "/not-replayed", new string('b', 64), SessionId: actor.SessionId, RunId: Guid.NewGuid().ToString());
        await store.Put(new(reference, new("app"), actor.UserId, "original-principal", "consumer", actor.Installation, null, request, null,
            DateTimeOffset.UtcNow.AddHours(-1), Admitted: true), default);
        await store.RecordLease(reference, new("", "", actor.SessionId, known, Guid.NewGuid().ToString()), default);
        await workspaces.CommandAsync(tree.Id, actor, "lease", new(Guid.NewGuid().ToString(), LeaseId: known), default);
        await workspaces.CommandAsync(tree.Id, actor, "lease", new(Guid.NewGuid().ToString(), LeaseId: unrelated), default);
        var reopened = new CoreAgentAuthorizationStore(f.Paths);
        Assert.Empty((await reopened.Get(reference, default)).Leases![0].WorktreeId);
        await using var host = await Http.CoreHttpHarness.StartAsync(configure: services => {
            services.AddSingleton(workspaces); services.AddSingleton(reopened);
        });
        var service = host.Services.GetRequiredService<CoreAgentExecution>();
        var input = new CoreAgentWorkspaceRequest(reference, "release_all", new("", RequestId: Guid.NewGuid().ToString()));
        await Assert.ThrowsAsync<AppIdentityException>(() => service.Workspace(provider with { Id = "other.provider" }, input, default));
        await service.Workspace(provider, input, default); await service.Workspace(provider, input, default);
        var actual = await workspaces.Read(tree.Id, null, default);
        Assert.DoesNotContain(known, actual.Leases); Assert.Contains(unrelated, actual.Leases);
        Assert.True((await reopened.Get(reference, default)).Leases![0].Released);
        var second = new string('c', 64);
        await reopened.Put((await reopened.Get(reference, default)) with { Id = second, Leases = [] }, default);
        await Assert.ThrowsAsync<CoreProviderException>(() => reopened.RecordLease(second,
            new(tree.WorkspaceId, tree.Id, actor.SessionId, known, Guid.NewGuid().ToString()), default));
    }

    [Fact]
    public async Task AgentLeaseAcknowledgementReleasesOnlyRecordedRepositoryAndPreservesOtherConsumers()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var first = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        var repository = await CreateGitRepositoryAsync(Path.Combine(f.Root, "agent-other-repository"));
        var app = (await f.Apps.GetAppAsync(SourceTestApp))!;
        await f.Apps.UpsertAppAsync(app with { Id = "independent.other", SourceState = app.SourceState! with { Repository = repository, LocalOverridePath = repository } });
        var second = await service.PrepareAsync(owner, WorkspaceRequest() with { AppId = "independent.other" }, default);
        var one = Guid.NewGuid().ToString(); var two = Guid.NewGuid().ToString();
        await service.CommandAsync(first.Id, owner, "lease", new(Guid.NewGuid().ToString(), LeaseId: one), default);
        await service.CommandAsync(second.Id, owner, "lease", new(Guid.NewGuid().ToString(), LeaseId: two), default);
        await service.SessionActivityAsync(owner, new("running", one, Sequence: 7), default);
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.ReleaseAgentLeaseAsync(first.Id, owner with { SessionId = "other" }, one, default));
        var firstAck = await service.ReleaseAgentLeaseAsync(first.Id, owner, one, default);
        Assert.NotEqual("idle", firstAck.State);
        Assert.DoesNotContain(one, (await service.Read(first.Id, null, default)).Leases);
        Assert.Contains(two, (await service.Read(second.Id, null, default)).Leases);
        var lastAck = await service.ReleaseAgentLeaseAsync(second.Id, owner, two, default);
        Assert.Equal("idle", lastAck.State);
        Assert.DoesNotContain(two, (await service.Read(second.Id, null, default)).Leases);
        Assert.Equal("idle", (await service.ReleaseAgentLeaseAsync(second.Id, owner, two, default)).State);
    }
}
