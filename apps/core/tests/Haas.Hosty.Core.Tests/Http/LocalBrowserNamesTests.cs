using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class LocalBrowserNamesTests
{
    private static async Task<AppRecord> Seed(CoreHttpHarness host, string id)
    {
        var app = AssistantMcpAccessHttpTests.Record(id, DateTimeOffset.UtcNow) with {
            Endpoints = [new("ui", "http", "http://127.0.0.1:3100", true), new("api", "http", "http://127.0.0.1:3101", false)] };
        return (await host.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(app)).App;
    }
    private static AppConfigureRequest Rename(AppRecord app, string? name) => new(
        Settings: new Dictionary<string, string?> { [LocalBrowserOrigins.NameKey("ui")] = name, [PublicOriginSettings.BuildSettingKey("ui")] = null },
        ExpectedBrowserOrigins: new Dictionary<string, string?> { ["ui"] = LocalBrowserOrigins.App(app, app.Endpoints[0]) });

    [Fact]
    public async Task LocalName_FollowsPortAndPreservesManualOriginUntilExplicitlySelected()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var app = await Seed(host, "example.media");
        var lifecycle = host.Services.GetRequiredService<CoreLifecycleService>();
        var store = host.Services.GetRequiredService<AppRegistryStore>();
        await lifecycle.ConfigureAsync(app.Id, Rename(app, "media-server"));
        var named = (await store.GetAppAsync(app.Id))!;
        var origin = LocalBrowserOrigins.App(named, named.Endpoints[0]);
        Assert.Contains("media-server.", origin);
        Assert.EndsWith(":3100", origin);
        Assert.Equal("http://127.0.0.1:3101", LocalBrowserOrigins.App(named, named.Endpoints[1]));
        await Assert.ThrowsAsync<AppLifecycleException>(() => lifecycle.ConfigureAsync(app.Id, Rename(app, "stale-name")));
        var moved = (await store.UpdateAppAsync(app.Id, record => record with { Endpoints = record.Endpoints.Select(e => e.Key == "ui" ? e with { Url = "http://127.0.0.1:3300" } : e).ToArray() })).App;
        Assert.EndsWith(":3300", LocalBrowserOrigins.App(moved, moved.Endpoints[0]));
        await lifecycle.ConfigureAsync(app.Id, new(Settings: new Dictionary<string, string?> { [PublicOriginSettings.BuildSettingKey("ui")] = "https://custom.example:444" }));
        var external = (await store.GetAppAsync(app.Id))!;
        Assert.Equal("https://custom.example:444", LocalBrowserOrigins.App(external, external.Endpoints[0]));
        Assert.Contains("media-server.", LocalBrowserOrigins.Local(external, external.Endpoints[0]));
        await lifecycle.ConfigureAsync(app.Id, new(Settings: new Dictionary<string, string?> { [PublicOriginSettings.BuildSettingKey("ui")] = null }));
        var restored = (await store.GetAppAsync(app.Id))!;
        Assert.EndsWith(":3300", LocalBrowserOrigins.App(restored, restored.Endpoints[0]));
        await lifecycle.ConfigureAsync(app.Id, Rename(restored, null));
        var reset = (await store.GetAppAsync(app.Id))!;
        Assert.Equal(LocalBrowserOrigins.DefaultLocal(reset, reset.Endpoints[0]), LocalBrowserOrigins.App(reset, reset.Endpoints[0]));
    }

    [Fact]
    public async Task ConcurrentNames_HaveOneWinner_AndReserveLocalFallbackBehindExternalOrigin()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var first = await Seed(host, "example.first");
        var second = await Seed(host, "example.second");
        var lifecycle = host.Services.GetRequiredService<CoreLifecycleService>();
        async Task<bool> Try(AppRecord app) {
            try { await lifecycle.ConfigureAsync(app.Id, Rename(app, "media")); return true; }
            catch (AppLifecycleException ex) when (ex.Code == "origin_host_conflict") { return false; }
        }
        var outcomes = await Task.WhenAll(Try(first), Try(second));
        Assert.Single(outcomes, result => result);
        var winner = outcomes[0] ? first : second;
        var loser = outcomes[0] ? second : first;
        await lifecycle.ConfigureAsync(winner.Id, new(Settings: new Dictionary<string, string?> { [PublicOriginSettings.BuildSettingKey("ui")] = "https://external.example" }));
        Assert.False(await Try(loser));
    }

    [Fact]
    public async Task NamedOrigin_IsSharedBySummaryAndRuntime_ButNeverByCore()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var app = await Seed(host, "example.named");
        var store = host.Services.GetRequiredService<AppRegistryStore>();
        await host.Services.GetRequiredService<CoreLifecycleService>().ConfigureAsync(app.Id, Rename(app, "reader"));
        var named = (await store.GetAppAsync(app.Id))!;
        var endpoint = AppSummary.From(named).Endpoints.First(e => e.Key == "ui");
        Assert.Equal("reader", endpoint.LocalName);
        Assert.Equal(LocalBrowserOrigins.Site(named.BrowserOriginScope), endpoint.LocalSuffix);
        Assert.Equal(endpoint.LocalOrigin, endpoint.BrowserOrigin);
        Assert.Equal(endpoint.BrowserOrigin, LocalBrowserOrigins.Environment(named, named.Endpoints)["HOSTY_PUBLIC_ORIGIN_UI"]);
        Assert.NotEqual(endpoint.BrowserOrigin, LocalBrowserOrigins.App(named with { BrowserOriginScope = "another-instance" }, named.Endpoints[0]));
        await Assert.ThrowsAsync<AppLifecycleException>(() => LocalBrowserOrigins.ValidateCoreAsync(endpoint.BrowserOrigin!, store, default));
        await host.Services.GetRequiredService<CoreLifecycleService>().ConfigureAsync(app.Id,
            new(Settings: new Dictionary<string, string?> { [PublicOriginSettings.BuildSettingKey("ui")] = "https://reader.example" }));
        await Assert.ThrowsAsync<AppLifecycleException>(() => LocalBrowserOrigins.ValidateCoreAsync(endpoint.LocalOrigin!, store, default));
    }

    [Theory]
    [InlineData("core")]
    [InlineData("bad.name")]
    [InlineData("-bad")]
    [InlineData("name:8080")]
    public async Task InvalidOrReservedNames_DoNotChangeSettings(string name)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var app = await Seed(host, "example.app");
        await Assert.ThrowsAsync<AppLifecycleException>(() => host.Services.GetRequiredService<CoreLifecycleService>().ConfigureAsync(app.Id, Rename(app, name)));
        Assert.Null(LocalBrowserOrigins.Name((await host.Services.GetRequiredService<AppRegistryStore>().GetAppAsync(app.Id))!, app.Endpoints[0]));
    }
}
