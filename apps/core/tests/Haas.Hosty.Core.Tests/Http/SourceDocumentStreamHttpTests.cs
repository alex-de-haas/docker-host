using System.Net;
using Haas.Hosty.Core;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class SourceDocumentStreamHttpTests
{
    [Fact]
    public async Task StreamRequiresReviewedIdentityFiltersHintsAndEndsOnRevocation()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        const string appId = "example.documents-reader", route = "/api/internal/apps/example.documents-reader/source-documents/events";
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        var record = AssistantMcpAccessHttpTests.Record(appId, now);
        await apps.UpsertAppAsync(record);
        await users.WriteAsync(new(1, [new("admin", "admin@example.test", "Admin", "host.admin", false, now, now)], [], [], []));
        using var client = host.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(route)).StatusCode);
        client.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(appId));
        var grant = await BrowserAuthorityFixture.Grant(host, appId, "admin");
        client.DefaultRequestHeaders.Add("X-Hosty-User-Token", grant.AccessToken);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(route)).StatusCode);
        await apps.UpsertAppAsync(record with { GrantedCorePermissions = [CoreAppPermissions.SourcesRead] });
        using var stop = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var response = await client.GetAsync(route, HttpCompletionOption.ResponseHeadersRead, stop.Token);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/event-stream", response.Content.Headers.ContentType!.MediaType);
        using var reader = new StreamReader(await response.Content.ReadAsStreamAsync(stop.Token));
        Assert.Equal("event: stream.ready", await reader.ReadLineAsync(stop.Token));
        Assert.Equal("data: {}", await reader.ReadLineAsync(stop.Token));
        Assert.Equal("", await reader.ReadLineAsync(stop.Token));
        var events = host.Services.GetRequiredService<CoreEventHub>();
        var pending = reader.ReadLineAsync(stop.Token).AsTask();
        events.PublishWorkspaceChange(new string('f', 64));
        await Task.Delay(100, stop.Token);
        Assert.False(pending.IsCompleted); // An inaccessible/nonexistent source is not announced.
        events.PublishWorkspaceChange("*");
        Assert.Equal("event: source.changed", await pending);
        Assert.Equal("data: {}", await reader.ReadLineAsync(stop.Token));
        Assert.Equal("", await reader.ReadLineAsync(stop.Token));
        await apps.UpsertAppAsync(record with { GrantedCorePermissions = [] });
        Assert.Equal("event: stream.revoked", await reader.ReadLineAsync(stop.Token));
    }
}
