using Haas.Hosty.Core;
using Microsoft.Extensions.Configuration;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task WorkspaceInspection_GroupsRepositoriesAndPreservesLegacyIdentityAndUnavailableChildren()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceTestOwner(f);
        var first = await service.PrepareAsync(owner, WorkspaceRequest(), default);
        var app = (await f.Apps.GetAppAsync(SourceTestApp))!;
        var otherRepository = await CreateGitRepositoryAsync(Path.Combine(f.Root, "other-repository"));
        await f.Apps.UpsertAppAsync(app with { Id = "example.other", SourceState = app.SourceState! with { Repository = otherRepository, LocalOverridePath = otherRepository } });
        var second = await service.PrepareAsync(owner, WorkspaceRequest() with { AppId = "example.other" }, default);
        Assert.NotEqual(first.Id, second.Id);
        Assert.Equal(first.WorkspaceId, second.WorkspaceId);
        var restarted = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var inspection = new WorkspaceInspectionService(restarted, f.Apps, f.Clock);
        var aggregate = Assert.Single((await inspection.ListAsync("admin", default)).Workspaces);
        Assert.Equal(first.WorkspaceId, aggregate.Id);
        Assert.Equal(2, aggregate.Worktrees.Length);
        Assert.All(aggregate.Worktrees, tree => Assert.Empty(tree.Observation!.SessionFiles!));
        Assert.Equal(first.Path, aggregate.Worktrees.Single(w => w.Id == first.Id).Path);
        Assert.Equal(first.Operations, (await restarted.Read(first.Id, owner, default)).Operations);
        Directory.Move(second.Path, second.Path + "-unavailable");
        var detail = await inspection.ReadAsync(aggregate.Id, second.Id, "admin", default);
        Assert.Equal("unavailable", detail.Observation!.State);
        aggregate = Assert.Single((await inspection.ListAsync("admin", default)).Workspaces);
        Assert.Equal("attention", aggregate.State);
        Assert.Equal(2, aggregate.Worktrees.Length);
        Assert.Equal("ok", aggregate.Worktrees.Single(w => w.Id == first.Id).Observation!.State);
        await Assert.ThrowsAsync<AppLifecycleException>(() => inspection.ReadAsync(new string('f', 64), first.Id, "admin", default));
    }

    [Fact]
    public async Task WorkspaceInspection_ReadsCommitsAndLocalDiffWithoutFetchingOrMutatingGit()
    {
        var (f, origin) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var tree = await service.PrepareAsync(WorkspaceTestOwner(f), WorkspaceRequest(), default);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "README.md"), "committed change\n");
        await RunGitAsync(tree.Path, ["add", "README.md"]);
        await RunGitAsync(tree.Path, ["-c", "user.name=Inspector", "-c", "user.email=inspector@example.test", "commit", "-m", "A recorded change"]);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "README.md"), "committed change\nlocal change\n");
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "new.txt"), "new file\n");
        var inspection = new WorkspaceInspectionService(service, f.Apps, f.Clock);
        var before = await RunGitAsync(tree.Path, ["status", "--porcelain=v1"]);
        var detail = await inspection.ReadAsync(tree.WorkspaceId, tree.Id, "admin", default);
        Assert.Equal("A recorded change", Assert.Single(detail.Commits).Subject);
        Assert.Equal(1, detail.Observation!.Ahead);
        Assert.Contains("local change", (await inspection.DiffAsync(tree.WorkspaceId, tree.Id, "admin", new("README.md", "local"), default)).Combined);
        Assert.Contains("committed change", (await inspection.DiffAsync(tree.WorkspaceId, tree.Id, "admin", new("README.md"), default)).Combined);
        Assert.Contains("new file", (await inspection.DiffAsync(tree.WorkspaceId, tree.Id, "admin", new("new.txt"), default)).Combined);
        await Assert.ThrowsAsync<AppLifecycleException>(() => inspection.DiffAsync(tree.WorkspaceId, tree.Id, "admin", new("../../secret"), default));
        Assert.Equal(before, await RunGitAsync(tree.Path, ["status", "--porcelain=v1"]));
        Assert.Equal("source", await File.ReadAllTextAsync(Path.Combine(origin, "README.md")));
        Assert.Equal(tree.Operations.Length, (await service.Read(tree.Id, null, default)).Operations.Length);
    }

    [Theory]
    [InlineData("revoke")]
    [InlineData("clear")]
    public async Task WorkspaceInspection_PrivateSourceRevocationHidesInventoryAndRejectsDetailAndDiff(string transition)
    {
        var (f, users, access, service, tree, _, _) = await PrivateWorkspaceDocumentFixtureAsync();
        var inspection = new WorkspaceInspectionService(service, f.Apps, f.Clock, privateSources: access);
        Assert.Single((await inspection.ListAsync("admin", default)).Workspaces);
        Assert.Empty((await inspection.ListAsync("another-admin", default)).Workspaces);
        await Assert.ThrowsAsync<AppLifecycleException>(() => inspection.DiffAsync(tree.WorkspaceId, tree.Id, "another-admin", new(PlanPath), default));
        if (transition == "clear") await f.Apps.UpdateAppAsync(SourceTestApp, a => a with { PrivateSources = null });
        else await users.UpdateAsync(s => s with { ProviderConnections = [] });
        Assert.Empty((await inspection.ListAsync("admin", default)).Workspaces);
        await Assert.ThrowsAsync<AppLifecycleException>(() => inspection.ReadAsync(tree.WorkspaceId, tree.Id, "admin", default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => inspection.DiffAsync(tree.WorkspaceId, tree.Id, "admin", new(PlanPath), default));
    }

    [Fact]
    public async Task WorkspaceInspection_ExternalReferencesReleasedHistoryAndRecordedUrlsStayHonest()
    {
        var (f, _) = await SourceFixtureAsync();
        var service = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = WorkspaceOwner.ForExternal("admin", "oauth:first", "task-one", "Codex");
        var tree = await service.PrepareAsync(owner, WorkspaceRequest("task-one") with { SessionPath = null, LeaseId = Guid.NewGuid().ToString() }, default);
        var changedLabel = tree with { Owner = owner with { External = new("oauth:first", "Renamed") } };
        Assert.Equal(tree.WorkspaceId, changedLabel.WorkspaceId);
        Assert.NotEqual(tree.WorkspaceId, (tree with { Owner = WorkspaceOwner.ForExternal("admin", "oauth:second", "task-one", "Codex") }).WorkspaceId);
        var released = tree with { State = "released", PullRequests = ["https://github.com/example/repo/pull/1", "javascript:alert(1)"] };
        await JsonStorage.WriteAsync(Path.Combine(f.Paths.CoreRoot, "development/workspaces", tree.Id + ".json"), released);
        var inspection = new WorkspaceInspectionService(service, f.Apps, f.Clock);
        var aggregate = Assert.Single((await inspection.ListAsync("admin", default)).Workspaces);
        Assert.Equal("released", aggregate.State);
        Assert.Equal("external", aggregate.Owner.Kind);
        Assert.Null(aggregate.Owner.SessionUrl);
        Assert.Equal("task-one", aggregate.Owner.Reference);
        var detail = await inspection.ReadAsync(tree.WorkspaceId, tree.Id, "admin", default);
        Assert.Null(Assert.Single(detail.PullRequests).Observation);
        Assert.DoesNotContain("fingerprint", CoreJson.Text(detail), StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("sourceGrant", CoreJson.Text(detail), StringComparison.OrdinalIgnoreCase);
    }
    [Fact]
    public async Task WorkspaceInspection_PublicationFactsRequireOwnerRepositoryConnectionAndPublishedHead()
    {
        var f = await PublicationFixture();
        f.Provider.RepositoryOverride = "owner/repo";
        var connections = new UserConnectionService(f.Users, new SourceProviderRegistry([new GitHubSourceProvider(new HttpClient(),
            new ConfigurationBuilder().Build(), f.F.Clock, f.Provider)]), f.F.Clock, new AuditStore(f.F.Paths), f.F.CoreSettings);
        var inspection = new WorkspaceInspectionService(f.Workspaces, f.F.Apps, f.F.Clock, f.Service, f.Users, connections);
        var record = Assert.Single((await f.Service.ListAsync(null, default)).Publications) with {
            Url = "https://github.com/owner/repo/pull/2", PublishedHead = f.W.Observation!.Head,
            History = [new(1, "https://github.com/owner/repo/pull/1", "older", "merged")],
            Observation = new(f.F.Clock.UtcNow, "open", f.W.Observation.Head, Checks: [new("CI", "SUCCESS")],
                Reviews: [new("private-review", "README.md", 1, false, ["Comment body not needed by viewer"])]) };
        var path = Path.Combine(f.F.Paths.CoreRoot, "development/publications", f.W.Id + ".json");
        await JsonStorage.WriteAsync(path, record);
        var detail = await inspection.ReadAsync(f.W.WorkspaceId, f.W.Id, "admin", default);
        Assert.Equal(2, detail.PullRequests.Length);
        var observed = Assert.Single(detail.PullRequests, p => p.Observation is not null);
        Assert.Equal("SUCCESS", Assert.Single(observed.Observation!.Checks!).State);
        Assert.Null(observed.Observation.Reviews);
        Assert.Empty((await inspection.ReadAsync(f.W.WorkspaceId, f.W.Id, "another-admin", default)).PullRequests);
        await JsonStorage.WriteAsync(path, record with { PublishedHead = "changed" });
        Assert.All((await inspection.ReadAsync(f.W.WorkspaceId, f.W.Id, "admin", default)).PullRequests, p => Assert.Null(p.Observation));
        await JsonStorage.WriteAsync(path, record);
        f.Provider.RepositoryOverride = "different/repo";
        Assert.All((await inspection.ReadAsync(f.W.WorkspaceId, f.W.Id, "admin", default)).PullRequests, p => Assert.Null(p.Observation));
        f.Provider.RepositoryOverride = "owner/repo";
        await f.Users.UpdateAsync(s => s with { ProviderConnections = [] });
        var revoked = await inspection.ReadAsync(f.W.WorkspaceId, f.W.Id, "admin", default);
        Assert.Equal(2, revoked.PullRequests.Length);
        Assert.All(revoked.PullRequests, p => Assert.Null(p.Observation));
    }

}
