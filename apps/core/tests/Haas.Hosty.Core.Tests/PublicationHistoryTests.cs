using Haas.Hosty.Core;
using Microsoft.Extensions.Configuration;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task Publication_CorrectiveRetainsObservedSummaryWithoutPrivateReviewBodies()
    {
        var f = await PublicationFixture(); var head = f.W.Observation!.Head!;
        await f.Service.CommandAsync(f.W.Id, f.W.Owner, "publish", new(Guid.NewGuid().ToString(), head, Title: "Feature"), default);
        f.Provider.State = "merged"; f.Provider.Complete = true;
        var corrected = await f.Service.CommandAsync(f.W.Id, f.W.Owner, "corrective", new(Guid.NewGuid().ToString(), head), default);
        var previous = Assert.Single(corrected.History);
        Assert.Equal(42, previous.Number);
        Assert.Equal(head, previous.Head);
        Assert.Equal("merged", previous.Observation!.State);
        Assert.Equal("merge-sha", previous.Observation.MergeCommit);
        Assert.Equal("APPROVED", previous.Observation.ReviewDecision);
        Assert.Equal("SUCCESS", Assert.Single(previous.Observation.Checks!).State);
        Assert.Null(previous.Observation.Reviews);
        Assert.DoesNotContain("private review body", CoreJson.Text(corrected.History));
        var retained = Assert.Single((await f.Service.ListAsync(null, default)).Publications);
        Assert.Equal(CoreJson.Text(previous), CoreJson.Text(Assert.Single(retained.History)));
    }

    [Theory]
    [InlineData("matching")]
    [InlineData("missing")]
    [InlineData("mismatched-head")]
    [InlineData("revoked")]
    [InlineData("different-repository")]
    [InlineData("different-user")]
    public async Task WorkspaceInspection_HistoricalSummaryRequiresExactHeadAndExistingAuthority(string scenario)
    {
        var f = await PublicationFixture();
        f.Provider.RepositoryOverride = "owner/repo";
        var connections = new UserConnectionService(f.Users, new SourceProviderRegistry([new GitHubSourceProvider(new HttpClient(),
            new ConfigurationBuilder().Build(), f.F.Clock, f.Provider)]), f.F.Clock, new AuditStore(f.F.Paths), f.F.CoreSettings);
        var inspection = new WorkspaceInspectionService(f.Workspaces, f.F.Apps, f.F.Clock, f.Service, f.Users, connections);
        var at = DateTimeOffset.Parse("2026-10-20T13:00:00Z");
        var observation = new PublicationObservation(at, "merged", "previous-head", MergeCommit: "previous-merge",
            ReviewDecision: "APPROVED", UnresolvedThreads: 2, Complete: true, Checks: [new("CI", "SUCCESS")],
            Reviews: [new("private-review", "README.md", 1, false, ["Private historical review body"])],
            Title: "Previous contribution", CommentCount: 7, MergedAt: at.AddMinutes(-1));
        var record = Assert.Single((await f.Service.ListAsync(null, default)).Publications) with {
            History = [new(41, "https://github.com/owner/repo/pull/41", scenario == "mismatched-head" ? "other-head" : "previous-head",
                "previous-merge", scenario == "missing" ? null : observation)] };
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development/publications", f.W.Id + ".json"), record);
        if (scenario == "revoked") await f.Users.UpdateAsync(s => s with { ProviderConnections = [] });
        if (scenario == "different-repository") f.Provider.RepositoryOverride = "different/repo";
        if (scenario == "different-user")
        {
            var denied = await Assert.ThrowsAsync<AppLifecycleException>(() => inspection.ReadAsync(f.W.WorkspaceId, f.W.Id, "another-admin", default));
            Assert.Equal("workspace_forbidden", denied.Code);
            return;
        }
        var detail = await inspection.ReadAsync(f.W.WorkspaceId, f.W.Id, "admin", default);
        if (scenario != "different-user")
        {
            var previous = Assert.Single(detail.PullRequests);
            Assert.True(previous.Historical);
            if (scenario == "matching")
            {
                Assert.Equal(at, previous.Observation!.At);
                Assert.Equal(at.AddMinutes(-1), previous.Observation.MergedAt);
                Assert.Equal("Previous contribution", previous.Observation.Title);
                Assert.Equal("merged", previous.Observation.State);
                Assert.Equal(7, previous.Observation.CommentCount);
                Assert.Equal(2, previous.Observation.UnresolvedThreads);
                Assert.Null(previous.Observation.Reviews);
                Assert.Null(previous.Unavailable);
            }
            else { Assert.Null(previous.Observation); Assert.NotEmpty(previous.Unavailable!); }
        }
        Assert.DoesNotContain("Private historical review body", CoreJson.Text(detail));
        Assert.Equal(0, f.Provider.Observed); // Inspection never refreshes history or performs provider writes.
    }
}
