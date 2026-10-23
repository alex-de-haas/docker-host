using System.Text.Json.Nodes;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class GitHubPublicationTests
{
    private static readonly string CommentHead = new('b', 40);
    private static readonly string CommentBase = new('a', 40);
    private static readonly string NewCommentMarker = "<!-- hosty-review-comment:" + new string('d', 64) + " -->";
    private const string CommentPatch = "@@ -10,3 +10,3 @@\n first\n-old\n+new\n last";
    private static PublicationReviewCommand CommentInput => new(Guid.NewGuid().ToString(), "https://github.com/owner/repo/pull/42",
        CommentHead, Body: "Review this range", AuthorIntent: true, Path: "file.cs", DiffSide: "RIGHT", StartLine: 10, Line: 12);
    private static string CommentGraph(string? head = null, string state = "OPEN")
    {
        var graph = JsonNode.Parse(Graph(head: head ?? CommentHead, state: state))!;
        graph["data"]!["repository"]!["pullRequest"]!["baseRefOid"] = CommentBase;
        return graph.ToJsonString();
    }
    private static string CommentCompare(string? patch = CommentPatch)
        => new JsonObject { ["base_commit"] = new JsonObject { ["sha"] = CommentBase },
            ["merge_base_commit"] = new JsonObject { ["sha"] = new string('c', 40) },
            ["files"] = new JsonArray(new JsonObject { ["filename"] = "file.cs", ["status"] = "modified",
                ["additions"] = 1, ["deletions"] = 1, ["patch"] = patch }) }.ToJsonString();
    private static string NewCommentThreads(string? marker = null, string author = "42", bool more = false, string thread = "new-thread")
        => new JsonObject { ["data"] = new JsonObject { ["repository"] = new JsonObject { ["pullRequest"] = new JsonObject {
            ["reviewThreads"] = new JsonObject { ["pageInfo"] = new JsonObject { ["hasNextPage"] = more, ["endCursor"] = "next" },
                ["nodes"] = marker is null ? new JsonArray() : new JsonArray(new JsonObject { ["id"] = thread,
                    ["comments"] = new JsonObject { ["nodes"] = new JsonArray(new JsonObject { ["id"] = "new-comment",
                        ["body"] = "Review this range\n\n" + marker, ["author"] = new JsonObject { ["databaseId"] = int.Parse(author) } }) } }) }
        } } } }.ToJsonString();
    private static string CreatedReviewComment => new JsonObject {
        ["node_id"] = "new-comment", ["body"] = "Review this range\n\n" + NewCommentMarker,
        ["user"] = new JsonObject { ["id"] = 42 }, ["commit_id"] = CommentHead,
        ["path"] = "file.cs", ["side"] = "RIGHT", ["line"] = 12, ["start_line"] = 10, ["start_side"] = "RIGHT"
    }.ToJsonString();
    private static void QueueCommentPreparation(Http http, string? patch = CommentPatch, string? finalHead = null, string state = "OPEN")
    {
        http.Replies.Enqueue("{\"id\":42}"); http.Replies.Enqueue(NewCommentThreads());
        http.Replies.Enqueue(CommentGraph()); http.Replies.Enqueue(CommentCompare(patch)); http.Replies.Enqueue(CommentGraph());
        http.Replies.Enqueue(CommentGraph(finalHead, state));
    }

    [Fact]
    public async Task NewReviewCommentPinsPublishedCommitAndRangeAndReturnsStandaloneThreadAfterAdmission()
    {
        var http = new Http(); QueueCommentPreparation(http);
        http.Replies.Enqueue(CreatedReviewComment); http.Replies.Enqueue(NewCommentThreads(NewCommentMarker));
        var admitted = false;
        var created = await new GitHubPublicationProvider(new HttpClient(http), new Clock()).CreateReviewCommentAsync(Connection, Record,
            CommentInput, NewCommentMarker, false, () => { admitted = true; Assert.Equal(6, http.Calls.Count); return Task.CompletedTask; }, default);
        Assert.True(admitted); Assert.Equal(new("new-thread", "new-comment"), created);
        var call = Assert.Single(http.Calls, c => c.Url.EndsWith("/pulls/42/comments"));
        var body = JsonNode.Parse(call.Body)!;
        Assert.Equal(CommentHead, body["commit_id"]!.GetValue<string>()); Assert.Equal("file.cs", body["path"]!.GetValue<string>());
        Assert.Equal("RIGHT", body["side"]!.GetValue<string>()); Assert.Equal("RIGHT", body["start_side"]!.GetValue<string>());
        Assert.Equal(10, body["start_line"]!.GetValue<int>()); Assert.Equal(12, body["line"]!.GetValue<int>());
        Assert.Equal("Review this range\n\n" + NewCommentMarker, body["body"]!.GetValue<string>());
        Assert.Equal("Review this range", GitHubPublicationProvider.VisibleReviewBody(body["body"]!.GetValue<string>()));
    }

    [Fact]
    public async Task NewReviewCommentMalformedPostConfirmationRecoversObservedThreadWithoutAnotherPost()
    {
        var http = new Http(); QueueCommentPreparation(http); http.Replies.Enqueue("{");
        var provider = new GitHubPublicationProvider(new HttpClient(http), new Clock());
        var error = await Assert.ThrowsAsync<PublicationException>(() => provider.CreateReviewCommentAsync(Connection, Record,
            CommentInput, NewCommentMarker, false, () => Task.CompletedTask, default));
        Assert.Equal("publication_comment_uncertain", error.Code);
        http.Replies.Enqueue("{\"id\":42}"); http.Replies.Enqueue(NewCommentThreads(NewCommentMarker));
        var recovered = await provider.CreateReviewCommentAsync(Connection, Record, CommentInput,
            NewCommentMarker, true, () => throw new InvalidOperationException(), default);
        Assert.Equal("new-thread", recovered.ThreadId);
        Assert.Single(http.Calls, call => call.Url.EndsWith("/pulls/42/comments"));
    }

    [Theory]
    [InlineData("LEFT", 10, 12, true)]
    [InlineData("RIGHT", 10, 12, true)]
    [InlineData("RIGHT", 9, 12, false)]
    [InlineData("RIGHT", 10, 13, false)]
    [InlineData("RIGHT", 12, 10, false)]
    [InlineData("WORKING", 10, 12, false)]
    [InlineData("LEFT", 0, 1, false)]
    public void NewReviewCommentRequiresEverySelectedLineInOnePublishedHunk(string side, int start, int end, bool allowed)
    {
        var file = new PublicationReviewFile("file.cs", "modified", null, "diff --git a/file.cs b/file.cs\n--- a/file.cs\n+++ b/file.cs\n" + CommentPatch, 1, 1);
        Assert.Equal(allowed, GitHubPublicationProvider.ReviewCommentRangeIsInPatch(file, side, start, end));
        Assert.False(GitHubPublicationProvider.ReviewCommentRangeIsInPatch(file with { Patch = null }, side, start, end));
        Assert.False(GitHubPublicationProvider.ReviewCommentRangeIsInPatch(file with { Binary = true }, side, start, end));
        Assert.False(GitHubPublicationProvider.ReviewCommentRangeIsInPatch(file with { Additions = 9 }, side, start, end));
    }

    [Fact]
    public void NewReviewCommentRefusesRangeAcrossHunksAndTruncatedPatches()
    {
        var file = new PublicationReviewFile("file.cs", "modified", null,
            "@@ -1 +1 @@\n-a\n+b\n@@ -3 +3 @@\n-c\n+d\n", 2, 2);
        Assert.False(GitHubPublicationProvider.ReviewCommentRangeIsInPatch(file, "RIGHT", 1, 3));
        Assert.True(GitHubPublicationProvider.ReviewCommentRangeIsInPatch(file, "RIGHT", null, 3));
        Assert.False(GitHubPublicationProvider.ReviewCommentRangeIsInPatch(file with { Patch = "@@ -1,2 +1,2 @@\n-a\n+b\n" }, "RIGHT", null, 1));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task NewReviewCommentRejectsUnpublishedOrUnavailableLinesBeforeMutation(bool absentPatch)
    {
        var http = new Http(); QueueCommentPreparation(http, absentPatch ? null : CommentPatch);
        var input = absentPatch ? CommentInput : CommentInput with { Line = 13 };
        var error = await Assert.ThrowsAsync<PublicationException>(() => new GitHubPublicationProvider(new HttpClient(http), new Clock())
            .CreateReviewCommentAsync(Connection, Record, input, NewCommentMarker, false,
                () => throw new InvalidOperationException("Invalid lines cannot admit a mutation."), default));
        Assert.Equal("publication_comment_location_invalid", error.Code);
        Assert.DoesNotContain(http.Calls, c => c.Url.EndsWith("/pulls/42/comments"));
    }

    [Theory]
    [InlineData("OPEN")]
    [InlineData("CLOSED")]
    public async Task NewReviewCommentRechecksHeadAndOpenStateImmediatelyBeforeAdmission(string state)
    {
        var http = new Http(); QueueCommentPreparation(http, finalHead: state == "OPEN" ? new string('e', 40) : null, state: state);
        var error = await Assert.ThrowsAsync<PublicationException>(() => new GitHubPublicationProvider(new HttpClient(http), new Clock())
            .CreateReviewCommentAsync(Connection, Record, CommentInput, NewCommentMarker, false,
                () => throw new InvalidOperationException("Changed PR cannot admit a mutation."), default));
        Assert.Equal("publication_review_changed", error.Code);
        Assert.DoesNotContain(http.Calls, c => c.Url.EndsWith("/pulls/42/comments"));
    }

    [Fact]
    public async Task NewReviewCommentRecoveryFindsOriginalRootCommentWithoutCheckingMovedHeadOrClosedPr()
    {
        var http = new Http(); http.Replies.Enqueue("{\"id\":42}"); http.Replies.Enqueue(NewCommentThreads(NewCommentMarker));
        var result = await new GitHubPublicationProvider(new HttpClient(http), new Clock()).CreateReviewCommentAsync(Connection, Record,
            CommentInput, NewCommentMarker, true, () => throw new InvalidOperationException("Recovery never admits another POST."), default);
        Assert.Equal("new-thread", result.ThreadId); Assert.Equal(2, http.Calls.Count);
        Assert.DoesNotContain(http.Calls, c => c.Url.EndsWith("/pulls/42/comments"));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("99")]
    public async Task NewReviewCommentRecoveryNeverRepostsAbsentOrForeignAuthorsMarker(string? author)
    {
        var http = new Http(); http.Replies.Enqueue("{\"id\":42}");
        http.Replies.Enqueue(author is null ? NewCommentThreads() : NewCommentThreads(NewCommentMarker, author));
        var error = await Assert.ThrowsAsync<PublicationException>(() => new GitHubPublicationProvider(new HttpClient(http), new Clock())
            .CreateReviewCommentAsync(Connection, Record, CommentInput, NewCommentMarker, true, () => throw new InvalidOperationException(), default));
        Assert.Equal("publication_comment_uncertain", error.Code);
        Assert.DoesNotContain(http.Calls, c => c.Url.EndsWith("/pulls/42/comments"));
    }

    [Fact]
    public async Task NewReviewCommentRecoveryPaginatesRootCommentsAndRejectsDuplicateMarkers()
    {
        var http = new Http(); http.Replies.Enqueue("{\"id\":42}"); http.Replies.Enqueue(NewCommentThreads(more: true));
        http.Replies.Enqueue(NewCommentThreads(NewCommentMarker));
        var result = await new GitHubPublicationProvider(new HttpClient(http), new Clock()).CreateReviewCommentAsync(Connection, Record,
            CommentInput, NewCommentMarker, true, () => throw new InvalidOperationException(), default);
        Assert.Equal("new-thread", result.ThreadId);
        Assert.Equal("next", JsonNode.Parse(http.Calls.Last().Body)!["variables"]!["after"]!.GetValue<string>());
        http = new Http(); http.Replies.Enqueue("{\"id\":42}"); http.Replies.Enqueue(NewCommentThreads(NewCommentMarker, more: true));
        http.Replies.Enqueue(NewCommentThreads(NewCommentMarker, thread: "duplicate"));
        Assert.Equal("publication_comment_uncertain", (await Assert.ThrowsAsync<PublicationException>(() =>
            new GitHubPublicationProvider(new HttpClient(http), new Clock()).CreateReviewCommentAsync(Connection, Record,
                CommentInput, NewCommentMarker, true, () => throw new InvalidOperationException(), default))).Code);
    }
}
