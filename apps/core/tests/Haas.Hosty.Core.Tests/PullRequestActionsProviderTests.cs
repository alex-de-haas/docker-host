using System.Net;
using System.Text;
using System.Text.Json.Nodes;

namespace Haas.Hosty.Core.Tests;

public sealed class PullRequestActionsProviderTests
{
    private sealed class Clock : IClock { public DateTimeOffset UtcNow => DateTimeOffset.Parse("2026-10-30T10:00:00Z"); }
    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> send) : HttpMessageHandler
    { protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) => Task.FromResult(send(request)); }
    private static UserProviderConnection Connection => new("c", "u", "GitHub", "github", "", "", "42", "owner", "pat", "test", null, null, null, new Clock().UtcNow, null, "connected", "r1");
    private static HttpResponseMessage Reply(string json) => new(HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
    private static PullRequestCommand Command => new(Guid.NewGuid().ToString(), "merge", new('a', 40), new('b', 40));
    [Fact]
    public async Task AsyncMergeUsesExactHeadAndExplicitNoBypassThenObservesProviderReceipt()
    {
        var command = Command; var puts = 0; var before = 0; var id = Guid.NewGuid().ToString();
        using var http = new HttpClient(new Handler(r => {
            Assert.Equal("2026-03-10", Assert.Single(r.Headers.GetValues("X-GitHub-Api-Version")));
            if (r.Method == HttpMethod.Put)
            {
                puts++; var body = JsonNode.Parse(r.Content!.ReadAsStringAsync().GetAwaiter().GetResult())!;
                Assert.Equal(command.Head, body["sha"]!.ToString()); Assert.Equal("merge", body["merge_method"]!.ToString());
                Assert.Equal("direct_merge", body["merge_action"]!.ToString()); Assert.False(body["bypass_rules"]!.GetValue<bool>());
                return Reply("{\"status\":\"pending\",\"details\":{\"uuid\":\"" + id + "\"}}");
            }
            return r.RequestUri!.AbsolutePath.EndsWith(id, StringComparison.Ordinal) ? Reply("{\"status\":\"merged\"}") :
                Reply("{\"merged\":true,\"head\":{\"sha\":\"" + command.Head + "\"}}");
        }));
        var provider = new GitHubPublicationProvider(http, new Clock());
        var pending = await provider.ExecuteActionAsync(Connection, "owner/repo", 1, command, () => { before++; return Task.CompletedTask; }, default);
        Assert.Equal("pending", pending.State); Assert.Equal(id, pending.ProviderRequestId);
        var result = await provider.RecoverActionAsync(Connection, "owner/repo", 1, command, pending, default);
        Assert.Equal("merged", result.State); Assert.Equal(1, puts); Assert.Equal(1, before);
    }
    [Fact]
    public async Task AlreadyMergedAtAnotherHeadIsNotProofThatTheRequestedHeadMerged()
    {
        using var http = new HttpClient(new Handler(r => r.Method == HttpMethod.Put ? Reply("{\"status\":\"merged\"}") :
            Reply("{\"merged\":true,\"head\":{\"sha\":\"" + new string('c', 40) + "\"}}")));
        var result = await new GitHubPublicationProvider(http, new Clock()).ExecuteActionAsync(Connection, "owner/repo", 1, Command, () => Task.CompletedTask, default);
        Assert.Equal("unknown", result.State);
    }
    [Fact]
    public async Task ExplicitRateLimitRejectionDoesNotBecomeAnUncertainWrite()
    {
        using var http = new HttpClient(new Handler(_ => { var response = Reply("{}"); response.StatusCode = HttpStatusCode.TooManyRequests; return response; }));
        var provider = new GitHubPublicationProvider(http, new Clock(), new PullRequestProviderBudget(new Clock()));
        var result = await provider.ExecuteActionAsync(Connection, "owner/repo", 1, Command, () => Task.CompletedTask, default);
        Assert.Equal("failed", result.State);
    }
    [Theory]
    [InlineData("dirty", false, false)]
    [InlineData("unknown", false, false)]
    [InlineData("blocked", false, false)]
    [InlineData("clean", true, false)]
    [InlineData("behind", false, true)]
    public async Task EligibilityUsesGitHubRequirementsNotOnlyCheckCounts(string state, bool merge, bool update)
    {
        using var http = new HttpClient(new Handler(r => r.RequestUri!.AbsolutePath.EndsWith("/pulls/1", StringComparison.Ordinal)
            ? Reply("{\"state\":\"open\",\"draft\":false,\"mergeable\":true,\"mergeable_state\":\"" + state + "\",\"auto_merge\":{\"merge_method\":\"merge\"},\"head\":{\"sha\":\"" + new string('a', 40) + "\",\"repo\":{\"full_name\":\"owner/repo\"}},\"base\":{\"sha\":\"" + new string('b', 40) + "\"}}")
            : Reply("{\"full_name\":\"owner/repo\",\"permissions\":{\"push\":true},\"allow_merge_commit\":true}")));
        var result = await new GitHubPublicationProvider(http, new Clock()).ActionsAsync(Connection, "owner/repo", 1, default);
        Assert.Equal(merge, result.Merge.Enabled); Assert.Equal(update, result.UpdateBranch.Enabled); Assert.Equal("enabled", result.AutoMerge);
    }
}
