using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private const string EvidencePullRequest = "https://github.com/owner/repo/pull/42";

    private static async Task<(WorkspaceInspectionService Inspection, DevelopmentWorkspaceService Workspaces,
        DevelopmentWorkspace W, PublicationProviderFixture Provider, PublicationReviewSnapshot Snapshot,
        UserDirectoryStore Users)> UnpublishedEvidenceFixtureAsync()
    {
        var f = await PublicationFixture();
        f.Provider.RepositoryOverride = "owner/repo";
        await File.WriteAllTextAsync(Path.Combine(f.W.Path, "README.md"), "source\npublished\nstable\n");
        await RunGitAsync(f.W.Path, ["add", "README.md"]);
        await RunGitAsync(f.W.Path, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "Published change"]);
        var head = (await RunGitAsync(f.W.Path, ["rev-parse", "HEAD"])).Trim();
        var record = Assert.Single((await f.Service.ListAsync(null, default)).Publications) with
            { Url = EvidencePullRequest, Number = 42, PublishedHead = head };
        await JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development/publications", f.W.Id + ".json"), record);
        var observation = new PublicationObservation(f.F.Clock.UtcNow, "open", head, "main", BaseHead: f.W.OriginalBase);
        var snapshot = new PublicationReviewSnapshot(EvidencePullRequest, "owner/repo", "main", f.W.OriginalBase,
            f.W.OriginalBase, head, observation, [new("README.md", "modified", null,
                "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,3 @@\n source\n+published\n+stable\n", 2, 0)]);
        f.Provider.ReviewSnapshot = (_, _) => Task.FromResult(snapshot);
        return (new(f.Workspaces, f.F.Apps, f.F.Clock, f.Service), f.Workspaces, f.W, f.Provider, snapshot, f.Users);
    }

    [Theory]
    [InlineData("local")]
    [InlineData("session")]
    [InlineData("target")]
    public async Task WorkspaceReview_UnpublishedEvidenceUsesExplicitPrHeadAndWorkingRightLinesWithoutChangingIndex(string scope)
    {
        var f = await UnpublishedEvidenceFixtureAsync();
        await File.WriteAllTextAsync(Path.Combine(f.W.Path, "README.md"), "source\npublished\ncommitted\nstable\n");
        await RunGitAsync(f.W.Path, ["add", "README.md"]);
        await RunGitAsync(f.W.Path, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "Unpublished commit"]);
        await File.WriteAllTextAsync(Path.Combine(f.W.Path, "README.md"), "source\npublished\ncommitted\nstaged\nstable\n");
        await RunGitAsync(f.W.Path, ["add", "README.md"]);
        await File.WriteAllTextAsync(Path.Combine(f.W.Path, "README.md"), "source\npublished\ncommitted\nstaged\nlocal\nstable\n");
        await File.WriteAllTextAsync(Path.Combine(f.W.Path, "new.txt"), "brand\nnew\n");
        var beforeStatus = await RunGitAsync(f.W.Path, ["status", "--porcelain=v1"]);
        var index = (await RunGitAsync(f.W.Path, ["rev-parse", "--git-path", "index"])).Trim();
        var indexPath = Path.IsPathRooted(index) ? index : Path.Combine(f.W.Path, index);
        var beforeIndex = await File.ReadAllBytesAsync(indexPath);
        var beforeRefs = await RunGitAsync(f.W.Path, ["show-ref"]);
        var plain = await f.Inspection.ReviewAsync(f.W.WorkspaceId, f.W.Id, "admin", scope, null, default);
        Assert.Null(plain.Source.PublishedComparisonUrl);
        var review = await f.Inspection.ReviewAsync(f.W.WorkspaceId, f.W.Id, "admin", scope, EvidencePullRequest, default);
        Assert.NotEqual(plain.Source.Revision, review.Source.Revision);
        Assert.False(review.Source.Published);
        Assert.Null(review.Source.PullRequestUrl);
        Assert.Equal(EvidencePullRequest, review.Source.PublishedComparisonUrl);
        Assert.Equal(f.Snapshot.Head, review.Source.PublishedComparisonHead);
        var diff = await f.Inspection.ReviewDiffAsync(f.W.WorkspaceId, f.W.Id, "admin", scope, EvidencePullRequest,
            "README.md", review.Source.Revision, default);
        var evidence = Assert.IsType<WorkspaceReviewPublishedEvidence>(diff.PublishedEvidence);
        Assert.True(evidence.Complete, evidence.Unavailable);
        Assert.Equal(new WorkspaceReviewLineRange(3, 5), Assert.Single(evidence.UnpublishedRanges));
        var newFile = await f.Inspection.ReviewDiffAsync(f.W.WorkspaceId, f.W.Id, "admin", scope, EvidencePullRequest,
            "new.txt", review.Source.Revision, default);
        Assert.True(newFile.PublishedEvidence!.Complete, newFile.PublishedEvidence.Unavailable);
        Assert.Equal(new WorkspaceReviewLineRange(1, 2), Assert.Single(newFile.PublishedEvidence.UnpublishedRanges));
        var withoutComparison = await f.Inspection.ReviewDiffAsync(f.W.WorkspaceId, f.W.Id, "admin", scope, null,
            "README.md", plain.Source.Revision, default);
        Assert.Null(withoutComparison.PublishedEvidence);
        Assert.Equal(beforeStatus, await RunGitAsync(f.W.Path, ["status", "--porcelain=v1"]));
        Assert.Equal(beforeIndex, await File.ReadAllBytesAsync(indexPath));
        Assert.Equal(beforeRefs, await RunGitAsync(f.W.Path, ["show-ref"]));
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("binary")]
    [InlineData("bounded")]
    public async Task WorkspaceReview_UnavailableComparisonNeverInventsUnpublishedMarkers(string reason)
    {
        var f = await UnpublishedEvidenceFixtureAsync();
        await File.WriteAllTextAsync(Path.Combine(f.W.Path, "README.md"), reason == "binary" ? "binary\0content" : "changed\n");
        var snapshot = reason == "missing" ? f.Snapshot with
            { Head = new string('f', 40), Observation = f.Snapshot.Observation with { Head = new string('f', 40) } }
            : reason == "bounded" ? f.Snapshot with { Truncated = true } : f.Snapshot;
        f.Provider.ReviewSnapshot = (_, _) => Task.FromResult(snapshot);
        var review = await f.Inspection.ReviewAsync(f.W.WorkspaceId, f.W.Id, "admin", "session", EvidencePullRequest, default);
        var diff = await f.Inspection.ReviewDiffAsync(f.W.WorkspaceId, f.W.Id, "admin", "session", EvidencePullRequest,
            "README.md", review.Source.Revision, default);
        Assert.False(diff.PublishedEvidence!.Complete);
        Assert.Empty(diff.PublishedEvidence.UnpublishedRanges);
        Assert.False(string.IsNullOrWhiteSpace(diff.PublishedEvidence.Unavailable));
    }

    [Fact]
    public async Task WorkspaceReview_UnpublishedComparisonRejectsUnboundPrStaleHeadAndRevokedConnection()
    {
        var f = await UnpublishedEvidenceFixtureAsync();
        await File.WriteAllTextAsync(Path.Combine(f.W.Path, "README.md"), "changed\n");
        await Assert.ThrowsAsync<PublicationException>(() => f.Inspection.ReviewAsync(f.W.WorkspaceId, f.W.Id,
            "admin", "session", "https://github.com/owner/repo/pull/99", default));
        var review = await f.Inspection.ReviewAsync(f.W.WorkspaceId, f.W.Id, "admin", "session", EvidencePullRequest, default);
        var changed = f.Snapshot with { Head = new string('e', 40), Observation = f.Snapshot.Observation with { Head = new string('e', 40) } };
        f.Provider.ReviewSnapshot = (_, _) => Task.FromResult(changed);
        var stale = await Assert.ThrowsAsync<AppLifecycleException>(() => f.Inspection.ReviewDiffAsync(f.W.WorkspaceId,
            f.W.Id, "admin", "session", EvidencePullRequest, "README.md", review.Source.Revision, default));
        Assert.Equal("workspace_review_stale", stale.Code);
        var reads = 0;
        f.Provider.ReviewSnapshot = (_, _) => Task.FromResult(++reads == 1 ? f.Snapshot : changed);
        stale = await Assert.ThrowsAsync<AppLifecycleException>(() => f.Inspection.ReviewDiffAsync(f.W.WorkspaceId,
            f.W.Id, "admin", "session", EvidencePullRequest, "README.md", review.Source.Revision, default));
        Assert.Equal("workspace_review_stale", stale.Code);
        f.Provider.ReviewSnapshot = async (_, _) =>
        {
            await f.Users.UpdateAsync(state => state with { ProviderConnections = [] });
            return f.Snapshot;
        };
        await Assert.ThrowsAsync<PublicationException>(() => f.Inspection.ReviewAsync(f.W.WorkspaceId, f.W.Id,
            "admin", "session", EvidencePullRequest, default));
    }

    [Theory]
    [InlineData("@@ -1 +1,2 @@\n-old\n+first\n+second\n", "1:2")]
    [InlineData("@@ -0,0 +1,2 @@\n+first\n+second\n\\ No newline at end of file\n", "1:2")]
    [InlineData("@@ -3,2 +2,0 @@\n-old\n-old\n", "")]
    [InlineData("@@ -1,2 +1,3 @@\n context\n-old\n+first\n+second\n", "2:3")]
    [InlineData("@@ -1 +1 @@\n-old\n+new\n@@ -5 +5 @@\n-other\n+changed\n", "1:1,5:5")]
    [InlineData("", "")]
    public void WorkspaceReview_UnpublishedParserMarksOnlyAddedWorkingLines(string patch, string expected)
    {
        Assert.True(WorkspaceInspectionService.TryParseUnpublishedRanges(patch, out var ranges));
        Assert.Equal(expected, string.Join(',', ranges.Select(range => $"{range.StartLine}:{range.EndLine}")));
    }

    [Theory]
    [InlineData("@@ -1 +1,2 @@\n-old\n+only-one\n")]
    [InlineData("@@ -1 +1 @@\n-old\n+first\n+unexpected\n")]
    [InlineData("@@ -1 +2147483647,2 @@\n-old\n+overflow\n+overflow\n")]
    [InlineData("@@ -1 +0 @@\n-old\n+bad\n")]
    [InlineData("@@ -9223372036854775807,2 +1 @@\n-old\n-old\n+bad\n")]
    [InlineData("@@ malformed @@\n+bad\n")]
    public void WorkspaceReview_UnpublishedParserRejectsIncompleteOrInvalidCoordinates(string patch)
    {
        Assert.False(WorkspaceInspectionService.TryParseUnpublishedRanges(patch, out var ranges));
        Assert.Empty(ranges);
    }
}
