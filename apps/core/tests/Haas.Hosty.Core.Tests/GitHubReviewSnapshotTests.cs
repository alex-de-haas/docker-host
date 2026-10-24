using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class GitHubReviewSnapshotTests
{
    private const string Head = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string Basis = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string MergeBase = "cccccccccccccccccccccccccccccccccccccccc";
    private sealed class Clock : IClock { public DateTimeOffset UtcNow => DateTimeOffset.Parse("2026-10-21T12:00:00Z"); }
    private sealed class Http : HttpMessageHandler
    {
        internal readonly Queue<string> Replies = new();
        internal readonly List<string> Calls = [];
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Calls.Add(request.RequestUri!.ToString());
            Assert.Equal("Bearer test-token", request.Headers.Authorization!.ToString());
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                { Content = new StringContent(Replies.Dequeue(), Encoding.UTF8, "application/json") });
        }
    }
    private static UserProviderConnection Connection => new("c", "admin", "GitHub", "github", "", "", "42", "owner", "pat", "test-token", null, null, null, DateTimeOffset.UtcNow, null, "connected", "r");
    private static PublicationRecord Record => new() { WorkspaceId = new('a', 64), Owner = new("assistant", DateTimeOffset.UtcNow, "admin", "session"), Repository = "owner/repo", HeadRepository = "owner/repo", ConnectionId = "c", Branch = "feature", TargetBranch = "main", Number = 42 };
    private static string Graph(string head = Head) => new JsonObject { ["data"] = new JsonObject { ["repository"] = new JsonObject {
        ["pullRequest"] = new JsonObject { ["id"] = "PR_42", ["state"] = "OPEN", ["isDraft"] = false,
            ["headRefName"] = "feature", ["headRefOid"] = head, ["baseRefName"] = "main", ["baseRefOid"] = Basis,
            ["headRepository"] = new JsonObject { ["nameWithOwner"] = "owner/repo" },
            ["reviewThreads"] = new JsonObject { ["pageInfo"] = new JsonObject { ["hasNextPage"] = false }, ["nodes"] = new JsonArray() },
            ["commits"] = new JsonObject { ["nodes"] = new JsonArray() } } } } }.ToJsonString();
    private static string Compare(JsonArray? files = null) => new JsonObject { ["base_commit"] = new JsonObject { ["sha"] = Basis },
        ["merge_base_commit"] = new JsonObject { ["sha"] = MergeBase }, ["files"] = files ?? new JsonArray(File()) }.ToJsonString();
    private static JsonObject File(string? patch = "@@ -1 +1 @@\n-old\n+published") => new() { ["filename"] = "file.cs", ["status"] = "modified", ["patch"] = patch, ["additions"] = 1, ["deletions"] = 1 };

    [Fact]
    public async Task PublishedReviewUsesAuthenticatedMergeBaseComparisonAndRechecksPublishedHead()
    {
        var http = new Http();
        foreach (var response in new[] { Graph(), Compare(), Graph() }) http.Replies.Enqueue(response);
        var snapshot = await new GitHubPublicationProvider(new HttpClient(http), new Clock()).ReadReviewSnapshotAsync(Connection, Record, default);
        Assert.Equal(Head, snapshot.Head);
        Assert.Equal(Basis, snapshot.Base);
        Assert.Equal(MergeBase, snapshot.MergeBase);
        Assert.Equal("main", snapshot.BaseBranch);
        Assert.Contains("/compare/" + Basis + "..." + Head, http.Calls[1]);
        Assert.Contains("+published", Assert.Single(snapshot.Files).Patch);
        Assert.False(snapshot.Truncated);
        Assert.Equal(3, http.Calls.Count);
    }

    [Fact]
    public async Task PublishedReviewRejectsHeadChangesAndIncompleteFileLists()
    {
        var http = new Http();
        foreach (var response in new[] { Graph(), Compare(), Graph(new string('d', 40)), Graph(), Compare(new JsonArray(Enumerable.Range(0, 300).Select(_ => (JsonNode)File()).ToArray())) }) http.Replies.Enqueue(response);
        var provider = new GitHubPublicationProvider(new HttpClient(http), new Clock());
        Assert.Equal("publication_review_stale", (await Assert.ThrowsAsync<PublicationException>(() => provider.ReadReviewSnapshotAsync(Connection, Record, default))).Code);
        Assert.Equal("publication_review_incomplete", (await Assert.ThrowsAsync<PublicationException>(() => provider.ReadReviewSnapshotAsync(Connection, Record, default))).Code);
    }

    [Fact]
    public async Task MissingAndTruncatedPatchesRemainExplicitlyUnavailable()
    {
        var http = new Http();
        foreach (var response in new[] { Graph(), Compare(new JsonArray(File(null), new JsonObject {
            ["filename"] = "large.cs", ["status"] = "modified", ["patch"] = "@@ -1,20 +1,20 @@\n-one\n+two", ["additions"] = 1, ["deletions"] = 1 })), Graph() }) http.Replies.Enqueue(response);
        var snapshot = await new GitHubPublicationProvider(new HttpClient(http), new Clock()).ReadReviewSnapshotAsync(Connection, Record, default);
        Assert.False(snapshot.Truncated); // File inventory is complete even when individual previews are unavailable.
        Assert.All(snapshot.Files, file => { Assert.Null(file.Patch); Assert.False(file.Binary); });
    }

    [Theory]
    [InlineData("@@ -1 +1 @@\n-old\n+new", 1, 1, true)]
    [InlineData("@@ -1,2 +1,2 @@\n-old\n+new", 1, 1, false)]
    [InlineData("@@ -1 +1 @@\n-old\n+new", 2, 1, false)]
    public void PatchCompletenessRequiresEveryHunkAndReportedLineCount(string patch, int added, int removed, bool complete)
        => Assert.Equal(complete, GitHubPublicationProvider.CompleteReviewPatch(patch, added, removed));
}
