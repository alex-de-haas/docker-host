using Haas.Hosty.Core;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static CoreDevelopmentService CoreSourceService(LifecycleFixture f, ISourceGitAccess? git = null)
        => new(new(f.Paths.DataRoot, Path.Combine(f.Paths.CoreRoot, "run"),
            Path.Combine(f.Paths.CoreRoot, "run/control.json"), 7070, "http://localhost:7070", null, "localhost", null, false),
            new("release", null, null, 123, DateTimeOffset.UnixEpoch), git);

    private static async Task AddCoreProject(string remote)
    {
        var project = CoreDevelopmentService.Project(remote);
        Directory.CreateDirectory(Path.GetDirectoryName(project)!);
        await File.WriteAllTextAsync(project, "<Project />");
        await RunGitAsync(remote, ["add", "."]);
        await RunGitAsync(remote, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "Core fixture"]);
    }

    [Fact]
    public async Task CoreWorkspace_PreparesWithoutAnInstalledAppReplaysAndPreservesEdits()
    {
        var (f, remote) = await SourceFixtureAsync();
        await AddCoreProject(remote);
        var git = new RemoteGitFixture(remote);
        var core = CoreSourceService(f, git);
        var source = await core.SaveAsync(new(null, "initial", new(RemoteGitFixture.Url, "main", ConnectionId: "connection")), default, "admin");
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock, privateSources: git, coreDevelopment: core);
        var owner = ExternalOwner("core-work");
        var input = new CoreWorkspacePrepare(Guid.NewGuid().ToString(), owner.SessionId, Guid.NewGuid().ToString(), source.Revision);
        var tree = await service.PrepareCoreSourceAsync(owner, input, default);
        Assert.Empty(tree.Apps);
        Assert.Equal(source.ProjectPath, tree.Core!.ProjectPath);
        Assert.True(File.Exists(CoreDevelopmentService.Project(tree.Path)));
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "keep.txt"), "unfinished source");
        Assert.Equal(tree.Id, (await service.PrepareCoreSourceAsync(owner, input, default)).Id);
        Assert.Equal("unfinished source", await File.ReadAllTextAsync(Path.Combine(tree.Path, "keep.txt")));
        Assert.Single((await service.ListAsync(owner, false, default)).Workspaces);
        Assert.Equal("workspace_request_conflict", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            service.PrepareCoreSourceAsync(owner, input with { LeaseId = Guid.NewGuid().ToString() }, default))).Code);
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.PrepareCoreSourceAsync(owner,
            input with { SourceRevision = "stale" }, default));
        git.Revoked = true;
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.ObserveAsync(tree.Id, owner, default));
        Assert.True(File.Exists(Path.Combine(tree.Path, "keep.txt")));
    }

    [Fact]
    public async Task Activation_UsesExplicitAppsAndRepositoryMatchedOptionalCore()
    {
        var (f, remote) = await SourceFixtureAsync();
        await AddCoreProject(remote);
        var git = new RemoteGitFixture(remote);
        var core = CoreSourceService(f, git);
        var source = await core.SaveAsync(new(null, "initial", new(RemoteGitFixture.Url, "main", ConnectionId: "connection")), default, "admin");
        var grant = await git.BindAsync("admin", "connection", RemoteGitFixture.Url, false, default);
        var app = (await f.Apps.GetAppAsync(SourceTestApp))!;
        app = app with { SourceState = app.SourceState! with { Repository = RemoteGitFixture.Url, LocalOverridePath = null },
            PrivateSources = new(Git: grant), RuntimeProfiles = [new("dev", "docker", false, true)] };
        await f.Apps.UpsertAppAsync(app);
        await f.Apps.UpsertAppAsync(app with { Id = "hosty.harness", System = true });
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock, privateSources: git, coreDevelopment: core);
        var owner = ExternalOwner();
        var tree = await service.PrepareAsync(owner, ExternalPrepare(), default);
        var planner = new WorkspaceActivationPlanner(service, new(service, f.Apps, f.Clock, privateSources: git), f.Apps, core);
        var before = await RunGitAsync(tree.Path, ["status", "--porcelain"]);
        var plan = await planner.PlanAsync(tree.WorkspaceId, "admin", new(), default);
        Assert.Equal("selection-only", plan.Stage);
        Assert.Equal(2, plan.Participants.Length);
        Assert.All(plan.Participants, p => Assert.True(p.Selected, p.Unavailable));
        Assert.DoesNotContain(plan.Participants, p => p.Id == "hosty.harness");
        Assert.Equal(tree.Id, plan.Participants.Single(p => p.Kind == "core").WorktreeId);
        var uncheckedCore = await planner.PlanAsync(tree.WorkspaceId, "admin", new(CoreSelected: false), default);
        Assert.False(uncheckedCore.Participants.Single(p => p.Kind == "core").Selected);
        Assert.True(uncheckedCore.Participants.Single(p => p.Kind == "app").Selected);
        Assert.Equal(before, await RunGitAsync(tree.Path, ["status", "--porcelain"]));
        await Assert.ThrowsAsync<AppLifecycleException>(() => planner.PlanAsync(tree.WorkspaceId, "another-user", new(), default));
        await Assert.ThrowsAsync<ArgumentException>(() => planner.PlanAsync(tree.WorkspaceId, "admin",
            new(Apps: [new("hosty.harness")]), default));
        await core.SaveAsync(new(null, source.Revision, new("https://github.com/other/fork")), default, "admin");
        var fork = await planner.PlanAsync(tree.WorkspaceId, "admin", new(), default);
        Assert.False(fork.Participants.Single(p => p.Kind == "core").Selected);
        Assert.True(fork.Participants.Single(p => p.Kind == "app").Selected);
    }

    [Fact]
    public async Task Activation_MultipleRepositoriesAndUnsupportedOrReinstalledBindingsStayExplicit()
    {
        var (f, _) = await SourceFixtureAsync();
        var core = CoreSourceService(f);
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = ExternalOwner();
        var first = await service.PrepareAsync(owner, ExternalPrepare(), default);
        var app = (await f.Apps.GetAppAsync(SourceTestApp))!;
        await f.Apps.UpsertAppAsync(app with { RuntimeProfiles = [new("dev", "docker", false, true)] });
        var remote = await CreateGitRepositoryAsync(Path.Combine(f.Root, "second"));
        await f.Apps.UpsertAppAsync(app with { Id = "example.second",
            SourceState = app.SourceState! with { Repository = remote, LocalOverridePath = remote },
            RuntimeProfiles = [] });
        var second = await service.PrepareAsync(owner, ExternalPrepare() with { AppId = "example.second" }, default);
        var planner = new WorkspaceActivationPlanner(service, new(service, f.Apps, f.Clock), f.Apps, core);
        var plan = await planner.PlanAsync(first.WorkspaceId, "admin", new(), default);
        Assert.True(plan.Participants.Single(p => p.Id == SourceTestApp).Selected);
        Assert.False(plan.Participants.Single(p => p.Id == "example.second").Selected);
        Assert.Contains("profile", plan.Participants.Single(p => p.Id == "example.second").Unavailable);
        Assert.Equal(second.Id, plan.Participants.Single(p => p.Id == "example.second").WorktreeId);
        await f.Apps.UpsertAppAsync(app with { InstalledAt = app.InstalledAt.AddSeconds(1) });
        plan = await planner.PlanAsync(first.WorkspaceId, "admin", new(), default);
        Assert.Contains("reinstalled", plan.Participants.Single(p => p.Id == SourceTestApp).Unavailable);
        Assert.All(plan.Participants, p => Assert.False(p.Selected));
    }

    [Fact]
    public async Task Activation_SourceRebindingRequiresExplicitWorktreeChoice()
    {
        var (f, _) = await SourceFixtureAsync();
        var app = (await f.Apps.GetAppAsync(SourceTestApp))!;
        app = app with { RuntimeProfiles = [new("dev", "docker", false, true)] };
        await f.Apps.UpsertAppAsync(app);
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = ExternalOwner();
        var first = await service.PrepareAsync(owner, ExternalPrepare(), default);
        var remote = await CreateGitRepositoryAsync(Path.Combine(f.Root, "second-source"));
        await f.Apps.UpsertAppAsync(app with { SourceState = app.SourceState! with { Repository = remote, LocalOverridePath = remote } });
        var second = await service.PrepareAsync(owner, ExternalPrepare(), default);
        var planner = new WorkspaceActivationPlanner(service, new(service, f.Apps, f.Clock), f.Apps, CoreSourceService(f));
        var plan = await planner.PlanAsync(first.WorkspaceId, "admin", new(), default);
        Assert.Contains("Choose a worktree", plan.Participants.Single(p => p.Id == SourceTestApp).Unavailable);
        var old = await planner.PlanAsync(first.WorkspaceId, "admin", new(Apps: [new(SourceTestApp, WorktreeId: first.Id)]), default);
        Assert.Contains("source changed", old.Participants.Single(p => p.Id == SourceTestApp).Unavailable);
        var current = await planner.PlanAsync(first.WorkspaceId, "admin", new(Apps: [new(SourceTestApp, WorktreeId: second.Id)]), default);
        Assert.True(current.Participants.Single(p => p.Id == SourceTestApp).Selected);
        Assert.True(Directory.Exists(first.Path));
    }

    [Fact]
    public async Task Activation_AmbiguousProfilesRequireChoiceAndPreserveAppDataAndDirtySource()
    {
        var (f, _) = await SourceFixtureAsync();
        var core = CoreSourceService(f);
        var app = (await f.Apps.GetAppAsync(SourceTestApp))!;
        await f.Apps.UpsertAppAsync(app with { RuntimeProfiles = [new("dev", "docker", false, true), new("native", "localCommand", false, true)] });
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var tree = await service.PrepareAsync(ExternalOwner(), ExternalPrepare(), default);
        var file = Path.Combine(tree.Path, "keep.txt");
        await File.WriteAllTextAsync(file, "unfinished");
        var planner = new WorkspaceActivationPlanner(service, new(service, f.Apps, f.Clock), f.Apps, core);
        var plan = await planner.PlanAsync(tree.WorkspaceId, "admin", new(), default);
        Assert.Contains("Choose", plan.Participants.Single(p => p.Id == SourceTestApp).Unavailable);
        Assert.False(plan.Participants.Single(p => p.Id == SourceTestApp).Selected);
        var selected = await planner.PlanAsync(tree.WorkspaceId, "admin", new(Apps: [new(SourceTestApp, Runtime: "native")]), default);
        Assert.True(selected.Participants.Single(p => p.Id == SourceTestApp).Selected);
        Assert.Equal("native", selected.Participants.Single(p => p.Id == SourceTestApp).TargetRuntime);
        Assert.Equal(app.SelectedRuntime, (await f.Apps.GetAppAsync(SourceTestApp))!.SelectedRuntime);
        Assert.Equal(app.RuntimeState, (await f.Apps.GetAppAsync(SourceTestApp))!.RuntimeState);
        Assert.Equal("unfinished", await File.ReadAllTextAsync(file));
        await Assert.ThrowsAsync<ArgumentException>(() => planner.PlanAsync(tree.WorkspaceId, "admin",
            new(Apps: [new(SourceTestApp, Runtime: "production")]), default));
        await Assert.ThrowsAsync<ArgumentException>(() => planner.PlanAsync(tree.WorkspaceId, "admin",
            new(CoreWorktreeId: tree.Id), default));
        await Assert.ThrowsAsync<ArgumentException>(() => planner.PlanAsync(tree.WorkspaceId, "admin",
            new(Apps: [new(SourceTestApp, WorktreeId: "foreign")]), default));
    }

    [Fact]
    public async Task CoreSource_PrivateBindingChecksOwnerAndRevocationBeforeClone()
    {
        var (f, remote) = await SourceFixtureAsync();
        var git = new RemoteGitFixture(remote);
        var core = CoreSourceService(f, git);
        var source = await core.SaveAsync(new(null, "initial", new(RemoteGitFixture.Url, ConnectionId: "connection")), default, "admin");
        await Assert.ThrowsAsync<AppLifecycleException>(() => core.PrepareSourceAsync(source, default, actor: "other"));
        git.Revoked = true;
        await Assert.ThrowsAsync<AppLifecycleException>(() => core.PrepareSourceAsync(source, default, actor: "admin"));
        Assert.False(Directory.Exists(core.SelectedRoot(source)));
    }
}
