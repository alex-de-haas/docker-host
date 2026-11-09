using Haas.Hosty.Core;
using Microsoft.Extensions.Configuration;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static async Task<(LifecycleFixture F, DevelopmentWorkspaceService Workspaces, PublicationService Publications,
        PublicationProviderFixture Provider, DevelopmentWorkspace W, RemoteGitFixture Git,
        UserDirectoryStore Users, UserConnectionService Connections)> ExternalLocalPublicationFixture()
    {
        var f = await LocalRemoteFixture();
        var owner = WorkspaceOwner.ForExternal(f.W.Owner.UserId, "oauth:external", "external-local-pr", "Codex");
        var w = await f.Service.PrepareAsync(owner,
            new(Guid.NewGuid().ToString(), owner.SessionId, "test.created", null, LeaseId: Guid.NewGuid().ToString()), default);
        var users = new UserDirectoryStore(f.F.Paths);
        var selected = new UserProviderConnection("connection", owner.UserId, "Reviewed GitHub", "github", "", "", "42", "owner",
            "pat", "fixture-secret", null, null, null, f.F.Clock.UtcNow, null, "connected", "r1");
        await users.WriteAsync(new(1,
            [new(owner.UserId, "admin@example.test", "Admin", "host.admin", false, f.F.Clock.UtcNow, f.F.Clock.UtcNow)], [], [], [],
            // A second account makes accidental account inference or fallback observable.
            ProviderConnections: [selected with { Id = "unused-connection", Label = "Other GitHub", AccountId = "43" }, selected]));
        var provider = new PublicationProviderFixture { Head = w.OriginalBase };
        provider.BeforeObserve = (record, _) =>
        {
            Assert.Equal("owner/repo", record.Repository);
            Assert.Equal("owner/repo", record.HeadRepository);
            Assert.Equal("connection", record.ConnectionId);
            Assert.Equal("qa/base", record.TargetBranch);
            return Task.CompletedTask;
        };
        var connections = new UserConnectionService(users,
            new SourceProviderRegistry([new GitHubSourceProvider(new HttpClient(), new ConfigurationBuilder().Build(), f.F.Clock, provider)]),
            f.F.Clock, new AuditStore(f.F.Paths), f.F.CoreSettings);
        f.Git.Connections = connections;
        await f.Service.RemoteCommandAsync(w.Id, owner, "connect", RemoteRequest(), default);
        w = await f.Service.CommandAsync(w.Id, owner, "references",
            new(Guid.NewGuid().ToString(), PullRequests: ["https://github.com/owner/repo/pull/42"]), default);
        Assert.Equal("main", w.TargetBranch);
        Assert.EndsWith(Path.DirectorySeparatorChar + ".git", w.Repository);
        var publications = new PublicationService(f.F.Paths, f.Service, connections, f.F.Apps, users, f.F.Clock, new(f.F.Paths));
        return (f.F, f.Service, publications, provider, w, f.Git, users, connections);
    }

    [Fact]
    public async Task ExternalLocalPublication_CachedCanonicalInspectionUsesReviewedRemoteWithoutProviderOrOnlineValidation()
    {
        var f = await ExternalLocalPublicationFixture();
        var observation = new PublicationObservation(f.F.Clock.UtcNow, "open", f.Provider.Head,
            Base: "qa/base", Checks: [new("ci-required", "SUCCESS")],
            Reviews: [new("private-thread", "README.md", 1, false, ["private review body"])]);
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development/publications", f.W.Id + ".json"),
            ExternalDisplayRecord(f.W, observation) with { TargetBranch = "qa/base" });
        f.Git.BeforeValidate = () => throw new InvalidOperationException("Cached inspection must validate the grant locally.");
        f.Provider.BeforeObserve = (_, _) => throw new InvalidOperationException("Cached inspection must not call the provider.");
        var inspection = new WorkspaceInspectionService(f.Workspaces, f.F.Apps, f.F.Clock, f.Publications, f.Users, f.Connections);

        var detail = await inspection.ReadAsync(f.W.WorkspaceId, f.W.Id, f.W.Owner.UserId, default);
        var shown = Assert.Single(detail.PullRequests);
        Assert.Equal("open", shown.Observation!.State);
        Assert.Equal(f.W.OriginalBase, shown.PublishedHead);
        Assert.Equal("SUCCESS", Assert.Single(shown.Observation.Checks!).State);
        Assert.Null(shown.Observation.Reviews);
        Assert.Null(shown.Unavailable);
        var row = Assert.Single((await inspection.ListAsync(f.W.Owner.UserId, default)).Workspaces,
            workspace => workspace.Id == f.W.WorkspaceId);
        Assert.Equal("open", row.PullRequestSummary!.State);
        Assert.Equal("passed", row.PullRequestSummary.Checks);
        Assert.False(row.PullRequestSummary.Partial);
        Assert.Equal(0, f.Provider.Observed);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ExternalLocalPublication_BackgroundAndCompactFallbackObserveReviewedRemoteAndTarget(bool compact)
    {
        var f = await ExternalLocalPublicationFixture();
        if (compact)
        {
            var job = Assert.Single(await f.Publications.BackgroundObservationJobsAsync(default));
            await job.Run(default);
        }
        else await f.Publications.RefreshExternalReferencesAsync(default);

        var result = Assert.Single(await f.Publications.ReadExternalReferencesAsync(f.W, f.W.Owner.UserId, default));
        Assert.Equal("open", result.Observation!.State);
        Assert.Equal(f.Provider.Head, result.PublishedHead);
        Assert.Equal("SUCCESS", Assert.Single(result.Observation.Checks!).State);
        Assert.Null(result.Observation.Reviews);
        Assert.Null(result.Unavailable);
        Assert.Equal(1, f.Provider.Observed);
        Assert.Equal(0, f.Provider.Created);
        Assert.Equal(0, f.Provider.Pushed);
        Assert.Equal(0, f.Provider.Merged);
        Assert.Empty((await f.Publications.ListAsync(null, default)).Publications);
        Assert.Equal("main", (await f.Workspaces.Read(f.W.Id, f.W.Owner, default)).TargetBranch);
        var snapshot = (await JsonStorage.ReadAsync<ExternalPublicationSnapshot>(ExternalDisplayPath(f.F.Paths.CoreRoot, f.W)))!;
        Assert.Equal("owner/repo", snapshot.Repository);
        Assert.Equal("connection", snapshot.ConnectionId);
        Assert.DoesNotContain("fixture-secret", CoreJson.Text(snapshot));
        Assert.DoesNotContain("private review body", CoreJson.Text(snapshot));
    }

    [Theory]
    [InlineData("revoked-grant")]
    [InlineData("removed-connection")]
    [InlineData("changed-connection")]
    [InlineData("changed-target")]
    [InlineData("changed-repository")]
    public async Task ExternalLocalPublication_ChangedOrRevokedReviewedBindingHidesCanonicalAndSnapshotEvidence(string change)
    {
        var f = await ExternalLocalPublicationFixture();
        await f.Publications.RefreshExternalReferencesAsync(default);
        var retained = Assert.Single(await f.Publications.ReadExternalReferencesAsync(f.W, f.W.Owner.UserId, default));
        Assert.Equal("open", retained.Observation!.State);
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development/publications", f.W.Id + ".json"),
            ExternalDisplayRecord(f.W, retained.Observation) with { TargetBranch = "qa/base" });
        f.Git.BeforeValidate = () => throw new InvalidOperationException("Cached inspection must validate the grant locally.");
        if (change == "revoked-grant") f.Git.Revoked = true;
        else if (change == "removed-connection")
            await f.Users.UpdateAsync(state => state with
                { ProviderConnections = state.ProviderConnections!.Where(connection => connection.Id != "connection").ToArray() });
        else
            await f.F.Apps.UpdateAppAsync("test.created", app =>
            {
                var remote = app.SourceState!.Remote!;
                remote = change switch
                {
                    "changed-connection" => remote with { Grant = remote.Grant with { ConnectionId = "unused-connection" } },
                    "changed-target" => remote with { TargetBranch = "qa/another" },
                    "changed-repository" => remote with { Repository = "https://github.com/another/repo.git",
                        Grant = remote.Grant with { Repository = "https://github.com/another/repo.git" } },
                    _ => throw new InvalidOperationException(change)
                };
                return app with { SourceState = app.SourceState with { Remote = remote } };
            });

        var result = Assert.Single(await f.Publications.ReadExternalReferencesAsync(f.W, f.W.Owner.UserId, default));
        Assert.Null(result.Observation);
        Assert.Null(result.PublishedHead);
        Assert.NotNull(result.Unavailable);
        Assert.Equal(1, f.Provider.Observed);
    }

    [Fact]
    public async Task ExternalLocalPublication_ReviewBindingUsesHeldReviewedConnectionWithoutNestedOnlineValidation()
    {
        var f = await ExternalLocalPublicationFixture();
        f.Git.BeforeValidate = () => throw new InvalidOperationException("Held connection must not trigger another source connection acquisition.");
        var workspaces = new DevelopmentWorkspaceService(f.F.Paths, f.F.Apps, f.F.Clock,
            privateSources: new PrivateSourceService(f.Connections, new HttpClient()));
        var publications = new PublicationService(f.F.Paths, workspaces, f.Connections, f.F.Apps, f.Users, f.F.Clock, new(f.F.Paths));
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var binding = await f.Connections.UseForSourceAsync(f.W.Owner.UserId, "connection",
            connection => publications.RequireReviewBindingAsync(f.W, f.W.Owner.UserId, f.W.PullRequests[0], deadline.Token,
                heldConnection: connection), deadline.Token);
        Assert.Equal("owner/repo", binding.Record.Repository);
        Assert.Equal("qa/base", binding.Record.TargetBranch);
        Assert.Equal("connection", binding.Connection.Id);
        Assert.Equal("connection", binding.Record.ConnectionId);
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Connections.UseForSourceAsync(f.W.Owner.UserId, "unused-connection",
            connection => publications.RequireReviewBindingAsync(f.W, f.W.Owner.UserId, f.W.PullRequests[0], deadline.Token,
                heldConnection: connection), deadline.Token));
        Assert.Equal(0, f.Provider.Observed);
    }
}
