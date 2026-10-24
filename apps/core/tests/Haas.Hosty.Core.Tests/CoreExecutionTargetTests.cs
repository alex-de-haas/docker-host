using Haas.Hosty.Core;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static async Task<(LifecycleFixture Fixture, DevelopmentWorkspaceService Workspaces,
        DevelopmentWorkspace Tree, CoreDevelopmentService Core, RemoteGitFixture Git)> CoreCatalogFixture()
    {
        var (fixture, remote) = await SourceFixtureAsync();
        await AddCoreProject(remote);
        var git = new RemoteGitFixture(remote);
        var core = CoreSourceService(fixture, git);
        var source = await core.SaveAsync(new(null, "initial", new(RemoteGitFixture.Url, "main", ConnectionId: "connection")), default, "admin");
        var workspaces = new DevelopmentWorkspaceService(fixture.Paths, fixture.Apps, fixture.Clock, privateSources: git, coreDevelopment: core);
        var owner = ExternalOwner("core-catalog", label: "Catalog workspace");
        var tree = await workspaces.PrepareCoreSourceAsync(owner,
            new(Guid.NewGuid().ToString(), owner.SessionId, Guid.NewGuid().ToString(), source.Revision, Label: "Catalog workspace"), default);
        return (fixture, workspaces, tree, core, git);
    }

    private static WorkspaceRuntimeActivation CatalogActivation(DevelopmentWorkspace tree, string user = "admin") =>
        new(Guid.NewGuid().ToString(), tree.WorkspaceId, user, "fingerprint", "instance", "revision", tree.Id,
            CoreDevelopmentService.Project(tree.Path), new("release", null, null, 123, DateTimeOffset.UnixEpoch), [], "active",
            Authority: new(user, "test", Principal: "private-authority-marker"), CoreReserved: true,
            CoreReturnTarget: new(new("release", null, null, 123, DateTimeOffset.UnixEpoch), "/private/executable", "private-hash"));

    [Fact]
    public async Task CoreExecutionTargets_ReadMetadataWithoutRefreshingGitOrActivationReviews()
    {
        var (fixture, workspaces, tree, core, git) = await CoreCatalogFixture();
        var activation = CatalogActivation(tree);
        WorkspaceRuntimeFiles.Save(fixture.Paths.DataRoot, activation);
        var metadata = Path.Combine(fixture.Paths.CoreRoot, "development/workspaces", tree.Id + ".json");
        var before = await File.ReadAllTextAsync(metadata);
        // A fresh observation would fail and rewrite its persisted health. Discovery must not
        // touch Git or hash the deliberately unavailable captured Return executable.
        await File.WriteAllTextAsync(Path.Combine(tree.Path, ".git"), "Unavailable Git fixture");
        fixture.Clock.UtcNow += TimeSpan.FromHours(1);
        var targets = new CoreExecutionTargetService(new(workspaces, fixture.Apps, fixture.Clock, privateSources: git), core, fixture.Paths);

        var catalog = await targets.InventoryAsync("admin", default);

        var choice = Assert.Single(catalog.Targets);
        Assert.Equal(tree.WorkspaceId, choice.WorkspaceId);
        Assert.Equal(tree.Id, choice.WorktreeId);
        Assert.Equal("Catalog workspace", choice.Label);
        Assert.Equal(CoreDevelopmentService.Project(tree.Path), choice.ProjectPath);
        Assert.Null(choice.Unavailable);
        Assert.Equal(activation.Id, Assert.Single(catalog.Activations).Activation.Id);
        Assert.Equal(before, await File.ReadAllTextAsync(metadata));
        var json = CoreJson.Text(catalog);
        Assert.DoesNotContain("private-authority-marker", json);
        Assert.DoesNotContain("private/executable", json);
        Assert.DoesNotContain("private-hash", json);
        Assert.Equal(0, fixture.Adapter.StartCount);
        Assert.Equal(0, fixture.Adapter.StopCount);
    }

    [Fact]
    public async Task CoreExecutionTargets_RevokedPrivateSourceHidesChoicesAndRetainedActivation()
    {
        var (fixture, workspaces, tree, core, git) = await CoreCatalogFixture();
        WorkspaceRuntimeFiles.Save(fixture.Paths.DataRoot, CatalogActivation(tree));
        var targets = new CoreExecutionTargetService(new(workspaces, fixture.Apps, fixture.Clock, privateSources: git), core, fixture.Paths);
        git.Revoked = true;

        var catalog = await targets.InventoryAsync("admin", default);

        Assert.Empty(catalog.Targets);
        Assert.Empty(catalog.Activations);
        Assert.True(Directory.Exists(tree.Path));
    }

    [Fact]
    public async Task CoreExecutionTargets_OnlyOwnedWorkspacesAndLiveCoreOwnershipAreDiscoverable()
    {
        var (fixture, _) = await SourceFixtureAsync();
        var workspaces = new DevelopmentWorkspaceService(fixture.Paths, fixture.Apps, fixture.Clock);
        var owned = await workspaces.PrepareAsync(ExternalOwner(), ExternalPrepare(), default);
        var foreignOwner = WorkspaceOwner.ForExternal("another-admin", "oauth:another", "foreign-task", "Foreign editor");
        var foreign = await workspaces.PrepareAsync(foreignOwner, ExternalPrepare("foreign-task"), default);
        var keep = CatalogActivation(owned);
        WorkspaceRuntimeFiles.Save(fixture.Paths.DataRoot, keep);
        foreach (var item in new[] { CatalogActivation(foreign, foreignOwner.UserId),
            CatalogActivation(foreign), CatalogActivation(owned, "another-admin"),
            CatalogActivation(owned) with { CoreReturned = true }, CatalogActivation(owned) with { Phase = "returned" },
            CatalogActivation(owned) with { Phase = "preparing", CoreReserved = false, PreparationReleased = true },
            CatalogActivation(owned) with { CoreProject = null } })
            WorkspaceRuntimeFiles.Save(fixture.Paths.DataRoot, item);
        var targets = new CoreExecutionTargetService(new(workspaces, fixture.Apps, fixture.Clock), CoreSourceService(fixture), fixture.Paths);

        var catalog = await targets.InventoryAsync("admin", default);

        Assert.Empty(catalog.Targets);
        Assert.Equal(keep.Id, Assert.Single(catalog.Activations).Activation.Id);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CoreExecutionTargets_UnavailableOrLinkedProjectCannotBeSelected(bool linked)
    {
        var (fixture, workspaces, tree, core, git) = await CoreCatalogFixture();
        var project = CoreDevelopmentService.Project(tree.Path);
        File.Delete(project);
        if (linked)
        {
            var outside = Path.Combine(fixture.Root, "outside.csproj");
            await File.WriteAllTextAsync(outside, "<Project />");
            File.CreateSymbolicLink(project, outside);
        }
        var targets = new CoreExecutionTargetService(new(workspaces, fixture.Apps, fixture.Clock, privateSources: git), core, fixture.Paths);

        var choice = Assert.Single((await targets.InventoryAsync("admin", default)).Targets);

        Assert.NotNull(choice.Unavailable);
        Assert.Contains(linked ? "escapes its repository" : "unavailable in this worktree", choice.Unavailable);
    }
}
