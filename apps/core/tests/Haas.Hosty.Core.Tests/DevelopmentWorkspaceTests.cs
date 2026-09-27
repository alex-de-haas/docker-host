using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static WorkspaceOwner WorkspaceTestOwner(LifecycleFixture fixture, string session = "session-one")
        => new("hosty.harness", fixture.Clock.UtcNow, "admin", session);
    private static WorkspacePrepare WorkspaceRequest(string session = "session-one")
        => new(Guid.NewGuid().ToString(), session, SourceTestApp, "/assistant?session=" + session, "main");
    private static WorkspaceCommand WorkspaceCommit(string head, string message, params string[] files)
        => new(Guid.NewGuid().ToString(), head, message, files, "Test Agent", "agent@example.test");

    [Fact]
    public async Task Workspace_AllocatesOncePerOwnerAndRepositoryWithoutChangingBaseline()
    {
        var (f, origin) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var w = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        var repeat = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        Assert.Equal(w.Id, repeat.Id);
        Assert.Equal("active", w.State);
        Assert.Equal("ok", w.Observation!.State);
        Assert.True(File.Exists(Path.Combine(w.Path, ".git")));
        Assert.Equal("source", await File.ReadAllTextAsync(Path.Combine(origin, "README.md")));
        var other = await service.PrepareAsync(owner with { SessionId = "second" }, WorkspaceRequest("second"), default);
        Assert.NotEqual(w.Id, other.Id);
        Assert.Equal(w.RepositoryId, other.RepositoryId);
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.ObserveAsync(w.Id, owner with { Installation = owner.Installation.AddSeconds(1) }, default));
        var restart = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        Assert.Equal(w.Id, (await restart.PrepareAsync(owner, WorkspaceRequest(), default)).Id);
    }

    [Fact]
    public async Task Workspace_CommitReplayKeepsSessionDiffAndSeesExternalCommits()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var w = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        await File.WriteAllTextAsync(Path.Combine(w.Path, "README.md"), "changed\n");
        await File.WriteAllTextAsync(Path.Combine(w.Path, "untracked.txt"), "keep\n");
        var request = WorkspaceCommit(w.OriginalBase, "feat: edit\n\nCo-Authored-By: Test Agent <agent@example.test>", "README.md");
        w = await service.CommandAsync(w.Id, owner, "commit", request, default);
        Assert.Equal("succeeded", w.Operations.Last().State);
        Assert.NotEqual(w.OriginalBase, w.Observation!.Head);
        Assert.Equal("untracked.txt", Assert.Single(w.Observation.Local!.Files).Path);
        var diff = await service.DiffAsync(w.Id, owner, new("README.md"), default);
        Assert.Contains("+changed", diff.Combined);
        var repeated = await service.CommandAsync(w.Id, owner, "commit", request, default);
        Assert.Equal(w.Observation.Head, repeated.Observation!.Head);
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.CommandAsync(w.Id, owner, "commit", request with { Message = "different" }, default));
        await RunGitAsync(w.Path, ["-c", "user.name=Operator", "-c", "user.email=operator@example.test", "add", "untracked.txt"]);
        await RunGitAsync(w.Path, ["-c", "user.name=Operator", "-c", "user.email=operator@example.test", "commit", "-m", "manual commit"]);
        var observed = await service.ObserveAsync(w.Id, owner, default);
        Assert.NotEqual(w.Observation.Head, observed.Observation!.Head);
        Assert.Equal(w.Operations.Length, observed.Operations.Length);
        Assert.Contains("README.md", observed.Observation.SessionFiles!);
        Assert.Contains("untracked.txt", observed.Observation.SessionFiles!);
    }

    [Fact]
    public async Task Workspace_CleanupProtectsLeasesDirtyAndUnmergedWorkThenReplaysRelease()
    {
        var (f, origin) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var lease = Guid.NewGuid().ToString();
        var w = await service.PrepareAsync(owner, WorkspaceRequest() with { LeaseId = lease }, default);
        Task<DevelopmentWorkspace> Cleanup() => service.CommandAsync(w.Id, owner, "cleanup", new(Guid.NewGuid().ToString(), w.Observation!.Head), default);
        Assert.Equal("workspace_in_use", (await Assert.ThrowsAsync<AppLifecycleException>(Cleanup)).Code);
        await service.CommandAsync(w.Id, owner, "release-lease", new(Guid.NewGuid().ToString(), LeaseId: lease), default);
        await File.WriteAllTextAsync(Path.Combine(w.Path, "README.md"), "feature\n");
        Assert.Equal("workspace_dirty", (await Assert.ThrowsAsync<AppLifecycleException>(Cleanup)).Code);
        w = await service.CommandAsync(w.Id, owner, "commit", WorkspaceCommit(w.OriginalBase, "feat: feature", "README.md"), default);
        Assert.Equal("workspace_unmerged", (await Assert.ThrowsAsync<AppLifecycleException>(Cleanup)).Code);
        await RunGitAsync(origin, ["fetch", w.Path, w.Branch]);
        await RunGitAsync(origin, ["merge", "--ff-only", "FETCH_HEAD"]);
        var cleanup = new WorkspaceCommand(Guid.NewGuid().ToString(), w.Observation!.Head);
        var released = await service.CommandAsync(w.Id, owner, "cleanup", cleanup, default);
        Assert.Equal("released", released.State);
        Assert.False(Directory.Exists(w.Path));
        Assert.True(Directory.Exists(origin));
        Assert.Empty((await service.ListAsync(null, false, default)).Workspaces);
        Assert.Equal("released", (await new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock).CommandAsync(w.Id, owner, "cleanup", cleanup, default)).State);
    }

    [Fact]
    public async Task Workspace_FreshBaseAndExistingBaseAreDistinctAndFetchFailureDoesNotFallback()
    {
        var (f, origin) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var first = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        await File.WriteAllTextAsync(Path.Combine(origin, "README.md"), "new target\n");
        await RunGitAsync(origin, ["add", "."]);
        await RunGitAsync(origin, ["commit", "-m", "new target"]);
        var second = await service.PrepareAsync(owner with { SessionId = "second" }, WorkspaceRequest("second"), default);
        Assert.NotEqual(first.OriginalBase, second.OriginalBase);
        Assert.Equal(first.OriginalBase, (await service.PrepareAsync(owner, WorkspaceRequest(), default)).OriginalBase);
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.PrepareAsync(owner with { SessionId = "third" }, WorkspaceRequest("third") with { TargetBranch = "missing" }, default));
        Assert.Equal(2, (await service.ListAsync(null, false, default)).Workspaces.Length);
    }

    [Fact]
    public async Task Workspace_ExplicitMergeReportsConflictsAndAbortRestoresHead()
    {
        var (f, origin) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var w = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        await File.WriteAllTextAsync(Path.Combine(w.Path, "README.md"), "session\n");
        w = await service.CommandAsync(w.Id, owner, "commit", WorkspaceCommit(w.OriginalBase, "feat: session", "README.md"), default);
        await File.WriteAllTextAsync(Path.Combine(origin, "README.md"), "target\n");
        await RunGitAsync(origin, ["add", "."]); await RunGitAsync(origin, ["commit", "-m", "target"]);
        var head = w.Observation!.Head;
        w = await service.CommandAsync(w.Id, owner, "merge", WorkspaceCommit(head!, "Merge main"), default);
        Assert.Equal("conflict", w.Operations.Last().State);
        Assert.True(w.Observation!.Conflict);
        w = await service.CommandAsync(w.Id, owner, "abort-merge", new(Guid.NewGuid().ToString(), head), default);
        Assert.False(w.Observation!.Conflict);
        Assert.Equal(head, w.Observation.Head);
        Assert.Empty(w.Observation.Local!.Files);
    }

    [Fact]
    public async Task Workspace_ConcurrentMonorepoRequestsReuseSourceAndRejectChangedRequest()
    {
        var (f, _) = await SourceFixtureAsync();
        var app = (await f.Apps.GetAppAsync(SourceTestApp))!;
        const string sibling = "com.example.sibling";
        await f.Apps.UpsertAppAsync(app with { Id = sibling, SourceState = app.SourceState! with { ManifestSubpath = "apps/sibling" } });
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var request = WorkspaceRequest();
        var both = await Task.WhenAll(service.PrepareAsync(owner, request, default), service.PrepareAsync(owner, request, default));
        Assert.Equal(both[0].Id, both[1].Id);
        var attached = await service.PrepareAsync(owner, WorkspaceRequest() with { AppId = sibling }, default);
        Assert.Equal(both[0].Id, attached.Id);
        Assert.Equal(2, attached.Apps.Length);
        Assert.Equal("apps/sibling", attached.Apps.Single(a => a.AppId == sibling).Subpath);
        Assert.Equal("workspace_request_conflict", (await Assert.ThrowsAsync<AppLifecycleException>(() => service.PrepareAsync(owner, request with { SessionPath = "/different" }, default))).Code);
        await f.Apps.UpdateAppAsync(SourceTestApp, current => current with { InstalledAt = current.InstalledAt.AddSeconds(1) });
        Assert.Equal("workspace_app_reinstalled", (await Assert.ThrowsAsync<AppLifecycleException>(() => service.PrepareAsync(owner, request, default))).Code);
    }

    [Fact]
    public async Task Workspace_RecoversCommitIntentWithoutReplayingAndFailsClosedOnMissingSource()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var w = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        await File.WriteAllTextAsync(Path.Combine(w.Path, "README.md"), "persisted change");
        var command = WorkspaceCommit(w.OriginalBase, "feat: persisted", "README.md");
        w = await service.CommandAsync(w.Id, owner, "commit", command, default);
        var committed = w.Observation!.Head;
        var op = w.Operations.Last();
        var record = Path.Combine(f.Paths.CoreRoot, "development", "workspaces", w.Id + ".json");
        await JsonStorage.WriteAsync(record, w with { Operations = w.Operations.Select(o => o.Id == op.Id ? o with { State = "pending" } : o).ToArray() });
        var restarted = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var recovered = await restarted.CommandAsync(w.Id, owner, "commit", command, default);
        Assert.Equal("succeeded", recovered.Operations.Last().State);
        Assert.Equal(committed, recovered.Observation!.Head);
        Assert.Equal("workspace_stale_head", (await Assert.ThrowsAsync<AppLifecycleException>(() => restarted.CommandAsync(w.Id, owner, "commit", command with { RequestId = Guid.NewGuid().ToString() }, default))).Code);
        Directory.Move(w.Path, w.Path + "-temporarily-missing");
        Assert.Equal("unavailable", (await restarted.ObserveAsync(w.Id, owner, default)).Observation!.State);
        Assert.Equal("workspace_unavailable", (await Assert.ThrowsAsync<AppLifecycleException>(() => restarted.CommandAsync(w.Id, owner, "cleanup", new(Guid.NewGuid().ToString(), committed), default))).Code);
    }

    [Fact]
    public async Task Workspace_PartialCleanupRecoversAfterWorktreeRemoval()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var w = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        var command = new WorkspaceCommand(Guid.NewGuid().ToString(), w.OriginalBase);
        var op = new WorkspaceOperation(command.RequestId, "cleanup", DevelopmentWorkspaceService.Hash(CoreJson.Text(command)), "pending", w.OriginalBase);
        var record = Path.Combine(f.Paths.CoreRoot, "development", "workspaces", w.Id + ".json");
        await JsonStorage.WriteAsync(record, w with { State = "releasing", Operations = [.. w.Operations, op] });
        var repo = Path.Combine(f.Paths.CoreRoot, "development", "repositories", w.RepositoryId + ".git");
        await RunGitAsync(repo, ["worktree", "remove", w.Path]);
        var recovered = await new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock).CommandAsync(w.Id, owner, "cleanup", command, default);
        Assert.Equal("released", recovered.State);
    }

    [Fact]
    public async Task Workspace_CoreManagedAppKeepsItsRuntimeAndRunningConsumersPreventCleanup()
    {
        var f = await LifecycleFixture.CreateAsync();
        var appId = await InstallDevelopmentSourceAppAsync(f, development: true);
        var origin = await CreateGitRepositoryAsync(f.Root);
        await f.Sources.SetLocalOverrideAsync(appId, new(origin));
        await f.Apps.UpdateAppAsync(appId, app => app with { SourceState = app.SourceState! with { Repository = origin, ManifestSubpath = null } });
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock, f.LocalProcesses);
        var owner = WorkspaceTestOwner(f);
        try
        {
            await f.Service.StartAsync(appId);
            var process = f.LocalProcesses.Get(appId, "app");
            Assert.NotNull(process);
            var pid = process.Process.Id;
            var before = (await f.Apps.GetAppAsync(appId))!;
            var w = await service.PrepareAsync(owner, WorkspaceRequest() with { AppId = appId }, default);
            Assert.Equal(pid, f.LocalProcesses.Get(appId, "app")!.Process.Id);
            var after = (await f.Apps.GetAppAsync(appId))!;
            Assert.Equal(before.SelectedRuntime, after.SelectedRuntime);
            Assert.Equal(before.SourceState, after.SourceState);
            await File.WriteAllTextAsync(Path.Combine(w.Path, "README.md"), "workspace only");
            Assert.Equal("source", await File.ReadAllTextAsync(Path.Combine(origin, "README.md")));
            await RunGitAsync(w.Path, ["restore", "README.md"]);
            // Existing explicit source overrides can select a worktree. They are not a test runtime:
            // the same app/data identity remains, and even a stopped selected override blocks cleanup.
            await f.Service.StopAsync(appId);
            await f.Sources.SetLocalOverrideAsync(appId, new(w.Path));
            await f.Service.StartAsync(appId);
            Assert.True(DevelopmentWorkspaceService.IsUnder(w.Path, f.LocalProcesses.Get(appId, "app")!.WorkingDirectory));
            await f.Sources.SetLocalOverrideAsync(appId, new(origin)); // The old live process still owns its cwd.
            Assert.Equal("workspace_in_use", (await Assert.ThrowsAsync<AppLifecycleException>(() => service.CommandAsync(w.Id, owner, "cleanup", new(Guid.NewGuid().ToString(), w.OriginalBase), default))).Code);
            await f.Service.StopAsync(appId);
            Assert.Equal("released", (await service.CommandAsync(w.Id, owner, "cleanup", new(Guid.NewGuid().ToString(), w.OriginalBase), default)).State);
        }
        finally { await f.Service.StopAsync(appId); }
    }

    [Fact]
    public async Task Workspace_FullDiffHandlesCommittedDeletionThenUntrackedRecreationAndNewFiles()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var w = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        File.Delete(Path.Combine(w.Path, "README.md"));
        w = await service.CommandAsync(w.Id, owner, "commit", WorkspaceCommit(w.OriginalBase, "feat: remove", "README.md"), default);
        await File.WriteAllTextAsync(Path.Combine(w.Path, "README.md"), "recreated");
        var diff = await service.DiffAsync(w.Id, owner, new("README.md"), default);
        Assert.Contains("-source", diff.Combined);
        Assert.Contains("+recreated", diff.Combined);
        await File.WriteAllTextAsync(Path.Combine(w.Path, "new.txt"), "new file");
        diff = await service.DiffAsync(w.Id, owner, new("new.txt"), default);
        Assert.Contains("+new file", diff.Combined);
        var status = await service.ObserveAsync(w.Id, owner, default);
        Assert.All(status.Observation!.Local!.Files, file => Assert.Equal("??", file.Status));
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.DiffAsync(w.Id, owner, new("../README.md"), default));
    }

    [Fact]
    public async Task Workspace_CleanupChecksLiveDockerMountsAfterSourceSelectionChanges()
    {
        var (f, _) = await SourceFixtureAsync();
        var docker = new WorkspaceDockerRunner();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock, docker: docker);
        var owner = WorkspaceTestOwner(f);
        var w = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        await f.Apps.UpdateAppAsync(SourceTestApp, app => app with { RuntimeState = "running" });
        docker.Source = w.Path;
        Task<DevelopmentWorkspace> Cleanup() => service.CommandAsync(w.Id, owner, "cleanup", new(Guid.NewGuid().ToString(), w.OriginalBase), default);
        Assert.Equal("workspace_in_use", (await Assert.ThrowsAsync<AppLifecycleException>(Cleanup)).Code);
        docker.Unavailable = true;
        Assert.Equal("workspace_consumer_unavailable", (await Assert.ThrowsAsync<AppLifecycleException>(Cleanup)).Code);
        Assert.True(Directory.Exists(w.Path));
        docker.Unavailable = false; docker.Source = null;
        Assert.Equal("released", (await Cleanup()).State);
    }
    private sealed class WorkspaceDockerRunner : IDockerCommandRunner
    {
        public string? Source { get; set; }
        public bool Unavailable { get; set; }
        public Task<DockerCommandResult> RunAsync(IReadOnlyList<string> args, IReadOnlyDictionary<string, string>? environment = null, CancellationToken cancellationToken = default)
        {
            if (Unavailable) throw new DockerUnavailableException("offline");
            return Task.FromResult(new DockerCommandResult(0, args[0] == "ps" ? "abc123" :
                System.Text.Json.JsonSerializer.Serialize(Source is null ? Array.Empty<object>() : new object[] { new { Source } }), ""));
        }
    }
}
