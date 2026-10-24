using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static PublicationReviewCommand NewReviewComment(string url, string head) =>
        new(Guid.NewGuid().ToString(), url, head, Body: "An explicit new comment", AuthorIntent: true,
            Path: "file.cs", DiffSide: "RIGHT", StartLine: 10, Line: 12);

    [Fact]
    public void ReviewCommentExtensionsPreserveExistingReplyRequestFingerprints()
    {
        var input = new PublicationReviewCommand("request", "https://github.com/owner/repo/pull/42", "head", "thread", Body: "Reply", AuthorIntent: true);
        Assert.Equal("{\"requestId\":\"request\",\"pullRequestUrl\":\"https://github.com/owner/repo/pull/42\",\"expectedHead\":\"head\",\"threadId\":\"thread\",\"connectionId\":null,\"body\":\"Reply\",\"authorIntent\":true}", CoreJson.Text(input));
    }

    [Fact]
    public async Task NewReviewComment_RequiresExplicitIntentValidRangeAndOwnersBoundPrAccount()
    {
        var f = await ExternalPublicationFixture();
        var input = NewReviewComment(f.W.PullRequests[0], f.Provider.Head);
        Assert.Equal("publication_comment_invalid", (await Assert.ThrowsAsync<PublicationException>(() =>
            f.Service.CommandReviewAsync(f.W, "admin", "comment", input with { AuthorIntent = false }, default))).Code);
        foreach (var invalid in new[] { input with { Line = 0 }, input with { StartLine = 13 },
            input with { DiffSide = "WORKING" }, input with { Path = "" }, input with { StartLine = 0 } })
            Assert.Equal("publication_comment_invalid", (await Assert.ThrowsAsync<PublicationException>(() =>
                f.Service.CommandReviewAsync(f.W, "admin", "comment", invalid, default))).Code);
        Assert.Equal("publication_forbidden", (await Assert.ThrowsAsync<PublicationException>(() =>
            f.Service.CommandReviewAsync(f.W, "another-admin", "comment", input, default))).Code);
        Assert.Equal("publication_pr_mismatch", (await Assert.ThrowsAsync<PublicationException>(() =>
            f.Service.CommandReviewAsync(f.W, "admin", "comment", input with { PullRequestUrl = "https://github.com/foreign/repo/pull/42" }, default))).Code);
        Assert.Equal("publication_connection_conflict", (await Assert.ThrowsAsync<PublicationException>(() =>
            f.Service.CommandReviewAsync(f.W, "admin", "comment", input with { ConnectionId = "other-account" }, default))).Code);
        Assert.Equal(0, f.Provider.ReviewComments);
    }

    [Fact]
    public async Task NewReviewComment_LostResponseRecoversThreadOnceAfterHeadMovedAndRejectsChangedRange()
    {
        var f = await ExternalPublicationFixture(); f.Provider.LoseReviewComment = true;
        var input = NewReviewComment(f.W.PullRequests[0], f.Provider.Head);
        Assert.Equal("pending", (await f.Service.CommandReviewAsync(f.W, "admin", "comment", input, default)).State);
        Assert.Equal("publication_request_conflict", (await Assert.ThrowsAsync<PublicationException>(() =>
            f.Service.CommandReviewAsync(f.W, "admin", "comment", input with { Line = 13 }, default))).Code);
        Assert.Equal("publication_operation_pending", (await Assert.ThrowsAsync<PublicationException>(() =>
            f.Service.CommandReviewAsync(f.W, "admin", "comment", input with { RequestId = Guid.NewGuid().ToString() }, default))).Code);
        f.Provider.Head = "later-head"; f.Provider.State = "closed";
        var recovered = await f.Service.CommandReviewAsync(f.W, "admin", "comment", input, default);
        Assert.Equal("succeeded", recovered.State); Assert.Equal("new-thread", recovered.ThreadId); Assert.Equal("new-comment", recovered.CommentId);
        var replay = await f.Service.CommandReviewAsync(f.W, "admin", "comment", input, default);
        Assert.Equal("new-thread", replay.ThreadId); Assert.Equal(1, f.Provider.ReviewComments);
        var journal = await File.ReadAllTextAsync(Path.Combine(f.F.Paths.CoreRoot, "development/publications/review-operations", f.W.Id + ".json"));
        Assert.DoesNotContain(input.Body!, journal); Assert.DoesNotContain("fixture-secret", journal);
    }

    [Fact]
    public async Task NewReviewComment_UncertainUnobservedRequestNeverPostsAgain()
    {
        var f = await ExternalPublicationFixture(); f.Provider.LoseReviewComment = true;
        var input = NewReviewComment(f.W.PullRequests[0], f.Provider.Head);
        Assert.Equal("pending", (await f.Service.CommandReviewAsync(f.W, "admin", "comment", input, default)).State);
        f.Provider.CommentObserved = false;
        Assert.Equal("pending", (await f.Service.CommandReviewAsync(f.W, "admin", "comment", input, default)).State);
        Assert.Equal(1, f.Provider.ReviewComments);
    }

    [Fact]
    public async Task NewReviewComment_RevokedOwnerAuthorityBeforeAdmissionPreventsPosting()
    {
        var f = await ExternalPublicationFixture();
        f.Provider.BeforeCommentAdmission = () => f.Users.UpdateAsync(s => s with
        {
            Users = [.. s.Users.Select(u => u.Id == "admin" ? u with { Disabled = true } : u)]
        });
        var result = await f.Service.CommandReviewAsync(f.W, "admin", "comment",
            NewReviewComment(f.W.PullRequests[0], f.Provider.Head), default);
        Assert.Equal("failed", result.State); Assert.Equal(0, f.Provider.ReviewComments);
    }

    [Fact]
    public async Task NewReviewComment_RevokedSourceGrantBeforeAdmissionDoesNotLeaveBlockingPendingJournal()
    {
        var f = await ExternalPublicationFixture();
        f.Provider.BeforeCommentAdmission = () => throw PrivateSourceService.Denied();
        var input = NewReviewComment(f.W.PullRequests[0], f.Provider.Head);
        var rejected = await f.Service.CommandReviewAsync(f.W, "admin", "comment", input, default);
        Assert.Equal("failed", rejected.State); Assert.Equal(0, f.Provider.ReviewComments);
        var journal = await JsonStorage.ReadAsync<PublicationReviewJournal>(Path.Combine(f.F.Paths.CoreRoot,
            "development/publications/review-operations", f.W.Id + ".json"));
        Assert.Equal("failed", Assert.Single(journal!.Operations).State);
        f.Provider.BeforeCommentAdmission = null;
        Assert.Equal("succeeded", (await f.Service.CommandReviewAsync(f.W, "admin", "comment",
            input with { RequestId = Guid.NewGuid().ToString() }, default)).State);
        Assert.Equal(1, f.Provider.ReviewComments);
    }

    [Theory]
    [InlineData("review_changed")]
    [InlineData("comment_location_invalid")]
    public async Task NewReviewComment_DefinitiveProviderRejectionReturnsFailedAndAllowsFreshIntent(string code)
    {
        var f = await ExternalPublicationFixture();
        f.Provider.BeforeCommentAdmission = () => throw new PublicationException(code, "Refresh the published diff.");
        var input = NewReviewComment(f.W.PullRequests[0], f.Provider.Head);
        var result = await f.Service.CommandReviewAsync(f.W, "admin", "comment", input, default);
        Assert.Equal("failed", result.State); Assert.Equal("Refresh the published diff.", result.Error);
        Assert.Equal(0, f.Provider.ReviewComments);
        f.Provider.BeforeCommentAdmission = null;
        Assert.Equal("succeeded", (await f.Service.CommandReviewAsync(f.W, "admin", "comment",
            input with { RequestId = Guid.NewGuid().ToString() }, default)).State);
    }

    [Fact]
    public async Task NewReviewComment_WorkspaceDeletionBeforeAdmissionPreventsPosting()
    {
        var f = await ExternalPublicationFixture();
        f.Provider.BeforeCommentAdmission = () => JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development/workflows",
            DevelopmentWorkspaceService.Hash(DevelopmentWorkspaceService.OwnerIdentity(f.W.Owner)) + ".json"), new WorkspaceWorkflow("deleting"));
        var error = await Assert.ThrowsAsync<PublicationException>(() => f.Service.CommandReviewAsync(f.W, "admin", "comment",
            NewReviewComment(f.W.PullRequests[0], f.Provider.Head), default));
        Assert.Equal("publication_workspace_closed", error.Code); Assert.Equal(0, f.Provider.ReviewComments);
    }
}
