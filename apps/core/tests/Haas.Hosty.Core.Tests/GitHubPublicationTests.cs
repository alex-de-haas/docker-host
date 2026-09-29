using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class GitHubPublicationTests
{
    private sealed class Clock : IClock { public DateTimeOffset UtcNow => DateTimeOffset.Parse("2026-09-29T12:00:00Z"); }
    private sealed class Http : HttpMessageHandler
    {
        public readonly Queue<string> Replies = new();
        public readonly Dictionary<int, HttpStatusCode> Statuses = new();
        public readonly List<(string Url, string? Authorization, string Body)> Calls = [];
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Calls.Add((request.RequestUri!.ToString(), request.Headers.Authorization?.ToString(), request.Content is null ? "" : await request.Content.ReadAsStringAsync(ct)));
            Assert.NotEmpty(Replies);
            return new(Statuses.GetValueOrDefault(Calls.Count, HttpStatusCode.OK)) { Content = new StringContent(Replies.Dequeue(), Encoding.UTF8, "application/json") };
        }
    }
    private static UserProviderConnection Connection => new("c", "admin", "GitHub", "github", "", "", "42", "owner", "pat", "provider-secret", null, null, null, DateTimeOffset.UtcNow, null, "connected", "r");
    private static PublicationRecord Record => new() { WorkspaceId = new('a', 64), Owner = new("assistant", DateTimeOffset.UtcNow, "admin", "session"), Repository = "owner/repo", HeadRepository = "owner/repo", ConnectionId = "c", Branch = "feature", TargetBranch = "main", Number = 42 };
    private static string Graph(string state = "OPEN", string headRepo = "owner/repo", string head = "head", bool more = false)
        => new JsonObject { ["data"] = new JsonObject { ["repository"] = new JsonObject { ["pullRequest"] = new JsonObject {
            ["id"] = "PR_42", ["state"] = state, ["isDraft"] = false, ["headRefName"] = "feature", ["headRefOid"] = head, ["baseRefName"] = "main", ["headRepository"] = new JsonObject { ["nameWithOwner"] = headRepo },
            ["mergeCommit"] = new JsonObject { ["oid"] = "merge" }, ["mergeStateStatus"] = "CLEAN", ["reviewDecision"] = "APPROVED",
            ["reviewThreads"] = new JsonObject { ["pageInfo"] = new JsonObject { ["hasNextPage"] = more }, ["nodes"] = new JsonArray() },
            ["commits"] = new JsonObject { ["nodes"] = new JsonArray(new JsonObject { ["commit"] = new JsonObject { ["statusCheckRollup"] = new JsonObject { ["contexts"] = new JsonObject { ["pageInfo"] = new JsonObject { ["hasNextPage"] = false }, ["nodes"] = new JsonArray(new JsonObject { ["name"] = "CI", ["status"] = "COMPLETED", ["conclusion"] = "SUCCESS" }) } } } }) }
        } } } }.ToJsonString();
    [Theory]
    [InlineData("https://github.com/owner/repo.git", "owner/repo")]
    [InlineData("https://github.com/owner/repo.git-tools", "owner/repo.git-tools")]
    public void RepositoryStripsOnlyTheGitSuffix(string url, string expected) => Assert.Equal(expected, GitHubPublicationProvider.Repository(url));
    [Theory]
    [InlineData("https://github.com.evil.test/o/r")]
    [InlineData("https://token@github.com/o/r")]
    [InlineData("https://github.com/o/r?token=secret")]
    public void RepositoryRefusesNoncanonicalCredentialDestinations(string url) => Assert.Throws<PublicationException>(() => GitHubPublicationProvider.Repository(url));
    [Fact]
    public async Task ForkIsVerifiedAgainstUpstreamNetworkAndPushRights()
    {
        var h = new Http(); h.Replies.Enqueue("""{"full_name":"owner/repo","permissions":{"push":false}}""");
        h.Replies.Enqueue("""{"id":42,"login":"user"}"""); h.Replies.Enqueue("[]");
        h.Replies.Enqueue("""{"full_name":"user/repo"}"""); h.Replies.Enqueue(Fork());
        var provider = new GitHubPublicationProvider(new HttpClient(h), new Clock());
        Assert.Equal("user/repo", await provider.DestinationAsync(Connection, "owner/repo", false, default));
        Assert.All(h.Calls, call => { Assert.StartsWith("https://api.github.com/", call.Url); Assert.Equal("Bearer provider-secret", call.Authorization); });
    }
    private static string Fork(string name = "user/repo") => new JsonObject {
        ["full_name"] = name, ["fork"] = true, ["owner"] = new JsonObject { ["id"] = 42 },
        ["source"] = new JsonObject { ["full_name"] = "owner/repo" }, ["permissions"] = new JsonObject { ["push"] = true }
    }.ToJsonString();
    [Fact]
    public async Task ExistingRenamedForkIsReusedWithoutCreatingAnother()
    {
        var h = new Http(); h.Replies.Enqueue("""{"full_name":"owner/repo","permissions":{"push":false}}""");
        h.Replies.Enqueue("""{"id":42,"login":"user"}""");
        h.Replies.Enqueue("[" + Fork("user/renamed") + "]"); h.Replies.Enqueue(Fork("user/renamed"));
        Assert.Equal("user/renamed", await new GitHubPublicationProvider(new HttpClient(h), new Clock()).DestinationAsync(Connection, "owner/repo", false, default));
        Assert.DoesNotContain(h.Calls, c => c.Url.EndsWith("/forks"));
    }
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ForkReconcilesLostCreateResponseOrDelayedLookup(bool delayedLookup)
    {
        var h = new Http(); h.Replies.Enqueue("""{"full_name":"owner/repo","permissions":{"push":false}}""");
        h.Replies.Enqueue("""{"id":42,"login":"user"}"""); h.Replies.Enqueue("[]");
        h.Replies.Enqueue(delayedLookup ? """{"full_name":"user/repo"}""" : "{}");
        if (delayedLookup) { h.Replies.Enqueue("{}"); h.Statuses[5] = HttpStatusCode.NotFound; }
        else h.Statuses[4] = HttpStatusCode.BadGateway;
        h.Replies.Enqueue("[" + Fork() + "]"); h.Replies.Enqueue(Fork());
        Assert.Equal("user/repo", await new GitHubPublicationProvider(new HttpClient(h), new Clock()).DestinationAsync(Connection, "owner/repo", false, default));
        Assert.Single(h.Calls, c => c.Url.EndsWith("/forks"));
    }
    [Theory]
    [InlineData("success", true)]
    [InlineData("failure", false)]
    public async Task RequiredChecksShareOneHeadBoundSnapshot(string second, bool complete)
    {
        var h = new Http(); h.Replies.Enqueue(Graph("MERGED"));
        h.Replies.Enqueue(new JsonObject { ["total_count"] = 2, ["check_runs"] = new JsonArray(
            new JsonObject { ["name"] = "build", ["head_sha"] = "merge", ["conclusion"] = "success", ["status"] = "completed" },
            new JsonObject { ["name"] = "test", ["head_sha"] = "merge", ["conclusion"] = second, ["status"] = "completed" }) }.ToJsonString());
        var observed = await new GitHubPublicationProvider(new HttpClient(h), new Clock()).ObserveAsync(Connection, Record with { Policy = new(["build", "test"], [], []) }, default);
        Assert.Equal(complete, observed.Complete);
        Assert.Single(h.Calls, c => c.Url.Contains("/check-runs?"));
    }
    [Fact]
    public async Task ObservationRefusesForeignHeadAndTruncatedReviewData()
    {
        var h = new Http(); h.Replies.Enqueue(Graph(headRepo: "other/repo")); h.Replies.Enqueue(Graph(more: true));
        var provider = new GitHubPublicationProvider(new HttpClient(h), new Clock());
        await Assert.ThrowsAsync<PublicationException>(() => provider.ObserveAsync(Connection, Record, default));
        await Assert.ThrowsAsync<PublicationException>(() => provider.ObserveAsync(Connection, Record, default));
    }
    [Fact]
    public async Task ReadyDoesNotRepeatMutationForAnAlreadyReadyPr()
    {
        var h = new Http(); h.Replies.Enqueue(Graph());
        await new GitHubPublicationProvider(new HttpClient(h), new Clock()).ReadyAsync(Connection, Record, default);
        Assert.Single(h.Calls);
    }
    [Fact]
    public async Task MergeCarriesTheExactHeadAndMethod()
    {
        var h = new Http(); h.Replies.Enqueue("""{"merged":true}""");
        await new GitHubPublicationProvider(new HttpClient(h), new Clock()).MergeAsync(Connection, Record, "head", "merge", default);
        var body = JsonNode.Parse(Assert.Single(h.Calls).Body)!;
        Assert.Equal("head", body["sha"]!.GetValue<string>()); Assert.Equal("merge", body["merge_method"]!.GetValue<string>());
    }
    [Fact]
    public async Task PostMergeChecksAndReleaseMustMatchActualMergeCommit()
    {
        var h = new Http(); h.Replies.Enqueue(Graph("MERGED"));
        h.Replies.Enqueue("""{"total_count":1,"workflow_runs":[{"head_sha":"merge","head_branch":"main","event":"push","run_number":3,"conclusion":"success"}]}""");
        h.Replies.Enqueue("""{"sha":"unrelated-later-main"}""");
        var record = Record with { Policy = new([], [17], [new("v1.2.3", "release.zip")]) };
        var observed = await new GitHubPublicationProvider(new HttpClient(h), new Clock()).ObserveAsync(Connection, record, default);
        Assert.Equal("merged", observed.State); Assert.False(observed.Complete);
        Assert.Contains("head_sha=merge", h.Calls[1].Url);
    }
    [Fact]
    public async Task ExactNpmVersionUsesAnonymousMetadataAndRequiresMergeGitHead()
    {
        var h = new Http(); h.Replies.Enqueue("""{"name":"@owner/sdk","version":"1.2.3","gitHead":"merge","dist":{"integrity":"sha512-example"}}""");
        var verifier = new PublicationArtifacts(new HttpClient(h));
        Assert.True(await verifier.Verify(new(Kind: "npm", Package: "@owner/sdk", Version: "1.2.3"), "owner/repo", "merge", default));
        Assert.Null(Assert.Single(h.Calls).Authorization);
        Assert.StartsWith("https://registry.npmjs.org/", h.Calls[0].Url);
        Assert.Throws<PublicationException>(() => PublicationArtifacts.Validate(new(Kind: "npm", Package: "@owner/sdk", Version: "latest")));
    }
    [Theory]
    [InlineData("merge", true)]
    [InlineData("unrelated", false)]
    public async Task GhcrExactVersionVerifiesConfigDigestAndMergeRevision(string revision, bool expected)
    {
        var config = new JsonObject { ["config"] = new JsonObject { ["Labels"] = new JsonObject {
            ["org.opencontainers.image.source"] = "https://github.com/owner/repo",
            ["org.opencontainers.image.revision"] = revision } } }.ToJsonString();
        var digest = "sha256:" + Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(config)));
        var h = new Http();
        h.Replies.Enqueue("""{"token":"anonymous-registry-token"}""");
        h.Replies.Enqueue(new JsonObject { ["config"] = new JsonObject { ["digest"] = digest } }.ToJsonString());
        h.Replies.Enqueue(config);
        Assert.Equal(expected, await new PublicationArtifacts(new HttpClient(h)).Verify(new(Kind: "ghcr", Package: "owner/image", Version: "1.2.3"), "owner/repo", "merge", default));
        Assert.Null(h.Calls[0].Authorization);
        Assert.All(h.Calls.Skip(1), call => Assert.Equal("Bearer anonymous-registry-token", call.Authorization));
        Assert.EndsWith("/manifests/1.2.3", h.Calls[1].Url);
    }
    [Fact]
    public async Task ReviewResolutionRequiresTheCurrentHeadAndAnOwnedThread()
    {
        var h = new Http();
        var graph = JsonNode.Parse(Graph())!;
        graph["data"]!["repository"]!["pullRequest"]!["reviewThreads"]!["nodes"] = new JsonArray(new JsonObject { ["id"] = "thread", ["isResolved"] = false });
        h.Replies.Enqueue(graph.ToJsonString());
        h.Replies.Enqueue(graph.ToJsonString());
        h.Replies.Enqueue(graph.ToJsonString());
        h.Replies.Enqueue("""{"data":{"resolveReviewThread":{"thread":{"id":"thread","isResolved":true}}}}""");
        var provider = new GitHubPublicationProvider(new HttpClient(h), new Clock());
        await Assert.ThrowsAsync<PublicationException>(() => provider.ResolveReviewAsync(Connection, Record, "thread", "stale", default));
        await Assert.ThrowsAsync<PublicationException>(() => provider.ResolveReviewAsync(Connection, Record, "foreign", "head", default));
        await provider.ResolveReviewAsync(Connection, Record, "thread", "head", default);
        Assert.Equal(4, h.Calls.Count);
        Assert.Contains("resolveReviewThread", h.Calls.Last().Body);
    }
    [Fact]
    public async Task ProviderIdentityRequiresMatchingAccountAndVerifiedEmail()
    {
        var h = new Http(); h.Replies.Enqueue("""{"id":42,"login":"owner","name":"User"}""");
        h.Replies.Enqueue("""[{"email":"unverified@example.test","primary":true,"verified":false}]""");
        await Assert.ThrowsAsync<PublicationException>(() => new GitHubPublicationProvider(new HttpClient(h), new Clock()).IdentityAsync(Connection, default));
    }
}
