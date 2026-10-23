using System.Text.Json.Nodes;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class GitHubPublicationTests
{
    private static string ThreadGraph(string head = "head", bool outdated = false)
    {
        var graph = JsonNode.Parse(Graph(head: head))!;
        graph["data"]!["repository"]!["pullRequest"]!["baseRefOid"] = "base-sha";
        graph["data"]!["repository"]!["pullRequest"]!["reviewThreads"]!["nodes"] = new JsonArray(new JsonObject
        {
            ["id"] = "thread", ["path"] = "file.cs", ["line"] = 12, ["originalLine"] = 9,
            ["startLine"] = 10, ["originalStartLine"] = 7, ["diffSide"] = "RIGHT", ["startDiffSide"] = "RIGHT",
            ["isResolved"] = false, ["isOutdated"] = outdated, ["subjectType"] = "LINE",
            ["comments"] = new JsonObject { ["pageInfo"] = new JsonObject { ["hasNextPage"] = true },
                ["nodes"] = new JsonArray(new JsonObject { ["id"] = "comment", ["databaseId"] = 101,
                    ["body"] = "Review body", ["createdAt"] = "2026-10-21T12:00:00Z", ["url"] = "https://github.com/owner/repo/pull/42#discussion_r101",
                    ["author"] = new JsonObject { ["login"] = "reviewer", ["__typename"] = "Bot" } }) }
        });
        return graph.ToJsonString();
    }
    private static string CommentPage(string? marker = null, string accountId = "42", bool more = false)
        => new JsonObject { ["data"] = new JsonObject { ["node"] = new JsonObject { ["id"] = "thread",
            ["comments"] = new JsonObject { ["pageInfo"] = new JsonObject { ["hasNextPage"] = more, ["endCursor"] = "next" },
                ["nodes"] = marker is null ? new JsonArray() : new JsonArray(new JsonObject { ["id"] = "reply", ["body"] = "Reply\n\n" + marker,
                    ["author"] = new JsonObject { ["databaseId"] = int.Parse(accountId) } }) } } } }.ToJsonString();

    [Fact]
    public async Task ReviewObservationPreservesAuthorsRangesOriginalCoordinatesAndTruncation()
    {
        var http = new Http(); http.Replies.Enqueue(ThreadGraph(outdated: true));
        var observed = await new GitHubPublicationProvider(new HttpClient(http), new Clock()).ObserveAsync(Connection, Record, default);
        Assert.Equal("base-sha", observed.BaseHead);
        var thread = Assert.Single(observed.Reviews!);
        Assert.Equal(12, thread.Line); Assert.Equal(9, thread.OriginalLine);
        Assert.Equal(10, thread.StartLine); Assert.Equal(7, thread.OriginalStartLine);
        Assert.Equal("RIGHT", thread.DiffSide); Assert.Equal("RIGHT", thread.StartDiffSide);
        Assert.Equal("LINE", thread.SubjectType); Assert.True(thread.Outdated); Assert.False(thread.CommentsComplete);
        Assert.Equal(["Review body", "Additional comments are available on the PR."], thread.Comments);
        var comment = Assert.Single(thread.Details!);
        Assert.Equal("reviewer", comment.AuthorLogin); Assert.Equal("Bot", comment.AuthorKind);
        Assert.Equal(101, comment.DatabaseId); Assert.Equal("comment", comment.Id);
        Assert.Equal(DateTimeOffset.Parse("2026-10-21T12:00:00Z"), comment.CreatedAt);
        Assert.Contains("originalStartLine", Assert.Single(http.Calls).Body);
    }

    [Fact]
    public async Task ReviewReplyCarriesExplicitBodyAndAdmitsBeforeRemoteMutation()
    {
        var marker = "<!-- hosty-review-reply:" + new string('a', 64) + " -->";
        var http = new Http(); http.Replies.Enqueue(ThreadGraph()); http.Replies.Enqueue("{\"id\":42}");
        http.Replies.Enqueue(CommentPage()); http.Replies.Enqueue(ThreadGraph());
        http.Replies.Enqueue(new JsonObject { ["data"] = new JsonObject { ["addPullRequestReviewThreadReply"] = new JsonObject { ["comment"] = new JsonObject
            { ["id"] = "reply", ["body"] = "Reply\n\n" + marker, ["author"] = new JsonObject { ["databaseId"] = 42 } } } } }.ToJsonString());
        var admitted = false;
        var id = await new GitHubPublicationProvider(new HttpClient(http), new Clock()).ReplyReviewAsync(Connection, Record,
            "thread", "head", "Reply", marker, false, () => { admitted = true; Assert.Equal(4, http.Calls.Count); return Task.CompletedTask; }, default);
        Assert.True(admitted); Assert.Equal("reply", id);
        var request = JsonNode.Parse(http.Calls.Last().Body)!;
        Assert.Equal("thread", request["variables"]!["thread"]!.GetValue<string>());
        Assert.Equal("Reply\n\n" + marker, request["variables"]!["body"]!.GetValue<string>());
        Assert.Equal("Reply", GitHubPublicationProvider.VisibleReviewBody("Reply\n\n" + marker));
    }

    [Fact]
    public async Task ReviewReplyRecoveryFindsPriorReplyAfterHeadMovedWithoutPostingAgain()
    {
        var marker = "<!-- hosty-review-reply:" + new string('a', 64) + " -->";
        var http = new Http(); http.Replies.Enqueue(ThreadGraph("new-head")); http.Replies.Enqueue("{\"id\":42}");
        http.Replies.Enqueue(CommentPage(marker));
        var id = await new GitHubPublicationProvider(new HttpClient(http), new Clock()).ReplyReviewAsync(Connection, Record,
            "thread", "head", "Reply", marker, true, () => throw new InvalidOperationException("No mutation during recovery."), default);
        Assert.Equal("reply", id);
        Assert.DoesNotContain(http.Calls, c => c.Body.Contains("addPullRequestReviewThreadReply"));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("99")]
    public async Task ReviewReplyRecoveryRefusesAbsentOrForeignAuthorMarkerWithoutPosting(string? markerAuthor)
    {
        var marker = "<!-- hosty-review-reply:" + new string('a', 64) + " -->";
        var http = new Http(); http.Replies.Enqueue(ThreadGraph()); http.Replies.Enqueue("{\"id\":42}");
        http.Replies.Enqueue(markerAuthor is null ? CommentPage() : CommentPage(marker, markerAuthor));
        var error = await Assert.ThrowsAsync<PublicationException>(() => new GitHubPublicationProvider(new HttpClient(http), new Clock()).ReplyReviewAsync(Connection, Record,
            "thread", "head", "Reply", marker, true, () => throw new InvalidOperationException(), default));
        Assert.Equal("publication_reply_uncertain", error.Code);
        Assert.DoesNotContain(http.Calls, c => c.Body.Contains("addPullRequestReviewThreadReply"));
    }

    [Fact]
    public async Task ReviewReplyRechecksHeadAfterMarkerReconciliationBeforeAdmittingNewPost()
    {
        var http = new Http(); http.Replies.Enqueue(ThreadGraph()); http.Replies.Enqueue("{\"id\":42}");
        http.Replies.Enqueue(CommentPage()); http.Replies.Enqueue(ThreadGraph("new-head"));
        var error = await Assert.ThrowsAsync<PublicationException>(() =>
            new GitHubPublicationProvider(new HttpClient(http), new Clock()).ReplyReviewAsync(Connection, Record,
                "thread", "head", "Reply", "marker", false,
                () => throw new InvalidOperationException("A stale head must never admit the mutation."), default));
        Assert.Equal("publication_review_changed", error.Code);
        Assert.DoesNotContain(http.Calls, call => call.Body.Contains("addPullRequestReviewThreadReply"));
    }

    [Fact]
    public async Task ReviewResolutionRecoversAlreadyResolvedThreadAfterHeadMoved()
    {
        var graph = JsonNode.Parse(ThreadGraph("later-head"))!;
        graph["data"]!["repository"]!["pullRequest"]!["reviewThreads"]!["nodes"]![0]!["isResolved"] = true;
        var http = new Http(); http.Replies.Enqueue(graph.ToJsonString());
        await new GitHubPublicationProvider(new HttpClient(http), new Clock()).ResolveReviewAsync(Connection, Record, "thread", "head", default);
        Assert.Single(http.Calls);
        Assert.DoesNotContain(http.Calls, c => c.Body.Contains("resolveReviewThread"));
    }

    [Fact]
    public async Task ReviewReplyRejectsChangedHeadForeignThreadAndCredentialIdentityBeforeMutation()
    {
        var http = new Http(); http.Replies.Enqueue(ThreadGraph());
        var provider = new GitHubPublicationProvider(new HttpClient(http), new Clock());
        Assert.Equal("publication_review_changed", (await Assert.ThrowsAsync<PublicationException>(() =>
            provider.ReplyReviewAsync(Connection, Record, "foreign", "head", "Reply", "marker", false, () => Task.CompletedTask, default))).Code);
        http.Replies.Enqueue(ThreadGraph()); http.Replies.Enqueue("{\"id\":99}");
        Assert.Equal("publication_identity_changed", (await Assert.ThrowsAsync<PublicationException>(() =>
            provider.ReplyReviewAsync(Connection, Record, "thread", "head", "Reply", "marker", false, () => Task.CompletedTask, default))).Code);
        http.Replies.Enqueue(ThreadGraph()); http.Replies.Enqueue("{\"id\":42}"); http.Replies.Enqueue(CommentPage()); http.Replies.Enqueue(ThreadGraph());
        Assert.Equal("publication_review_changed", (await Assert.ThrowsAsync<PublicationException>(() =>
            provider.ReplyReviewAsync(Connection, Record, "thread", "stale", "Reply", "marker", false, () => Task.CompletedTask, default))).Code);
        Assert.DoesNotContain(http.Calls, c => c.Body.Contains("addPullRequestReviewThreadReply"));
    }
}
