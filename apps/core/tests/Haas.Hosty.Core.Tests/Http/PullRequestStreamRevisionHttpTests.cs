using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed partial class PullRequestHttpTests
{
    [Fact]
    public async Task StreamRevision_UnrelatedRepositoryObservation_DoesNotInvalidateSelectedRepository()
    {
        var f = await Start(); await using var host = f.Host; using var client = f.Client;
        var id = await Populate(f.Service); var actor = new PullRequestActor("admin");
        var ticket = await f.Service.SubscribeAsync(actor, new(Repositories: [id], PullRequests: [new(id, 1)]), default);
        using var stream = f.Service.Admit(actor, ticket.Id);
        var before = await f.Service.StreamStateAsync(actor, ticket.Id, default);
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        await apps.UpsertAppAsync(AssistantMcpAccessHttpTests.Record("vendor.other-repository", f.Clock.UtcNow) with {
            SourceState = new("git", "https://github.com/other/repo.git", "main", null, null, null, f.Clock.UtcNow, "other") });
        f.Provider.Intercept = (request, _) => request.RequestUri!.AbsolutePath == "/repos/other/repo"
            ? Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = JsonContent.Create(new { node_id = "REPO_2", full_name = "other/repo" }) }) : null;
        await f.Service.RepositoriesAsync(actor, default);
        var ownerRevision = f.Service.CurrentRevision(actor);
        await f.Service.TickAsync(default); // Access proof for the unrelated repository.
        Assert.NotEqual(ownerRevision, f.Service.CurrentRevision(actor));
        Assert.Equal(before.Revision, (await f.Service.StreamStateAsync(actor, ticket.Id, default)).Revision);
        await f.Service.TickAsync(default); // Its discovery is also irrelevant to this stream.
        Assert.Equal(before.Revision, (await f.Service.StreamStateAsync(actor, ticket.Id, default)).Revision);
        await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(s => s with { ProviderConnections = [] });
        var revoked = await f.Service.StreamStateAsync(actor, ticket.Id, default);
        Assert.NotEqual(before.Revision, revoked.Revision);
        Assert.Empty(revoked.Repositories); Assert.Empty(revoked.PullRequests);
    }

    [Fact]
    public async Task StreamRevision_OtherPullRequestInSameRepository_DoesNotInvalidateSelectedPullRequest()
    {
        var f = await Start(); await using var host = f.Host; using var client = f.Client;
        JsonObject Summary(int number) => new() {
            ["id"] = "PR_" + number, ["node_id"] = "PR_" + number, ["number"] = number, ["title"] = "PR " + number,
            ["state"] = "open", ["updatedAt"] = f.Clock.UtcNow, ["headRefName"] = "deps", ["headRefOid"] = f.Provider.Head,
            ["baseRefName"] = "main", ["baseRefOid"] = new string('b', 40), ["author"] = new JsonObject { ["login"] = "bot" },
            ["head"] = new JsonObject { ["sha"] = f.Provider.Head }, ["base"] = new JsonObject { ["sha"] = new string('b', 40) }
        };
        f.Provider.Intercept = (request, ct) => {
            if (request.RequestUri!.AbsolutePath.EndsWith("/pulls", StringComparison.Ordinal))
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = JsonContent.Create(new[] { Summary(1), Summary(2) }) });
            if (request.RequestUri.AbsolutePath != "/graphql") return null;
            var input = JsonNode.Parse(request.Content!.ReadAsStringAsync(ct).GetAwaiter().GetResult())!;
            var numbers = input["variables"]!.AsObject().Where(p => p.Key.StartsWith('n')).Select(p => p.Value!.GetValue<int>()).ToArray();
            var repository = new JsonObject();
            for (var i = 0; i < numbers.Length; i++) repository["p" + i] = Summary(numbers[i]);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = JsonContent.Create(new JsonObject {
                ["data"] = new JsonObject { ["repository"] = repository }
            }) });
        };
        var id = await Populate(f.Service); var actor = new PullRequestActor("admin");
        var ticket = await f.Service.SubscribeAsync(actor, new(PullRequests: [new(id, 1)]), default);
        using var stream = f.Service.Admit(actor, ticket.Id);
        var before = await f.Service.StreamStateAsync(actor, ticket.Id, default);
        f.Clock.UtcNow += TimeSpan.FromSeconds(1);
        Assert.True(f.Service.Invalidate("admin", id, 2, "test"));
        await f.Service.TickAsync(default);
        Assert.Equal(before.Revision, (await f.Service.StreamStateAsync(actor, ticket.Id, default)).Revision);
        Assert.True(f.Service.Invalidate("admin", id, 1, "test"));
        await f.Service.TickAsync(default);
        Assert.NotEqual(before.Revision, (await f.Service.StreamStateAsync(actor, ticket.Id, default)).Revision);
    }
}
