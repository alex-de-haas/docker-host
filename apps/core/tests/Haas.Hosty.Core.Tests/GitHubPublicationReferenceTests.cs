using System.Text.Json.Nodes;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class GitHubPublicationTests
{
    [Theory]
    [InlineData("OPEN")]
    [InlineData("MERGED")]
    public async Task LinkedReferenceDisplaysAnotherBranchWithoutCreatingCompletionOrReviewEvidence(string state)
    {
        var http = new Http();
        var graph = JsonNode.Parse(Graph(state))!;
        var pr = graph["data"]!["repository"]!["pullRequest"]!;
        pr["headRefName"] = "hosty/session/another-task";
        pr["title"] = "docs(harness): verify published production runtimes";
        pr["comments"] = new JsonObject { ["totalCount"] = 2 };
        pr["reviewThreads"]!["nodes"] = new JsonArray(new JsonObject {
            ["id"] = "thread", ["isResolved"] = false, ["comments"] = new JsonObject {
                ["nodes"] = new JsonArray(new JsonObject { ["body"] = "Private review body" }) } });
        http.Replies.Enqueue(graph.ToJsonString());
        http.Replies.Enqueue(graph.ToJsonString());
        http.Replies.Enqueue(graph.ToJsonString());
        var provider = new GitHubPublicationProvider(new HttpClient(http), new Clock());
        var record = Record with { Number = 631, Policy = new(["Release"], [7], []) };

        var metadata = await provider.ObserveReferenceAsync(Connection, record, default);

        Assert.Equal("docs(harness): verify published production runtimes", metadata.Title);
        Assert.Equal(state.ToLowerInvariant(), metadata.State);
        Assert.Equal("SUCCESS", Assert.Single(metadata.Checks!).State);
        Assert.Equal("head", metadata.Head);
        Assert.Equal(2, metadata.CommentCount);
        Assert.Equal(1, metadata.UnresolvedThreads);
        Assert.False(metadata.Complete);
        Assert.Null(metadata.Reviews);
        Assert.Single(http.Calls); // Display never checks release/completion policy.
        var variables = JsonNode.Parse(http.Calls[0].Body)!["variables"]!;
        Assert.Equal("owner", variables["owner"]!.GetValue<string>());
        Assert.Equal("repo", variables["repo"]!.GetValue<string>());
        Assert.Equal(631, variables["number"]!.GetValue<int>());
        Assert.Equal("Bearer provider-secret", http.Calls[0].Authorization);
        Assert.Equal("publication_pr_mismatch", (await Assert.ThrowsAsync<PublicationException>(() => provider.ObserveAsync(Connection, record, default))).Code);
        Assert.Equal("publication_pr_mismatch", (await Assert.ThrowsAsync<PublicationException>(() => provider.ReadReviewSnapshotAsync(Connection, record, default))).Code);
        Assert.All(http.Calls, call => Assert.Equal("https://api.github.com/graphql", call.Url));
    }

    [Theory]
    [InlineData("another/repo", "main")]
    [InlineData("owner/repo", "another-target")]
    public async Task LinkedReferenceStillRejectsDifferentHeadRepositoryOrTarget(string headRepository, string target)
    {
        var http = new Http();
        var graph = JsonNode.Parse(Graph(headRepo: headRepository))!;
        graph["data"]!["repository"]!["pullRequest"]!["baseRefName"] = target;
        http.Replies.Enqueue(graph.ToJsonString());
        var error = await Assert.ThrowsAsync<PublicationException>(() => new GitHubPublicationProvider(new HttpClient(http), new Clock()).ObserveReferenceAsync(Connection, Record, default));
        Assert.Equal("publication_pr_mismatch", error.Code);
    }
}
