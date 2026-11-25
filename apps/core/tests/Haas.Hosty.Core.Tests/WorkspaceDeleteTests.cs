using Haas.Hosty.Core;
using Haas.Hosty.Core.Tests.Http;
using Microsoft.Extensions.DependencyInjection;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static WorkspaceCleanupService DeleteCleanup(DiscardFixture f)
    {
        var store = new CoreEnvironmentStore(f.F.Paths);
        var environments = new CoreEnvironmentService(store, new ResourceControlRuntime(), f.F.Clock, f.Service);
        return new(f.F.Paths, new(f.Service, f.F.Apps, f.F.Clock), f.Service, null!, f.F.Apps,
            store, environments, new(store, environments));
    }

    [Fact]
    public async Task WorkspaceDelete_ReturnsConfirmedLiveAppAfterBrowserClosesBeforeRemovingSource()
    {
        const string appId = "test.created", browser = "deletion-reviewer";
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        await f.Service.StartAsync(appId);
        await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", tree), default);
        await using var host = await CoreHttpHarness.StartAsync(f.Clock, services =>
        {
            services.AddSingleton(f.Paths); services.AddSingleton(f.Apps); services.AddSingleton(f.Service); services.AddSingleton(workspaces);
        });
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        var now = f.Clock.UtcNow;
        await users.WriteAsync(new(1, [new(owner.UserId, "operator@example.test", "Operator", "host.admin", false, now, now)], [], [],
            [new(browser, owner.UserId, now, now.AddHours(1), null, now, BrowserOrigin: "http://localhost")]));
        var cleanup = host.Services.GetRequiredService<WorkspaceCleanupService>();
        var worker = host.Services.GetRequiredService<AppExecutionTargetService>();
        var inspection = await cleanup.DeleteDetailsAsync(tree.WorkspaceId, owner.UserId, null, default);
        var target = Assert.Single(inspection.ReturnTargets!);
        Assert.Equal(appId, target.Name);
        var command = new WorkspaceDeleteCommand(Guid.NewGuid().ToString(), ReturnTargets: [target.Key]);
        var actor = new WorkspaceActivationActor(owner.UserId, "browser", Principal: "browser:" + DevelopmentWorkspaceService.Hash(browser));
        var wrong = await Assert.ThrowsAsync<AppLifecycleException>(() => cleanup.ApplyDeleteAsync(tree.WorkspaceId, owner.UserId, null,
            command with { ReturnTargets = [new string('a', 64)] }, default, authority: actor));
        Assert.Equal("workspace_selection_changed", wrong.Code);
        var pending = await cleanup.ApplyDeleteAsync(tree.WorkspaceId, owner.UserId, null, command, default, authority: actor);
        Assert.Equal("pending", pending.State);
        Assert.True(Directory.Exists(tree.Path));
        var state = await users.ReadAsync();
        await users.WriteAsync(state with { Sessions = [] });
        var token = new CancellationTokenSource(TimeSpan.FromSeconds(25)).Token;
        await worker.StartAsync(token);
        try
        {
            while (Directory.Exists(tree.Path))
            {
                await cleanup.RecoverDeletesAsync(token);
                if (Directory.Exists(tree.Path)) await Task.Delay(50, token);
            }
            var status = await cleanup.DeleteStatusAsync(tree.WorkspaceId, owner.UserId, null, command.RequestId, token);
            Assert.Equal("removed", status.State);
            var app = (await f.Apps.GetAppAsync(appId, token))!;
            Assert.Equal("running", app.RuntimeState);
            Assert.Equal(target.Replacement, app.SelectedRuntime);
        }
        finally { await worker.StopAsync(CancellationToken.None); }
    }

    [Fact]
    public async Task WorkspaceDelete_FencesNewAdmissionsAndWaitsForTheOriginalVerifiedWriter()
    {
        await using var f = await AgentLeaseRaceFixture.Create();
        var lease = Guid.NewGuid().ToString();
        await f.Acquire("direct", Guid.NewGuid().ToString(), lease);
        // These synthetic installations have no service processes. Losing contact with them
        // after acquisition must preserve the lease and never count as physical writer exit.
        var registry = f.Host.Services.GetRequiredService<AppRegistryStore>();
        foreach (var app in (await registry.ListAppRecordsAsync()).Where(app => string.IsNullOrWhiteSpace(app.ManifestPath)))
            await registry.UpsertAppAsync(app with { RuntimeState = "stopped" });
        var cleanup = f.Host.Services.GetRequiredService<WorkspaceCleanupService>();
        var command = new WorkspaceDeleteCommand(Guid.NewGuid().ToString());
        var result = await cleanup.ApplyDeleteAsync(f.Tree.WorkspaceId, f.Owner.UserId, null, command, default);
        Assert.Equal("pending", result.State);
        Assert.Contains("provider", result.Error);
        Assert.True(Directory.Exists(f.Tree.Path));
        var writer = Assert.Single(await cleanup.WriterStopsAsync(f.Consumer.Id, f.Consumer.InstalledAt, default));
        Assert.Equal(f.Reference, writer.AdmissionRef);
        Assert.Empty(await cleanup.WriterStopsAsync(f.Consumer.Id, f.Consumer.InstalledAt.AddSeconds(1), default));
        Assert.Empty(await cleanup.WriterStopsAsync(f.Provider.Id, f.Provider.InstalledAt, default));
        await f.ReleaseAll();
        await cleanup.RecoverDeletesAsync(default);
        Assert.False(Directory.Exists(f.Tree.Path));
        Assert.Empty(await cleanup.WriterStopsAsync(f.Consumer.Id, f.Consumer.InstalledAt, default));
        Assert.Equal("removed", (await cleanup.DeleteStatusAsync(f.Tree.WorkspaceId, f.Owner.UserId, null, command.RequestId, default)).State);
    }

    [Fact]
    public async Task WorkspaceDelete_DeliversFrozenOwnedChatsAfterRemovalUntilOwningInstallationAcknowledges()
    {
        using var f = await DiscardFixtureAsync();
        var participation = await f.Service.ParticipationAsync(f.Tree.WorkspaceId, f.Owner.UserId, default);
        var sibling = f.Owner with { SessionId = "also-selected" };
        participation = await f.Service.ChangeSessionAsync(participation.Id, sibling, "attach",
            new(Guid.NewGuid().ToString(), participation.Revision, "Sibling chat", "/sibling"), default);
        var other = f.Owner with { SessionId = "private-other", UserId = "other-member" };
        participation = await f.Service.ChangeMemberAsync(participation.Id, f.Owner.UserId, "grant",
            new(Guid.NewGuid().ToString(), participation.Revision, other.UserId, [f.Tree.Id]), default);
        await f.Service.ChangeSessionAsync(participation.Id, other, "attach",
            new(Guid.NewGuid().ToString(), participation.Revision, "Other chat", "/other"), default);
        var request = Guid.NewGuid().ToString();
        await f.Service.AdmitDeleteAsync(f.Owner, f.Owner.UserId, request, [], default,
            deleteOwner: new(f.Owner.AppId, f.Owner.Installation, true));
        var cleanup = DeleteCleanup(f);
        var installation = f.Owner.Installation;
        var delivery = Assert.Single(await cleanup.ChatRemovalsAsync(f.Owner.AppId, installation, default));
        Assert.Equal(new[] { f.Owner.SessionId, sibling.SessionId }.Order(), delivery.SessionIds);
        Assert.Empty(await cleanup.ChatRemovalsAsync(f.Owner.AppId, installation.AddSeconds(1), default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => cleanup.AcceptChatRemovalsAsync(f.Owner.AppId,
            installation.AddSeconds(1), f.Tree.WorkspaceId, request, default));
        var journal = await f.Service.ReadDiscardAsync(f.Tree.WorkspaceId, request, f.Owner.UserId, default);
        await f.Service.FinishDiscardAsync(f.Owner, f.Owner.UserId, journal!.Command, default);
        Assert.Single(await cleanup.ChatRemovalsAsync(f.Owner.AppId, installation, default));
        var sourceRemoved = await cleanup.DeleteStatusAsync(f.Tree.WorkspaceId, f.Owner.UserId, null, request, default);
        Assert.Equal("removed", sourceRemoved.State);
        Assert.Equal("pending", sourceRemoved.AttachedChatDelivery);
        Assert.True(await cleanup.AcceptChatRemovalsAsync(f.Owner.AppId, installation, f.Tree.WorkspaceId, request, default));
        Assert.Empty(await cleanup.ChatRemovalsAsync(f.Owner.AppId, installation, default));
        Assert.Equal("accepted", (await cleanup.DeleteStatusAsync(f.Tree.WorkspaceId, f.Owner.UserId, null, request, default)).AttachedChatDelivery);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task WorkspaceDelete_DifferentOperatorRemovesDirtyActiveWorkspaceWithoutReview(bool external)
    {
        using var f = await DiscardFixtureAsync(external);
        await AddDiscardableSource(f.Tree);
        var lease = Guid.NewGuid().ToString();
        await f.Service.CommandAsync(f.Tree.Id, f.Owner, "lease", new(Guid.NewGuid().ToString(), LeaseId: lease), default);
        var cleanup = DeleteCleanup(f);
        var details = await cleanup.DeleteDetailsAsync(f.Tree.WorkspaceId, "another-admin", null, default);
        Assert.Empty(details.Blockers);
        Assert.NotEmpty(details.Warnings!);
        Assert.NotEmpty(Assert.Single(details.Trees).ChangedFiles);
        var request = new WorkspaceDeleteCommand(Guid.NewGuid().ToString());
        var deleted = await cleanup.ApplyDeleteAsync(f.Tree.WorkspaceId, "another-admin", null, request, default);
        Assert.True(deleted.State == "removed", deleted.Error);
        Assert.Contains(deleted.Activity!, a => a.Reference == lease && a.State == "retired" && a.Detail!.Contains("unknown"));
        Assert.False(Directory.Exists(f.Tree.Path));
        Assert.True(Directory.Exists(f.Origin));
        Assert.Empty((await f.Service.ListAsync(null, true, default)).Workspaces);
        Assert.Equal("removed", (await cleanup.ApplyDeleteAsync(f.Tree.WorkspaceId, "third-admin", null, request, default)).State);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task WorkspaceDelete_ClientCancellationDuringChildFinishStillFinishesAcceptedCleanup(bool batch)
    {
        using var f = await DiscardFixtureAsync();
        using var caller = new CancellationTokenSource();
        var store = new CoreEnvironmentStore(f.F.Paths);
        var runtime = new ResourceControlRuntime();
        var environments = new CoreEnvironmentService(store, runtime, f.F.Clock, f.Service);
        var cleanup = new WorkspaceCleanupService(f.F.Paths, new(f.Service, f.F.Apps, f.F.Clock), f.Service, null!, f.F.Apps,
            store, environments, new(store, environments));
        var another = batch ? await f.Service.PrepareAsync(WorkspaceTestOwner(f.F, "second-delete"), WorkspaceRequest("second-delete"), default) : null;
        var targets = another is null ? new[] { f.Tree } : new[] { f.Tree, another };
        foreach (var target in targets)
            await environments.CreateAsync(new("admin"), new(Guid.NewGuid().ToString(), "Deletion child",
                Context: new(WorkspaceId: target.WorkspaceId), WorktreeIds: [target.Id]), default);
        var first = targets.OrderBy(t => t.WorkspaceId, StringComparer.Ordinal).First();
        var requestId = Guid.NewGuid().ToString();
        runtime.StopProbe = async () =>
        {
            Assert.Equal("deleting", (await f.Service.WorkflowAsync(first.Owner, default)).State);
            Assert.All(targets, target => Assert.True(Directory.Exists(target.Path)));
            // Harness stops the calling agent when its next activity report sees the deletion fence.
            // Cancel on the first batch target so the remaining target must still be processed.
            caller.Cancel();
            runtime.StopProbe = null;
        };

        if (batch)
        {
            var command = new WorkspaceDeleteBatchCommand(requestId, [f.Tree.WorkspaceId, another!.WorkspaceId]);
            var removed = await cleanup.DeleteBatchAsync("admin", null, command, caller.Token);
            Assert.All(removed.Targets, target => Assert.True(target.State == "removed", target.Error));
            Assert.Equal(2, removed.Targets.Length);
            var replay = await cleanup.DeleteBatchAsync("admin", null, command, default);
            Assert.Equal(removed.Targets.Select(t => t.RequestId), replay.Targets.Select(t => t.RequestId));
            Assert.False(Directory.Exists(another.Path));
        }
        else
        {
            var command = new WorkspaceDeleteCommand(requestId);
            var removed = await cleanup.ApplyDeleteAsync(f.Tree.WorkspaceId, "admin", null, command, caller.Token);
            Assert.True(removed.State == "removed", removed.Error);
            Assert.Equal(requestId, removed.RequestId);
            Assert.Equal("removed", (await cleanup.ApplyDeleteAsync(f.Tree.WorkspaceId, "admin", null, command, default)).State);
        }
        Assert.True(caller.IsCancellationRequested);
        Assert.False(Directory.Exists(f.Tree.Path));
        Assert.Empty((await f.Service.ListAsync(null, true, default)).Workspaces);
        Assert.True(Directory.Exists(f.Origin));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task WorkspaceDelete_CancelledBeforeAdmissionPreservesSource(bool batch)
    {
        using var f = await DiscardFixtureAsync();
        using var caller = new CancellationTokenSource();
        caller.Cancel();
        var cleanup = DeleteCleanup(f);
        var requestId = Guid.NewGuid().ToString();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
        {
            if (batch) await cleanup.DeleteBatchAsync("admin", null, new(requestId, [f.Tree.WorkspaceId]), caller.Token);
            else await cleanup.ApplyDeleteAsync(f.Tree.WorkspaceId, "admin", null, new(requestId), caller.Token);
        });
        Assert.True(Directory.Exists(f.Tree.Path));
        Assert.Null(await f.Service.ReadDiscardAsync(f.Tree.WorkspaceId, requestId, "admin", default));
        Assert.Equal("in-progress", (await f.Service.WorkflowAsync(f.Owner, default)).State);
    }

    [Fact]
    public async Task WorkspaceDelete_CoreShutdownRetainsRequestForRecovery()
    {
        using var f = await DiscardFixtureAsync();
        using var lifetime = new RestartTestLifetime();
        var store = new CoreEnvironmentStore(f.F.Paths);
        var runtime = new ResourceControlRuntime();
        var environments = new CoreEnvironmentService(store, runtime, f.F.Clock, f.Service);
        await environments.CreateAsync(new("admin"), new(Guid.NewGuid().ToString(), "Deletion child",
            Context: new(WorkspaceId: f.Tree.WorkspaceId), WorktreeIds: [f.Tree.Id]), default);
        WorkspaceCleanupService Cleanup(RestartTestLifetime? host = null) => new(f.F.Paths, new(f.Service, f.F.Apps, f.F.Clock),
            f.Service, null!, f.F.Apps, store, environments, new(store, environments), host);
        var command = new WorkspaceDeleteCommand(Guid.NewGuid().ToString());
        runtime.StopProbe = () => { lifetime.StopApplication(); return Task.CompletedTask; };
        var pending = await Cleanup(lifetime).ApplyDeleteAsync(f.Tree.WorkspaceId, "admin", null, command, default);
        Assert.Equal("pending", pending.State);
        Assert.NotNull(pending.Error);
        Assert.Equal(command.RequestId, pending.RequestId);
        Assert.True(Directory.Exists(f.Tree.Path));
        runtime.StopProbe = null;
        var removed = await Cleanup().ApplyDeleteAsync(f.Tree.WorkspaceId, "admin", null, command, default);
        Assert.True(removed.State == "removed", removed.Error);
        Assert.Equal(command.RequestId, removed.RequestId);
        Assert.False(Directory.Exists(f.Tree.Path));
    }

    [Fact]
    public async Task WorkspaceDelete_SourceChangesAfterAdmissionDoNotRequireAnotherConfirmation()
    {
        using var f = await DiscardFixtureAsync();
        var id = Guid.NewGuid().ToString();
        await f.Service.AdmitDeleteAsync(f.Owner, "admin", id, [], default);
        await AddDiscardableSource(f.Tree);
        var deleted = await DeleteCleanup(f).ApplyDeleteAsync(f.Tree.WorkspaceId, "admin", null, new(id), default);
        Assert.True(deleted.State == "removed", deleted.Error);
    }

    [Fact]
    public async Task WorkspaceDelete_MissingDirectoryStillRemovesItsGitRegistrationAndBranch()
    {
        using var f = await DiscardFixtureAsync();
        Directory.Delete(f.Tree.Path, true);
        var deleted = await DeleteCleanup(f).ApplyDeleteAsync(f.Tree.WorkspaceId, "admin", null, new(Guid.NewGuid().ToString()), default);
        Assert.True(deleted.State == "removed", deleted.Error);
        Assert.Empty((await f.Service.ListAsync(null, true, default)).Workspaces);
    }

    [Theory]
    [InlineData("preparing")]
    [InlineData("failed")]
    public async Task WorkspaceDelete_RemovesPartialPreparationWithoutGitMetadata(string state)
    {
        using var f = await DiscardFixtureAsync();
        await RunGitAsync(Path.Combine(f.F.Paths.CoreRoot, "development", "repositories", f.Tree.RepositoryId + ".git"),
            ["worktree", "remove", "--force", f.Tree.Path]);
        Directory.CreateDirectory(f.Tree.Path);
        await File.WriteAllTextAsync(Path.Combine(f.Tree.Path, "partial.txt"), "incomplete preparation");
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development", "workspaces", f.Tree.Id + ".json"),
            f.Tree with { State = state });
        var removed = await DeleteCleanup(f).ApplyDeleteAsync(f.Tree.WorkspaceId, "another-admin", null,
            new(Guid.NewGuid().ToString()), default);
        Assert.True(removed.State == "removed", removed.Error);
        Assert.False(Directory.Exists(f.Tree.Path));
    }

    [Theory]
    [InlineData("detached")]
    [InlineData("missing-git")]
    [InlineData("nested-repository")]
    public async Task WorkspaceDelete_CheckoutStateDoesNotBlockRemoval(string state)
    {
        using var f = await DiscardFixtureAsync();
        if (state == "detached") await RunGitAsync(f.Tree.Path, ["checkout", "--detach"]);
        if (state == "missing-git") File.Delete(Path.Combine(f.Tree.Path, ".git"));
        if (state == "nested-repository")
        {
            Directory.CreateDirectory(Path.Combine(f.Tree.Path, "nested"));
            await RunGitAsync(Path.Combine(f.Tree.Path, "nested"), ["init"]);
        }
        var unrelated = Path.Combine(f.F.Root, "keep-outside-workspace");
        Directory.CreateDirectory(unrelated);
        await File.WriteAllTextAsync(Path.Combine(unrelated, "keep.txt"), "preserved");
        if (!OperatingSystem.IsWindows()) Directory.CreateSymbolicLink(Path.Combine(f.Tree.Path, "external-link"), unrelated);
        var removed = await DeleteCleanup(f).ApplyDeleteAsync(f.Tree.WorkspaceId, "another-admin", null,
            new(Guid.NewGuid().ToString()), default);
        Assert.True(removed.State == "removed", removed.Error);
        Assert.False(Directory.Exists(f.Tree.Path));
        Assert.True(File.Exists(Path.Combine(unrelated, "keep.txt")));
    }

    [Fact]
    public async Task WorkspaceDelete_RetryDoesNotDeleteRecreatedAllocationOrExpandBatch()
    {
        using var f = await DiscardFixtureAsync();
        var cleanup = DeleteCleanup(f);
        var command = new WorkspaceDeleteBatchCommand(Guid.NewGuid().ToString(), All: true);
        var first = await cleanup.DeleteBatchAsync("admin", null, command, default);
        Assert.Equal("removed", Assert.Single(first.Targets).State);
        var recreated = await f.Service.PrepareAsync(f.Owner, WorkspaceRequest() with { RequestId = Guid.NewGuid().ToString() }, default);
        var other = await f.Service.PrepareAsync(WorkspaceTestOwner(f.F, "later-session"), WorkspaceRequest("later-session"), default);
        await File.WriteAllTextAsync(Path.Combine(recreated.Path, "keep.txt"), "new work");
        var replay = await cleanup.DeleteBatchAsync("another-admin", null, command, default);
        Assert.Single(replay.Targets);
        Assert.True(File.Exists(Path.Combine(recreated.Path, "keep.txt")));
        Assert.True(Directory.Exists(other.Path));
        var singleReplay = await cleanup.ApplyDeleteAsync(recreated.WorkspaceId, "admin", null, new(first.Targets[0].RequestId), default);
        Assert.Equal("removed", singleReplay.State);
        Assert.True(Directory.Exists(recreated.Path));
    }

    [Fact]
    public async Task WorkspaceDelete_PathReplacementFailureRetainsRequestAndCanBeRetried()
    {
        if (OperatingSystem.IsWindows()) return;
        using var f = await DiscardFixtureAsync();
        var cleanup = DeleteCleanup(f);
        var request = new WorkspaceDeleteCommand(Guid.NewGuid().ToString());
        var saved = f.Tree.Path + ".saved";
        var unrelated = Path.Combine(f.F.Root, "unrelated-data");
        Directory.CreateDirectory(unrelated);
        await File.WriteAllTextAsync(Path.Combine(unrelated, "keep.txt"), "preserve");
        Directory.Move(f.Tree.Path, saved);
        Directory.CreateSymbolicLink(f.Tree.Path, unrelated);
        var pending = await cleanup.ApplyDeleteAsync(f.Tree.WorkspaceId, "admin", null, request, default);
        Assert.Equal("pending", pending.State);
        Assert.NotNull(pending.Error);
        Assert.Equal(request.RequestId, pending.RequestId);
        Assert.True(File.Exists(Path.Combine(unrelated, "keep.txt")));
        Directory.Delete(f.Tree.Path);
        Directory.Move(saved, f.Tree.Path);
        var deleted = await cleanup.ApplyDeleteAsync(f.Tree.WorkspaceId, "another-admin", null, request, default);
        Assert.True(deleted.State == "removed", deleted.Error);
        Assert.True(File.Exists(Path.Combine(unrelated, "keep.txt")));
    }
    [Theory]
    [InlineData("workspace")]
    [InlineData("legacy")]
    [InlineData("source")]
    public async Task WorkspaceDelete_AnotherUserFinishesOnlyAcceptedResourcesAndRetriesRealFailure(string association)
    {
        var legacySessionContext = association == "legacy";
        using var f = await DiscardFixtureAsync(external: !legacySessionContext);
        var resourceOwner = legacySessionContext ? new SandboxActor(f.Owner.UserId, f.Owner.AppId, f.Owner.Installation) : new("admin");
        var context = legacySessionContext ? new SandboxContext(SessionId: f.Owner.SessionId)
            : association == "source" ? null : new(WorkspaceId: f.Tree.WorkspaceId);
        var store = new CoreEnvironmentStore(f.F.Paths);
        var runtime = new ResourceControlRuntime();
        var environments = new CoreEnvironmentService(store, runtime, f.F.Clock, f.Service);
        var cleanup = new WorkspaceCleanupService(f.F.Paths, new(f.Service, f.F.Apps, f.F.Clock), f.Service, null!, f.F.Apps,
            store, environments, new(store, environments));
        var child = await environments.CreateAsync(resourceOwner, new(Guid.NewGuid().ToString(), "Owned test data",
            Context: context, WorktreeIds: [f.Tree.Id]), default);
        var unrelated = await environments.CreateAsync(new("admin"), new(Guid.NewGuid().ToString(), "Unrelated data"), default);
        var command = new WorkspaceDeleteCommand(Guid.NewGuid().ToString());
        runtime.FailStop = true;
        var pending = await cleanup.ApplyDeleteAsync(f.Tree.WorkspaceId, "another-admin", null, command, default);
        Assert.Equal("pending", pending.State);
        Assert.True(Directory.Exists(f.Tree.Path));
        var accepted = await f.Service.ReadDiscardAsync(f.Tree.WorkspaceId, command.RequestId, "another-admin", default);
        Assert.Equal("another-admin", accepted!.Actor);
        var ids = accepted.Cleanup.Select(r => r.RequestId).ToArray();
        runtime.FailStop = false;
        var removed = await cleanup.ApplyDeleteAsync(f.Tree.WorkspaceId, "third-admin", null, command, default);
        Assert.True(removed.State == "removed", removed.Error);
        Assert.Equal("finished", (await environments.ReadAsync(new("admin"), child.Id, default)).State);
        Assert.True(Directory.Exists(unrelated.DataRoot));
        Assert.Single((await store.ReadAsync(child.Id, default))!.Operations!, op => ids.Contains(Guid.Parse(op.Id).ToString("D")));
        Assert.DoesNotContain("deletingWorkspace", CoreJson.Text(new SandboxActor("admin") { DeletingWorkspace = f.Tree.WorkspaceId }), StringComparison.OrdinalIgnoreCase);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task WorkspaceDelete_RefusesDevRuntimeUntilExplicitReturnAndPreservesOrdinaryData(bool running)
    {
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture(shortPaths: true);
        try
        {
            if (running) await f.Service.StartAsync("test.created");
            var before = (await f.Apps.GetAppAsync("test.created"))!;
            var data = Path.Combine(f.Paths.AppsRoot, "test.created", "data", "notes.txt");
            Directory.CreateDirectory(Path.GetDirectoryName(data)!);
            await File.WriteAllTextAsync(data, "before development");
            await ApplyReviewedDev(f.Service, DevRequest("enter", tree.Id), DevActor(owner));
            await File.WriteAllTextAsync(data, "ordinary data changed during development");
            await File.WriteAllTextAsync(Path.Combine(tree.Path, "unfinished.txt"), "discard this source");
            var store = new CoreEnvironmentStore(f.Paths);
            var environments = new CoreEnvironmentService(store, new ResourceControlRuntime(), f.Clock, workspaces);
            var cleanup = new WorkspaceCleanupService(f.Paths, new(workspaces, f.Apps, f.Clock), workspaces, null!, f.Apps,
                store, environments, new(store, environments));

            var command = new WorkspaceDeleteCommand(Guid.NewGuid().ToString());
            var details = await cleanup.DeleteDetailsAsync(tree.WorkspaceId, "another-admin", null, default);
            Assert.NotEmpty(details.Blockers);
            var starts = f.Adapter.StartCount;
            var stops = f.Adapter.StopCount;
            var refusal = await Assert.ThrowsAsync<AppLifecycleException>(() =>
                cleanup.ApplyDeleteAsync(tree.WorkspaceId, "another-admin", null, command, default));
            Assert.Equal("workspace_in_use", refusal.Code);
            Assert.True(File.Exists(Path.Combine(tree.Path, "unfinished.txt")));
            Assert.Equal("active", (await f.Service.GetDevModeAsync("test.created")).Phase);
            Assert.Equal(starts, f.Adapter.StartCount);
            Assert.Equal(stops, f.Adapter.StopCount);
            Assert.Null(await workspaces.ReadDiscardAsync(tree.WorkspaceId, command.RequestId, "another-admin", default));
            Assert.Equal("in-progress", (await workspaces.WorkflowAsync(owner, default)).State);

            await ApplyReviewedDev(f.Service, DevRequest("return") with { AcceptDataChanges = true }, DevActor(owner));
            var removed = await cleanup.ApplyDeleteAsync(tree.WorkspaceId, "another-admin", null, command, default);
            Assert.True(removed.State == "removed", removed.Error);
            Assert.False(Directory.Exists(tree.Path));
            Assert.Equal("returned", (await f.Service.GetDevModeAsync("test.created")).Phase);
            var after = (await f.Apps.GetAppAsync("test.created"))!;
            Assert.Equal(before.SourceState, after.SourceState);
            Assert.Equal(running ? "running" : "stopped", after.RuntimeState);
            Assert.Equal("ordinary data changed during development", await File.ReadAllTextAsync(data));
        }
        finally { CoreOwnedDirectoryCleanup.Delete(f.Root); }
    }

    [Fact]
    public async Task WorkspaceDelete_RefusesSelectedAppSourceWithoutStoppingIt()
    {
        using var f = await DiscardFixtureAsync();
        var app = (await f.F.Apps.GetAppAsync(SourceTestApp))!;
        await f.F.Apps.UpsertAppAsync(app with { SourceState = app.SourceState! with { LocalOverridePath = f.Tree.Path } });
        var cleanup = DeleteCleanup(f);
        var command = new WorkspaceDeleteCommand(Guid.NewGuid().ToString());
        var stops = f.F.Adapter.StopCount;

        var details = await cleanup.DeleteDetailsAsync(f.Tree.WorkspaceId, "admin", null, default);
        Assert.NotEmpty(details.Blockers);
        var refusal = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            cleanup.ApplyDeleteAsync(f.Tree.WorkspaceId, "admin", null, command, default));

        Assert.Equal("workspace_in_use", refusal.Code);
        Assert.Equal(stops, f.F.Adapter.StopCount);
        Assert.True(Directory.Exists(f.Tree.Path));
        Assert.Null(await f.Service.ReadDiscardAsync(f.Tree.WorkspaceId, command.RequestId, "admin", default));
        Assert.Equal("in-progress", (await f.Service.WorkflowAsync(f.Owner, default)).State);
    }

    [Theory]
    [InlineData("running")]
    [InlineData("preparing")]
    [InlineData("prepared")]
    [InlineData("core-starting")]
    [InlineData("active")]
    [InlineData("return-core-starting")]
    [InlineData("return-baseline")]
    public async Task WorkspaceDelete_RefusesRunningReservedAndReturnCoreSource(string kind)
    {
        using var f = await DiscardFixtureAsync(external: true);
        var tree = f.Tree;
        var project = Path.Combine(tree.Path, "Core.csproj");
        var core = new CoreDevelopmentService(new(f.F.Paths.DataRoot, Path.Combine(f.F.Paths.CoreRoot, "run"),
            Path.Combine(f.F.Paths.CoreRoot, "run/control.json"), 7070, "http://localhost:7070", null, "localhost", null, false),
            new(kind == "running" ? "dev" : "release", kind == "running" ? project : null, null, 123, f.F.Clock.UtcNow));
        var workspaces = new DevelopmentWorkspaceService(f.F.Paths, f.F.Apps, f.F.Clock, coreDevelopment: core);
        if (kind != "running")
        {
            var baseline = kind == "return-baseline";
            WorkspaceRuntimeFiles.Save(f.F.Paths.DataRoot, new WorkspaceRuntimeActivation(Guid.NewGuid().ToString(),
                tree.WorkspaceId, f.Owner.UserId, "review", "instance", "revision", baseline ? "another-tree" : tree.Id,
                baseline ? Path.Combine(f.F.Root, "another-core", "Core.csproj") : project,
                new(baseline ? "dev" : "release", baseline ? project : null, null, 1, f.F.Clock.UtcNow), [],
                baseline ? "active" : kind, CoreReserved: true));
        }
        var store = new CoreEnvironmentStore(f.F.Paths);
        var runtime = new ResourceControlRuntime();
        var environments = new CoreEnvironmentService(store, runtime, f.F.Clock, workspaces);
        var child = await environments.CreateAsync(new("admin"), new(Guid.NewGuid().ToString(), "Keep until runtime returns",
            Context: new(WorkspaceId: tree.WorkspaceId), WorktreeIds: [tree.Id]), default);
        var cleanup = new WorkspaceCleanupService(f.F.Paths, new(workspaces, f.F.Apps, f.F.Clock), workspaces, null!, f.F.Apps,
            store, environments, new(store, environments));
        var command = new WorkspaceDeleteCommand(Guid.NewGuid().ToString());

        Assert.NotEmpty((await cleanup.DeleteDetailsAsync(tree.WorkspaceId, "admin", null, default)).Blockers);
        var refusal = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            cleanup.ApplyDeleteAsync(tree.WorkspaceId, "admin", null, command, default));

        Assert.Equal("workspace_in_use", refusal.Code);
        Assert.True(Directory.Exists(tree.Path));
        Assert.True(Directory.Exists(child.DataRoot));
        Assert.Equal(0, runtime.Stops);
        Assert.Null(await workspaces.ReadDiscardAsync(tree.WorkspaceId, command.RequestId, "admin", default));
        Assert.Equal("in-progress", (await workspaces.WorkflowAsync(f.Owner, default)).State);
    }

    [Fact]
    public async Task WorkspaceDelete_BatchPreservesProtectedRuntimeAndDeletesOtherTarget()
    {
        using var f = await DiscardFixtureAsync();
        var other = await f.Service.PrepareAsync(WorkspaceTestOwner(f.F, "unconsumed"), WorkspaceRequest("unconsumed"), default);
        var app = (await f.F.Apps.GetAppAsync(SourceTestApp))!;
        await f.F.Apps.UpsertAppAsync(app with { SourceState = app.SourceState! with { LocalOverridePath = f.Tree.Path } });
        var command = new WorkspaceDeleteBatchCommand(Guid.NewGuid().ToString(), [f.Tree.WorkspaceId, other.WorkspaceId]);

        var result = await DeleteCleanup(f).DeleteBatchAsync("admin", null, command, default);

        var blocked = Assert.Single(result.Targets, t => t.WorkspaceId == f.Tree.WorkspaceId);
        Assert.Equal("pending", blocked.State);
        Assert.Contains("source override", blocked.Error);
        Assert.Equal("removed", Assert.Single(result.Targets, t => t.WorkspaceId == other.WorkspaceId).State);
        Assert.True(Directory.Exists(f.Tree.Path));
        Assert.False(Directory.Exists(other.Path));
        Assert.Equal("in-progress", (await f.Service.WorkflowAsync(f.Owner, default)).State);
    }

    [Fact]
    public async Task WorkspaceDelete_RechecksRetainedRequestBeforeFinishingChildResources()
    {
        using var f = await DiscardFixtureAsync();
        var store = new CoreEnvironmentStore(f.F.Paths);
        var runtime = new ResourceControlRuntime();
        var environments = new CoreEnvironmentService(store, runtime, f.F.Clock, f.Service);
        var child = await environments.CreateAsync(new("admin"), new(Guid.NewGuid().ToString(), "Owned test data",
            Context: new(WorkspaceId: f.Tree.WorkspaceId), WorktreeIds: [f.Tree.Id]), default);
        var request = new WorkspaceDeleteCommand(Guid.NewGuid().ToString());
        await f.Service.AdmitDeleteAsync(f.Owner, "admin", request.RequestId,
            [new(child.Id, "core", "Owned test data", child.DataRoot, "created", 0)], default);
        var app = (await f.F.Apps.GetAppAsync(SourceTestApp))!;
        await f.F.Apps.UpsertAppAsync(app with { SourceState = app.SourceState! with { LocalOverridePath = f.Tree.Path } });
        var cleanup = new WorkspaceCleanupService(f.F.Paths, new(f.Service, f.F.Apps, f.F.Clock), f.Service, null!, f.F.Apps,
            store, environments, new(store, environments));

        var blocked = await cleanup.ApplyDeleteAsync(f.Tree.WorkspaceId, "admin", null, request, default);

        Assert.Equal("pending", blocked.State);
        Assert.Contains("source override", blocked.Error);
        Assert.Equal(0, runtime.Stops);
        Assert.True(Directory.Exists(child.DataRoot));
        Assert.True(Directory.Exists(f.Tree.Path));
    }

    [Fact]
    public async Task WorkspaceDelete_RechecksCoreConsumerAfterChildFinishAndRetriesOriginalRequest()
    {
        using var f = await DiscardFixtureAsync();
        var store = new CoreEnvironmentStore(f.F.Paths);
        var runtime = new ResourceControlRuntime();
        var environments = new CoreEnvironmentService(store, runtime, f.F.Clock, f.Service);
        var child = await environments.CreateAsync(new("admin"), new(Guid.NewGuid().ToString(), "Owned test data",
            Context: new(WorkspaceId: f.Tree.WorkspaceId), WorktreeIds: [f.Tree.Id]), default);
        var activation = new WorkspaceRuntimeActivation(Guid.NewGuid().ToString(), f.Tree.WorkspaceId, f.Owner.UserId,
            "review", "instance", "revision", f.Tree.Id, Path.Combine(f.Tree.Path, "Core.csproj"),
            new("release", null, null, 1, f.F.Clock.UtcNow), [], "core-starting");
        runtime.StopProbe = () => { WorkspaceRuntimeFiles.Save(f.F.Paths.DataRoot, activation); return Task.CompletedTask; };
        var cleanup = new WorkspaceCleanupService(f.F.Paths, new(f.Service, f.F.Apps, f.F.Clock), f.Service, null!, f.F.Apps,
            store, environments, new(store, environments));
        var request = new WorkspaceDeleteCommand(Guid.NewGuid().ToString());

        var blocked = await cleanup.ApplyDeleteAsync(f.Tree.WorkspaceId, "admin", null, request, default);

        Assert.Equal("pending", blocked.State);
        Assert.Contains("Core consumes", blocked.Error);
        Assert.True(Directory.Exists(f.Tree.Path));
        Assert.False(Directory.Exists(child.DataRoot));
        Assert.Equal(1, runtime.Stops);
        WorkspaceRuntimeFiles.Save(f.F.Paths.DataRoot, activation with { Phase = "returned", CoreReturned = true });
        var removed = await cleanup.ApplyDeleteAsync(f.Tree.WorkspaceId, "admin", null, request, default);
        Assert.True(removed.State == "removed", removed.Error);
        Assert.Equal(request.RequestId, removed.RequestId);
        Assert.Equal(1, runtime.Stops);
        Assert.False(Directory.Exists(f.Tree.Path));
    }

    [Fact]
    public async Task WorkspaceDelete_PreservesUnknownSandboxBinding()
    {
        using var f = await DiscardFixtureAsync();
        var sandboxId = Guid.NewGuid().ToString("N");
        await f.Service.SetSandboxConsumerAsync(f.Tree.Id, sandboxId, true, default);
        var command = new WorkspaceDeleteCommand(Guid.NewGuid().ToString());
        var cleanup = DeleteCleanup(f);

        Assert.NotEmpty((await cleanup.DeleteDetailsAsync(f.Tree.WorkspaceId, "admin", null, default)).Blockers);
        var refusal = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            cleanup.ApplyDeleteAsync(f.Tree.WorkspaceId, "admin", null, command, default));

        Assert.Equal("workspace_in_use", refusal.Code);
        Assert.True(Directory.Exists(f.Tree.Path));
        Assert.Null(await f.Service.ReadDiscardAsync(f.Tree.WorkspaceId, command.RequestId, "admin", default));
    }
}
