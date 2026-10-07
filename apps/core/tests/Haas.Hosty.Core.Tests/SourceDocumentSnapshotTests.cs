using System.Diagnostics;
using System.Net.Http.Headers;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task SourceSnapshots_Batch157DocumentsAndReuseImmutableMetadataAndBytes()
    {
        var (_, origin, _, documents) = await DocumentFixtureAsync();
        var notes = string.Join('\n', Enumerable.Repeat("Plain repository documentation for the snapshot performance fixture.", 256));
        for (var index = 0; index < 156; index++)
            await File.WriteAllTextAsync(Path.Combine(origin, "docs", $"example-{index}.md"), $"# Document {index}\n\n[Plan](features/sample/plan.md)\n{notes}\n");
        await RunGitAsync(origin, ["add", "."]); await CommitDocsAsync(origin);
        var entry = Assert.Single((await documents.ListRepositoriesAsync("admin", default)).Repositories);
        var stopwatch = Stopwatch.StartNew();
        var first = await documents.ListDocumentsAsync(entry.Id, "admin", false, default);
        var cold = stopwatch.ElapsedMilliseconds;
        Assert.Equal(157, first.Documents.Length);
        Assert.Equal(1, documents.SnapshotStatistics.TreeLoads);
        Assert.Equal(1, documents.SnapshotStatistics.BlobProcesses);
        stopwatch.Restart();
        var second = await documents.ListDocumentsAsync(entry.Id, "admin", false, default);
        var warm = stopwatch.ElapsedMilliseconds;
        Assert.Equal(first.Commit, second.Commit);
        Assert.Equal(1, documents.SnapshotStatistics.TreeLoads);
        Assert.Equal(1, documents.SnapshotStatistics.BlobProcesses);
        foreach (var document in second.Documents)
        {
            var content = await documents.ReadContentAsync(entry.Id, "admin", new(document.Path, Commit: second.Commit, ExpectedSha: document.Sha), default);
            Assert.Equal(document.ReferencePaths, content.ReferencePaths);
        }
        Assert.Equal(1, documents.SnapshotStatistics.BlobProcesses);
        Assert.InRange(documents.SnapshotStatistics.Bytes, 1, 64 * 1024 * 1024);
        Console.WriteLine($"157-doc snapshot: cold={cold}ms warm={warm}ms; tree loads=1, blob processes=1.");
    }

    [Fact]
    public async Task SourceSnapshots_FocusedReadsAvoidUnrelatedBlobsAndRevalidateChangedCommits()
    {
        var (_, origin, _, documents) = await DocumentFixtureAsync();
        await File.WriteAllTextAsync(Path.Combine(origin, "docs", "invalid.md"), "[bad](" + new string('x', 2049) + ")\n");
        await File.WriteAllBytesAsync(Path.Combine(origin, "docs", "oversized.md"), new byte[SourceDocumentService.FileLimit + 1]);
        await RunGitAsync(origin, ["add", "."]); await CommitDocsAsync(origin);
        var entry = Assert.Single((await documents.ListRepositoriesAsync("admin", default)).Repositories);
        var first = await documents.ListDocumentsAsync(entry.Id, "admin", false, default, documentPath: PlanPath);
        Assert.Equal(PlanPath, Assert.Single(first.Documents).Path);
        Assert.Contains(first.Documents[0].ReferencePaths!, reference => reference.Path == "README.md" && reference.Exists);
        Assert.Equal(1, documents.SnapshotStatistics.BlobProcesses);
        Assert.Equal(1, documents.SnapshotStatistics.TreeLoads);
        var content = await documents.ReadContentAsync(entry.Id, "admin", new(PlanPath, Commit: first.Commit), default);
        Assert.Equal(PlanText, content.Content);
        Assert.Equal(1, documents.SnapshotStatistics.BlobProcesses);
        Assert.Empty((await documents.ListDocumentsAsync(entry.Id, "admin", false, default, documentPath: "docs/missing.md")).Documents);
        Assert.Equal("source_document_size_limit", (await Assert.ThrowsAsync<AppLifecycleException>(() => documents.ListDocumentsAsync(entry.Id, "admin", false, default))).Code);
        File.Delete(Path.Combine(origin, "README.md"));
        await CommitDocsAsync(origin);
        var next = await documents.ListDocumentsAsync(entry.Id, "admin", true, default, documentPath: PlanPath);
        Assert.NotEqual(first.Commit, next.Commit);
        Assert.Equal(first.Documents[0].Sha, next.Documents[0].Sha);
        Assert.Contains(next.Documents[0].ReferencePaths!, reference => reference.Path == "README.md" && !reference.Exists);
        Assert.Equal(2, documents.SnapshotStatistics.TreeLoads);
        Assert.Equal(1, documents.SnapshotStatistics.BlobProcesses); // Same blob, fresh tree reference context.
        Assert.Equal("source_document_conflict", (await Assert.ThrowsAsync<AppLifecycleException>(() => documents.ReadContentAsync(entry.Id, "admin", new(PlanPath, Commit: first.Commit), default))).Code);
    }

    [Fact]
    public async Task SourceSnapshots_FocusedWorktreeReadsStayFreshAndRejectSymlinks()
    {
        var (fixture, _, workspaces, documents) = await DocumentFixtureAsync();
        var workspace = await workspaces.PrepareAsync(WorkspaceTestOwner(fixture), WorkspaceRequest(), default);
        var entry = Assert.Single((await documents.ListRepositoriesAsync("admin", default)).Repositories);
        await File.WriteAllBytesAsync(Path.Combine(workspace.Path, "docs", "unrelated.md"), new byte[SourceDocumentService.FileLimit + 1]);
        var first = await documents.ListDocumentsAsync(entry.Id, "admin", false, default, "worktree", workspace.Id, PlanPath);
        var document = Assert.Single(first.Documents);
        await File.WriteAllTextAsync(Path.Combine(workspace.Path, PlanPath), PlanText.Replace("Ready", "In Progress"));
        var second = await documents.ListDocumentsAsync(entry.Id, "admin", false, default, "worktree", workspace.Id, PlanPath);
        Assert.NotEqual(document.Sha, Assert.Single(second.Documents).Sha);
        Assert.Equal("source_document_conflict", (await Assert.ThrowsAsync<AppLifecycleException>(() => documents.ReadContentAsync(entry.Id, "admin", new(PlanPath, "worktree", workspace.Id, ExpectedSha: document.Sha), default))).Code);
        Assert.Empty((await documents.ListDocumentsAsync(entry.Id, "admin", false, default, "worktree", workspace.Id, "docs/missing.md")).Documents);
        if (!OperatingSystem.IsWindows())
        {
            File.CreateSymbolicLink(Path.Combine(workspace.Path, "docs", "link.md"), Path.Combine(workspace.Path, PlanPath));
            Assert.Equal("source_document_path_invalid", (await Assert.ThrowsAsync<AppLifecycleException>(() => documents.ListDocumentsAsync(entry.Id, "admin", false, default, "worktree", workspace.Id, "docs/link.md"))).Code);
        }
    }

    [Fact]
    public async Task SourceSnapshots_CacheIsBoundedAndCoalescesWithoutCrossRepositoryBlocking()
    {
        var cache = new SourceDocumentSnapshotCache(2, 1024);
        cache.Set("a", "first", 100); cache.Set("b", "second", 100);
        Assert.True(cache.TryGet<string>("a", out _)); cache.Set("c", "third", 100);
        Assert.False(cache.TryGet<string>("b", out _));
        cache.Set("oversized", new byte[2048], 2048);
        Assert.Equal(2, cache.Statistics.Count); Assert.InRange(cache.Statistics.Bytes, 1, 1024);
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var finish = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var calls = 0;
        async Task<(string, long)> Load(CancellationToken ct) { Interlocked.Increment(ref calls); started.SetResult(); return (await finish.Task.WaitAsync(ct), 1); }
        var first = cache.GetAsync("slow", Load, default); await started.Task;
        using var cancel = new CancellationTokenSource();
        var cancelled = cache.GetAsync("slow", Load, cancel.Token); cancel.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => cancelled);
        Assert.Equal("other", await cache.GetAsync("other", _ => Task.FromResult(("other", 1L)), default));
        var second = cache.GetAsync("slow", Load, default); finish.SetResult("done");
        Assert.Equal("done", await first); Assert.Equal("done", await second); Assert.Equal(1, calls);
        await Assert.ThrowsAsync<IOException>(() => cache.GetAsync<string>("failed", _ => throw new IOException(), default));
        Assert.Equal("recovered", await cache.GetAsync("failed", _ => Task.FromResult(("recovered", 1L)), default));
    }

    [Fact]
    public async Task SourceSnapshots_CallerCannotMutateCachedReferencedPathMetadata()
    {
        var (_, _, _, documents) = await DocumentFixtureAsync();
        var entry = Assert.Single((await documents.ListRepositoriesAsync("admin", default)).Repositories);
        var first = await documents.ListDocumentsAsync(entry.Id, "admin", false, default);
        var document = Assert.Single(first.Documents);
        document.ReferencePaths![0] = new("invented", false, false);
        first.Documents[0] = document with { Path = "invented" };
        var second = Assert.Single((await documents.ListDocumentsAsync(entry.Id, "admin", false, default)).Documents);
        Assert.Equal(PlanPath, second.Path); Assert.DoesNotContain(second.ReferencePaths!, reference => reference.Path == "invented");
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SourceSnapshots_AggregateMetadataIsBoundedBeforeSharedBlobExpansion(bool worktree)
    {
        var (fixture, origin, workspaces, documents) = await DocumentFixtureAsync();
        var references = Enumerable.Range(0, 512).Select(index => $"reference-{index:D3}/" + new string('x', 1940));
        var shared = "---\ncomponents: [" + string.Join(", ", references) + "]\n---\n# Shared reference metadata\n";
        Assert.True(System.Text.Encoding.UTF8.GetByteCount(shared) < SourceDocumentService.FileLimit);
        for (var index = 0; index < 36; index++)
            await File.WriteAllTextAsync(Path.Combine(origin, "docs", $"bulk-{index:D2}.md"), shared);
        await RunGitAsync(origin, ["add", "."]); await CommitDocsAsync(origin);
        var workspace = worktree ? await workspaces.PrepareAsync(WorkspaceTestOwner(fixture), WorkspaceRequest(), default) : null;
        var entry = Assert.Single((await documents.ListRepositoriesAsync("admin", default)).Repositories);
        var version = worktree ? "worktree" : "target";
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => documents.ListDocumentsAsync(entry.Id, "admin", false, default, version, workspace?.Id));
        Assert.Equal("source_document_size_limit", error.Code);
        Assert.Contains("64 MiB metadata limit", error.Message);
        Assert.InRange(documents.SnapshotStatistics.Bytes, 0, SourceDocumentService.MetadataLimit);
        var focused = await documents.ListDocumentsAsync(entry.Id, "admin", false, default, version, workspace?.Id, PlanPath);
        Assert.Equal(PlanPath, Assert.Single(focused.Documents).Path);
        var oneLarge = await documents.ListDocumentsAsync(entry.Id, "admin", false, default, version, workspace?.Id, "docs/bulk-00.md");
        Assert.Equal(512, Assert.Single(oneLarge.Documents).ReferencePaths!.Length);
        Assert.InRange(documents.SnapshotStatistics.Bytes, 0, SourceDocumentService.MetadataLimit);
    }

    [Fact]
    public async Task SourceSnapshots_PrivateAliasConflictRejectsKnownTargetContent()
    {
        var (fixture, origin, original, _) = await DocumentFixtureAsync();
        var workspace = await original.PrepareAsync(WorkspaceTestOwner(fixture), WorkspaceRequest(), default);
        const string first = "https://github.com/Owner/Repository";
        const string second = "https://github.com/owner/repository.git";
        var (_, access, grant) = await PrivateDocumentAccessAsync(fixture, first, new SnapshotDocumentProvider());
        await fixture.Apps.UpdateAppAsync(SourceTestApp, app => app with { PrivateSources = new(Git: grant), SourceState = app.SourceState! with { Repository = first, LocalOverridePath = null, ManagedCheckoutPath = null } });
        var records = Path.Combine(fixture.Paths.CoreRoot, "development/workspaces");
        await JsonStorage.WriteAsync(Path.Combine(records, workspace.Id + ".json"), workspace with { Repository = first, RepositoryId = DevelopmentWorkspaceService.Hash(first), SourceGrant = grant });
        var otherId = new string('b', 64);
        await JsonStorage.WriteAsync(Path.Combine(records, otherId + ".json"), workspace with { Id = otherId, Repository = second, RepositoryId = DevelopmentWorkspaceService.Hash(second), Path = Path.Combine(Path.GetDirectoryName(workspace.Path)!, otherId), Branch = "hosty/session/" + otherId, SourceGrant = grant });
        var service = new DevelopmentWorkspaceService(fixture.Paths, fixture.Apps, fixture.Clock, privateSources: access);
        var root = service.RepositoryPath(first);
        Directory.CreateDirectory(root); await RunGitAsync(root, ["init", "--bare"]);
        await RunGitAsync(root, ["fetch", origin, "refs/heads/main:refs/hosty/targets/" + DevelopmentWorkspaceService.Hash("main")]);
        var head = (await RunGitAsync(origin, ["rev-parse", "HEAD"])).Trim();
        var documents = new SourceDocumentService(fixture.Apps, service, access);
        var entry = Assert.Single((await documents.ListRepositoriesAsync("admin", default)).Repositories);
        Assert.Equal("unavailable", entry.State);
        Assert.Equal("source_document_unavailable", (await Assert.ThrowsAsync<AppLifecycleException>(() => documents.ReadContentAsync(entry.Id, "admin", new(PlanPath, Commit: head), default))).Code);
        Assert.Equal(0, documents.SnapshotStatistics.BlobProcesses);
    }

    [Fact]
    public async Task SourceSnapshots_PrivateContentRequiresFreshTransportBeforeCachedBytes()
    {
        var (fixture, origin, _, _) = await DocumentFixtureAsync();
        const string repository = "https://127.0.0.1:1/stale-private-snapshot.git";
        var (_, access, grant) = await PrivateDocumentAccessAsync(fixture, repository, new SnapshotDocumentProvider());
        await fixture.Apps.UpdateAppAsync(SourceTestApp, app => app with { PrivateSources = new(Git: grant), SourceState = app.SourceState! with { Repository = repository, LocalOverridePath = null, ManagedCheckoutPath = null } });
        var workspaces = new DevelopmentWorkspaceService(fixture.Paths, fixture.Apps, fixture.Clock, privateSources: access);
        var root = workspaces.RepositoryPath(repository);
        Directory.CreateDirectory(root); await RunGitAsync(root, ["init", "--bare"]);
        await RunGitAsync(root, ["fetch", origin, "refs/heads/main:refs/hosty/targets/" + DevelopmentWorkspaceService.Hash("main")]);
        var head = (await RunGitAsync(origin, ["rev-parse", "HEAD"])).Trim();
        // A prior successful private transport populated this target. Once its TTL expires, an
        // unreachable private remote must refuse reads rather than treating cached bytes as fresh.
        await workspaces.Fetches.FetchAsync(root, repository, "main", true, _ => Task.FromResult(head), default);
        var documents = new SourceDocumentService(fixture.Apps, workspaces, access);
        var entry = Assert.Single((await documents.ListRepositoriesAsync("admin", default)).Repositories);
        var first = await documents.ListDocumentsAsync(entry.Id, "admin", false, default);
        Assert.Equal(PlanText, (await documents.ReadContentAsync(entry.Id, "admin", new(PlanPath, Commit: first.Commit), default)).Content);
        fixture.Clock.UtcNow += SourceRepositoryFetchCoordinator.Interval;
        await Assert.ThrowsAsync<AppLifecycleException>(() => documents.ReadContentAsync(entry.Id, "admin", new(PlanPath, Commit: first.Commit), default));
        Assert.Equal(1, documents.SnapshotStatistics.BlobProcesses);
    }

    [Fact]
    public async Task SourceSnapshots_CachedPrivateSnapshotCannotAuthorizeAnotherUserOrClearedGrant()
    {
        var (fixture, origin, _, _) = await DocumentFixtureAsync();
        const string repository = "https://127.0.0.1:1/snapshot-private.git";
        var (_, access, grant) = await PrivateDocumentAccessAsync(fixture, repository, new SnapshotDocumentProvider());
        await fixture.Apps.UpdateAppAsync(SourceTestApp, app => app with { PrivateSources = new(Git: grant), SourceState = app.SourceState! with { Repository = repository, LocalOverridePath = null, ManagedCheckoutPath = null } });
        var workspaces = new DevelopmentWorkspaceService(fixture.Paths, fixture.Apps, fixture.Clock, privateSources: access);
        var root = workspaces.RepositoryPath(repository);
        Directory.CreateDirectory(root); await RunGitAsync(root, ["init", "--bare"]);
        await RunGitAsync(root, ["fetch", origin, "refs/heads/main:refs/hosty/targets/" + DevelopmentWorkspaceService.Hash("main")]);
        var head = (await RunGitAsync(origin, ["rev-parse", "HEAD"])).Trim();
        await workspaces.Fetches.FetchAsync(root, repository, "main", true, _ => Task.FromResult(head), default);
        var documents = new SourceDocumentService(fixture.Apps, workspaces, access);
        var entry = Assert.Single((await documents.ListRepositoriesAsync("admin", default)).Repositories);
        Assert.Single((await documents.ListDocumentsAsync(entry.Id, "admin", false, default)).Documents);
        Assert.Equal(1, documents.SnapshotStatistics.BlobProcesses);
        Assert.Equal("source_document_forbidden", (await Assert.ThrowsAsync<AppLifecycleException>(() => documents.ReadContentAsync(entry.Id, "bob", new(PlanPath, Commit: head), default))).Code);
        await fixture.Apps.UpdateAppAsync(SourceTestApp, app => app with { PrivateSources = null });
        await Assert.ThrowsAsync<AppLifecycleException>(() => documents.ReadContentAsync(entry.Id, "bob", new(PlanPath, Commit: head), default));
        Assert.Equal(1, documents.SnapshotStatistics.BlobProcesses);
        Assert.False(workspaces.Fetches.HasPublicProof(repository, "main", head));
    }

    private sealed class SnapshotDocumentProvider : ISourceProvider
    {
        private readonly LocalDocumentProvider local = new();
        public SourceProviderDescriptor Descriptor => local.Descriptor;
        public string? ClientId => null;
        public IPublicationProvider? Publication => null;
        public UserConnectionInput Validate(UserConnectionInput input) => input;
        public bool Owns(Uri uri) => uri.Scheme == "https";
        public string NormalizeRepository(string value)
        {
            var uri = new Uri(value);
            if (uri.Host != "github.com") return value.TrimEnd('/');
            var path = uri.AbsolutePath.Trim('/').ToLowerInvariant();
            return "https://github.com/" + (path.EndsWith(".git", StringComparison.Ordinal) ? path : path + ".git");
        }
        public SourceRepositoryFile ParseManifest(string url) => throw new NotSupportedException();
        public HttpRequestMessage FileRequest(UserProviderConnection connection, SourceRepositoryFile file) => throw new NotSupportedException();
        public AuthenticationHeaderValue GitAuthorization(UserProviderConnection connection) => new("Bearer", "fixture");
        public Task<ProviderDevice> StartAsync(UserConnectionInput input, string clientId, CancellationToken ct) => throw new NotSupportedException();
        public Task<(ProviderToken? Token, string? Pending)> PollAsync(string clientId, string deviceCode, CancellationToken ct) => throw new NotSupportedException();
        public Task<ProviderToken> RefreshAsync(UserProviderConnection connection, CancellationToken ct) => throw new NotSupportedException();
        public Task<ProviderIdentity> IdentityAsync(string method, string token, CancellationToken ct) => throw new NotSupportedException();
    }
}
