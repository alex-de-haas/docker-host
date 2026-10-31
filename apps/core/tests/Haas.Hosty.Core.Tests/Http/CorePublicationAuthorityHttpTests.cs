using System.Net;
using System.Net.Http.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class CorePublicationAuthorityHttpTests
{
    [Fact]
    public async Task DirectPublication_RequiresDistinctReadAndWriteBeforeResolvingResources()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        var now = DateTimeOffset.UtcNow;
        const string token = "publication-direct-token";
        await users.WriteAsync(new(1, [new("admin", "admin@example.test", "Admin", "host.admin", false, now, now)], [], [],
            [new(token, "admin", now, now.AddHours(1), null, now, Audience: AccessTokenScopes.CoreAudience, Scopes: [AccessTokenScopes.McpRead, AccessTokenScopes.McpWorkspaces], Kind: AccessTokenKinds.Manual)]));
        using var client = host.CreateClient(); client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/publications/v1/connections")).StatusCode);
        await users.UpdateAsync(s => s with { Sessions = s.Sessions.Select(v => v with { Scopes = [AccessTokenScopes.McpRead, AccessTokenScopes.McpWorkspaces, AccessTokenScopes.McpPublicationRead] }).ToArray() });
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/publications/v1/connections")).StatusCode);
        Assert.Empty((await (await client.PostAsJsonAsync("/api/publications/v1/query", new CorePublicationQuery())).Content.ReadFromJsonAsync<PublicationList>())!.Publications);
        foreach (var kind in new[] { "configure", "push", "publish", "link", "ready", "resolve-review", "merge", "corrective" })
        {
            var response = await client.PostAsJsonAsync("/api/publications/v1/commands/" + kind,
                new CorePublicationMutation(new string('a', 64), new(Guid.NewGuid().ToString(), Fork: true)));
            Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
            Assert.Contains(AccessTokenScopes.McpPublicationWrite, await response.Content.ReadAsStringAsync());
        }
        var commit = await client.PostAsJsonAsync("/api/publications/v1/commands/commit", new CorePublicationMutation(new string('a', 64), new(Guid.NewGuid().ToString())));
        Assert.Equal(HttpStatusCode.Conflict, commit.StatusCode);
        Assert.Contains("workspace_not_found", await commit.Content.ReadAsStringAsync());
    }
}
