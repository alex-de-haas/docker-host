namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Theory]
    [InlineData("hosty.harness", "HOSTY_HARNESS_RETENTION_DAYS", "90")]
    [InlineData("hosty.marketplace", "HOSTY_MARKETPLACE_SOURCE_URL", "https://custom.example/catalog.json")]
    public async Task NativePreference_RemovalRetainsBootstrapValueWithoutACompetingEditor(string appId, string key, string value)
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var v1 = await fixture.WriteManifestAsync("1.0.0", id: appId, settingsJson: $$""" "settings": [{"key":"{{key}}","type":"string","default":"{{value}}"}],""");
        await fixture.Service.InstallAsync(new(v1));
        var v2 = await fixture.WriteManifestAsync("2.0.0", id: appId, settingsJson: "\"settings\": [],");
        var plan = await fixture.Service.CreateUpdatePlanAsync(appId, new(v2));
        var updated = await fixture.Service.ApplyUpdateAsync(appId, new(plan.PlanDigest, v2));
        Assert.DoesNotContain(updated.App!.Settings, setting => setting.Key == key);
        Assert.Equal(value, (await fixture.Apps.GetAppAsync(appId))!.Settings[key].Value);
        await fixture.Service.StartAsync(appId);
        Assert.Equal(value, fixture.Adapter.LastContext!.App.Settings[key].Value);
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Service.ConfigureAsync(appId, new(new Dictionary<string, string?> { [key] = "changed" })));
        Assert.Equal("app_owned_setting", error.Code);
    }
}
