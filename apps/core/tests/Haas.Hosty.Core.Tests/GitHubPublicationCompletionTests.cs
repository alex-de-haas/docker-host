using System.Net;
using System.Text.Json.Nodes;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class GitHubPublicationTests
{
    [Theory]
    [InlineData("head", "completed", "success", "missing")]
    [InlineData("merge", "queued", "", "pending")]
    [InlineData("merge", "in_progress", "", "pending")]
    [InlineData("merge", "completed", "failure", "failed")]
    [InlineData("merge", "completed", "skipped", "failed")]
    [InlineData("merge", "completed", "", "unavailable")]
    [InlineData("merge", "completed", "success", null)]
    public async Task Completion_CheckDiagnosticsNeverSubstitutePrHead(string sha, string status, string conclusion, string? expected)
    {
        var h = new Http(); h.Replies.Enqueue(Graph("MERGED"));
        h.Replies.Enqueue(new JsonObject { ["total_count"] = 1, ["check_runs"] = new JsonArray(new JsonObject {
            ["name"] = "CI", ["head_sha"] = sha, ["status"] = status, ["conclusion"] = conclusion }) }.ToJsonString());
        var result = await new GitHubPublicationProvider(new HttpClient(h), new Clock()).ObserveAsync(Connection,
            Record with { Policy = new(["CI"], [], []) }, default);
        Assert.Equal(expected is null, result.Complete);
        Assert.Equal(expected is null ? null : new PublicationCompletionIssue("check", "CI", expected, "merge"), result.CompletionIssue);
        if (expected is not null) { Assert.Contains("merge commit merge", result.Error); Assert.Contains("CI", result.Error); }
    }

    [Theory]
    [InlineData("push", "merge", "main", "completed", "success", null)]
    [InlineData("workflow_run", "merge", "main", "completed", "success", null)]
    [InlineData("pull_request", "merge", "main", "completed", "success", "missing")]
    [InlineData("pull_request_target", "merge", "main", "completed", "success", "missing")]
    [InlineData("push", "other", "main", "completed", "success", "missing")]
    [InlineData("push", "merge", "other", "completed", "success", "missing")]
    [InlineData("push", "merge", "main", "in_progress", "", "pending")]
    [InlineData("push", "merge", "main", "completed", "failure", "failed")]
    public async Task Completion_ReleaseWorkflowUsesExactMergeAndLatestRun(string eventName, string head, string branch,
        string status, string conclusion, string? expected)
    {
        var h = new Http(); h.Replies.Enqueue(Graph("MERGED"));
        var runs = new JsonArray(new JsonObject { ["head_sha"] = head, ["head_branch"] = branch, ["event"] = eventName,
            ["run_number"] = 2, ["status"] = status, ["conclusion"] = conclusion });
        if (expected is "pending" or "failed") runs.Add(new JsonObject { ["head_sha"] = "merge", ["head_branch"] = "main",
            ["event"] = "push", ["run_number"] = 1, ["status"] = "completed", ["conclusion"] = "success" });
        h.Replies.Enqueue(new JsonObject { ["total_count"] = runs.Count, ["workflow_runs"] = runs }.ToJsonString());
        var result = await new GitHubPublicationProvider(new HttpClient(h), new Clock()).ObserveAsync(Connection,
            Record with { Policy = new([], [17], []) }, default);
        Assert.Equal(expected is null, result.Complete);
        Assert.Equal(expected is null ? null : new PublicationCompletionIssue("workflow", "17", expected, "merge"), result.CompletionIssue);
    }

    [Theory]
    [InlineData("{}", false)]
    [InlineData("{\"total_count\":2,\"check_runs\":[]}", false)]
    [InlineData("{\"secret\":\"provider-secret\"}", true)]
    public async Task Completion_UnavailableEvidencePreservesMergedStateWithoutProviderSecrets(string body, bool forbidden)
    {
        var h = new Http(); h.Replies.Enqueue(Graph("MERGED")); h.Replies.Enqueue(body);
        if (forbidden) h.Statuses[2] = HttpStatusCode.Forbidden;
        var result = await new GitHubPublicationProvider(new HttpClient(h), new Clock()).ObserveAsync(Connection,
            Record with { Policy = new(["Docker"], [], []) }, default);
        Assert.Equal("merged", result.State); Assert.False(result.Complete);
        Assert.Equal(new("check", "Docker", "unavailable", "merge"), result.CompletionIssue);
        Assert.DoesNotContain("provider-secret", CoreJson.Text(result));
    }

    [Theory]
    [InlineData("other", false, "uploaded", "unverified")]
    [InlineData("merge", true, "uploaded", "pending")]
    [InlineData("merge", false, "new", "pending")]
    [InlineData("merge", false, "uploaded", null)]
    public async Task Completion_ArtifactDiagnosticsRemainMergeBound(string head, bool draft, string state, string? expected)
    {
        var h = new Http(); h.Replies.Enqueue(Graph("MERGED")); h.Replies.Enqueue(new JsonObject { ["sha"] = head }.ToJsonString());
        if (head == "merge") h.Replies.Enqueue(new JsonObject { ["draft"] = draft,
            ["assets"] = new JsonArray(new JsonObject { ["name"] = "bundle.zip", ["state"] = state }) }.ToJsonString());
        var result = await new GitHubPublicationProvider(new HttpClient(h), new Clock()).ObserveAsync(Connection,
            Record with { Policy = new([], [], [new("v1.2.3", "bundle.zip")]) }, default);
        Assert.Equal(expected is null, result.Complete);
        Assert.Equal(expected, result.CompletionIssue?.State);
        if (expected is not null) Assert.Equal("release:v1.2.3/bundle.zip", result.CompletionIssue?.Requirement);
    }
}
