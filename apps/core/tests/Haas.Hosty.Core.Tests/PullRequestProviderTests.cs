using System.Net;
using System.Text;
using System.Text.Json.Nodes;

namespace Haas.Hosty.Core.Tests;

public sealed class PullRequestProviderTests
{
    private sealed class Clock : IClock { public DateTimeOffset UtcNow => DateTimeOffset.Parse("2026-10-29T12:00:00Z"); }
    private sealed class Handler(Func<HttpRequestMessage, HttpResponseMessage> read) : HttpMessageHandler
    { protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) => Task.FromResult(read(request)); }
    private static UserProviderConnection Connection => new("c", "u", "GitHub", "github", "", "", "42", "owner", "pat", "test", null, null, null, new Clock().UtcNow, null, "connected", "r1");
    private static HttpResponseMessage Reply(string json, HttpStatusCode status = HttpStatusCode.OK) => new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
    [Fact]
    public async Task RepositoryRenameAcceptsOnlyFixedGitHubIdentityRedirect()
    {
        var paths = new List<string>();
        using var http = new HttpClient(new Handler(r => {
            paths.Add(r.RequestUri!.AbsoluteUri);
            if (paths.Count == 1) { var response = Reply("{}", HttpStatusCode.MovedPermanently); response.Headers.Location = new("https://api.github.com/repositories/42"); return response; }
            Assert.Equal("Bearer", r.Headers.Authorization!.Scheme);
            return Reply("""{"node_id":"R_42","full_name":"new-owner/new-name"}""");
        }));
        var repo = await new GitHubPublicationProvider(http, new Clock()).RepositoryAsync(Connection, "old/repo", default);
        Assert.Equal("R_42", repo.ProviderId); Assert.Equal("new-owner/new-name", repo.Name); Assert.Equal(2, paths.Count);
        using var hostile = new HttpClient(new Handler(_ => { var r = Reply("{}", HttpStatusCode.MovedPermanently); r.Headers.Location = new("https://untrusted.example/repositories/42"); return r; }));
        await Assert.ThrowsAsync<PullRequestException>(() => new GitHubPublicationProvider(hostile, new Clock()).RepositoryAsync(Connection, "old/repo", default));
    }
    [Fact]
    public async Task DiscoveryKeepsValidatorsAndDoesNotInterpret304AsAnEmptyInventory()
    {
        using var http = new HttpClient(new Handler(r => {
            Assert.Contains("sort=created&direction=desc&per_page=100&page=2", r.RequestUri!.Query);
            Assert.Equal("\"generation\"", Assert.Single(r.Headers.IfNoneMatch).Tag);
            return new(HttpStatusCode.NotModified);
        }));
        var page = await new GitHubPublicationProvider(http, new Clock()).ListPullRequestsAsync(Connection, "owner/repo", "id", 2, "\"generation\"", default);
        Assert.True(page.NotModified); Assert.Equal("\"generation\"", page.ETag);
    }
    [Fact]
    public async Task PartialChecksRemainUnknownAndReviewRejectsChangedHead()
    {
        using var http = new HttpClient(new Handler(_ => Reply("""{"data":{"repository":{"p0":{"id":"PR_1","number":1,"headRefOid":"old","baseRefOid":"base","state":"OPEN","commits":{"nodes":[]}},"pullRequest":{"headRefOid":"new","reviewThreads":{"nodes":[],"totalCount":0}}}},"errors":[{"message":"Some fields are unavailable"}]}""")));
        var provider = new GitHubPublicationProvider(http, new Clock());
        var pr = Assert.Single(await provider.ReadPullRequestsAsync(Connection, "owner/repo", "id", [1], default));
        Assert.Equal("unknown", pr.Checks.Completeness); Assert.Equal("partial", pr.Receipt.Completeness);
        var error = await Assert.ThrowsAsync<PullRequestException>(() => provider.ReadDiscussionAsync(Connection, "owner/repo", 1, "old", null, default));
        Assert.Equal("pr_changed", error.Code);
    }
    [Fact]
    public async Task ExistingPublicationCommandsKeepTheirRecoverableErrorContractWhenRateLimited()
    {
        using var http = new HttpClient(new Handler(_ => {
            var response = Reply("{}", HttpStatusCode.TooManyRequests);
            response.Headers.RetryAfter = new(TimeSpan.FromSeconds(30)); return response;
        }));
        var provider = new GitHubPublicationProvider(http, new Clock(), new PullRequestProviderBudget(new Clock()));
        var error = await Assert.ThrowsAsync<PublicationException>(() => provider.IdentityAsync(Connection, default));
        Assert.Equal("publication_pr_rate_limited", error.Code);
    }
    [Fact]
    public void JitterNeverShortensBaselineAndStaysWithinTenPercent()
    {
        foreach (var seconds in new[] { 10, 60, 300 })
        foreach (var key in Enumerable.Range(0, 100).Select(i => "resource-" + i))
            Assert.InRange(PullRequestPolicy.Jitter(TimeSpan.FromSeconds(seconds), key).TotalSeconds, seconds, seconds * 1.1);
    }
}
