using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed partial class PullRequestHttpTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SharedReview_RevokedOrReinstalledWaitingApp_DoesNotReceivePrivateResult(bool reinstall)
    {
        var f = await Start(); await using var host = f.Host; using var client = f.Client;
        var id = await Populate(f.Service);
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var leaderApp = AssistantMcpAccessHttpTests.Record("vendor.first-reader", f.Clock.UtcNow) with { GrantedCorePermissions = [CoreAppPermissions.Sources] };
        var waiterApp = leaderApp with { Id = "vendor.second-reader" };
        await apps.UpsertAppAsync(leaderApp); await apps.UpsertAppAsync(waiterApp);
        var leader = new PullRequestActor("admin", leaderApp.Id, leaderApp.InstalledAt);
        var waiter = new PullRequestActor("admin", waiterApp.Id, waiterApp.InstalledAt);
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var providerReads = 0;
        f.Provider.Intercept = (request, ct) => request.RequestUri!.AbsolutePath == "/graphql" ? ReadReview(ct) : null;
        async Task<HttpResponseMessage> ReadReview(CancellationToken ct)
        {
            Interlocked.Increment(ref providerReads); started.TrySetResult();
            await release.Task.WaitAsync(ct);
            return new(HttpStatusCode.OK) { Content = JsonContent.Create(new { data = new { repository = new { pullRequest = new {
                headRefOid = f.Provider.Head, reviewThreads = new { totalCount = 1, pageInfo = new { hasNextPage = false }, nodes = new[] {
                    new { id = "private-thread", isResolved = false, comments = new { nodes = new[] { new { body = "Private review", author = new { login = "owner" } } } } }
                }
            } } } } }) };
        }
        var first = f.Service.ReviewAsync(leader, id, 1, null, default);
        await started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        var second = f.Service.ReviewAsync(waiter, id, 1, null, default);
        // Both calls must remain suspended on the shared remote read before revocation.
        await Task.Delay(100);
        Assert.False(second.IsCompleted); Assert.Equal(1, providerReads);
        await apps.UpsertAppAsync(reinstall ? waiterApp with { InstalledAt = f.Clock.UtcNow.AddSeconds(1) }
            : waiterApp with { GrantedCorePermissions = [] });
        release.SetResult();
        Assert.Equal("Private review", Assert.Single((await first).Items).Body);
        var error = await Assert.ThrowsAsync<PullRequestException>(() => second);
        Assert.Equal("pr_forbidden", error.Code); Assert.Equal(1, providerReads);
        // An authorized reader can still consume the shared cached value.
        Assert.Equal("Private review", Assert.Single((await f.Service.ReviewAsync(leader, id, 1, null, default)).Items).Body);
        Assert.Equal(1, providerReads);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PartialStatus_RequestedOrMissingPr_RetriesLaterWithoutFreshnessOrStarvation(bool missing)
    {
        var f = await Start(); await using var host = f.Host; using var client = f.Client;
        var omitted = false; var partial = false; var batches = new List<int[]>();
        JsonObject Summary(int number) => new() {
            ["id"] = "PR_" + number, ["node_id"] = "PR_" + number, ["number"] = number, ["title"] = "PR " + number,
            ["state"] = "open", ["updatedAt"] = f.Clock.UtcNow, ["headRefName"] = "deps", ["headRefOid"] = f.Provider.Head,
            ["baseRefName"] = "main", ["baseRefOid"] = new string('b', 40), ["author"] = new JsonObject { ["login"] = "bot" },
            ["head"] = new JsonObject { ["sha"] = f.Provider.Head }, ["base"] = new JsonObject { ["sha"] = new string('b', 40) }
        };
        f.Provider.Intercept = (request, ct) => {
            if (request.RequestUri!.AbsolutePath.EndsWith("/pulls", StringComparison.Ordinal))
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = JsonContent.Create(
                    Enumerable.Range(1, 12).Where(n => !omitted || n != 1).Select(Summary).ToArray()) });
            if (request.RequestUri.AbsolutePath != "/graphql") return null;
            var input = JsonNode.Parse(request.Content!.ReadAsStringAsync(ct).GetAwaiter().GetResult())!;
            var numbers = input["variables"]!.AsObject().Where(p => p.Key.StartsWith('n')).Select(p => p.Value!.GetValue<int>()).ToArray();
            batches.Add(numbers);
            var repository = new JsonObject();
            for (var i = 0; i < numbers.Length; i++) repository["p" + i] = partial && numbers[i] == 1 ? null : Summary(numbers[i]);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = JsonContent.Create(new JsonObject {
                ["data"] = new JsonObject { ["repository"] = repository }
            }) });
        };
        var id = await Populate(f.Service); await f.Service.TickAsync(default);
        var actor = new PullRequestActor("admin");
        var before = (await f.Service.ListAsync(actor, new(), default)).Items.Single(p => p.Number == 1).Receipt;
        f.Clock.UtcNow += TimeSpan.FromSeconds(1);
        if (missing)
        {
            omitted = true;
            await f.Service.RefreshAsync(actor, new(Guid.NewGuid().ToString(), Repositories: [id]), default);
            await f.Service.TickAsync(default);
        }
        foreach (var n in Enumerable.Range(missing ? 2 : 1, missing ? 11 : 12)) Assert.True(f.Service.Invalidate("admin", id, n, "test"));
        partial = true; batches.Clear();
        await f.Service.TickAsync(default);
        Assert.Contains(1, Assert.Single(batches));
        var stale = (await f.Service.ListAsync(actor, new(), default)).Items.Single(p => p.Number == 1).Receipt;
        Assert.Equal("stale", stale.Freshness); Assert.Equal(before.LastSuccessAt, stale.LastSuccessAt);
        Assert.True(stale.NextAttemptAt > f.Clock.UtcNow);
        await f.Service.TickAsync(default);
        Assert.DoesNotContain(1, batches[1]); Assert.Contains(11, batches[1]); Assert.Contains(12, batches[1]);
        for (var i = 0; i < 20; i++) { f.Clock.UtcNow += TimeSpan.FromSeconds(1); await f.Service.TickAsync(default); }
        Assert.Equal(2, batches.Count);
        f.Clock.UtcNow = stale.NextAttemptAt!.Value;
        partial = false;
        await f.Service.TickAsync(default);
        Assert.Equal([1], batches[^1]);
        var fresh = (await f.Service.ListAsync(actor, new(), default)).Items.Single(p => p.Number == 1).Receipt;
        Assert.Equal("fresh", fresh.Freshness); Assert.Null(fresh.NextAttemptAt); Assert.Equal(f.Clock.UtcNow, fresh.LastSuccessAt);
    }
}
