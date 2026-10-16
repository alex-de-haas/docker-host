using Haas.Hosty.Core;
using Microsoft.Extensions.Configuration;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static async Task<(LifecycleFixture F, DevelopmentWorkspaceService Workspaces, PublicationService Service,
        PublicationProviderFixture Provider, DevelopmentWorkspace W, UserDirectoryStore Users)> ExternalPublicationFixture()
    {
        var (f, _) = await SourceFixtureAsync();
        var owner = WorkspaceOwner.ForExternal("admin", "oauth:external", "external-pr", "Codex");
        var workspaces = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var w = await workspaces.PrepareAsync(owner, WorkspaceRequest("external-pr") with { SessionPath = null, LeaseId = Guid.NewGuid().ToString() }, default);
        const string repository = "https://github.com/owner/repo.git";
        w = w with { Repository = repository, RepositoryId = DevelopmentWorkspaceService.Hash(repository),
            PullRequests = ["https://github.com/owner/repo/pull/42"] };
        await JsonStorage.WriteAsync(Path.Combine(f.Paths.CoreRoot, "development/workspaces", w.Id + ".json"), w);
        var users = new UserDirectoryStore(f.Paths);
        await users.WriteAsync(new(1, [new(owner.UserId, "admin@example.test", "Admin", "host.admin", false, f.Clock.UtcNow, f.Clock.UtcNow)], [], [], [],
            ProviderConnections: [new("connection", owner.UserId, "GitHub", "github", "", "", "42", "owner", "pat", "fixture-secret", null, null, null, f.Clock.UtcNow, null, "connected", "r1")]));
        var provider = new PublicationProviderFixture { Head = w.Observation!.Head! };
        var connections = new UserConnectionService(users, new SourceProviderRegistry([new GitHubSourceProvider(new HttpClient(), new ConfigurationBuilder().Build(), f.Clock, provider)]), f.Clock, new AuditStore(f.Paths), f.CoreSettings);
        return (f, workspaces, new(f.Paths, workspaces, connections, f.Apps, users, f.Clock, new(f.Paths)), provider, w, users);
    }

    [Fact]
    public async Task ExternalPublication_MergedEvidenceAcceptsCanonicalUrlCasingWithoutAcceptingOtherRepositories()
    {
        var f = await ExternalPublicationFixture();
        var w = f.W with { PullRequests = ["https://GITHUB.COM/OWNER/REPO/pull/42"] };
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development/workspaces", w.Id + ".json"), w);
        f.Provider.State = "merged"; f.Provider.Complete = true;
        var heads = await f.Service.MergedWorkspaceHeadsAsync(w.Owner, default);
        Assert.Equal(w.Observation!.Head, heads[w.Id]);
        w = w with { PullRequests = ["https://github.com/another/repo/pull/42"] };
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development/workspaces", w.Id + ".json"), w);
        Assert.Empty(await f.Service.MergedWorkspaceHeadsAsync(w.Owner, default));
    }

    [Fact]
    public async Task ExternalPublication_RefreshesPersistsAndTracksRemoteHeadWithoutMutations()
    {
        var f = await ExternalPublicationFixture();
        Assert.Null(Assert.Single(await f.Service.ReadExternalReferencesAsync(f.W, "admin", default)).Observation);
        await f.Service.RefreshExternalReferencesAsync(default);
        var result = Assert.Single(await f.Service.ReadExternalReferencesAsync(f.W, "admin", default));
        Assert.Equal("open", result.Observation!.State);
        Assert.Equal("APPROVED", result.Observation.ReviewDecision);
        Assert.Equal("SUCCESS", Assert.Single(result.Observation.Checks!).State);
        Assert.Null(result.Observation.Reviews);
        Assert.Equal(f.Provider.Head, result.PublishedHead);
        var snapshot = await JsonStorage.ReadAsync<ExternalPublicationSnapshot>(Path.Combine(f.F.Paths.CoreRoot, "development/publications/external", f.W.Id + ".json"));
        Assert.Equal(CoreJson.Text(result), CoreJson.Text(Assert.Single(snapshot!.PullRequests)));
        Assert.DoesNotContain("fixture-secret", CoreJson.Text(snapshot));
        Assert.DoesNotContain("private review body", CoreJson.Text(snapshot));
        f.Provider.Head = "new-remote-head";
        f.Provider.State = "merged";
        await f.Service.RefreshExternalReferencesAsync(default);
        result = Assert.Single(await f.Service.ReadExternalReferencesAsync(f.W, "admin", default));
        Assert.Equal("new-remote-head", result.PublishedHead);
        Assert.Equal("merged", result.Observation!.State);
        Assert.Equal(f.W.Observation!.Head, (await f.Workspaces.Read(f.W.Id, f.W.Owner, default)).Observation!.Head);
        Assert.Empty((await f.Service.ListAsync(null, default)).Publications);
        Assert.Equal(0, f.Provider.Created); Assert.Equal(0, f.Provider.Merged);
        await Assert.ThrowsAsync<PublicationException>(() => f.Service.CommandAsync(f.W.Id, f.W.Owner, "merge", new(Guid.NewGuid().ToString()), default));
    }

    [Theory]
    [InlineData("disconnect")]
    [InlineData("disabled")]
    [InlineData("expired")]
    [InlineData("ambiguous")]
    [InlineData("unavailable")]
    public async Task ExternalPublication_ConnectionOrOwnerLossHidesCachedFacts(string reason)
    {
        var f = await ExternalPublicationFixture();
        await f.Service.RefreshExternalReferencesAsync(default);
        await f.Users.UpdateAsync(s => reason switch {
            "disconnect" => s with { ProviderConnections = [] },
            "disabled" => s with { Users = s.Users.Select(u => u with { Disabled = true }).ToArray() },
            "expired" => s with { ProviderConnections = s.ProviderConnections!.Select(c => c with { ExpiresAt = f.F.Clock.UtcNow.AddMinutes(-1) }).ToArray() },
            "ambiguous" => s with { ProviderConnections = [s.ProviderConnections![0], s.ProviderConnections[0] with { Id = "second" }] },
            _ => s with { ProviderConnections = s.ProviderConnections!.Select(c => c with { Status = "reconnect-required" }).ToArray() }
        });
        Assert.Null(Assert.Single(await f.Service.ReadExternalReferencesAsync(f.W, "admin", default)).Observation);
        Assert.Null(Assert.Single(await f.Service.ReadExternalReferencesAsync(f.W, "another-admin", default)).Observation);
        await f.Service.RefreshExternalReferencesAsync(default);
        Assert.Equal(1, f.Provider.Observed);
    }

    [Fact]
    public async Task ExternalPublication_MultipleReferencesRejectForeignUrlsAndIsolateProviderFailures()
    {
        var f = await ExternalPublicationFixture();
        var w = f.W with { PullRequests = [.. f.W.PullRequests, "https://github.com/owner/repo/pull/43", "https://github.com/foreign/repo/pull/44", "https://evil.test/owner/repo/pull/45", "https://github.com/owner/repo/pull/46?query=1"] };
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development/workspaces", w.Id + ".json"), w);
        f.Provider.FailedNumber = 43;
        await f.Service.RefreshExternalReferencesAsync(default);
        var results = await f.Service.ReadExternalReferencesAsync(w, "admin", default);
        Assert.Equal(5, results.Length);
        Assert.Single(results, p => p.Observation is not null);
        Assert.Equal(2, f.Provider.Observed);
        Assert.All(results.Skip(1), p => Assert.NotNull(p.Unavailable));
        f.Provider.FailedNumber = 42;
        await f.Service.RefreshExternalReferencesAsync(default);
        results = await f.Service.ReadExternalReferencesAsync(w, "admin", default);
        Assert.Null(results[0].Observation);
        Assert.NotNull(results[1].Observation);
    }
    [Fact]
    public async Task ExternalPublication_BoundsEachBatchAndRotatesWithoutDroppingPreviousObservations()
    {
        var f = await ExternalPublicationFixture();
        var w = f.W with { PullRequests = Enumerable.Range(1, 25).Select(n => $"https://github.com/owner/repo/pull/{n}").ToArray() };
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development/workspaces", w.Id + ".json"), w);
        await f.Service.RefreshExternalReferencesAsync(default);
        Assert.Equal(10, f.Provider.Observed);
        Assert.Equal(10, (await f.Service.ReadExternalReferencesAsync(w, "admin", default)).Count(p => p.Observation is not null));
        await f.Service.RefreshExternalReferencesAsync(default);
        Assert.Equal(20, f.Provider.ObservedNumbers.Distinct().Count());
        Assert.Equal(20, (await f.Service.ReadExternalReferencesAsync(w, "admin", default)).Count(p => p.Observation is not null));
        await f.Service.RefreshExternalReferencesAsync(default);
        Assert.Equal(30, f.Provider.Observed); Assert.Equal(25, f.Provider.ObservedNumbers.Distinct().Count());
        Assert.All(await f.Service.ReadExternalReferencesAsync(w, "admin", default), p => Assert.NotNull(p.Observation));
    }

    [Fact]
    public async Task ExternalPublication_OverallDeadlineCancelsSlowProviderAndNextCycleAdvances()
    {
        var f = await ExternalPublicationFixture();
        var w = f.W with { PullRequests = ["https://github.com/owner/repo/pull/1", "https://github.com/owner/repo/pull/2"] };
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development/workspaces", w.Id + ".json"), w);
        f.Provider.DelayedNumber = 1; f.Provider.ObservationDelay = Timeout.InfiniteTimeSpan;
        await f.Service.RefreshExternalReferencesAsync(default, TimeSpan.FromMilliseconds(250)).WaitAsync(TimeSpan.FromSeconds(3));
        Assert.Equal([1], f.Provider.ObservedNumbers);
        var first = (await f.Service.ReadExternalReferencesAsync(w, "admin", default))[0];
        Assert.Null(first.Observation); Assert.Contains("timed out", first.Unavailable);
        await f.Service.RefreshExternalReferencesAsync(default, TimeSpan.FromMilliseconds(250)).WaitAsync(TimeSpan.FromSeconds(3));
        Assert.Equal(2, f.Provider.ObservedNumbers[1]);
        Assert.NotNull((await f.Service.ReadExternalReferencesAsync(w, "admin", default))[1].Observation);
        using var canceled = new CancellationTokenSource(); canceled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => f.Service.RefreshExternalReferencesAsync(canceled.Token));
    }

}
