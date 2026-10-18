using System.Net;
using System.Net.Http.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class AppPermissionOverviewHttpTests
{
    private const string Route = "/api/apps/permissions";

    [Fact]
    public async Task CatalogueIncludesUnassignedEntriesAndOnlyPersistedHolders()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await AppManagementHttpTests.CreateAppClient(host, "example.console", [CoreAppPermissions.ReadApps]);
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var baseline = (await apps.GetAppAsync("example.console"))!;
        await apps.UpsertAppAsync(baseline with
        {
            Id = "example.provider", DisplayName = "Provider", System = true,
            GrantedCorePermissions = [CoreAppPermissions.SpeechProviders],
            RequiredCorePermissions = [CoreAppPermissions.ManageUsers],
            OptionalCorePermissions = [CoreAppPermissions.Install],
            Provides = [PlatformCapabilities.Assistant, PlatformCapabilities.SpeechToText, PlatformCapabilities.OtlpCollector, "future-role"],
            ConfirmedRoles = [PlatformCapabilities.SpeechToText],
        });

        using var response = await client.GetAsync(Route);
        response.EnsureSuccessStatusCode();
        Assert.True(response.Headers.CacheControl?.NoStore);
        var overview = (await response.Content.ReadFromJsonAsync<AppPermissionOverview>())!;
        Assert.Equal(CoreAppPermissions.Known.Order(), overview.Entries.Where(e => e.Kind == "permission").Select(e => e.Id).Order());
        Assert.Equal(PlatformCapabilities.ConsentRoles.Order(), overview.Entries.Where(e => e.Kind == "role").Select(e => e.Id).Order());
        Assert.All(overview.Entries, entry => Assert.NotEqual(entry.Id, entry.Description));
        Assert.Equal("example.provider", Assert.Single(overview.Entries.Single(e => e.Id == CoreAppPermissions.SpeechProviders).Apps).Id);
        Assert.Equal("example.provider", Assert.Single(overview.Entries.Single(e => e.Id == PlatformCapabilities.SpeechToText).Apps).Id);
        Assert.Empty(overview.Entries.Single(e => e.Id == PlatformCapabilities.Assistant).Apps);
        Assert.Empty(overview.Entries.Single(e => e.Id == CoreAppPermissions.ManageUsers).Apps);
        Assert.Empty(overview.Entries.Single(e => e.Id == CoreAppPermissions.Install).Apps);
        var collector = overview.Entries.Single(e => e.Id == PlatformCapabilities.OtlpCollector);
        Assert.Equal("provisioning", collector.Kind);
        Assert.Single(collector.Apps);
        Assert.DoesNotContain(overview.Entries, e => e.Id == "future-role" || e.Id == "system");

        await apps.UpsertAppAsync((await apps.GetAppAsync("example.provider"))! with { GrantedCorePermissions = [], ConfirmedRoles = [] });
        var revoked = (await client.GetFromJsonAsync<AppPermissionOverview>(Route))!;
        Assert.Empty(revoked.Entries.Single(e => e.Id == CoreAppPermissions.SpeechProviders).Apps);
        Assert.Empty(revoked.Entries.Single(e => e.Id == PlatformCapabilities.SpeechToText).Apps);
    }

    [Fact]
    public async Task HolderIconsPreserveLiveSourceAndLockedAssetCachePolicy()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await AppManagementHttpTests.CreateAppClient(host, "example.console", [CoreAppPermissions.ReadApps]);
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var baseline = (await apps.GetAppAsync("example.console"))!;
        var source = Path.Combine(Path.GetTempPath(), $"hosty-permission-icon-{Guid.NewGuid():N}");
        Directory.CreateDirectory(source);
        try
        {
            var provider = baseline with
            {
                Id = "example.provider", DisplayName = "Provider",
                GrantedCorePermissions = [CoreAppPermissions.SpeechProviders],
                RuntimeProfiles = [new("dev", "localCommand", true, Development: true)],
                InstallManifestPath = source,
                CatalogMetadata = new(null, null, [], "assets/icon.png", [], null, null, null, null, null, null),
            };
            await apps.UpsertAppAsync(provider);
            var live = (await client.GetFromJsonAsync<AppPermissionOverview>(Route))!;
            Assert.Equal("/api/apps/example.provider/assets/assets/icon.png",
                Assert.Single(live.Entries.Single(e => e.Id == CoreAppPermissions.SpeechProviders).Apps).IconUrl);

            await apps.UpsertAppAsync(provider with
            {
                RuntimeProfiles = [new("dev", "localCommand", true, Development: false)],
            });
            var locked = (await client.GetFromJsonAsync<AppPermissionOverview>(Route))!;
            Assert.Equal("/api/apps/example.provider/assets/assets/icon.png?v=1.0.0",
                Assert.Single(locked.Entries.Single(e => e.Id == CoreAppPermissions.SpeechProviders).Apps).IconUrl);
        }
        finally { Directory.Delete(source, recursive: true); }
    }

    [Fact]
    public async Task RequiresAdministratorAndCurrentReadAppsGrant()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var anonymous = host.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync(Route)).StatusCode);
        using var client = await AppManagementHttpTests.CreateAppClient(host, "example.console", []);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(Route)).StatusCode);
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var app = (await apps.GetAppAsync("example.console"))!;
        await apps.UpsertAppAsync(app with { GrantedCorePermissions = [CoreAppPermissions.ReadApps] });
        (await client.GetAsync(Route)).EnsureSuccessStatusCode();
        await apps.UpsertAppAsync(app with { GrantedCorePermissions = [] });
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(Route)).StatusCode);

        await apps.UpsertAppAsync(app with { GrantedCorePermissions = [CoreAppPermissions.ReadApps] });
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        await users.UpdateAsync(state => state with
        {
            Users = state.Users.Select(user => user with { Role = "host.user" }).ToArray(),
            Assignments = [new("example.console", "actor", DateTimeOffset.UtcNow)],
        });
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(Route)).StatusCode);
        using var browser = host.CreateClient();
        browser.DefaultRequestHeaders.Add("Cookie", "hosty_session=operator");
        Assert.Equal(HttpStatusCode.Forbidden, (await browser.GetAsync(Route)).StatusCode);
        await users.UpdateAsync(state => state with { Users = state.Users.Select(user => user with { Role = "host.admin" }).ToArray() });
        (await browser.GetAsync(Route)).EnsureSuccessStatusCode();
    }
}
