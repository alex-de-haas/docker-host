using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Haas.Hosty.Core.Tests.Http;

public sealed partial class PullRequestHttpTests
{
    private sealed class Clock : IClock { public DateTimeOffset UtcNow { get; set; } = DateTimeOffset.Parse("2026-10-29T12:00:00Z"); }
    private sealed class Provider(Clock clock) : HttpMessageHandler
    {
        public int Lists, StatusReads;
        public Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>?>? Intercept;
        public bool Denied, Active = true, Closed;
        public int Writes;
        public bool Draft = true, Merged, LoseResponse, DenyWrite, WriteAccess = true;
        public string MergeState = "clean";
        public string Head = new('a', 40);
        public readonly List<string> Calls = [];
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Calls.Add(request.RequestUri!.PathAndQuery);
            if (Intercept?.Invoke(request, ct) is { } response) return response;
            if (Denied) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden) { Content = new StringContent("{}") });
            object value;
            if (request.Method == HttpMethod.Put)
            {
                Writes++;
                if (DenyWrite) return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden) { Content = new StringContent("{}") });
                var body = JsonNode.Parse(request.Content!.ReadAsStringAsync(ct).GetAwaiter().GetResult())!;
                if (request.RequestUri.AbsolutePath.EndsWith("/merge-async", StringComparison.Ordinal))
                {
                    Assert.Equal(Head, body["sha"]!.ToString()); Assert.Equal("merge", body["merge_method"]!.ToString());
                    Assert.Equal("direct_merge", body["merge_action"]!.ToString()); Assert.False(body["bypass_rules"]!.GetValue<bool>());
                    Merged = true;
                }
                else { Assert.Equal(Head, body["expected_head_sha"]!.ToString()); Head = new('c', 40); MergeState = "clean"; }
                if (LoseResponse) throw new HttpRequestException("Lost after remote acceptance");
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Accepted) { Content = JsonContent.Create(new { status = Merged ? "merged" : "pending" }) });
            }
            if (request.RequestUri.AbsolutePath.Contains("/compare/", StringComparison.Ordinal)) value = new { status = "ahead" };
            else if (request.RequestUri.AbsolutePath.EndsWith("/pulls/1", StringComparison.Ordinal)) value = new {
                number = 1, state = Merged ? "closed" : "open", merged = Merged, draft = Draft, mergeable = true, mergeable_state = MergeState,
                head = new { sha = Head, repo = new { full_name = "owner/repo" } }, @base = new { sha = new string('b', 40) }
            };
            else
            if (request.RequestUri.AbsolutePath == "/graphql")
            {
                StatusReads++;
                value = new { data = new { repository = new { p0 = new {
                    id = "PR_1", number = 1, title = "Update dependencies", state = Closed ? "CLOSED" : "OPEN", isDraft = true,
                    updatedAt = clock.UtcNow, headRefName = "bot/deps", headRefOid = Head, baseRefName = "main", baseRefOid = new string('b', 40),
                    author = new { login = "dependabot", __typename = "Bot" }, reviewDecision = "REVIEW_REQUIRED", mergeStateStatus = "BLOCKED",
                    comments = new { totalCount = 2 }, commits = new { nodes = new[] { new { commit = new { statusCheckRollup = new { contexts = new {
                        totalCount = 1, pageInfo = new { hasNextPage = false }, nodes = new[] { new { id = "CHECK_1", name = "CI", status = Active ? "IN_PROGRESS" : "COMPLETED", conclusion = Active ? "" : "SKIPPED", detailsUrl = "https://github.com/owner/repo/actions/runs/1" } }
                    } } } } } }
                } } } };
            }
            else if (request.RequestUri.AbsolutePath.EndsWith("/pulls", StringComparison.Ordinal))
            {
                Lists++;
                value = Closed ? Array.Empty<object>() : new object[] { new { node_id = "PR_1", number = 1, title = "Update dependencies", state = "open", draft = true,
                    updated_at = clock.UtcNow, user = new { login = "dependabot", type = "Bot" }, head = new { sha = Head, @ref = "bot/deps" }, @base = new { sha = new string('b', 40), @ref = "main" } } };
            }
            else value = new { node_id = "REPO_1", full_name = "owner/repo", permissions = new { push = WriteAccess }, allow_merge_commit = true, allow_auto_merge = true, archived = false };
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = JsonContent.Create(value) });
        }
    }
    private static UserProviderConnection Connection(Clock clock, string user = "admin", string id = "connection")
        => new(id, user, "GitHub", "github", "", "", "42", "owner", "pat", "fixture-secret", null, null, null, clock.UtcNow, null, "connected", "r1");
    private static async Task<(CoreHttpHarness Host, Clock Clock, Provider Provider, HttpClient Client, PullRequestService Service)> Start()
    {
        var clock = new Clock(); var provider = new Provider(clock);
        var host = await CoreHttpHarness.StartAsync(clock, services =>
        {
            services.RemoveAll<SourceProviderRegistry>();
            services.AddSingleton(new SourceProviderRegistry([new GitHubSourceProvider(new HttpClient(provider), new ConfigurationBuilder().Build(), clock)]));
        });
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1,
            [new("admin", "admin@example.test", "Admin", "host.admin", false, clock.UtcNow, clock.UtcNow)], [], [],
            [new("session", "admin", clock.UtcNow, clock.UtcNow.AddHours(8), null, clock.UtcNow)], ProviderConnections: [Connection(clock)]));
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        foreach (var id in new[] { "unrelated.vendor.one", "another.vendor.two" })
            await apps.UpsertAppAsync(AssistantMcpAccessHttpTests.Record(id, clock.UtcNow) with { RuntimeState = "stopped",
                SourceState = new("git", "https://github.com/owner/repo.git", id == "another.vendor.two" ? "other-branch" : "main", null, null, null, clock.UtcNow, id) });
        var client = host.CreateClient(); client.DefaultRequestHeaders.Authorization = new("Bearer", "session");
        return (host, clock, provider, client, host.Services.GetRequiredService<PullRequestService>());
    }
    private static async Task<string> Populate(PullRequestService service)
    {
        await service.RepositoriesAsync(new("admin"), default);
        await service.TickAsync(default); // access proof
        await service.TickAsync(default); // inventory
        await service.TickAsync(default); // current-head facts
        return Assert.Single((await service.RepositoriesAsync(new("admin"), default)).Repositories).Id;
    }
    [Fact]
    public async Task ManualActionsRejectStaleHeadsAndDraftsBeforeAnyWrite()
    {
        var f = await Start(); await using var host = f.Host; using var client = f.Client;
        var id = await Populate(f.Service); var route = $"/api/pull-requests/{id}/1/actions";
        var caps = await client.GetFromJsonAsync<PullRequestActions>(route); Assert.False(caps!.Merge.Enabled);
        var draft = await client.PostAsJsonAsync(route, new PullRequestCommand(Guid.NewGuid().ToString(), "merge", f.Provider.Head, new('b', 40)));
        Assert.Equal(HttpStatusCode.Conflict, draft.StatusCode);
        f.Provider.Draft = false;
        var stale = await client.PostAsJsonAsync(route, new PullRequestCommand(Guid.NewGuid().ToString(), "merge", new('f', 40), new('b', 40)));
        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode); Assert.Equal(0, f.Provider.Writes);
        f.Provider.WriteAccess = false;
        caps = await client.GetFromJsonAsync<PullRequestActions>(route); Assert.False(caps!.Merge.Enabled);
    }
    [Fact]
    public async Task UncertainMergeIsPersistedRestoredAndRecoveredWithoutResending()
    {
        var f = await Start(); await using var host = f.Host; using var client = f.Client;
        var id = await Populate(f.Service); var route = $"/api/pull-requests/{id}/1/actions";
        f.Provider.Draft = false; f.Provider.LoseResponse = true;
        var input = new PullRequestCommand(Guid.NewGuid().ToString(), "merge", f.Provider.Head, new('b', 40));
        var absent = await client.PostAsJsonAsync(route + "/recover", input); absent.EnsureSuccessStatusCode();
        Assert.Equal("failed", (await absent.Content.ReadFromJsonAsync<PullRequestCommandResult>())!.State); Assert.Equal(0, f.Provider.Writes);
        var first = await client.PostAsJsonAsync(route, input); first.EnsureSuccessStatusCode();
        Assert.Equal("unknown", (await first.Content.ReadFromJsonAsync<PullRequestCommandResult>())!.State);
        var caps = await client.GetFromJsonAsync<PullRequestActions>(route); Assert.Equal(input, caps!.PendingCommand);
        var restored = ActivatorUtilities.CreateInstance<PullRequestService>(host.Services);
        Assert.Equal(id, await Populate(restored));
        var restoredCaps = await restored.ActionsAsync(new("admin"), id, 1, default); Assert.Equal(input, restoredCaps.PendingCommand);
        var replay = await client.PostAsJsonAsync(route + "/recover", input); replay.EnsureSuccessStatusCode();
        Assert.Equal("merged", (await replay.Content.ReadFromJsonAsync<PullRequestCommandResult>())!.State);
        Assert.Equal(1, f.Provider.Writes);
        var conflict = await client.PostAsJsonAsync(route, input with { Action = "update-branch" }); Assert.Equal(HttpStatusCode.Conflict, conflict.StatusCode);
        var duplicate = await client.PostAsJsonAsync(route, input with { RequestId = Guid.NewGuid().ToString() }); Assert.Equal(HttpStatusCode.Conflict, duplicate.StatusCode);
        Assert.Equal(1, f.Provider.Writes);
    }
    [Fact]
    public async Task BranchUpdateAcceptanceNeedsObservationAndDeniedMergeIsNotSuccess()
    {
        var f = await Start(); await using var host = f.Host; using var client = f.Client;
        var id = await Populate(f.Service); var route = $"/api/pull-requests/{id}/1/actions";
        f.Provider.Draft = false; f.Provider.MergeState = "behind";
        var input = new PullRequestCommand(Guid.NewGuid().ToString(), "update-branch", f.Provider.Head, new('b', 40));
        var first = await client.PostAsJsonAsync(route, input); first.EnsureSuccessStatusCode();
        Assert.Equal("pending", (await first.Content.ReadFromJsonAsync<PullRequestCommandResult>())!.State);
        var replay = await client.PostAsJsonAsync(route + "/recover", input); replay.EnsureSuccessStatusCode();
        Assert.Equal("updated", (await replay.Content.ReadFromJsonAsync<PullRequestCommandResult>())!.State); Assert.Equal(1, f.Provider.Writes);
        f.Provider.DenyWrite = true;
        var denied = await client.PostAsJsonAsync(route, new PullRequestCommand(Guid.NewGuid().ToString(), "merge", f.Provider.Head, input.Base));
        denied.EnsureSuccessStatusCode(); Assert.Equal("failed", (await denied.Content.ReadFromJsonAsync<PullRequestCommandResult>())!.State);
    }
    [Fact]
    public async Task InstalledStoppedAppsShareOneRepositoryAndExternalBotPrWithoutWorkspace()
    {
        var f = await Start(); await using var host = f.Host; using var client = f.Client;
        var id = await Populate(f.Service);
        var repositories = await client.GetFromJsonAsync<PullRequestRepositories>("/api/pull-requests/repositories");
        Assert.Equal(2, Assert.Single(repositories!.Repositories).Apps.Length);
        var page = await client.GetFromJsonAsync<PullRequestPage>("/api/pull-requests?bot=true&draft=true");
        var item = Assert.Single(page!.Items); Assert.Equal(id, item.RepositoryId); Assert.True(item.Bot); Assert.True(item.Draft);
        Assert.Equal("running", Assert.Single(item.Checks.Items).State);
        Assert.Equal(1, f.Provider.Lists); Assert.Equal(1, f.Provider.StatusReads);
        Assert.Equal(f.Clock.UtcNow, page.Receipt.LastSuccessAt);
        Assert.Empty((await host.Services.GetRequiredService<DevelopmentWorkspaceService>().ListAsync(null, false, default)).Workspaces);
        Assert.DoesNotContain("fixture-secret", CoreJson.Text(page));
        Assert.False(PublicationService.DisplayObservation(item).Complete);
    }
    [Fact]
    public async Task OnlyAdmittedScopedStreamsPromoteActiveChecksAndDisposeRestoresBaseline()
    {
        var f = await Start(); await using var host = f.Host; using var client = f.Client;
        var id = await Populate(f.Service); var actor = new PullRequestActor("admin");
        f.Clock.UtcNow += TimeSpan.FromSeconds(11);
        var ticket = await f.Service.SubscribeAsync(actor, new(PullRequests: [new(id, 1)]), default);
        await f.Service.TickAsync(default); Assert.Equal(1, f.Provider.StatusReads);
        using (f.Service.Admit(actor, ticket.Id))
        {
            await f.Service.TickAsync(default); Assert.Equal(2, f.Provider.StatusReads);
            f.Clock.UtcNow += TimeSpan.FromSeconds(9); await f.Service.TickAsync(default); Assert.Equal(2, f.Provider.StatusReads);
            f.Clock.UtcNow += TimeSpan.FromSeconds(2); f.Provider.Active = false;
            await f.Service.TickAsync(default); Assert.Equal(3, f.Provider.StatusReads);
        }
        f.Clock.UtcNow += TimeSpan.FromSeconds(61); await f.Service.TickAsync(default); Assert.Equal(3, f.Provider.StatusReads);
        Assert.Throws<PullRequestException>(() => f.Service.Admit(actor, ticket.Id));
        Assert.Equal("skipped", Assert.Single(Assert.Single((await f.Service.ListAsync(actor, new(), default)).Items).Checks.Items).State);
    }
    [Fact]
    public async Task DisconnectingCannotExposeCachedPrivatePrBytes()
    {
        var f = await Start(); await using var host = f.Host; using var client = f.Client;
        await Populate(f.Service);
        await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(s => s with { ProviderConnections = [] });
        var page = await client.GetFromJsonAsync<PullRequestPage>("/api/pull-requests"); Assert.Empty(page!.Items);
        var repos = await client.GetFromJsonAsync<PullRequestRepositories>("/api/pull-requests/repositories");
        Assert.Empty(repos!.Repositories); Assert.Contains(repos.Coverage, c => c.State == "connection_required");
        var before = f.Provider.Calls.Count; f.Clock.UtcNow += TimeSpan.FromMinutes(6); await f.Service.TickAsync(default); Assert.Equal(before, f.Provider.Calls.Count);
    }
    [Fact]
    public async Task ProviderIdentityCoalescesRenamedSourceAliases()
    {
        var f = await Start(); await using var host = f.Host; using var client = f.Client;
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var alias = (await apps.GetAppAsync("another.vendor.two"))!;
        await apps.UpsertAppAsync(alias with { SourceState = alias.SourceState! with { Repository = "https://github.com/old-owner/old-name.git" } });
        await f.Service.RepositoriesAsync(new("admin"), default);
        for (var i = 0; i < 6; i++) await f.Service.TickAsync(default);
        var repo = Assert.Single((await f.Service.RepositoriesAsync(new("admin"), default)).Repositories);
        Assert.Equal(2, repo.Apps.Length);
        Assert.Single((await f.Service.ListAsync(new("admin"), new(), default)).Items);
        Assert.Equal(1, f.Provider.Lists);
    }
    [Fact]
    public async Task RemovingLastInstalledReferenceStopsObservationWithoutWorkspaceFallback()
    {
        var f = await Start(); await using var host = f.Host; using var client = f.Client;
        await Populate(f.Service);
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        await apps.RemoveAppAsync("unrelated.vendor.one");
        await f.Service.RepositoriesAsync(new("admin"), default);
        await f.Service.TickAsync(default); await f.Service.TickAsync(default);
        Assert.Single(Assert.Single((await f.Service.RepositoriesAsync(new("admin"), default)).Repositories).Apps);
        await apps.RemoveAppAsync("another.vendor.two");
        Assert.Empty((await f.Service.ListAsync(new("admin"), new(), default)).Items);
        var before = f.Provider.Calls.Count; f.Clock.UtcNow += TimeSpan.FromMinutes(6);
        await f.Service.TickAsync(default); Assert.Equal(before, f.Provider.Calls.Count);
    }
    [Fact]
    public async Task UnsupportedSourceChangeEvictsPreviouslyAuthorizedRows()
    {
        var f = await Start(); await using var host = f.Host; using var client = f.Client;
        var id = await Populate(f.Service);
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        foreach (var app in await apps.ListAppRecordsAsync())
            await apps.UpsertAppAsync(app with { SourceState = app.SourceState! with { Repository = "https://unsupported.example/source.git" } });
        var inventory = await f.Service.RepositoriesAsync(new("admin"), default);
        Assert.Empty(inventory.Repositories); Assert.Contains(inventory.Coverage, c => c.State == "source_unsupported");
        Assert.Empty((await f.Service.ListAsync(new("admin"), new(), default)).Items);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/pull-requests/" + id + "/1")).StatusCode);
    }
    [Fact]
    public async Task MissingCheckPermissionDoesNotHideStillAuthorizedPrMetadata()
    {
        var f = await Start(); await using var host = f.Host; using var client = f.Client;
        var id = await Populate(f.Service); f.Provider.Denied = true;
        var checks = await f.Service.ChecksAsync(new("admin"), id, 1, null, default);
        Assert.Equal("unknown", checks.Completeness);
        Assert.Single((await f.Service.ListAsync(new("admin"), new(), default)).Items);
        // A later repository access proof still detects a genuinely revoked token.
        f.Clock.UtcNow += TimeSpan.FromMinutes(5); await f.Service.TickAsync(default);
        Assert.Empty((await f.Service.ListAsync(new("admin"), new(), default)).Items);
    }
    [Fact]
    public async Task ConfirmedDenialHidesRowsAndDoesNotBecomeSuccessfulEmptyCoverage()
    {
        var f = await Start(); await using var host = f.Host; using var client = f.Client;
        await Populate(f.Service); f.Provider.Denied = true; f.Clock.UtcNow += TimeSpan.FromMinutes(5);
        await f.Service.TickAsync(default);
        var repos = await f.Service.RepositoriesAsync(new("admin"), default);
        Assert.Empty(repos.Repositories); Assert.Contains(repos.Coverage, c => c.State == "access_denied");
        Assert.Empty((await f.Service.ListAsync(new("admin"), new(), default)).Items);
    }
    [Fact]
    public async Task AppRouteUsesReviewedFullSourcePermissionAndCurrentIdentity()
    {
        var f = await Start(); await using var host = f.Host; using var client = f.Client;
        const string appId = "thirdparty.review-client";
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var app = AssistantMcpAccessHttpTests.Record(appId, f.Clock.UtcNow) with { GrantedCorePermissions = [CoreAppPermissions.SourcesRead] };
        await apps.UpsertAppAsync(app);
        var token = await BrowserAuthorityFixture.Grant(host, appId, "admin");
        client.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(appId));
        client.DefaultRequestHeaders.Add("X-Hosty-App-Identity", token.AccessToken);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/pull-requests/repositories")).StatusCode);
        await apps.UpsertAppAsync(app with { GrantedCorePermissions = [CoreAppPermissions.Sources] });
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/pull-requests/repositories")).StatusCode);
        await apps.UpsertAppAsync(app with { GrantedCorePermissions = [] });
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/pull-requests")).StatusCode);
    }
    [Fact]
    public async Task AmbiguousAccountsNeedSelectionInsteadOfFanout()
    {
        var f = await Start(); await using var host = f.Host; using var client = f.Client;
        await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(s => s with { ProviderConnections = [Connection(f.Clock), Connection(f.Clock, id: "other")] });
        var result = await f.Service.RepositoriesAsync(new("admin"), default); Assert.Empty(result.Repositories);
        Assert.Contains(result.Coverage, c => c.State == "connection_selection_required");
        await f.Service.TickAsync(default); Assert.Empty(f.Provider.Calls);
    }
    [Fact]
    public async Task ConfirmedClosedPrLeavesActiveListAndInvalidationCannotInventFacts()
    {
        var f = await Start(); await using var host = f.Host; using var client = f.Client;
        var id = await Populate(f.Service); var actor = new PullRequestActor("admin");
        var first = Assert.Single((await f.Service.ListAsync(actor, new(), default)).Items);
        Assert.Equal(1, first.Reference.SchemaVersion); Assert.Equal(first.Head, first.Reference.Head);
        Assert.Equal("github.com", first.Reference.Host);
        var move = new ObservationInvalidation(new(1, "game-position", "game-1", "move-4"), "changed");
        Assert.False(f.Service.Invalidate(actor.UserId, move));
        var signal = new ObservationInvalidation(new(1, "pull-request", id + ":1", "older-revision"), "changed");
        Assert.True(f.Service.Invalidate(actor.UserId, signal)); Assert.True(f.Service.Invalidate(actor.UserId, signal));
        var before = f.Provider.StatusReads; f.Provider.Closed = true;
        await f.Service.TickAsync(default); await f.Service.TickAsync(default);
        Assert.Equal(before + 1, f.Provider.StatusReads);
        Assert.Empty((await f.Service.ListAsync(actor, new(), default)).Items);
    }
    [Fact]
    public async Task ActorBoundOneUseSubscriptionAndRefreshRejectUninstalledReferences()
    {
        var f = await Start(); await using var host = f.Host; using var client = f.Client;
        var id = await Populate(f.Service); var actor = new PullRequestActor("admin");
        var ticket = await f.Service.SubscribeAsync(actor, new(PullRequests: [new(id, 1)]), default);
        Assert.Throws<PullRequestException>(() => f.Service.Admit(new("another-owner"), ticket.Id));
        using var stream = f.Service.Admit(actor, ticket.Id);
        Assert.Throws<PullRequestException>(() => f.Service.Admit(actor, ticket.Id));
        var command = new PullRequestRefresh(Guid.NewGuid().ToString(), PullRequests: [new(id, 1)]);
        Assert.Equal("queued", (await f.Service.RefreshAsync(actor, command, default)).State);
        Assert.Equal("coalesced", (await f.Service.RefreshAsync(actor, command, default)).State);
        Assert.False(f.Service.Invalidate("another-owner", id, 1, "signal"));
        Assert.False(f.Service.Invalidate("admin", "unknown", 1, "signal"));
        Assert.True(f.Service.Invalidate("admin", id, 1, "signal"));
        Assert.True(f.Service.Invalidate("admin", id, 1, "signal"));
    }
}
