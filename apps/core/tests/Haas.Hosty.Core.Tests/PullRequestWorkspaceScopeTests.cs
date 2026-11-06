namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task Publication_ObservationScopeCountsExplicitAndWorkspaceReferencesTogether()
    {
        var f = await PublicationFixture();
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development/workspaces", f.W.Id + ".json"),
            f.W with { PullRequests = Enumerable.Range(1, 101).Select(number => $"https://github.com/owner/repo/pull/{number}").ToArray() });
        var actor = new PullRequestActor(f.W.Owner.UserId);
        await f.Service.ValidateObservationScopesAsync(actor, [f.W.WorkspaceId, f.W.WorkspaceId], default, 99);
        var error = await Assert.ThrowsAsync<PullRequestException>(() =>
            f.Service.ValidateObservationScopesAsync(actor, [f.W.WorkspaceId], default, 100));
        Assert.Equal("pr_scope_limit", error.Code);
        Assert.Equal(0, f.Provider.Observed);
    }
    [Theory]
    [InlineData("owner/repo", "main", true)]
    [InlineData("foreign/fork", "main", false)]
    [InlineData("owner/repo", "other-target", false)]
    public void Publication_CompactWorkspaceFactsPreserveReferenceRepositoryAndTargetGuards(string repository, string target, bool allowed)
    {
        var summary = new PullRequestSummary("repo-id", 42, "pr-id", "Another task", "https://github.com/owner/repo/pull/42",
            "author", false, false, "open", DateTimeOffset.UnixEpoch, "head", "base", "different-task", target,
            "APPROVED", "CLEAN", 0, new([], 0, "complete"), new("revision"), repository);
        if (allowed)
        {
            var observation = PublicationService.DisplayReferenceObservation(summary, "owner/repo", "main");
            Assert.Equal("head", observation.Head);
            Assert.False(observation.Complete);
            Assert.Null(observation.Reviews);
        }
        else Assert.Equal("publication_pr_mismatch", Assert.Throws<PublicationException>(() =>
            PublicationService.DisplayReferenceObservation(summary, "owner/repo", "main")).Code);
    }
}
