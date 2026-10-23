using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task ExternalReviewReply_RequiresExplicitIntentBoundPrAndWorkspaceOwnersAccount()
    {
        var f = await ExternalPublicationFixture();
        var command = new PublicationReviewCommand(Guid.NewGuid().ToString(), f.W.PullRequests[0], f.Provider.Head, "thread", Body: "An explicit reply");
        Assert.Equal("publication_reply_invalid", (await Assert.ThrowsAsync<PublicationException>(() =>
            f.Service.CommandReviewAsync(f.W, "admin", "reply", command, default))).Code);
        command = command with { AuthorIntent = true };
        Assert.Equal("publication_forbidden", (await Assert.ThrowsAsync<PublicationException>(() =>
            f.Service.CommandReviewAsync(f.W, "another-admin", "reply", command, default))).Code);
        Assert.Equal("publication_pr_mismatch", (await Assert.ThrowsAsync<PublicationException>(() =>
            f.Service.CommandReviewAsync(f.W, "admin", "reply", command with { PullRequestUrl = "https://github.com/foreign/repo/pull/42" }, default))).Code);
        Assert.Equal("publication_connection_conflict", (await Assert.ThrowsAsync<PublicationException>(() =>
            f.Service.CommandReviewAsync(f.W, "admin", "reply", command with { ConnectionId = "other-account" }, default))).Code);
        Assert.Equal(0, f.Provider.ReviewReplies);
        Assert.False(File.Exists(Path.Combine(f.F.Paths.CoreRoot, "development/publications/review-operations", f.W.Id + ".json")));
    }

    [Fact]
    public async Task ExternalReviewReply_LostResponseRecoversOneReplyAndRejectsChangedIntent()
    {
        var f = await ExternalPublicationFixture();
        f.Provider.LoseReviewReply = true;
        var command = new PublicationReviewCommand(Guid.NewGuid().ToString(), f.W.PullRequests[0], f.Provider.Head,
            "thread", Body: "My reply", AuthorIntent: true);
        var uncertain = await f.Service.CommandReviewAsync(f.W, "admin", "reply", command, default);
        Assert.Equal("pending", uncertain.State);
        Assert.Equal("publication_request_conflict", (await Assert.ThrowsAsync<PublicationException>(() =>
            f.Service.CommandReviewAsync(f.W, "admin", "reply", command with { Body = "Different reply" }, default))).Code);
        Assert.Equal("publication_operation_pending", (await Assert.ThrowsAsync<PublicationException>(() =>
            f.Service.CommandReviewAsync(f.W, "admin", "reply", command with { RequestId = Guid.NewGuid().ToString() }, default))).Code);
        var recovered = await f.Service.CommandReviewAsync(f.W, "admin", "reply", command, default);
        Assert.Equal("succeeded", recovered.State);
        Assert.Equal("comment", recovered.CommentId);
        Assert.Equal(1, f.Provider.ReviewReplies);
        var path = Path.Combine(f.F.Paths.CoreRoot, "development/publications/review-operations", f.W.Id + ".json");
        var journal = await JsonStorage.ReadAsync<PublicationReviewJournal>(path);
        Assert.True(Assert.Single(journal!.Operations).MutationStarted);
        Assert.DoesNotContain("My reply", await File.ReadAllTextAsync(path));
        Assert.DoesNotContain("fixture-secret", await File.ReadAllTextAsync(path));
        Assert.Equal("succeeded", (await f.Service.CommandReviewAsync(f.W, "admin", "reply", command, default)).State);
        Assert.Equal(1, f.Provider.ReviewReplies);
    }

    [Fact]
    public async Task ExternalReviewReply_UnobservedUncertainReplyNeverPostsAgain()
    {
        var f = await ExternalPublicationFixture();
        f.Provider.LoseReviewReply = true;
        var command = new PublicationReviewCommand(Guid.NewGuid().ToString(), f.W.PullRequests[0], f.Provider.Head,
            "thread", Body: "My reply", AuthorIntent: true);
        Assert.Equal("pending", (await f.Service.CommandReviewAsync(f.W, "admin", "reply", command, default)).State);
        f.Provider.ReplyObserved = false;
        Assert.Equal("pending", (await f.Service.CommandReviewAsync(f.W, "admin", "reply", command, default)).State);
        Assert.Equal(1, f.Provider.ReviewReplies);
    }

    [Fact]
    public async Task ExternalReviewReply_WorkspaceDeletionBeforeAdmissionPreventsPosting()
    {
        var f = await ExternalPublicationFixture();
        f.Provider.BeforeReplyAdmission = () => JsonStorage.WriteAsync(Path.Combine(f.F.Paths.CoreRoot, "development/workflows",
            DevelopmentWorkspaceService.Hash(DevelopmentWorkspaceService.OwnerIdentity(f.W.Owner)) + ".json"), new WorkspaceWorkflow("deleting"));
        var command = new PublicationReviewCommand(Guid.NewGuid().ToString(), f.W.PullRequests[0], f.Provider.Head,
            "thread", Body: "Do not post after deletion started", AuthorIntent: true);
        var error = await Assert.ThrowsAsync<PublicationException>(() => f.Service.CommandReviewAsync(f.W, "admin", "reply", command, default));
        Assert.Equal("publication_workspace_closed", error.Code);
        Assert.Equal(0, f.Provider.ReviewReplies);
    }

    [Fact]
    public async Task ExternalReviewReply_DirtyWorktreeAndActiveLeaseDoNotBlockDiscussion()
    {
        var f = await ExternalPublicationFixture();
        await File.WriteAllTextAsync(Path.Combine(f.W.Path, "local-draft.txt"), "Uncommitted work stays intact.");
        var command = new PublicationReviewCommand(Guid.NewGuid().ToString(), f.W.PullRequests[0], f.Provider.Head,
            "thread", Body: "Discuss before finishing local edits", AuthorIntent: true);
        Assert.Equal("succeeded", (await f.Service.CommandReviewAsync(f.W, "admin", "reply", command, default)).State);
        Assert.Equal("succeeded", (await f.Service.CommandReviewAsync(f.W, "admin", "resolve",
            command with { RequestId = Guid.NewGuid().ToString(), Body = null }, default)).State);
        Assert.Equal(1, f.Provider.ReviewResolutions);
        Assert.Equal("Uncommitted work stays intact.", await File.ReadAllTextAsync(Path.Combine(f.W.Path, "local-draft.txt")));
    }
}
