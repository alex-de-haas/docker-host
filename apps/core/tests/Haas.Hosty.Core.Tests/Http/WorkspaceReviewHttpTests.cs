using System.Net;
using System.Net.Http.Json;
using Haas.Hosty.Core;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class WorkspaceReviewHttpTests
{
    [Fact]
    public async Task ReviewRoutesKeepReadAndMutationAuthoritySeparateAndRejectMixedCookies()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        const string appId = "hosty.harness";
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        var record = AssistantMcpAccessHttpTests.Record(appId, now);
        await apps.UpsertAppAsync(record);
        await users.WriteAsync(new(1, [new("admin", "admin@example.test", "Admin", "host.admin", false, now, now)], [], [], []));
        var basis = $"/api/internal/apps/{appId}/workspace-inspection/{new string('a', 64)}/worktrees/{new string('b', 64)}";
        var read = basis + "/review?scope=pull-request&pullRequestUrl=https%3A%2F%2Fgithub.com%2Fowner%2Frepo%2Fpull%2F42";
        var diff = basis + "/review/diff?scope=session&path=README.md";
        var command = new PublicationReviewCommand(Guid.NewGuid().ToString(), "https://github.com/owner/repo/pull/42", new('c', 40), "thread");
        using var client = host.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(read)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(diff)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsJsonAsync(basis + "/reviews/resolve", command, CoreJson.TypeInfo<PublicationReviewCommand>())).StatusCode);
        client.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(appId));
        client.DefaultRequestHeaders.Add("X-Hosty-User-Token", (await BrowserAuthorityFixture.Grant(host, appId, "admin")).AccessToken);
        await apps.UpsertAppAsync(record with { GrantedCorePermissions = [CoreAppPermissions.WorkspacesRead] });
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(read)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(diff)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync(basis + "/reviews/resolve", command, CoreJson.TypeInfo<PublicationReviewCommand>())).StatusCode);
        await apps.UpsertAppAsync(record with { GrantedCorePermissions = [CoreAppPermissions.Sources] });
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(read)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsJsonAsync(basis + "/reviews/resolve", command, CoreJson.TypeInfo<PublicationReviewCommand>())).StatusCode);
        await apps.UpsertAppAsync(record with { GrantedCorePermissions = [CoreAppPermissions.WorkspacesRead, CoreAppPermissions.Sources] });
        client.DefaultRequestHeaders.Add("Cookie", "hosty_session=browser-session");
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(read)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync(basis + "/reviews/resolve", command, CoreJson.TypeInfo<PublicationReviewCommand>())).StatusCode);
    }
}
