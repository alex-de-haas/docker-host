using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class UiPanelHttpTests
{
    [Fact]
    public async Task CatalogUsesActorAssignmentsAndTargetGrants_AndResolveRechecksRevocation()
    {
        await using var host = await Setup();
        using var client = await Client(host);
        var catalog = await client.GetFromJsonAsync<JsonElement>("/api/internal/apps/consumer/ui/panels");
        var panel = Assert.Single(catalog.GetProperty("panels").EnumerateArray());
        Assert.Equal("target", panel.GetProperty("panel").GetProperty("appId").GetString());
        Assert.True(panel.GetProperty("framePolicy").GetProperty("microphone").GetBoolean());
        Assert.False(panel.GetProperty("framePolicy").GetProperty("popupEscape").GetBoolean());
        Assert.False(panel.GetProperty("canStart").GetBoolean());
        Assert.DoesNotContain("grantedCorePermissions", catalog.ToString());
        var target = await Target(host);
        using var opened = await client.PostAsJsonAsync("/api/internal/apps/consumer/ui/panels/resolve", target);
        opened.EnsureSuccessStatusCode();
        var resolved = await opened.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal("/panel/session-1", resolved.GetProperty("surface").GetProperty("route").GetString());
        Assert.Contains("installationId=", resolved.GetProperty("standaloneHref").GetString());
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        await users.UpdateAsync(s => s with { Assignments = s.Assignments.Where(a => a.AppId != "target").ToArray() });
        using var denied = await client.PostAsJsonAsync("/api/internal/apps/consumer/ui/panels/resolve", target);
        Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
        var fresh = await client.GetFromJsonAsync<JsonElement>("/api/internal/apps/consumer/ui/panels");
        Assert.Empty(fresh.GetProperty("panels").EnumerateArray());
    }

    [Fact]
    public async Task BootstrapDoesNotNeedCatalogPermission_ButOnlyResolvesAnUnambiguousAuthorizedHost()
    {
        await using var host = await Setup();
        using var client = await Client(host, "target");
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var consumer = (await apps.GetAppAsync("consumer"))!;
        var origin = UiPanelService.Peer(consumer).Origins.First();
        var bootstrap = await client.GetFromJsonAsync<JsonElement>("/api/internal/apps/target/ui/bootstrap?parentOrigin=" + Uri.EscapeDataString(origin));
        Assert.False(bootstrap.GetProperty("canHost").GetBoolean());
        Assert.Equal("consumer", bootstrap.GetProperty("peer").GetProperty("appId").GetString());
        Assert.Equal("member", bootstrap.GetProperty("userId").GetString());
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/internal/apps/target/ui/panels")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/internal/apps/target/ui/bootstrap?parentOrigin=https%3A%2F%2Fforeign.test")).StatusCode);
        await apps.UpsertAppAsync(consumer with { Id = "collision" });
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/internal/apps/target/ui/bootstrap?parentOrigin=" + Uri.EscapeDataString(origin))).StatusCode);
    }

    [Fact]
    public async Task UiRequiresOwnServiceAndUserGrant_AndHostGrantRevocationIsImmediate()
    {
        await using var host = await Setup();
        using var client = await Client(host);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/internal/apps/target/ui/bootstrap")).StatusCode);
        var credential = client.DefaultRequestHeaders.GetValues("X-Hosty-User-Token").Single();
        client.DefaultRequestHeaders.Remove("X-Hosty-User-Token");
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/internal/apps/consumer/ui/bootstrap")).StatusCode);
        client.DefaultRequestHeaders.Add("X-Hosty-User-Token", credential);
        await host.Services.GetRequiredService<AppRegistryStore>().UpdateAppAsync("consumer", a => a with { GrantedCorePermissions = [] });
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/internal/apps/consumer/ui/panels")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/internal/apps/consumer/ui/bootstrap")).StatusCode);
    }

    [Fact]
    public async Task TargetsSurvivePresentationUpdatesButNotReinstall_AndLegacyDuplicatesCoalesce()
    {
        await using var host = await Setup();
        using var client = await Client(host);
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var target = await Target(host);
        await apps.UpdateAppAsync("target", a => a with { Ui = a.Ui! with { Panels = [
            new("/other", "web", "Other"), new("/panel", "web", "New label", "star", "tool"),
            new("/other", "web", "Same legacy route") ] } });
        using var success = await client.PostAsJsonAsync("/api/internal/apps/consumer/ui/panels/resolve", target);
        success.EnsureSuccessStatusCode();
        var catalog = await client.GetFromJsonAsync<JsonElement>("/api/internal/apps/consumer/ui/panels");
        Assert.Equal(2, catalog.GetProperty("panels").GetArrayLength());
        await apps.UpdateAppAsync("target", a => a with { InstalledAt = a.InstalledAt.AddSeconds(1) });
        using var changed = await client.PostAsJsonAsync("/api/internal/apps/consumer/ui/panels/resolve", target);
        Assert.Equal(HttpStatusCode.Conflict, changed.StatusCode);
        Assert.Equal("installation_changed", (await changed.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
    }

    [Theory]
    [InlineData("healthy", true, "running")]
    [InlineData("unhealthy", true, "degraded")]
    [InlineData("starting", false, "unavailable")]
    public async Task PanelUsesItsOwnServiceReadinessDuringAPartialOutage(string health, bool available, string state)
    {
        await using var host = await Setup();
        using var client = await Client(host);
        await host.Services.GetRequiredService<AppRegistryStore>().UpdateAppAsync("target", a => a with {
            RuntimeState = "unknown", Endpoints = [a.Endpoints[0] with { Service = "web" }],
            Health = new("degraded", [new("web", "running", health), new("sidecar", "exited", null)], DateTimeOffset.UtcNow)
        });
        var catalog = await client.GetFromJsonAsync<JsonElement>("/api/internal/apps/consumer/ui/panels");
        var panel = Assert.Single(catalog.GetProperty("panels").EnumerateArray());
        Assert.Equal(available, panel.GetProperty("available").GetBoolean());
        Assert.Equal(state, panel.GetProperty("state").GetString());
    }

    [Theory]
    [InlineData("/panel-other")]
    [InlineData("/panel/../admin")]
    [InlineData("/panel/%2e%2e/admin")]
    [InlineData("/panel/%255c")]
    [InlineData("//foreign.test/")]
    public async Task ResolutionRejectsUndeclaredAndAmbiguousRoutes(string route)
    {
        await using var host = await Setup();
        using var client = await Client(host);
        using var response = await client.PostAsJsonAsync("/api/internal/apps/consumer/ui/panels/resolve", (await Target(host)) with { Route = route });
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task SeparateOpenKeepsItsInstallationThroughLoginAndRefusesReinstall()
    {
        await using var host = await Setup();
        using var client = host.CreateClient();
        client.BaseAddress = new Uri("http://localhost:7070");
        var target = await Target(host);
        var link = UiPanelService.BuildOpenUrl(client.BaseAddress.GetLeftPart(UriPartial.Authority), "target", target.Panel.InstallationId, "web", target.Route!);
        using var login = await client.GetAsync(link);
        Assert.StartsWith("/login?returnTo=", login.Headers.Location!.OriginalString);
        await BrowserAuthorityFixture.Grant(host, "consumer", "member");
        client.DefaultRequestHeaders.Add("Cookie", "hosty_session=browser-session");
        using var opened = await client.GetAsync(link);
        Assert.Equal(HttpStatusCode.Redirect, opened.StatusCode);
        Assert.Equal("/panel/session-1", opened.Headers.Location!.AbsolutePath);
        Assert.Contains("hosty_launch=standalone", opened.Headers.Location.Query);
        await host.Services.GetRequiredService<AppRegistryStore>().UpdateAppAsync("target", a => a with { InstalledAt = a.InstalledAt.AddSeconds(1) });
        using var changed = await client.GetAsync(link);
        Assert.Equal(HttpStatusCode.Conflict, changed.StatusCode);
        Assert.Null(changed.Headers.Location);
    }

    [Theory]
    [InlineData("/panel/session-1", "unknown", "running", "healthy", true)]
    [InlineData("/navigation/session-1", "unknown", "running", "healthy", true)]
    [InlineData("/entry/session-1", "unknown", "running", "healthy", true)]
    [InlineData("/panel/session-1", "unknown", "running", "unhealthy", true)]
    [InlineData("/panel/session-1", "running", "exited", null, false)]
    [InlineData("/panel/session-1", "running", "running", "starting", false)]
    [InlineData("/panel/session-1", "starting", "running", "healthy", false)]
    [InlineData("/panel/session-1", "stopping", "running", "healthy", false)]
    public async Task SeparateOpenUsesTheMatchedSurfaceServiceReadiness(string route, string runtime,
        string serviceStatus, string? serviceHealth, bool available)
    {
        await using var host = await Setup();
        using var client = host.CreateClient();
        client.BaseAddress = new Uri("http://localhost:7070");
        await BrowserAuthorityFixture.Grant(host, "consumer", "member");
        client.DefaultRequestHeaders.Add("Cookie", "hosty_session=browser-session");
        await host.Services.GetRequiredService<AppRegistryStore>().UpdateAppAsync("target", a => a with {
            RuntimeState = runtime, Endpoints = [a.Endpoints[0] with { Service = "web" }],
            Health = new("degraded", [new("web", serviceStatus, serviceHealth), new("sidecar", "exited", null)], DateTimeOffset.UtcNow),
            Ui = a.Ui! with { EntryPath = "/entry", Navigation = [new("Navigation", "/navigation", "web")] }
        });
        var target = await Target(host);
        var link = UiPanelService.BuildOpenUrl(client.BaseAddress.GetLeftPart(UriPartial.Authority),
            "target", target.Panel.InstallationId, "web", route);
        using var opened = await client.GetAsync(link);
        Assert.Equal(available ? HttpStatusCode.Redirect : HttpStatusCode.Conflict, opened.StatusCode);
        if (available)
        {
            Assert.Equal(route, opened.Headers.Location!.AbsolutePath);
            Assert.Contains("hosty_launch=standalone", opened.Headers.Location.Query);
        }
        else Assert.Null(opened.Headers.Location);
    }

    private static async Task<UiPanelTarget> Target(CoreHttpHarness host)
        => new(new("target", PanelIdentity.Installation((await host.Services.GetRequiredService<AppRegistryStore>().GetAppAsync("target"))!), "tool"), "/panel/session-1");

    private static async Task<HttpClient> Client(CoreHttpHarness host, string appId = "consumer")
    {
        var client = host.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(appId));
        var token = await host.Services.GetRequiredService<AppIdentityService>().CreateLaunchTokenAsync(appId, "member");
        client.DefaultRequestHeaders.Add("X-Hosty-User-Token", token.AccessToken);
        return client;
    }

    private static async Task<CoreHttpHarness> Setup()
    {
        var host = await CoreHttpHarness.StartAsync();
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var now = DateTimeOffset.UtcNow;
        AppRecord App(string id, int port) => new(id, id, null, "1.0.0", "runtime", false, "installed", null, null,
            "local", "installed", "running", null, null, [], new Dictionary<string, AppSettingValue>(),
            [], [], [new("web", "http", $"http://127.0.0.1:{port}", true)], now, now,
            Ui: new(null, null, "web", "/", []));
        await apps.UpsertAppAsync(App("consumer", 3101) with { GrantedCorePermissions = [CoreAppPermissions.ReadPanels, CoreAppPermissions.Install] });
        await apps.UpsertAppAsync(App("target", 3102) with { GrantedCorePermissions = [CoreAppPermissions.SpeechProviders],
            Ui = new(null, null, "web", "/", [], Panels: [new("/panel", "web", "Tool", "bot", "tool")]) });
        await apps.UpsertAppAsync(App("hidden", 3103) with { Ui = new(null, null, "web", "/", [], Panels: [new("/", "web", "Hidden")]) });
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1,
            [new("member", "member@example.test", "Member", "host.user", false, now, now)], [],
            [new("consumer", "member", now), new("target", "member", now)], []));
        return host;
    }
}
