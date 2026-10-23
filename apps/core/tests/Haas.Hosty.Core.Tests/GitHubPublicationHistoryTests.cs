using System.Text.Json.Nodes;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class GitHubPublicationTests
{
    [Theory]
    [InlineData("MERGED", "2026-10-20T13:00:00Z", true)]
    [InlineData("MERGED", "invalid", false)]
    [InlineData("OPEN", "2026-10-20T13:00:00Z", false)]
    public async Task ObservationPreservesOnlyFactualMergedAt(string state, string timestamp, bool expected)
    {
        var h = new Http();
        var response = JsonNode.Parse(Graph(state))!;
        response["data"]!["repository"]!["pullRequest"]!["mergedAt"] = timestamp;
        h.Replies.Enqueue(response.ToJsonString());
        var result = await new GitHubPublicationProvider(new HttpClient(h), new Clock()).ObserveAsync(Connection, Record, default);
        Assert.Equal(expected ? DateTimeOffset.Parse(timestamp) : (DateTimeOffset?)null, result.MergedAt);
        Assert.Contains("mergedAt", Assert.Single(h.Calls).Body);
    }
}
