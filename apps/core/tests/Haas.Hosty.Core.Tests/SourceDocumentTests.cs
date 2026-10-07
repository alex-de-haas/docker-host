using System.Text;
using System.Net.Http.Headers;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private const string PlanPath = "docs/features/sample/plan.md";
    private const string PlanText = "---\nstatus: Ready\ncreated: 2026-10-06\nupdated: 2026-10-07\nsummary: Example plan.\ncomponents: [apps/example]\n---\n# Example\n\n[Source](../../../README.md)\n\n## Deliverables\n\n- [ ] D1. Build.\n";
    private static Task CommitDocsAsync(string root, string message = "Docs change")
        => RunGitAsync(root, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-am", message]);
    private static async Task<(LifecycleFixture Fixture, string Origin, DevelopmentWorkspaceService Workspaces, SourceDocumentService Documents)> DocumentFixtureAsync()
    {
        var (fixture, origin) = await SourceFixtureAsync();
        Directory.CreateDirectory(Path.Combine(origin, "docs/features/sample"));
        Directory.CreateDirectory(Path.Combine(origin, "apps/example"));
        await File.WriteAllTextAsync(Path.Combine(origin, "apps/example/.keep"), "source");
        await File.WriteAllTextAsync(Path.Combine(origin, PlanPath), PlanText);
        await RunGitAsync(origin, ["add", "."]);
        await CommitDocsAsync(origin);
        var workspaces = new DevelopmentWorkspaceService(fixture.Paths, fixture.Apps, fixture.Clock);
        return (fixture, origin, workspaces, new(fixture.Apps, workspaces));
    }

    [Fact]
    public async Task SourceDocuments_DeduplicateRepositoryBranchAndUseSharedFreshness()
    {
        var (f, origin, workspaces, documents) = await DocumentFixtureAsync();
        var app = (await f.Apps.GetAppAsync(SourceTestApp))!;
        await f.Apps.UpsertAppAsync(app with { Id = "example.sibling", SourceState = app.SourceState! with { Repository = new Uri(origin).AbsoluteUri } });
        var entries = await documents.ListRepositoriesAsync("admin", default);
        var entry = Assert.Single(entries.Repositories);
        Assert.Equal(2, entry.Apps.Length);
        Assert.Null(entry.Commit);
        var first = await documents.ListDocumentsAsync(entry.Id, "admin", false, default);
        Assert.Equal(PlanPath, Assert.Single(first.Documents).Path);
        var references = first.Documents[0].ReferencePaths!;
        Assert.Contains(references, p => p.Path == "apps/example" && p.Exists && p.IsDirectory);
        Assert.Contains(references, p => p.Path == "README.md" && p.Exists && !p.IsDirectory);
        await File.WriteAllTextAsync(Path.Combine(origin, PlanPath), PlanText.Replace("Ready", "Draft"));
        await CommitDocsAsync(origin);
        Assert.Equal(first.Commit, (await documents.ListDocumentsAsync(entry.Id, "admin", false, default)).Commit);
        var changed = await documents.ListDocumentsAsync(entry.Id, "admin", true, default);
        Assert.NotEqual(first.Commit, changed.Commit);
        Assert.Equal(changed.Commit, Assert.Single((await documents.ListRepositoriesAsync("admin", default)).Repositories).Commit);
        Assert.NotNull(workspaces.Fetches.LastFetched(entry.Repository, entry.Branch));
    }

    [Fact]
    public async Task SourceDocuments_RefuseStaleAndArbitraryCommitsAndReturnExactUtf8Bytes()
    {
        var (f, origin, workspaces, documents) = await DocumentFixtureAsync();
        var entry = Assert.Single((await documents.ListRepositoriesAsync("admin", default)).Repositories);
        var listed = await documents.ListDocumentsAsync(entry.Id, "admin", false, default);
        var doc = Assert.Single(listed.Documents);
        var content = await documents.ReadContentAsync(entry.Id, "admin", new(PlanPath, Commit: listed.Commit, ExpectedSha: doc.Sha), default);
        Assert.Equal(PlanText, content.Content);
        Assert.Equal(doc.Sha, content.Sha);
        var workspace = await workspaces.PrepareAsync(WorkspaceTestOwner(f), WorkspaceRequest(), default);
        await File.WriteAllTextAsync(Path.Combine(workspace.Path, PlanPath), "\uFEFF# Тест\n");
        await RunGitAsync(workspace.Path, ["add", "."]);
        await CommitDocsAsync(workspace.Path);
        var otherCommit = (await RunGitAsync(workspace.Path, ["rev-parse", "HEAD"])).Trim();
        var arbitrary = await Assert.ThrowsAsync<AppLifecycleException>(() => documents.ReadContentAsync(entry.Id, "admin", new(PlanPath, Commit: otherCommit), default));
        Assert.Equal("source_document_conflict", arbitrary.Code);
        var local = await documents.ListDocumentsAsync(entry.Id, "admin", false, default, "worktree", workspace.Id);
        var bytes = Assert.Single(local.Documents);
        var returned = await documents.ReadContentAsync(entry.Id, "admin", new(PlanPath, "worktree", workspace.Id, ExpectedSha: bytes.Sha), default);
        Assert.Equal("\uFEFF# Тест\n", returned.Content);
        Assert.Equal(bytes.Sha, returned.Sha);
        await File.WriteAllTextAsync(Path.Combine(workspace.Path, PlanPath), "changed after listing");
        Assert.Equal("source_document_conflict", (await Assert.ThrowsAsync<AppLifecycleException>(() => documents.ReadContentAsync(entry.Id, "admin",
            new(PlanPath, "worktree", workspace.Id, ExpectedSha: bytes.Sha), default))).Code);
        await File.WriteAllTextAsync(Path.Combine(origin, PlanPath), "# New target");
        await CommitDocsAsync(origin);
        await documents.ListDocumentsAsync(entry.Id, "admin", true, default);
        Assert.Equal("source_document_conflict", (await Assert.ThrowsAsync<AppLifecycleException>(() => documents.ReadContentAsync(entry.Id, "admin",
            new(PlanPath, Commit: listed.Commit), default))).Code);
    }

    [Theory]
    [InlineData("../README.md")]
    [InlineData("docs/../README.md")]
    [InlineData("docs/features/sample/plan.txt")]
    [InlineData("docs//plan.md")]
    [InlineData("/docs/plan.md")]
    [InlineData("docs/\\plan.md")]
    public void SourceDocuments_RestrictDocumentPaths(string path)
        => Assert.Equal("source_document_path_invalid", Assert.Throws<AppLifecycleException>(() => SourceDocumentService.RequirePath(path)).Code);

    [Fact]
    public async Task SourceDocuments_RefuseSymlinksAndOversizedDocuments()
    {
        var (f, _, workspaces, documents) = await DocumentFixtureAsync();
        var entry = Assert.Single((await documents.ListRepositoriesAsync("admin", default)).Repositories);
        var workspace = await workspaces.PrepareAsync(WorkspaceTestOwner(f), WorkspaceRequest(), default);
        if (!OperatingSystem.IsWindows())
        {
            File.CreateSymbolicLink(Path.Combine(workspace.Path, "docs/link.md"), Path.Combine(workspace.Path, "README.md"));
            Directory.CreateSymbolicLink(Path.Combine(workspace.Path, "docs/linked"), Path.Combine(workspace.Path, "docs/features/sample"));
            Assert.Equal("source_document_path_invalid", (await Assert.ThrowsAsync<AppLifecycleException>(() => documents.ReadContentAsync(entry.Id, "admin",
                new("docs/link.md", "worktree", workspace.Id, ExpectedSha: "expected"), default))).Code);
            Assert.DoesNotContain((await documents.ListDocumentsAsync(entry.Id, "admin", false, default, "worktree", workspace.Id)).Documents,
                d => d.Path.Contains("link", StringComparison.Ordinal));
        }
        await File.WriteAllBytesAsync(Path.Combine(workspace.Path, PlanPath), new byte[SourceDocumentService.FileLimit + 1]);
        Assert.Equal("source_document_size_limit", (await Assert.ThrowsAsync<AppLifecycleException>(() => documents.ReadContentAsync(entry.Id, "admin",
            new(PlanPath, "worktree", workspace.Id, ExpectedSha: "expected"), default))).Code);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SourceDocuments_IntegratedTargetChangesAreNotWorkspaceChanges(bool coreMerge)
    {
        var (f, origin, workspaces, documents) = await DocumentFixtureAsync();
        var workspace = await workspaces.PrepareAsync(WorkspaceTestOwner(f), WorkspaceRequest(), default);
        await File.WriteAllTextAsync(Path.Combine(origin, PlanPath), PlanText.Replace("Ready", "Draft"));
        await CommitDocsAsync(origin);
        if (coreMerge)
            await workspaces.CommandAsync(workspace.Id, workspace.Owner, "merge", WorkspaceCommit(workspace.OriginalBase, "Merge target"), default);
        else
        {
            await workspaces.CommandAsync(workspace.Id, workspace.Owner, "refresh", new(Guid.NewGuid().ToString()), default);
            await RunGitAsync(workspace.Path, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "merge", "--no-edit", "refs/hosty/targets/" + DevelopmentWorkspaceService.Hash("main")]);
        }
        Assert.Empty(Assert.Single((await documents.ListWorkspacesAsync("admin", null, default)).Workspaces).Changes!);
        Assert.Contains(PlanPath, (await workspaces.ObserveAsync(workspace.Id, null, default)).Observation!.SessionFiles!);
    }

    [Theory]
    [InlineData("merge")]
    [InlineData("squash")]
    [InlineData("cherry-pick")]
    public async Task SourceDocuments_TargetIntegratedWorkspaceContentDisappearsRegardlessOfAncestry(string integration)
    {
        var (f, origin, workspaces, documents) = await DocumentFixtureAsync();
        var workspace = await workspaces.PrepareAsync(WorkspaceTestOwner(f), WorkspaceRequest(), default);
        await File.WriteAllTextAsync(Path.Combine(workspace.Path, PlanPath), PlanText.Replace("Ready", "In Progress"));
        await RunGitAsync(workspace.Path, ["add", "."]);
        await CommitDocsAsync(workspace.Path);
        var commit = (await RunGitAsync(workspace.Path, ["rev-parse", "HEAD"])).Trim();
        await RunGitAsync(origin, ["fetch", workspaces.RepositoryPath(workspace.Repository), workspace.Branch]);
        if (integration == "cherry-pick") await RunGitAsync(origin, ["-c", "user.name=Target", "-c", "user.email=target@example.test", "cherry-pick", commit]);
        else if (integration == "merge") await RunGitAsync(origin, ["-c", "user.name=Target", "-c", "user.email=target@example.test", "merge", "--no-ff", "--no-edit", commit]);
        else
        {
            await RunGitAsync(origin, ["merge", "--squash", commit]);
            await CommitDocsAsync(origin, "Squashed change");
        }
        await workspaces.CommandAsync(workspace.Id, workspace.Owner, "refresh", new(Guid.NewGuid().ToString()), default);
        Assert.Empty(Assert.Single((await documents.ListWorkspacesAsync("admin", null, default)).Workspaces).Changes!);
    }

    [Fact]
    public async Task SourceDocuments_ShowWorkspaceChangesTargetChangesAndUninstalledOwners()
    {
        var (f, origin, workspaces, documents) = await DocumentFixtureAsync();
        await f.Apps.UpdateAppAsync(SourceTestApp, app => app with
        {
            Endpoints = [new("web", "http", "http://127.0.0.1:4111", true)],
        });
        var owner = new WorkspaceOwner(SourceTestApp, (await f.Apps.GetAppAsync(SourceTestApp))!.InstalledAt, "admin", "session-one");
        var workspace = await workspaces.PrepareAsync(owner, WorkspaceRequest(), default);
        var first = Assert.Single((await documents.ListWorkspacesAsync("admin", null, default)).Workspaces);
        Assert.NotNull(first.SessionUrl);
        await File.WriteAllTextAsync(Path.Combine(workspace.Path, PlanPath), PlanText.Replace("Ready", "In Progress"));
        await File.WriteAllTextAsync(Path.Combine(workspace.Path, "docs/new.md"), "# New\n");
        await File.WriteAllTextAsync(Path.Combine(origin, PlanPath), PlanText.Replace("Ready", "On Hold"));
        await CommitDocsAsync(origin);
        await workspaces.CommandAsync(workspace.Id, workspace.Owner, "refresh", new(Guid.NewGuid().ToString()), default);
        var changed = Assert.Single((await documents.ListWorkspacesAsync("admin", null, default)).Workspaces);
        Assert.Contains(changed.Changes!, c => c.Path == PlanPath && c.Kind == "modified" && c.TargetChanged && c.BaseSha is not null && c.WorktreeSha is not null);
        Assert.Contains(changed.Changes!, c => c.Path == "docs/new.md" && c.Kind == "added");
        await f.Apps.UpdateAppAsync(SourceTestApp, a => a with { InstalledAt = a.InstalledAt.AddSeconds(1) });
        Assert.Null(Assert.Single((await documents.ListWorkspacesAsync("admin", null, default)).Workspaces).SessionUrl);
        await f.Apps.RemoveAppAsync(SourceTestApp);
        Assert.True(Assert.Single((await documents.ListRepositoriesAsync("admin", default)).Repositories).WorkspaceDerived);
        var orphan = Assert.Single((await documents.ListWorkspacesAsync("admin", null, default)).Workspaces);
        Assert.NotNull(orphan.Changes);
        Assert.Null(orphan.SessionUrl);
        Assert.NotNull(orphan.SessionUrlError);
    }

    [Fact]
    public async Task SourceDocuments_UntrackedBranchAndReleasingWorkspaceKeepTheirEntries()
    {
        var (f, origin, workspaces, documents) = await DocumentFixtureAsync();
        await RunGitAsync(origin, ["branch", "other"]);
        var workspace = await workspaces.PrepareAsync(WorkspaceTestOwner(f), WorkspaceRequest() with { TargetBranch = "other" }, default);
        var entries = (await documents.ListRepositoriesAsync("admin", default)).Repositories;
        Assert.Equal(2, entries.Length);
        Assert.True(Assert.Single(entries, e => e.Branch == "other").WorkspaceDerived);
        var record = Path.Combine(f.Paths.CoreRoot, "development/workspaces", workspace.Id + ".json");
        await JsonStorage.WriteAsync(record, workspace with { State = "releasing" });
        var projection = Assert.Single((await documents.ListWorkspacesAsync("admin", null, default)).Workspaces);
        Assert.Equal("releasing", projection.State);
        Assert.Null(projection.Changes);
        Assert.NotNull(projection.Error);
        Assert.Equal(2, (await documents.ListRepositoriesAsync("admin", default)).Repositories.Length);
    }

    [Fact]
    public async Task SourceFetches_ShareOneInflightFetchAndTrackBranchesSeparately()
    {
        var clock = new FakeClock(DateTimeOffset.UtcNow);
        var coordinator = new SourceRepositoryFetchCoordinator(clock);
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var finish = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var count = 0;
        var root = Path.Combine(Path.GetTempPath(), "hosty-fetch-" + Guid.NewGuid().ToString("N"));
        async Task<string> Fetch(CancellationToken ct) { Interlocked.Increment(ref count); started.SetResult(); return await finish.Task.WaitAsync(ct); }
        var first = coordinator.FetchAsync(root, "one", "main", false, Fetch, default);
        await started.Task;
        var second = coordinator.FetchAsync(root, "one", "main", true, Fetch, default);
        Assert.Equal("other", await coordinator.FetchAsync(root, "two", "main", false, _ => Task.FromResult("other"), default));
        finish.SetResult("head");
        Assert.Equal("head", await first); Assert.Equal("head", await second); Assert.Equal(1, count);
        Assert.Equal("head", await coordinator.FetchAsync(root, "one", "main", false, _ => throw new InvalidOperationException(), default));
        Assert.Null(coordinator.LastFetched("one", "different"));
        Assert.Equal("branch", await coordinator.FetchAsync(root, "one", "different", false, _ => Task.FromResult("branch"), default));
        clock.UtcNow += SourceRepositoryFetchCoordinator.Interval;
        Assert.Equal("fresh", await coordinator.FetchAsync(root, "one", "main", false, _ => Task.FromResult("fresh"), default));
    }

    [Theory]
    [InlineData("sha1")]
    [InlineData("sha256")]
    public async Task SourceDocuments_BlobDigestMatchesGitIncludingUtf8Bom(string format)
    {
        var root = Path.Combine(Path.GetTempPath(), "hosty-blob-digest-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            await RunGitAsync(root, ["init", "--object-format=" + format]);
            var bytes = Encoding.UTF8.GetBytes("\uFEFF# Тест\n");
            await File.WriteAllBytesAsync(Path.Combine(root, "doc.md"), bytes);
            var expected = (await RunGitAsync(root, ["hash-object", "--no-filters", "--", "doc.md"])).Trim();
            Assert.Equal(expected, SourceDocumentService.BlobSha(bytes, format));
        }
        finally { Directory.Delete(root, true); }
    }

    private static async Task<(UserDirectoryStore Users, PrivateSourceService Private, SourceReadGrant Grant)> PrivateDocumentAccessAsync(
        LifecycleFixture fixture, string repository, ISourceProvider? provider = null)
    {
        var users = new UserDirectoryStore(fixture.Paths);
        var now = fixture.Clock.UtcNow;
        await users.WriteAsync(new(1,
            [new("admin", "admin@example.test", "Admin", "host.admin", false, now, now), new("bob", "bob@example.test", "Bob", "host.admin", false, now, now)], [], [], [],
            ProviderConnections: [
                new("source-admin", "admin", "Fixture", "fixture", "", "", "admin", "Admin", "pat", "fixture", null, null, null, now, now, "connected", "1"),
                new("source-bob", "bob", "Fixture", "fixture", "", "", "bob", "Bob", "pat", "fixture", null, null, null, now, now, "connected", "1") ]));
        var connection = new UserConnectionService(users, new SourceProviderRegistry([provider ?? new LocalDocumentProvider()]), fixture.Clock,
            new AuditStore(fixture.Paths), fixture.CoreSettings);
        var service = new PrivateSourceService(connection, new HttpClient());
        var grant = await service.BindAsync("admin", "source-admin", repository, false, default);
        return (users, service, grant);
    }

    // No secret or network is involved: production grant ownership/revocation is exercised with
    // a provider that recognizes the isolated test repository's file URL only.
    private sealed class LocalDocumentProvider : ISourceProvider
    {
        public SourceProviderDescriptor Descriptor => new("fixture", "Fixture", ["pat"], ["private-sources"]);
        public string? ClientId => null;
        public IPublicationProvider? Publication => null;
        public UserConnectionInput Validate(UserConnectionInput input) => input;
        public bool Owns(Uri uri) => uri.IsFile;
        public string NormalizeRepository(string value)
        {
            var local = value.StartsWith("file:", StringComparison.Ordinal) ? new Uri(value).LocalPath : value;
            return MountPathPolicy.ResolveRealPath(Directory.Exists(Path.Combine(local, ".git")) ? Path.Combine(local, ".git") : local);
        }
        public SourceRepositoryFile ParseManifest(string url) => throw new NotSupportedException();
        public HttpRequestMessage FileRequest(UserProviderConnection connection, SourceRepositoryFile file) => throw new NotSupportedException();
        public AuthenticationHeaderValue GitAuthorization(UserProviderConnection connection) => new("Bearer", "fixture");
        public Task<ProviderDevice> StartAsync(UserConnectionInput input, string clientId, CancellationToken ct) => throw new NotSupportedException();
        public Task<(ProviderToken? Token, string? Pending)> PollAsync(string clientId, string deviceCode, CancellationToken ct) => throw new NotSupportedException();
        public Task<ProviderToken> RefreshAsync(UserProviderConnection connection, CancellationToken ct) => throw new NotSupportedException();
        public Task<ProviderIdentity> IdentityAsync(string method, string token, CancellationToken ct) => throw new NotSupportedException();
    }

    [Fact]
    public async Task SourceDocuments_PrivateFallbackAuthorizesOwnerWithoutExposingAnotherOwnersWorktree()
    {
        var (f, _, initialWorkspaces, _) = await DocumentFixtureAsync();
        var workspace = await initialWorkspaces.PrepareAsync(WorkspaceTestOwner(f), WorkspaceRequest(), default);
        var (users, access, grant) = await PrivateDocumentAccessAsync(f, workspace.Repository);
        await f.Apps.UpdateAppAsync(SourceTestApp, a => a with { PrivateSources = new(Git: grant) });
        await JsonStorage.WriteAsync(Path.Combine(f.Paths.CoreRoot, "development/workspaces", workspace.Id + ".json"), workspace with { SourceGrant = grant });
        var workspaces = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock, privateSources: access);
        var documents = new SourceDocumentService(f.Apps, workspaces, access);
        var entry = Assert.Single((await documents.ListRepositoriesAsync("admin", default)).Repositories);
        Assert.Equal("available", entry.State);
        Assert.Equal("unavailable", Assert.Single((await documents.ListRepositoriesAsync("bob", default)).Repositories).State);
        var app = (await f.Apps.GetAppAsync(SourceTestApp))!;
        var otherGrant = await access.BindAsync("bob", "source-bob", workspace.Repository, false, default);
        await f.Apps.UpsertAppAsync(app with { Id = "example.other", PrivateSources = new(Git: otherGrant) });
        await f.Apps.RemoveAppAsync(SourceTestApp);
        // Installed grant belongs to Bob; Admin keeps the shared baseline through their orphan.
        Assert.Equal("available", Assert.Single((await documents.ListRepositoriesAsync("admin", default)).Repositories).State);
        Assert.Equal("available", Assert.Single((await documents.ListRepositoriesAsync("bob", default)).Repositories).State);
        var local = await documents.ListDocumentsAsync(entry.Id, "admin", false, default, "worktree", workspace.Id);
        Assert.Single(local.Documents);
        Assert.Equal("source_document_forbidden", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            documents.ListDocumentsAsync(entry.Id, "bob", false, default, "worktree", workspace.Id))).Code);
        await users.UpdateAsync(state => state with { ProviderConnections = state.ProviderConnections!.Where(c => c.UserId != "admin").ToArray() });
        Assert.Equal("unavailable", Assert.Single((await documents.ListRepositoriesAsync("admin", default)).Repositories).State);
        await Assert.ThrowsAsync<AppLifecycleException>(() => documents.ListDocumentsAsync(entry.Id, "admin", false, default, "worktree", workspace.Id));
    }

    [Theory]
    [InlineData("clear")]
    [InlineData("rebind")]
    public async Task SourceDocuments_ReviewedGrantChangesNeverRestoreWorkspaceGrant(string transition)
    {
        var (f, _, initialWorkspaces, _) = await DocumentFixtureAsync();
        var workspace = await initialWorkspaces.PrepareAsync(WorkspaceTestOwner(f), WorkspaceRequest(), default);
        var (_, access, grant) = await PrivateDocumentAccessAsync(f, workspace.Repository);
        var replacement = transition == "clear" ? null : await access.BindAsync("bob", "source-bob", workspace.Repository, false, default);
        await f.Apps.UpdateAppAsync(SourceTestApp, a => a with { PrivateSources = replacement is null ? null : new(Git: replacement) });
        await JsonStorage.WriteAsync(Path.Combine(f.Paths.CoreRoot, "development/workspaces", workspace.Id + ".json"), workspace with { SourceGrant = grant });
        var workspaces = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock, privateSources: access);
        var documents = new SourceDocumentService(f.Apps, workspaces, access);
        var entry = Assert.Single((await documents.ListRepositoriesAsync("admin", default)).Repositories);
        Assert.Equal(transition == "clear" ? "available" : "unavailable", entry.State);
        // A cleared public app remains discoverable for another administrator as well.
        if (transition == "clear") Assert.Equal("available", Assert.Single((await documents.ListRepositoriesAsync("bob", default)).Repositories).State);
        await Assert.ThrowsAsync<AppLifecycleException>(() => documents.ListDocumentsAsync(entry.Id, "admin", false, default, "worktree", workspace.Id));
    }

    [Fact]
    public async Task SourceDocuments_ReferenceMetadataMatchesProseFenceAndEncodedLinkRules()
    {
        var (_, origin, _, documents) = await DocumentFixtureAsync();
        await File.WriteAllTextAsync(Path.Combine(origin, "space name.cs"), "source");
        await File.WriteAllTextAsync(Path.Combine(origin, PlanPath), PlanText + "\n````md\n```\n[Hidden](../../../hidden.cs)\n````not-a-close\n[Still hidden](../../../hidden-two.cs)\n````\n\n`[Inline code](../../../hidden-three.cs)`\n[Encoded](../../../space%20name.cs)\n[ref]: ../../../README.md\n");
        await RunGitAsync(origin, ["add", "."]); await CommitDocsAsync(origin);
        var entry = Assert.Single((await documents.ListRepositoriesAsync("admin", default)).Repositories);
        var references = Assert.Single((await documents.ListDocumentsAsync(entry.Id, "admin", false, default)).Documents).ReferencePaths!;
        Assert.Contains(references, p => p.Path == "space name.cs" && p.Exists);
        Assert.Contains(references, p => p.Path == "README.md" && p.Exists);
        Assert.DoesNotContain(references, p => p.Path.StartsWith("hidden", StringComparison.Ordinal));
    }

    [Fact]
    public async Task SourceDocuments_ReferenceLimitFailsExplicitly()
    {
        var (_, origin, _, documents) = await DocumentFixtureAsync();
        await File.WriteAllTextAsync(Path.Combine(origin, PlanPath), string.Join('\n', Enumerable.Range(0, 513).Select(i => $"[link](../../../path{i}.txt)")));
        await CommitDocsAsync(origin);
        var entry = Assert.Single((await documents.ListRepositoriesAsync("admin", default)).Repositories);
        Assert.Equal("source_document_reference_limit", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            documents.ListDocumentsAsync(entry.Id, "admin", false, default))).Code);
    }
}
