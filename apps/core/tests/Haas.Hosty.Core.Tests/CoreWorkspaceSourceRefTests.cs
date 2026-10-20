using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task CoreWorkspace_TagOrAmbiguousSourceRefRequiresAnExplicitDevelopmentBranch(bool shadowed, bool annotated)
    {
        var (fixture, remote) = await SourceFixtureAsync();
        await AddCoreProject(remote);
        const string reference = "release/core";
        await RunGitAsync(remote, annotated
            ? ["-c", "user.name=Test", "-c", "user.email=test@example.test", "tag", "-a", reference, "-m", "Source tag fixture"]
            : ["tag", reference]);
        var tagged = await RunGitAsync(remote, ["rev-parse", "HEAD"]);
        await File.WriteAllTextAsync(Path.Combine(remote, "branch-only.txt"), "development branch content");
        await RunGitAsync(remote, ["add", "."]);
        await RunGitAsync(remote, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "Development branch fixture"]);
        var branchHead = await RunGitAsync(remote, ["rev-parse", "HEAD"]);
        Assert.NotEqual(tagged, branchHead);
        if (shadowed) await RunGitAsync(remote, ["branch", reference]);
        var git = new RemoteGitFixture(remote);
        var core = CoreSourceService(fixture, git);
        var source = await core.SaveAsync(new(null, "initial", new(RemoteGitFixture.Url, reference, ConnectionId: "connection")), default, "admin");
        var service = new DevelopmentWorkspaceService(fixture.Paths, fixture.Apps, fixture.Clock, privateSources: git, coreDevelopment: core);
        var owner = ExternalOwner("tagged-core");
        var input = new CoreWorkspacePrepare(Guid.NewGuid().ToString(), owner.SessionId, Guid.NewGuid().ToString(), source.Revision);

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => service.PrepareCoreSourceAsync(owner, input, default));

        Assert.Equal("workspace_branch_required", error.Code);
        Assert.Contains("explicit development target branch", error.Message);
        Assert.Empty((await service.ListAsync(owner, false, default)).Workspaces);
        Assert.False(Directory.Exists(core.SelectedRoot(source)));
        var explicitInput = input with { TargetBranch = shadowed ? reference : "main" };
        var tree = await service.PrepareCoreSourceAsync(owner, explicitInput, default);
        Assert.Equal(explicitInput.TargetBranch, tree.TargetBranch);
        Assert.Equal(branchHead, tree.OriginalBase);
        Assert.Equal(source, await core.SourceSettingsAsync(default));
        Assert.Equal(tagged, await RunGitAsync(remote, ["rev-parse", "refs/tags/" + reference + "^{commit}"]));
    }

    [Fact]
    public async Task CoreWorkspace_UnambiguousSourceBranchIsDefaultAndExactReplayNeedsNoRemoteRead()
    {
        var (fixture, remote) = await SourceFixtureAsync();
        await AddCoreProject(remote);
        const string branch = "development/core";
        await RunGitAsync(remote, ["branch", branch]);
        var expected = await RunGitAsync(remote, ["rev-parse", "refs/heads/" + branch]);
        var git = new RemoteGitFixture(remote);
        var core = CoreSourceService(fixture, git);
        var source = await core.SaveAsync(new(null, "initial", new(RemoteGitFixture.Url, branch, ConnectionId: "connection")), default, "admin");
        var service = new DevelopmentWorkspaceService(fixture.Paths, fixture.Apps, fixture.Clock, privateSources: git, coreDevelopment: core);
        var owner = ExternalOwner("branch-core");
        var input = new CoreWorkspacePrepare(Guid.NewGuid().ToString(), owner.SessionId, Guid.NewGuid().ToString(), source.Revision);

        var tree = await service.PrepareCoreSourceAsync(owner, input, default);

        Assert.Equal(branch, tree.TargetBranch);
        Assert.Equal(expected, tree.OriginalBase);
        var sentinel = Path.Combine(tree.Path, "unfinished.txt");
        await File.WriteAllTextAsync(sentinel, "preserve source changes");
        git.FailRead = true;
        Assert.Equal(tree.Id, (await service.PrepareCoreSourceAsync(owner, input, default)).Id);
        Assert.Equal("preserve source changes", await File.ReadAllTextAsync(sentinel));
    }

    [Fact]
    public async Task CoreWorkspace_MissingConfiguredRefRequiresAnExplicitDevelopmentBranch()
    {
        var (fixture, remote) = await SourceFixtureAsync();
        await AddCoreProject(remote);
        var git = new RemoteGitFixture(remote);
        var core = CoreSourceService(fixture, git);
        var source = await core.SaveAsync(new(null, "initial", new(RemoteGitFixture.Url, "missing-ref", ConnectionId: "connection")), default, "admin");
        var service = new DevelopmentWorkspaceService(fixture.Paths, fixture.Apps, fixture.Clock, privateSources: git, coreDevelopment: core);
        var owner = ExternalOwner("missing-ref-core");
        var input = new CoreWorkspacePrepare(Guid.NewGuid().ToString(), owner.SessionId, Guid.NewGuid().ToString(), source.Revision);

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => service.PrepareCoreSourceAsync(owner, input, default));

        Assert.Equal("workspace_branch_required", error.Code);
        Assert.Empty((await service.ListAsync(owner, false, default)).Workspaces);
        Assert.Equal("main", (await service.PrepareCoreSourceAsync(owner, input with { TargetBranch = "main" }, default)).TargetBranch);
    }

    [Fact]
    public async Task CoreWorkspace_AbsentSourceRefUsesTheRemoteDefaultBranch()
    {
        var (fixture, remote) = await SourceFixtureAsync();
        await AddCoreProject(remote);
        var git = new RemoteGitFixture(remote);
        var core = CoreSourceService(fixture, git);
        var source = await core.SaveAsync(new(null, "initial", new(RemoteGitFixture.Url, ConnectionId: "connection")), default, "admin");
        var service = new DevelopmentWorkspaceService(fixture.Paths, fixture.Apps, fixture.Clock, privateSources: git, coreDevelopment: core);
        var owner = ExternalOwner("default-ref-core");

        var tree = await service.PrepareCoreSourceAsync(owner,
            new(Guid.NewGuid().ToString(), owner.SessionId, Guid.NewGuid().ToString(), source.Revision), default);

        Assert.Equal("main", tree.TargetBranch);
        Assert.Equal(await RunGitAsync(remote, ["rev-parse", "refs/heads/main"]), tree.OriginalBase);
    }
}
