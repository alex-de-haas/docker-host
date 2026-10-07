using System.Text.RegularExpressions;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task SourceDocuments_DefaultBranchAliasPersistsThroughServiceRestart()
    {
        var (fixture, origin, workspaces, documents) = await DocumentFixtureAsync();
        const string repository = "https://example.test/source-default.git";
        var app = (await fixture.Apps.GetAppAsync(SourceTestApp))!;
        var manifest = await File.ReadAllTextAsync(app.ManifestPath!);
        await File.WriteAllTextAsync(app.ManifestPath!, Regex.Replace(manifest, "\"branch\"\\s*:\\s*\"main\"", "\"branch\": null"));
        await fixture.Apps.UpdateAppAsync(SourceTestApp, installed => installed with
        {
            SourceState = installed.SourceState! with { Repository = repository, LocalOverridePath = null, ManagedCheckoutPath = null },
        });
        var provisional = Assert.Single((await documents.ListRepositoriesAsync("admin", default)).Repositories);
        Assert.Equal("", provisional.Branch);
        var root = workspaces.RepositoryPath(repository);
        Directory.CreateDirectory(root);
        await RunGitAsync(root, ["init", "--bare"]);
        await RunGitAsync(root, ["fetch", origin, "refs/heads/main:refs/hosty/targets/" + DevelopmentWorkspaceService.Hash("main")]);
        var head = (await RunGitAsync(origin, ["rev-parse", "HEAD"])).Trim();
        await workspaces.SetDefaultBranchAsync(repository, "main", default);
        await workspaces.Fetches.FetchAsync(root, repository, "main", false, _ => Task.FromResult(head), default, anonymous: true);
        var listed = await documents.ListDocumentsAsync(provisional.Id, "admin", false, default);
        Assert.NotEqual(provisional.Id, listed.RepositoryId);
        var restartedWorkspaces = new DevelopmentWorkspaceService(fixture.Paths, fixture.Apps, fixture.Clock);
        await restartedWorkspaces.Fetches.FetchAsync(root, repository, "main", false, _ => Task.FromResult(head), default, anonymous: true);
        var restart = new SourceDocumentService(fixture.Apps, restartedWorkspaces);
        var canonical = Assert.Single((await restart.ListRepositoriesAsync("admin", default)).Repositories);
        Assert.Equal(listed.RepositoryId, canonical.Id);
        Assert.Equal("main", canonical.Branch);
        Assert.Equal(PlanText, (await restart.ReadContentAsync(provisional.Id, "admin", new(PlanPath, Commit: head), default)).Content);
        Assert.Equal(PlanText, (await restart.ReadContentAsync(canonical.Id, "admin", new(PlanPath, Commit: head), default)).Content);
    }

    [Fact]
    public async Task SourceDocuments_DifferentTrackedBranchesHaveIndependentBaselinesAndIntervals()
    {
        var (fixture, origin, _, documents) = await DocumentFixtureAsync();
        await RunGitAsync(origin, ["checkout", "-b", "other"]);
        await File.WriteAllTextAsync(Path.Combine(origin, PlanPath), "# Other branch\n");
        await CommitDocsAsync(origin);
        await RunGitAsync(origin, ["checkout", "main"]);
        var app = (await fixture.Apps.GetAppAsync(SourceTestApp))!;
        var secondManifest = Path.Combine(fixture.Root, "other-manifest.json");
        await File.WriteAllTextAsync(secondManifest, Regex.Replace(await File.ReadAllTextAsync(app.ManifestPath!),
            "\"branch\"\\s*:\\s*\"main\"", "\"branch\": \"other\""));
        await fixture.Apps.UpsertAppAsync(app with { Id = "example.other-branch", ManifestPath = secondManifest });
        var entries = (await documents.ListRepositoriesAsync("admin", default)).Repositories;
        Assert.Equal(2, entries.Length);
        var main = Assert.Single(entries, e => e.Branch == "main");
        var other = Assert.Single(entries, e => e.Branch == "other");
        var mainDocs = await documents.ListDocumentsAsync(main.Id, "admin", false, default);
        var otherDocs = await documents.ListDocumentsAsync(other.Id, "admin", false, default);
        Assert.NotEqual(mainDocs.Commit, otherDocs.Commit);
        Assert.Equal(PlanText, (await documents.ReadContentAsync(main.Id, "admin", new(PlanPath, Commit: mainDocs.Commit), default)).Content);
        Assert.Equal("# Other branch\n", (await documents.ReadContentAsync(other.Id, "admin", new(PlanPath, Commit: otherDocs.Commit), default)).Content);
    }

    [Fact]
    public async Task SourceDocuments_ReadAndWorkspaceRefreshShareFetchWhileObserverRemainsIndependent()
    {
        var (fixture, _, workspaces, documents) = await DocumentFixtureAsync();
        var first = await workspaces.PrepareAsync(WorkspaceTestOwner(fixture), WorkspaceRequest(), default);
        var other = await workspaces.PrepareAsync(WorkspaceTestOwner(fixture, "other-session"), WorkspaceRequest("other-session"), default);
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var finish = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var count = 0;
        async Task<string> Fetch(CancellationToken ct) { Interlocked.Increment(ref count); started.SetResult(); return await finish.Task.WaitAsync(ct); }
        var inflight = workspaces.Fetches.FetchAsync(workspaces.RepositoryPath(first.Repository), first.Repository, "main", true, Fetch, default, anonymous: true);
        await started.Task;
        var entry = Assert.Single((await documents.ListRepositoriesAsync("admin", default)).Repositories);
        var read = documents.ListDocumentsAsync(entry.Id, "admin", false, default);
        var refresh = workspaces.CommandAsync(first.Id, first.Owner, "refresh", new(Guid.NewGuid().ToString()), default);
        await workspaces.ObserveAvailableAsync(other.Id, default).WaitAsync(TimeSpan.FromSeconds(5));
        Assert.False(read.IsCompleted);
        Assert.Equal("ok", (await workspaces.Read(other.Id, null, default)).Observation!.State);
        finish.SetResult(first.OriginalBase);
        Assert.Equal(first.OriginalBase, await inflight);
        Assert.Equal(first.OriginalBase, (await read).Commit);
        Assert.Equal("succeeded", (await refresh).Operations.Last().State);
        Assert.Equal(1, count);
    }
}
