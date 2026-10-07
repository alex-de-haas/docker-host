using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task SourceFetches_AnonymousRequestsCannotUsePrivateFetchCacheOrInflightProof()
    {
        var clock = new FakeClock(DateTimeOffset.UtcNow);
        var coordinator = new SourceRepositoryFetchCoordinator(clock);
        var root = Path.Combine(Path.GetTempPath(), "hosty-public-proof-" + Guid.NewGuid().ToString("N"));
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var finish = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        var anonymousCalls = 0;
        async Task<string> Private(CancellationToken ct) { started.SetResult(); return await finish.Task.WaitAsync(ct); }
        Task<string> Public(CancellationToken ct) { Interlocked.Increment(ref anonymousCalls); return Task.FromResult("public-head"); }
        var privateRead = coordinator.FetchAsync(root, "repository", "main", false, Private, default);
        await started.Task;
        var publicRead = coordinator.FetchAsync(root, "repository", "main", false, Public, default, anonymous: true);
        Assert.False(publicRead.IsCompleted);
        Assert.Equal(0, anonymousCalls);
        finish.SetResult("private-head");
        Assert.Equal("private-head", await privateRead);
        Assert.Equal("public-head", await publicRead);
        Assert.Equal(1, anonymousCalls);
        Assert.True(coordinator.HasPublicProof("repository", "main", "public-head"));
        await coordinator.FetchAsync(root, "repository", "main", true, _ => Task.FromResult("secret-head"), default);
        Assert.False(coordinator.HasPublicProof("repository", "main", "public-head"));
        await Assert.ThrowsAsync<AppLifecycleException>(() => coordinator.FetchAsync(root, "repository", "main", false,
            _ => throw new AppLifecycleException("fixture_anonymous_denied", "Anonymous fetch refused."), default, anonymous: true));
        Assert.False(coordinator.HasPublicProof("repository", "main", "secret-head"));
    }

    [Fact]
    public async Task SourceDocuments_ClearedGrantNeverServesFormerPrivateBaselineWithoutAnonymousAccess()
    {
        var (fixture, origin, workspaces, documents) = await DocumentFixtureAsync();
        const string repository = "https://127.0.0.1:1/private-source.git";
        await fixture.Apps.UpdateAppAsync(SourceTestApp, app => app with
        {
            SourceState = app.SourceState! with { Repository = repository, LocalOverridePath = null, ManagedCheckoutPath = null },
            PrivateSources = null,
        });
        var root = workspaces.RepositoryPath(repository);
        Directory.CreateDirectory(root);
        await RunGitAsync(root, ["init", "--bare"]);
        await RunGitAsync(root, ["fetch", origin, "refs/heads/main:refs/hosty/targets/" + DevelopmentWorkspaceService.Hash("main")]);
        var head = (await RunGitAsync(origin, ["rev-parse", "HEAD"])).Trim();
        // Simulate the successful authenticated transport that populated the shared target before
        // the app's reviewed grant was cleared. No remote is started for this fixture.
        await workspaces.Fetches.FetchAsync(root, repository, "main", true, _ => Task.FromResult(head), default);
        var entry = Assert.Single((await documents.ListRepositoriesAsync("bob", default)).Repositories);
        Assert.False(workspaces.Fetches.HasPublicProof(repository, "main", head));
        await Assert.ThrowsAsync<AppLifecycleException>(() => documents.ListDocumentsAsync(entry.Id, "bob", false, default));
        await Assert.ThrowsAsync<AppLifecycleException>(() => documents.ReadContentAsync(entry.Id, "bob", new(PlanPath, Commit: head), default));
        Assert.False(workspaces.Fetches.HasPublicProof(repository, "main", head));
    }
}
