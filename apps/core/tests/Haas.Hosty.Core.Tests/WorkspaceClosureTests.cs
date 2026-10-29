using System.Security.Cryptography;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Theory]
    [InlineData("pause")]
    [InlineData("close")]
    public async Task WorkspaceClosure_RestartPreservesDirtySourceAndFencesActivityUntilResume(string action)
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var lease = Guid.NewGuid().ToString();
        var tree = await service.PrepareAsync(owner, WorkspaceRequest() with { LeaseId = lease }, default);
        var files = new[] { Path.Combine(tree.Path, "README.md"), Path.Combine(tree.Path, "untracked.bin") };
        await File.WriteAllTextAsync(files[0], "unfinished change\n");
        await File.WriteAllBytesAsync(files[1], [0, 1, 255, 8]);
        string[] Hashes() => files.Select(p => Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(p)))).ToArray();
        var hashes = Hashes();
        var close = new WorkspaceWorkflowCommand(Guid.NewGuid().ToString(), 0);
        var heads = new Dictionary<string, string>();
        var pending = await service.ChangeWorkflowAsync(owner, "admin", action, close, heads, default, prepareOnly: true);
        Assert.Equal("closing", pending.Closure);
        Assert.Equal("in-progress", pending.State);
        Assert.Null(pending.CompletedAt);
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.PrepareAsync(owner, WorkspaceRequest(), default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.CommandAsync(tree.Id, owner, "lease", new(Guid.NewGuid().ToString(), LeaseId: Guid.NewGuid().ToString()), default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.SetSandboxConsumerAsync(tree.Id, Guid.NewGuid().ToString("N"), true, default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.ChangeWorkflowAsync(owner, "admin", action, close, heads, default));
        service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var recovered = await service.WorkflowAsync(owner, default);
        Assert.Equal(close.RequestId, Assert.Single(recovered.Operations!).Id);
        Assert.Contains("lease", recovered.Operations![0].Error, StringComparison.OrdinalIgnoreCase);
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.ChangeWorkflowAsync(owner, "admin", "resume", new(Guid.NewGuid().ToString(), 0), heads, default));
        await service.CommandAsync(tree.Id, owner, "release-lease", new(Guid.NewGuid().ToString(), LeaseId: lease), default);
        var closed = await service.ChangeWorkflowAsync(owner, "admin", action, close, heads, default);
        Assert.Equal("closed", closed.Closure);
        Assert.Equal("in-progress", closed.State);
        Assert.Equal(1, closed.Revision);
        Assert.Equal(hashes, Hashes());
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.ChangeWorkflowAsync(owner, "admin", "delete", new(Guid.NewGuid().ToString(), 1), heads, default));
        var resumed = await service.ChangeWorkflowAsync(owner, "admin", "resume", new(Guid.NewGuid().ToString(), 1), heads, default);
        Assert.Null(resumed.Closure);
        Assert.Equal(CoreJson.Text(resumed), CoreJson.Text(await service.ChangeWorkflowAsync(owner, "admin", action, close, heads, default)));
        Assert.Equal(tree.Id, (await service.PrepareAsync(owner, WorkspaceRequest(), default)).Id);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task WorkspaceClosure_WaitsForAdmittedPreviewBeforeClosing(bool prepareOnly)
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var attach = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var previewId = Guid.NewGuid().ToString("N");
        var allocation = service.WithResourceContextAsync(new(owner.UserId), new(WorkspaceId: tree.WorkspaceId), async () =>
        {
            entered.SetResult();
            await attach.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await service.SetSandboxConsumerAsync(tree.Id, previewId, true, default);
            return previewId;
        }, default);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var request = new WorkspaceWorkflowCommand(Guid.NewGuid().ToString(), 0);
        var close = service.ChangeWorkflowAsync(owner, "admin", "close", request, new Dictionary<string, string>(), default, prepareOnly);
        try
        {
            // An admitted allocation must finish its source attachment before close can fence it.
            await Task.WhenAny(close, Task.Delay(100));
            Assert.False(close.IsCompleted);
            Assert.Null((await service.WorkflowAsync(owner, default)).Closure);
        }
        finally { attach.TrySetResult(); }
        Assert.Equal(previewId, await allocation.WaitAsync(TimeSpan.FromSeconds(5)));
        var result = await close.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(prepareOnly ? "closing" : "closed", result.Closure);
        Assert.Contains(previewId, (await service.Read(tree.Id, owner, default)).SandboxConsumers);
        var invoked = false;
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.WithResourceContextAsync(new(owner.UserId), new(WorkspaceId: tree.WorkspaceId),
            () => Task.FromResult(invoked = true), default));
        Assert.False(invoked);
    }

    [Fact]
    public async Task WorkspaceClosure_DefersQueuedPublicationCleanupUntilResume()
    {
        var f = await PublicationFixture();
        var head = f.W.Observation!.Head!;
        await f.Service.CommandAsync(f.W.Id, f.W.Owner, "publish", new(Guid.NewGuid().ToString(), head, Title: "Contribution"), default);
        await f.Service.CommandAsync(f.W.Id, f.W.Owner, "complete", new(Guid.NewGuid().ToString(), head, Outcome: "submitted", Cleanup: true), default);
        var lease = Guid.NewGuid().ToString();
        await f.Workspaces.CommandAsync(f.W.Id, f.W.Owner, "lease", new(Guid.NewGuid().ToString(), LeaseId: lease), default);
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.CleanupAsync(f.W.Id, default));
        var close = new WorkspaceWorkflowCommand(Guid.NewGuid().ToString(), 0);
        var heads = new Dictionary<string, string>();
        await f.Workspaces.ChangeWorkflowAsync(f.W.Owner, "admin", "close", close, heads, default, prepareOnly: true);
        await f.Workspaces.CommandAsync(f.W.Id, f.W.Owner, "release-lease", new(Guid.NewGuid().ToString(), LeaseId: lease), default);
        Assert.Equal("workspace_workflow_closed", (await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.CleanupAsync(f.W.Id, default))).Code);
        var closed = await f.Workspaces.ChangeWorkflowAsync(f.W.Owner, "admin", "close", close, heads, default);
        Assert.Equal("workspace_workflow_closed", (await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.CleanupAsync(f.W.Id, default))).Code);
        Assert.True(Directory.Exists(f.W.Path));
        Assert.Equal("active", (await f.Workspaces.Read(f.W.Id, f.W.Owner, default)).State);
        Assert.True((await f.Service.ObserveAsync(f.W.Id, f.W.Owner, default)).CleanupRequested);
        await f.Workspaces.ChangeWorkflowAsync(f.W.Owner, "admin", "resume", new(Guid.NewGuid().ToString(), closed.Revision), heads, default);
        Assert.True(Directory.Exists(f.W.Path));
        await f.Service.CleanupAsync(f.W.Id, default);
        Assert.False(Directory.Exists(f.W.Path));
    }

    [Fact]
    public async Task WorkspaceClosure_AllowsRecoveryOfPublicationCleanupAdmittedBeforeClose()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        var op = new WorkspaceOperation("publication-cleanup", "cleanup", tree.OriginalBase, "pending", tree.OriginalBase);
        await JsonStorage.WriteAsync(Path.Combine(f.Paths.CoreRoot, "development", "workspaces", tree.Id + ".json"),
            tree with { State = "releasing", Operations = [.. tree.Operations, op] });
        var repo = Path.Combine(f.Paths.CoreRoot, "development", "repositories", tree.RepositoryId + ".git");
        await RunGitAsync(repo, ["worktree", "remove", tree.Path]);
        var close = new WorkspaceWorkflowCommand(Guid.NewGuid().ToString(), 0);
        var heads = new Dictionary<string, string>();
        await service.ChangeWorkflowAsync(owner, "admin", "close", close, heads, default, prepareOnly: true);
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.ChangeWorkflowAsync(owner, "admin", "close", close, heads, default));
        service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        Assert.Equal("released", (await service.ReleasePublishedAsync(tree.Id, owner, tree.OriginalBase, default)).State);
        Assert.Equal("closed", (await service.ChangeWorkflowAsync(owner, "admin", "close", close, heads, default)).Closure);
    }

    [Theory]
    [InlineData("configure")]
    [InlineData("ready")]
    [InlineData("merge")]
    [InlineData("link")]
    [InlineData("complete")]
    [InlineData("resolve-review")]
    [InlineData("corrective")]
    [InlineData("commit")]
    [InlineData("publish")]
    public async Task WorkspaceClosure_RefusesNewPublicationCommandsButReplaysReceipts(string kind)
    {
        var f = await PublicationFixture();
        var publish = new PublicationCommand(Guid.NewGuid().ToString(), f.W.OriginalBase, Title: "Contribution");
        await f.Service.CommandAsync(f.W.Id, f.W.Owner, "publish", publish, default);
        var close = new WorkspaceWorkflowCommand(Guid.NewGuid().ToString(), 0);
        var heads = new Dictionary<string, string>();
        await f.Workspaces.ChangeWorkflowAsync(f.W.Owner, "admin", "close", close, heads, default, prepareOnly: true);
        foreach (var closing in new[] { true, false })
        {
            if (!closing) await f.Workspaces.ChangeWorkflowAsync(f.W.Owner, "admin", "close", close, heads, default);
            var command = new PublicationCommand(Guid.NewGuid().ToString(), f.W.OriginalBase, Title: "New", Number: 42, Outcome: "submitted");
            var error = await Assert.ThrowsAsync<PublicationException>(() => f.Service.CommandAsync(f.W.Id, f.W.Owner, kind, command, default));
            Assert.Equal("publication_workspace_closed", error.Code);
            var replay = await f.Service.CommandAsync(f.W.Id, f.W.Owner, "publish", publish, default);
            Assert.DoesNotContain(replay.Operations, op => op.Id == command.RequestId);
            Assert.Equal(1, f.Provider.Created);
        }
    }

    [Fact]
    public async Task WorkspaceClosure_PermitsRecoveryOfAnAdmittedPublicationCommand()
    {
        var f = await PublicationFixture();
        await f.Service.CommandAsync(f.W.Id, f.W.Owner, "publish", new(Guid.NewGuid().ToString(), f.W.OriginalBase, Title: "Contribution"), default);
        var ready = new PublicationCommand(Guid.NewGuid().ToString(), f.W.OriginalBase);
        var before = f.Provider.Readied;
        f.Provider.LoseReady = true;
        await Assert.ThrowsAsync<HttpRequestException>(() => f.Service.CommandAsync(f.W.Id, f.W.Owner, "ready", ready, default));
        await f.Workspaces.ChangeWorkflowAsync(f.W.Owner, "admin", "close", new(Guid.NewGuid().ToString(), 0), new Dictionary<string, string>(), default);
        var recovered = await f.Service.CommandAsync(f.W.Id, f.W.Owner, "ready", ready, default);
        Assert.Equal("succeeded", recovered.Operations.Single(op => op.Id == ready.RequestId).State);
        await f.Service.CommandAsync(f.W.Id, f.W.Owner, "ready", ready, default);
        Assert.Equal(before + 2, f.Provider.Readied);
    }

    [Fact]
    public async Task WorkspaceClosure_FencesPublicationWaitingOnDependenciesBeforeReceiptAdmission()
    {
        var f = await PublicationFixture();
        await f.Service.CommandAsync(f.W.Id, f.W.Owner, "publish", new(Guid.NewGuid().ToString(), f.W.OriginalBase, Title: "Contribution"), default);
        var record = await f.Service.ObserveAsync(f.W.Id, f.W.Owner, default);
        // Dependencies must have retained worktree records. An orphan publication is no
        // longer observed, because it can be a late response from a deleted workspace.
        var repository = await CreateGitRepositoryAsync(Path.Combine(f.F.Root, "closure-dependency"));
        var source = (await f.F.Apps.GetAppAsync(SourceTestApp))!;
        await f.F.Apps.UpsertAppAsync(source with { Id = "example.dependency", SourceState = source.SourceState! with { Repository = repository, LocalOverridePath = repository } });
        var dependency = await f.Workspaces.PrepareAsync(f.W.Owner, WorkspaceRequest() with { AppId = "example.dependency" }, default);
        var dependencyId = dependency.Id;
        var root = Path.Combine(f.F.Paths.CoreRoot, "development", "publications");
        await JsonStorage.WriteAsync(Path.Combine(root, dependencyId + ".json"), record with {
            WorkspaceId = dependencyId, Branch = dependency.Branch, Number = 43, Url = "https://github.com/owner/repo/pull/43", Dependencies = [], Operations = [] });
        await JsonStorage.WriteAsync(Path.Combine(root, f.W.Id + ".json"), record with { Dependencies = [dependencyId] });
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Provider.BeforeObserve = async (r, ct) =>
        {
            f.Provider.State = r.Number == 43 ? "merged" : "open"; f.Provider.Complete = true;
            if (r.Number != 43) return;
            entered.TrySetResult();
            await release.Task.WaitAsync(TimeSpan.FromSeconds(10), ct);
        };
        var merge = new PublicationCommand(Guid.NewGuid().ToString(), f.W.OriginalBase);
        var command = f.Service.CommandAsync(f.W.Id, f.W.Owner, "merge", merge, default);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
        try
        {
            Assert.Equal("closed", (await f.Workspaces.ChangeWorkflowAsync(f.W.Owner, "admin", "close", new(Guid.NewGuid().ToString(), 0), new Dictionary<string, string>(), default)).Closure);
        }
        finally { release.TrySetResult(); }
        var error = await Assert.ThrowsAsync<PublicationException>(() => command);
        Assert.Equal("publication_workspace_closed", error.Code);
        var retained = await f.Service.ObserveAsync(f.W.Id, f.W.Owner, default);
        Assert.DoesNotContain(retained.Operations, op => op.Id == merge.RequestId);
        Assert.Equal(0, f.Provider.Merged);
        Assert.True(Directory.Exists(f.W.Path));
    }

    [Fact]
    public async Task WorkspaceClosure_SpecificLeaseBlocksConfirmationAndRetentionCannotRaceClose()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var tree = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        var other = owner with { SessionId = "other-session" };
        var lease = Guid.NewGuid().ToString();
        var heads = new Dictionary<string, string>();
        await service.CommandAsync(tree.Id, owner, "lease", new(Guid.NewGuid().ToString(), LeaseId: lease), default);
        var close = new WorkspaceWorkflowCommand(Guid.NewGuid().ToString(), 0);
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.ChangeWorkflowAsync(owner, "admin", "close", close, heads, default));

        await Assert.ThrowsAsync<AppLifecycleException>(() => service.ChangeWorkflowAsync(owner, "retention", "delete", new(Guid.NewGuid().ToString(), 0), heads, default));
        Assert.True(Directory.Exists(tree.Path));
        await service.CommandAsync(tree.Id, other, "release-lease", new(Guid.NewGuid().ToString(), LeaseId: lease), default);
        Assert.Equal("closed", (await service.ChangeWorkflowAsync(owner, "admin", "close", close, heads, default)).Closure);
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.CommandAsync(tree.Id, owner, "lease", new(Guid.NewGuid().ToString(), LeaseId: lease), default));
        var resumed = await service.ChangeWorkflowAsync(owner, "admin", "resume", new(Guid.NewGuid().ToString(), 1), heads, default);
        Assert.Null(resumed.CompletedAt);
        Assert.Equal("in-progress", resumed.State);
    }
}
