using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private const string PrivateWorkspaceText = "# Uncommitted private workspace document\n";

    private static async Task<(LifecycleFixture Fixture, UserDirectoryStore Users, PrivateSourceService Access,
        DevelopmentWorkspaceService Workspaces, DevelopmentWorkspace Workspace, SourceDocumentService Documents,
        SourceRepository Entry)> PrivateWorkspaceDocumentFixtureAsync()
    {
        var (fixture, _, initial, _) = await DocumentFixtureAsync();
        var workspace = await initial.PrepareAsync(WorkspaceTestOwner(fixture), WorkspaceRequest(), default);
        var (users, access, grant) = await PrivateDocumentAccessAsync(fixture, workspace.Repository);
        await fixture.Apps.UpdateAppAsync(SourceTestApp, app => app with { PrivateSources = new(Git: grant) });
        await JsonStorage.WriteAsync(Path.Combine(fixture.Paths.CoreRoot, "development/workspaces", workspace.Id + ".json"),
            workspace with { SourceGrant = grant });
        await File.WriteAllTextAsync(Path.Combine(workspace.Path, PlanPath), PrivateWorkspaceText);
        var workspaces = new DevelopmentWorkspaceService(fixture.Paths, fixture.Apps, fixture.Clock, privateSources: access);
        // The real managed Git tree already contains this exact baseline. Record the prior private
        // fetch's freshness, as in the snapshot fixtures, without establishing anonymous access.
        // This isolated provider validates real reviewed grants; its file transport is refused by
        // production's HTTPS-only private Git configuration once the fetch window expires.
        await workspaces.Fetches.FetchAsync(workspaces.RepositoryPath(workspace.Repository), workspace.Repository,
            "main", true, _ => Task.FromResult(workspace.OriginalBase), default);
        var documents = new SourceDocumentService(fixture.Apps, workspaces, access);
        var entry = Assert.Single((await documents.ListRepositoriesAsync("admin", default)).Repositories);
        Assert.False(entry.WorkspaceDerived);
        Assert.Equal("available", entry.State);
        Assert.Single(entry.Apps);
        Assert.False(workspaces.Fetches.HasPublicProof(entry.Repository, entry.Branch, entry.Commit));
        return (fixture, users, access, workspaces, workspace, documents, entry);
    }

    [Theory]
    [InlineData("base", false)]
    [InlineData("worktree", false)]
    [InlineData("base", true)]
    [InlineData("worktree", true)]
    public async Task SourceDocuments_PrivateWorkspaceReadsSurviveExpiredFetchOrCoordinatorReset(string version, bool reset)
    {
        var (fixture, _, access, workspaces, workspace, documents, entry) = await PrivateWorkspaceDocumentFixtureAsync();
        var warm = await documents.ListDocumentsAsync(entry.Id, "admin", false, default, version, workspace.Id);
        var warmDocument = Assert.Single(warm.Documents);
        var request = new SourceDocumentRead(PlanPath, version, workspace.Id, warm.Commit, warmDocument.Sha);
        var expected = version == "base" ? PlanText : PrivateWorkspaceText;
        Assert.Equal(expected, (await documents.ReadContentAsync(entry.Id, "admin", request, default)).Content);
        fixture.Clock.UtcNow += SourceRepositoryFetchCoordinator.Interval;
        if (reset)
        {
            workspaces = new DevelopmentWorkspaceService(fixture.Paths, fixture.Apps, fixture.Clock, privateSources: access);
            documents = new SourceDocumentService(fixture.Apps, workspaces, access);
            Assert.Null(workspaces.Fetches.LastFetched(entry.Repository, entry.Branch));
        }

        var listed = await documents.ListDocumentsAsync(entry.Id, "admin", false, default, version, workspace.Id);
        Assert.Equal(warm.Commit, listed.Commit);
        Assert.Equal(warmDocument.Sha, Assert.Single(listed.Documents).Sha);
        Assert.Equal(expected, (await documents.ReadContentAsync(entry.Id, "admin", request, default)).Content);
        Assert.Equal("source_document_conflict", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            documents.ReadContentAsync(entry.Id, "admin", request with { ExpectedSha = new string('0', 40) }, default))).Code);
        if (version == "base")
        {
            Assert.Equal("source_document_conflict", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
                documents.ReadContentAsync(entry.Id, "admin", request with { Commit = new string('0', 40) }, default))).Code);
        }
        else
        {
            Assert.Equal("source_document_invalid", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
                documents.ReadContentAsync(entry.Id, "admin", request with { ExpectedSha = null }, default))).Code);
            await File.WriteAllTextAsync(Path.Combine(workspace.Path, PlanPath), "# Changed after listing\n");
            Assert.Equal("source_document_conflict", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
                documents.ReadContentAsync(entry.Id, "admin", request, default))).Code);
        }
        Assert.Equal("source_document_forbidden", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            documents.ReadContentAsync(entry.Id, "bob", request, default))).Code);
        Assert.Equal("source_access_required", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            documents.ListDocumentsAsync(entry.Id, "admin", false, default))).Code);
        Assert.Equal("source_access_required", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            documents.ReadContentAsync(entry.Id, "admin", new(PlanPath, Commit: workspace.OriginalBase), default))).Code);
        Assert.False(workspaces.Fetches.HasPublicProof(entry.Repository, entry.Branch, entry.Commit));
    }

    [Theory]
    [InlineData("base", "clear")]
    [InlineData("worktree", "clear")]
    [InlineData("base", "rebind")]
    [InlineData("worktree", "rebind")]
    [InlineData("base", "revoke")]
    [InlineData("worktree", "revoke")]
    public async Task SourceDocuments_PrivateWorkspaceReadsRejectChangedOrRevokedGrants(string version, string transition)
    {
        var (fixture, users, access, _, workspace, documents, entry) = await PrivateWorkspaceDocumentFixtureAsync();
        var listed = await documents.ListDocumentsAsync(entry.Id, "admin", false, default, version, workspace.Id);
        var document = Assert.Single(listed.Documents);
        var request = new SourceDocumentRead(PlanPath, version, workspace.Id, listed.Commit, document.Sha);
        await documents.ReadContentAsync(entry.Id, "admin", request, default);
        if (transition == "revoke")
            await users.UpdateAsync(state => state with { ProviderConnections = state.ProviderConnections!.Where(connection => connection.Id != "source-admin").ToArray() });
        else
        {
            var replacement = transition == "clear" ? null : await access.BindAsync("bob", "source-bob", workspace.Repository, false, default);
            await fixture.Apps.UpdateAppAsync(SourceTestApp, app => app with { PrivateSources = replacement is null ? null : new(Git: replacement) });
        }
        fixture.Clock.UtcNow += SourceRepositoryFetchCoordinator.Interval;
        await Assert.ThrowsAsync<AppLifecycleException>(() => documents.ListDocumentsAsync(entry.Id, "admin", false, default, version, workspace.Id));
        await Assert.ThrowsAsync<AppLifecycleException>(() => documents.ReadContentAsync(entry.Id, "admin", request, default));
        if (transition == "rebind")
            Assert.Equal("source_document_forbidden", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
                documents.ReadContentAsync(entry.Id, "bob", request, default))).Code);
    }

    [Theory]
    [InlineData("base")]
    [InlineData("worktree")]
    public async Task SourceDocuments_PrivateWorkspaceAccessDoesNotBypassPublicAnonymousProof(string version)
    {
        var (fixture, origin, workspaces, documents) = await DocumentFixtureAsync();
        // Use a separate ordinary public fixture so neither a private grant nor private cache can
        // supply access. Its managed baseline remains readable after the source branch disappears.
        var workspace = await workspaces.PrepareAsync(WorkspaceTestOwner(fixture), WorkspaceRequest(), default);
        var entry = Assert.Single((await documents.ListRepositoriesAsync("admin", default)).Repositories);
        var listed = await documents.ListDocumentsAsync(entry.Id, "admin", false, default, version, workspace.Id);
        var document = Assert.Single(listed.Documents);
        var request = new SourceDocumentRead(PlanPath, version, workspace.Id, listed.Commit, document.Sha);
        await documents.ReadContentAsync(entry.Id, "admin", request, default);
        Assert.True(workspaces.Fetches.HasPublicProof(entry.Repository, entry.Branch, entry.Commit));
        await RunGitAsync(origin, ["update-ref", "refs/heads/offline-fixture", workspace.OriginalBase]);
        await RunGitAsync(origin, ["update-ref", "-d", "refs/heads/main"]);
        fixture.Clock.UtcNow += SourceRepositoryFetchCoordinator.Interval;
        Assert.False(workspaces.Fetches.HasPublicProof(entry.Repository, entry.Branch, entry.Commit));
        await Assert.ThrowsAsync<AppLifecycleException>(() => documents.ListDocumentsAsync(entry.Id, "admin", false, default, version, workspace.Id));
        await Assert.ThrowsAsync<AppLifecycleException>(() => documents.ReadContentAsync(entry.Id, "admin", request, default));
    }
}
