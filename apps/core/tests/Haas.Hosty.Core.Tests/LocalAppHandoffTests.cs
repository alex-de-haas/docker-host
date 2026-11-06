using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static async Task<(LifecycleFixture Fixture, WorkspaceOwner Owner, DevelopmentWorkspaceService Workspaces,
        DevelopmentWorkspace Tree, AppCreationResult Created, LocalAppHandoffRequest Request)> LocalHandoffFixture(bool shortPaths = false)
    {
        var f = await LifecycleFixture.CreateAsync(shortPaths: shortPaths);
        var owner = WorkspaceTestOwner(f);
        var input = NewApp();
        var created = await f.Service.CreateLocalAppAsync(owner, input, null, default);
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var tree = await service.PrepareAsync(owner, new(input.RequestId, owner.SessionId, input.AppId, "/assistant", "main"), default);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "feature.txt"), "accepted source");
        tree = await service.CommandAsync(tree.Id, owner, "commit", new(Guid.NewGuid().ToString(), tree.OriginalBase,
            "feat: add local feature", ["feature.txt"], "Test", "test@example.test"), default);
        return (f, owner, service, tree, created, new(Guid.NewGuid().ToString(), tree.Id, tree.Observation!.Head!, tree.OriginalBase));
    }

    [Fact]
    public async Task LocalHandoff_AcceptsWithoutPublicationAndCompletesUsingFreshTargetAncestry()
    {
        var (f, owner, service, tree, created, request) = await LocalHandoffFixture();
        var accepted = await f.Service.HandoffLocalAppAsync(owner, "test.created", "accept", request, service, default);
        Assert.True(accepted.Accepted);
        Assert.Equal(request.ExpectedHead, accepted.TargetHead);
        Assert.Equal("stopped", accepted.RuntimeState);
        Assert.Equal("accepted source", await File.ReadAllTextAsync(Path.Combine(created.Operation.SourcePath, "feature.txt")));
        Assert.Empty((await DevelopmentWorkspaceService.Git(created.Operation.SourcePath, ["remote"], default)).StandardOutput);
        Assert.Equal(request.ExpectedHead, (await service.ObserveAsync(tree.Id, owner, default)).Observation!.TargetHead);
        Assert.Equal("succeeded", (await f.Service.HandoffLocalAppAsync(owner, "test.created", "accept", request, service, default)).Operation!.State);
        var complete = await service.ChangeWorkflowAsync(owner, owner.UserId, "complete", new(Guid.NewGuid().ToString(), 0), new Dictionary<string,string>(), default);
        Assert.Equal("completed", complete.State);
        Assert.True(Directory.Exists(created.Operation.SourcePath));
    }

    [Theory]
    [InlineData("target", "local_source_dirty")]
    [InlineData("source", "local_source_dirty")]
    [InlineData("head", "local_head_changed")]
    [InlineData("lease", "workspace_in_use")]
    [InlineData("other-lease", "workspace_in_use")]
    [InlineData("running", "local_app_running")]
    public async Task LocalHandoff_RefusesUnsafeAcceptanceAndPreservesBothTrees(string change, string code)
    {
        var (f, owner, service, tree, created, request) = await LocalHandoffFixture();
        if (change is "target" or "source") await File.WriteAllTextAsync(Path.Combine(change == "target" ? created.Operation.SourcePath : tree.Path, "unfinished.txt"), "keep me");
        if (change == "head") request = request with { ExpectedTargetHead = new string('a', 40) };
        if (change == "lease") await service.CommandAsync(tree.Id, owner, "lease", new(Guid.NewGuid().ToString(), LeaseId: Guid.NewGuid().ToString()), default);
        if (change == "other-lease")
            await service.PrepareAsync(owner with { SessionId = "other" }, new(Guid.NewGuid().ToString(), "other", "test.created", "/assistant", "main", Guid.NewGuid().ToString()), default);
        if (change == "running") await f.Apps.UpdateAppAsync("test.created", app => app with { RuntimeState = "running" });
        var ex = await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.HandoffLocalAppAsync(owner, "test.created", "accept", request, service, default));
        Assert.Equal(code, ex.Code);
        Assert.Equal(created.Operation.Commit, (await DevelopmentWorkspaceService.Git(created.Operation.SourcePath, ["rev-parse", "HEAD"], default)).StandardOutput.Trim());
        Assert.Equal("accepted source", await File.ReadAllTextAsync(Path.Combine(tree.Path, "feature.txt")));
        if (change is "target" or "source") Assert.Equal("keep me", await File.ReadAllTextAsync(Path.Combine(change == "target" ? created.Operation.SourcePath : tree.Path, "unfinished.txt")));
    }

    [Fact]
    public async Task LocalHandoff_RefusesDivergenceAndStaleOrForeignReplay()
    {
        var (f, owner, service, tree, created, request) = await LocalHandoffFixture();
        var root = created.Operation.SourcePath;
        await File.WriteAllTextAsync(Path.Combine(root, "operator.txt"), "operator work");
        await DevelopmentWorkspaceService.Git(root, ["add", "operator.txt"], default);
        await DevelopmentWorkspaceService.Git(root, ["commit", "-m", "feat: operator work"], default, author: new("test", AuthorName: "Test", AuthorEmail: "test@example.test"));
        var target = (await DevelopmentWorkspaceService.Git(root, ["rev-parse", "HEAD"], default)).StandardOutput.Trim();
        request = request with { ExpectedTargetHead = target };
        Assert.Equal("local_diverged", (await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.HandoffLocalAppAsync(owner, "test.created", "accept", request, service, default))).Code);
        Assert.Equal(target, (await DevelopmentWorkspaceService.Git(root, ["rev-parse", "HEAD"], default)).StandardOutput.Trim());
        Assert.Equal("local_request_conflict", (await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.HandoffLocalAppAsync(owner, "test.created", "accept", request with { ExpectedHead = target }, service, default))).Code);
        Assert.Equal("local_request_conflict", (await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.HandoffLocalAppAsync(owner with { SessionId = "foreign" }, "test.created", "accept", request, service, default))).Code);
    }

    [Fact]
    public async Task LocalHandoff_RecoversAfterTargetMovedBeforeReceiptAndUsesOrdinaryData()
    {
        var (f, owner, service, tree, created, request) = await LocalHandoffFixture();
        await f.Service.HandoffLocalAppAsync(owner, "test.created", "accept", request, service, default);
        var file = Path.Combine(f.Paths.CoreRoot, "authoring", "local", request.RequestId + ".json");
        var op = (await JsonStorage.ReadAsync<LocalAppHandoffOperation>(file))!;
        await JsonStorage.WriteAsync(file, op with { State = "pending" });
        await f.Apps.UpdateAppAsync("test.created", app => app with { SourceState = app.SourceState! with { Commit = created.Operation.Commit } });
        var recovered = await f.Service.HandoffLocalAppAsync(owner, "test.created", "accept", request, service, default);
        Assert.True(recovered.Accepted);
        var use = request with { RequestId = Guid.NewGuid().ToString(), ExpectedTargetHead = request.ExpectedHead };
        var started = await f.Service.HandoffLocalAppAsync(owner, "test.created", "use", use, service, default);
        Assert.Equal("running", started.RuntimeState);
        Assert.False((await f.Apps.GetAppAsync("test.created"))!.Autostart);
        Assert.Equal("succeeded", (await f.Service.HandoffLocalAppAsync(owner, "test.created", "use", use, service, default)).Operation!.State);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "unaccepted.txt"), "keep");
        Assert.Equal("local_source_dirty", (await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.HandoffLocalAppAsync(owner, "test.created", "use", use with { RequestId = Guid.NewGuid().ToString() }, service, default))).Code);
        Assert.False(File.Exists(Path.Combine(created.Operation.SourcePath, "unaccepted.txt")));
    }
    [Fact]
    public async Task LocalHandoff_SourceAuthorityAllowsOnlyItsExactOwnedCanonicalDirectory()
    {
        var (f, owner, service, tree, created, request) = await LocalHandoffFixture();
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        var authority = new HostPathAuthority(f.Paths, f.Apps);
        Assert.Equal(MountPathPolicy.ResolveRealPath(created.Operation.SourcePath), await authority.OverrideAsync(app, created.Operation.SourcePath, default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => authority.OverrideAsync(app, Path.GetDirectoryName(created.Operation.SourcePath)!, default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => authority.OverrideAsync(app with { SourceState = app.SourceState! with { Type = "git" } }, created.Operation.SourcePath, default));
    }

    [Fact]
    public async Task LocalHandoff_AdmissionBlocksSameRepositoryWritersWithoutBlockingOtherRepositories()
    {
        var (f, owner, service, tree, _, _) = await LocalHandoffFixture();
        var otherOwner = owner with { SessionId = "other" };
        var sameRepository = await service.PrepareAsync(otherOwner,
            new(Guid.NewGuid().ToString(), otherOwner.SessionId, "test.created", "/assistant", "main"), default);
        await f.Service.CreateLocalAppAsync(owner, NewApp("test.independent"), null, default);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var held = service.WithLocalTargetAsync(tree.Id, owner, async _ =>
        {
            entered.SetResult();
            await release.Task;
            return true;
        }, default);
        await entered.Task;
        try
        {
            var independentOwner = owner with { SessionId = "independent" };
            await service.PrepareAsync(independentOwner,
                new(Guid.NewGuid().ToString(), independentOwner.SessionId, "test.independent", "/assistant", "main"), default)
                .WaitAsync(TimeSpan.FromSeconds(5));
            using var blocked = new CancellationTokenSource(TimeSpan.FromMilliseconds(200));
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => service.CommandAsync(sameRepository.Id,
                otherOwner, "lease", new(Guid.NewGuid().ToString(), LeaseId: Guid.NewGuid().ToString()), blocked.Token));
        }
        finally { release.TrySetResult(); await held; }
        await service.CommandAsync(sameRepository.Id, otherOwner, "lease",
            new(Guid.NewGuid().ToString(), LeaseId: Guid.NewGuid().ToString()), default);
    }

    [Theory]
    [InlineData("unknown")]
    [InlineData("unreadable")]
    public async Task LocalHandoff_UncertainWriterStateCannotAdvanceCanonicalMain(string failure)
    {
        var (f, owner, service, tree, created, request) = await LocalHandoffFixture();
        var otherOwner = owner with { SessionId = "other-writer" };
        var other = await service.PrepareAsync(otherOwner,
            new(Guid.NewGuid().ToString(), otherOwner.SessionId, "test.created", "/assistant", "main"), default);
        var record = Path.Combine(f.Paths.CoreRoot, "development", "workspaces", other.Id + ".json");
        var saved = await File.ReadAllTextAsync(record);
        if (failure == "unknown")
            await JsonStorage.WriteAsync(record, other with { Operations = [new(Guid.NewGuid().ToString(), "commit", "args", "unknown", other.OriginalBase)] });
        else await File.WriteAllTextAsync(record, "{interrupted-record");
        try
        {
            var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
                f.Service.HandoffLocalAppAsync(owner, "test.created", "accept", request, service, default));
            Assert.Equal(failure == "unknown" ? "workspace_in_use" : "workspace_state_unavailable", error.Code);
            Assert.Equal(created.Operation.Commit, (await DevelopmentWorkspaceService.Git(created.Operation.SourcePath,
                ["rev-parse", "HEAD"], default)).StandardOutput.Trim());
            Assert.Equal("accepted source", await File.ReadAllTextAsync(Path.Combine(tree.Path, "feature.txt")));
            Assert.False(File.Exists(Path.Combine(created.Operation.SourcePath, "feature.txt")));
        }
        finally { await File.WriteAllTextAsync(record, saved); }
        Assert.True((await f.Service.HandoffLocalAppAsync(owner, "test.created", "accept", request, service, default)).Accepted);
    }

    [Fact]
    public async Task LocalHandoff_FailedGitUpdateAndRuntimeStartRecoverWithOriginalRequests()
    {
        var (f, owner, service, tree, created, request) = await LocalHandoffFixture();
        var indexLock = Path.Combine(created.Operation.SourcePath, ".git", "index.lock");
        await File.WriteAllTextAsync(indexLock, "operator lock");
        try
        {
            await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.HandoffLocalAppAsync(owner, "test.created", "accept", request, service, default));
            Assert.Equal(created.Operation.Commit, (await DevelopmentWorkspaceService.Git(created.Operation.SourcePath, ["rev-parse", "HEAD"], default)).StandardOutput.Trim());
            Assert.Equal("accepted source", await File.ReadAllTextAsync(Path.Combine(tree.Path, "feature.txt")));
        }
        finally { File.Delete(indexLock); }
        Assert.True((await f.RecreateService().HandoffLocalAppAsync(owner, "test.created", "accept", request, service, default)).Accepted);
        var use = request with { RequestId = Guid.NewGuid().ToString(), ExpectedTargetHead = request.ExpectedHead };
        f.Adapter.FailOnStartCount = 1;
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.HandoffLocalAppAsync(owner, "test.created", "use", use, service, default));
        var receipt = Path.Combine(f.Paths.CoreRoot, "authoring", "local", use.RequestId + ".json");
        Assert.Equal("pending", (await JsonStorage.ReadAsync<LocalAppHandoffOperation>(receipt))!.State);
        Assert.Equal("accepted source", await File.ReadAllTextAsync(Path.Combine(created.Operation.SourcePath, "feature.txt")));
        f.Adapter.FailOnStartCount = null;
        var recovered = await f.RecreateService().HandoffLocalAppAsync(owner, "test.created", "use", use, service, default);
        Assert.Equal("running", recovered.RuntimeState);
        var starts = f.Adapter.StartCount;
        await f.RecreateService().HandoffLocalAppAsync(owner, "test.created", "use", use, service, default);
        Assert.Equal(starts, f.Adapter.StartCount);
    }

}
