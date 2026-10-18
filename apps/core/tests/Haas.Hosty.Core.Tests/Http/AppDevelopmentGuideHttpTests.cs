using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class AppDevelopmentGuideHttpTests
{
    [Fact]
    public async Task ControlAndAssistantReadTheSameTopicsWithoutCreatingSourceOrGrantingInstall()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var control = host.CreateClient();
        const string route = "/control/v1/apps/development-guide";
        Assert.Equal(HttpStatusCode.Unauthorized, (await control.GetAsync(route)).StatusCode);
        control.DefaultRequestHeaders.Add("X-Hosty-Control-Secret", host.Services.GetRequiredService<ControlSecret>().Value);
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1,
            [new("admin", "admin@example.test", "Admin", "host.admin", false, now, now)], [], [], []));
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var caller = AssistantMcpAccessHttpTests.Record("hosty.harness", now) with
        {
            ConfirmedRoles = ["assistant"],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["assistant"] = [new("default", null, "/assistant")] },
            GrantedCorePermissions = [CoreAppPermissions.Sources],
        };
        await apps.UpsertAppAsync(caller);
        using var assistant = host.CreateClient();
        const string path = "/api/internal/apps/hosty.harness/sessions/guide-only/app-creations/guide";
        Assert.Equal(HttpStatusCode.Unauthorized, (await assistant.GetAsync(path)).StatusCode);
        assistant.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(caller.Id));
        Assert.Equal(HttpStatusCode.Unauthorized, (await assistant.GetAsync(path)).StatusCode);
        assistant.DefaultRequestHeaders.Add("X-Hosty-User-Token", (await BrowserAuthorityFixture.Grant(host, caller.Id, "admin")).AccessToken);
        foreach (var topic in AppDevelopmentGuideReader.Read().Topics)
        {
            var expected = AppDevelopmentGuideReader.Read(topic.Id);
            using var response = await control.GetAsync(route + "?topic=" + topic.Id);
            Assert.True(response.Headers.CacheControl!.NoStore);
            Assert.Equal(CoreJson.Text(expected), await response.Content.ReadAsStringAsync());
            using var forwarded = await assistant.GetAsync(path + "?topic=" + topic.Id);
            Assert.Equal(HttpStatusCode.OK, forwarded.StatusCode);
            Assert.True(forwarded.Headers.CacheControl!.NoStore);
            Assert.Equal(CoreJson.Text(expected), await forwarded.Content.ReadAsStringAsync());
        }
        Assert.Equal(HttpStatusCode.BadRequest, (await control.GetAsync(route + "?topic=all")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await assistant.GetAsync(path + "?topic=..%2Fsecret")).StatusCode);
        await apps.UpsertAppAsync(caller with { GrantedCorePermissions = [] });
        Assert.Equal(HttpStatusCode.Forbidden, (await assistant.GetAsync(path)).StatusCode);
        Assert.Single(await apps.ListAppsAsync());
    }
}
