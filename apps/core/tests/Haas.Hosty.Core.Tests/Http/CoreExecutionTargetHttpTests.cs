using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class CoreExecutionTargetHttpTests
{
    [Fact]
    public async Task CoreCatalog_IsAnAuthorizedGetWithoutCsrfAndRequiresExistingListAuthority()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        const string route = "/api/core/execution-targets";
        using var anonymous = host.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync(route)).StatusCode);
        string[] permissions = [CoreAppPermissions.ReadCore, CoreAppPermissions.WorkspacesRead,
            CoreAppPermissions.Sources, CoreAppPermissions.AppLifecycle];
        using var client = await AppManagementHttpTests.CreateAppClient(host, "example.external-client", permissions);
        using var response = await client.GetAsync(route);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("no-store", response.Headers.CacheControl!.ToString());
        var payload = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Empty(payload.GetProperty("targets").EnumerateArray());
        Assert.Empty(payload.GetProperty("activations").EnumerateArray());
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        foreach (var permission in permissions)
        {
            await apps.UpdateAppAsync("example.external-client", app => app with
                { GrantedCorePermissions = permissions.Where(value => value != permission).ToArray() });
            Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(route)).StatusCode);
        }
        await apps.UpdateAppAsync("example.external-client", app => app with { GrantedCorePermissions = permissions });
        await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(state => state with
            { Users = state.Users.Select(user => user with { Role = "host.member" }).ToArray() });
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(route)).StatusCode);
    }
}
