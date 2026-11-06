using System.Net;
using System.Text.Json.Nodes;

namespace Haas.Hosty.Core.Tests;

public sealed partial class GitHubPublicationTests
{
    [Fact]
    public async Task BackgroundVerifier_AfterCompactRead_WaitsForPacingAndCompletesReleaseChecks()
    {
        var http = new Http(); var clock = new Clock();
        http.Replies.Enqueue("""{"data":{"repository":{"p0":{"id":"PR_42","number":42,"state":"MERGED"}}}}""");
        http.Replies.Enqueue(Graph("MERGED"));
        http.Replies.Enqueue("""{"total_count":1,"check_runs":[{"name":"release","head_sha":"merge","conclusion":"success","status":"completed"}]}""");
        var provider = new GitHubPublicationProvider(new HttpClient(http), clock, new PullRequestProviderBudget(clock));
        using var automatic = PullRequestProviderBudget.AutomaticScope();
        await provider.ReadPullRequestsAsync(Connection, Record.Repository, "repo", [42], default);
        var observed = await provider.ObserveAsync(Connection, Record with { Policy = new(["release"], [], []) }, default);
        Assert.True(observed.Complete); Assert.Null(observed.Error); Assert.Equal(3, http.Calls.Count);
        Assert.Contains("/check-runs", http.Calls[^1].Url);
    }

    [Fact]
    public async Task BackgroundVerifier_PacingWait_CanBeCancelled()
    {
        var http = new Http(); var clock = new Clock();
        http.Replies.Enqueue("""{"data":{"repository":{"p0":{"id":"PR_42","number":42,"state":"MERGED"}}}}""");
        var provider = new GitHubPublicationProvider(new HttpClient(http), clock, new PullRequestProviderBudget(clock));
        using var automatic = PullRequestProviderBudget.AutomaticScope();
        await provider.ReadPullRequestsAsync(Connection, Record.Repository, "repo", [42], default);
        using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(50));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => provider.ObserveAsync(Connection, Record, cancellation.Token));
        Assert.Single(http.Calls);
    }

    [Fact]
    public async Task BackgroundVerifier_ExhaustedAutomaticBudget_DoesNotBypassReserve()
    {
        var http = new Http(); var clock = new Clock();
        var payload = JsonNode.Parse("""{"data":{"repository":{"p0":{"id":"PR_42","number":42,"state":"MERGED"}},"rateLimit":{"cost":1,"limit":1000,"remaining":199}}}""")!;
        payload["data"]!["rateLimit"]!["resetAt"] = clock.UtcNow.AddHours(1).ToString("O");
        http.Replies.Enqueue(payload.ToJsonString());
        var provider = new GitHubPublicationProvider(new HttpClient(http), clock, new PullRequestProviderBudget(clock));
        using var automatic = PullRequestProviderBudget.AutomaticScope();
        await provider.ReadPullRequestsAsync(Connection, Record.Repository, "repo", [42], default);
        var error = await Assert.ThrowsAsync<PublicationException>(() => provider.ObserveAsync(Connection, Record, default));
        Assert.Equal("publication_pr_rate_limited", error.Code); Assert.Single(http.Calls);
    }
}
