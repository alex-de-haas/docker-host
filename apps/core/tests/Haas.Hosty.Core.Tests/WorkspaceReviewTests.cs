using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task WorkspaceReview_UsesActualCachedTargetAndRetainsOriginalSessionAndLocalScopes()
    {
        var (fixture, origin) = await SourceFixtureAsync();
        var workspaces = new DevelopmentWorkspaceService(fixture.Paths, fixture.Apps, fixture.Clock);
        var owner = WorkspaceTestOwner(fixture);
        var tree = await workspaces.PrepareAsync(owner, WorkspaceRequest(), default);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "README.md"), "shared\n");
        await RunGitAsync(tree.Path, ["add", "README.md"]);
        await RunGitAsync(tree.Path, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "Shared change"]);
        var shared = (await RunGitAsync(tree.Path, ["rev-parse", "HEAD"])).Trim();
        await RunGitAsync(origin, ["fetch", tree.Path, tree.Branch]);
        await RunGitAsync(origin, ["merge", "--ff-only", "FETCH_HEAD"]);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "README.md"), "shared\nfeature\n");
        await RunGitAsync(tree.Path, ["add", "README.md"]);
        await RunGitAsync(tree.Path, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "Feature change"]);
        tree = await workspaces.CommandAsync(tree.Id, owner, "refresh", new(Guid.NewGuid().ToString()), default);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "README.md"), "shared\nfeature\nlocal\n");
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "new.txt"), "new file\n");
        var inspection = new WorkspaceInspectionService(workspaces, fixture.Apps, fixture.Clock);
        var statusBefore = await RunGitAsync(tree.Path, ["status", "--porcelain=v1"]);
        var index = (await RunGitAsync(tree.Path, ["rev-parse", "--git-path", "index"])).Trim();
        var indexBefore = await File.ReadAllBytesAsync(Path.IsPathRooted(index) ? index : Path.Combine(tree.Path, index));
        var local = await inspection.ReviewAsync(tree.WorkspaceId, tree.Id, "admin", "local", null, default);
        Assert.Equal(tree.Observation!.Head, local.Source.Base);
        Assert.False(local.Source.Published);
        Assert.Equal(2, local.Files.Length);
        var session = await inspection.ReviewAsync(tree.WorkspaceId, tree.Id, "admin", "session", null, default);
        Assert.Equal(tree.OriginalBase, session.Source.Base);
        var target = await inspection.ReviewAsync(tree.WorkspaceId, tree.Id, "admin", "target", null, default);
        Assert.Equal("Since main", target.Source.Label);
        Assert.Equal(shared, target.Source.Base);
        Assert.Equal(shared, target.Source.MergeBase);
        var targetDiff = await inspection.ReviewDiffAsync(tree.WorkspaceId, tree.Id, "admin", "target", null,
            "README.md", target.Source.Revision, default);
        Assert.DoesNotContain("-source", targetDiff.Diff.Combined);
        Assert.Contains("+feature", targetDiff.Diff.Combined);
        Assert.Contains("+local", targetDiff.Diff.Combined);
        Assert.Equal("", targetDiff.Diff.Staged);
        Assert.Contains("new file", (await inspection.ReviewDiffAsync(tree.WorkspaceId, tree.Id, "admin", "target", null,
            "new.txt", target.Source.Revision, default)).Diff.Combined);
        Assert.Contains("-source", (await inspection.ReviewDiffAsync(tree.WorkspaceId, tree.Id, "admin", "session", null,
            "README.md", session.Source.Revision, default)).Diff.Combined);
        Assert.Equal(statusBefore, await RunGitAsync(tree.Path, ["status", "--porcelain=v1"]));
        Assert.Equal(indexBefore, await File.ReadAllBytesAsync(Path.IsPathRooted(index) ? index : Path.Combine(tree.Path, index)));
    }

    [Fact]
    public async Task WorkspaceReview_RejectsStaleRevisionUnsafePathAndRevokedSource()
    {
        var (fixture, users, access, workspaces, tree, _, _) = await PrivateWorkspaceDocumentFixtureAsync();
        var inspection = new WorkspaceInspectionService(workspaces, fixture.Apps, fixture.Clock, privateSources: access);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "README.md"), "first\n");
        var review = await inspection.ReviewAsync(tree.WorkspaceId, tree.Id, "admin", "session", null, default);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "README.md"), "second longer\n");
        var stale = await Assert.ThrowsAsync<AppLifecycleException>(() => inspection.ReviewDiffAsync(tree.WorkspaceId,
            tree.Id, "admin", "session", null, "README.md", review.Source.Revision, default));
        Assert.Equal("workspace_review_stale", stale.Code);
        var path = await Assert.ThrowsAsync<AppLifecycleException>(() => inspection.ReviewDiffAsync(tree.WorkspaceId,
            tree.Id, "admin", "target", null, "../secret", null, default));
        Assert.Equal("workspace_review_path_invalid", path.Code);
        await users.UpdateAsync(state => state with { ProviderConnections = [] });
        await Assert.ThrowsAsync<AppLifecycleException>(() => inspection.ReviewAsync(tree.WorkspaceId, tree.Id, "admin", "session", null, default));
    }

    [Fact]
    public async Task WorkspaceReview_PublishedDiffRetainsProviderThreadsAndExcludesLocalEdits()
    {
        var fixture = await PublicationFixture();
        fixture.Provider.RepositoryOverride = "owner/repo";
        var tree = fixture.W;
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "README.md"), "published\n");
        await RunGitAsync(tree.Path, ["add", "README.md"]);
        await RunGitAsync(tree.Path, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "Published change"]);
        var publishedHead = (await RunGitAsync(tree.Path, ["rev-parse", "HEAD"])).Trim();
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "README.md"), "local replacement\n");
        const string url = "https://github.com/owner/repo/pull/42";
        var record = Assert.Single((await fixture.Service.ListAsync(null, default)).Publications) with {
            Url = url, Number = 42, PublishedHead = publishedHead };
        await JsonStorage.WriteAsync(Path.Combine(fixture.F.Paths.CoreRoot, "development/publications", tree.Id + ".json"), record);
        var thread = new PublicationReview("thread", "README.md", 1, false, ["Explain this line"],
            DiffSide: "RIGHT", Details: [new("comment", "Explain this line", "reviewer", "User")]);
        var observation = new PublicationObservation(fixture.F.Clock.UtcNow, "open", publishedHead, "main",
            Reviews: [thread], BaseHead: tree.OriginalBase);
        var snapshot = new PublicationReviewSnapshot(url, "owner/repo", "main", tree.OriginalBase,
            tree.OriginalBase, publishedHead, observation, [new("README.md", "modified", null,
                "diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-source\n+published\n", 1, 1)]);
        fixture.Provider.ReviewSnapshot = (_, _) => Task.FromResult(snapshot);
        var inspection = new WorkspaceInspectionService(fixture.Workspaces, fixture.F.Apps, fixture.F.Clock, fixture.Service);
        var review = await inspection.ReviewAsync(tree.WorkspaceId, tree.Id, "admin", "pull-request", url, default);
        Assert.True(review.Source.Published);
        Assert.True(review.Source.NotPublished);
        Assert.Equal(publishedHead, review.Source.Head);
        Assert.Equal("reviewer", Assert.Single(Assert.Single(review.Threads).Details!).AuthorLogin);
        var diff = await inspection.ReviewDiffAsync(tree.WorkspaceId, tree.Id, "admin", "pull-request", url,
            "README.md", review.Source.Revision, default);
        Assert.Contains("+published", diff.Diff.Combined);
        Assert.DoesNotContain("local replacement", diff.Diff.Combined);
        Assert.True(diff.LocalRangesComplete);
        Assert.Equal(new WorkspaceReviewLineRange(1, 1), Assert.Single(diff.LocalRanges));
        Assert.Equal("local replacement\n", await File.ReadAllTextAsync(Path.Combine(tree.Path, "README.md")));
        await Assert.ThrowsAsync<PublicationException>(() => inspection.ReviewAsync(tree.WorkspaceId, tree.Id,
            "another-admin", "pull-request", url, default));
        await Assert.ThrowsAsync<PublicationException>(() => inspection.ReviewAsync(tree.WorkspaceId, tree.Id,
            "admin", "pull-request", "https://github.com/owner/repo/pull/99", default));
        fixture.Provider.ReviewSnapshot = async (_, _) =>
        {
            await fixture.Users.UpdateAsync(state => state with { ProviderConnections = [] });
            return snapshot;
        };
        await Assert.ThrowsAsync<PublicationException>(() => inspection.ReviewAsync(tree.WorkspaceId, tree.Id,
            "admin", "pull-request", url, default));
    }

    [Fact]
    public async Task WorkspaceReview_StoredLegacyCommentBodiesSurviveAdditiveAndUnknownFields()
    {
        var directory = Directory.CreateTempSubdirectory("hosty-review-json-").FullName;
        var path = Path.Combine(directory, "observation.json");
        try
        {
            await File.WriteAllTextAsync(path, """
                {"at":"2026-10-21T12:00:00Z","state":"open","head":"published","unknownEnvelope":1,
                 "reviews":[{"id":"thread","path":"file.cs","line":1,"resolved":false,
                   "comments":["Existing private comment"],"unknownThreadMetadata":{"value":"future"}}]}
                """);
            var legacy = (await JsonStorage.ReadAsync<PublicationObservation>(path))!;
            var thread = Assert.Single(legacy.Reviews!);
            Assert.Equal("Existing private comment", Assert.Single(thread.Comments));
            Assert.Null(thread.Details);
            var enriched = legacy with { Reviews = [thread with {
                DiffSide = "RIGHT", Details = [new("comment", thread.Comments[0], "reviewer", "User")] }] };
            await JsonStorage.WriteAsync(path, enriched, restrictToOwner: true);
            var roundTrip = (await JsonStorage.ReadAsync<PublicationObservation>(path))!;
            Assert.Equal(thread.Comments, Assert.Single(roundTrip.Reviews!).Comments);
            Assert.Equal("reviewer", Assert.Single(roundTrip.Reviews![0].Details!).AuthorLogin);
        }
        finally { Directory.Delete(directory, recursive: true); }
    }

    [Theory]
    [InlineData("@@ -10,3 +10,1 @@\n-old\n", 10, 12)]
    [InlineData("@@ -0,0 +1,2 @@\n+new\n", 1, 1)]
    [InlineData("@@ -7 +7,3 @@\n-old\n", 7, 7)]
    public void WorkspaceReview_LocalOverlapUsesPublishedSideCoordinates(string patch, int first, int last)
    {
        var range = Assert.Single(WorkspaceInspectionService.ParseOldLineRanges(patch));
        Assert.Equal(first, range.StartLine);
        Assert.Equal(last, range.EndLine);
    }
}
