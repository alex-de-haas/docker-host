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

    [Theory]
    [InlineData("hosty.harness", "HOSTY_HARNESS_RETENTION_DAYS")]
    [InlineData("hosty.marketplace", "HOSTY_MARKETPLACE_SOURCE_URL")]
    public async Task NativePreference_ReviewedRemovalDoesNotReappearAtTheSameVersionOrAfterRestart(string appId, string key)
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", id: appId,
            settingsJson: $$""" "settings": [{"key":"{{key}}","type":"string","default":"retained"}],""");
        await fixture.Service.InstallAsync(new(manifest));
        // The upstream contract changes without a version bump; the installed copy still declares the key.
        await fixture.WriteManifestAsync("1.0.0", id: appId, settingsJson: "\"settings\": [],");
        var removal = await fixture.Service.CreateUpdatePlanAsync(appId, new(manifest));
        Assert.Contains($"setting:{key}:removed", removal.Changes);
        Assert.True(removal.RequiresReview);
        Assert.Contains(removal.SettingChanges!, change => change.Key == key && change.Change == "removed");
        await fixture.Service.ApplyUpdateAsync(appId, new(removal.PlanDigest));

        var recheck = await fixture.Service.CreateUpdatePlanAsync(appId, new(manifest));
        Assert.Empty(recheck.Changes);
        Assert.False(recheck.RequiresReview);
        Assert.Empty(recheck.SettingChanges!);
        Assert.False(Assert.Single(await fixture.Service.ListAppsAsync()).UpdateCheck!.UpdateAvailable);

        // Reload persisted registry and verdict as a replacement Core would, then perform a fresh check.
        var restarted = fixture.RecreateService();
        Assert.False(Assert.Single(await restarted.ListAppsAsync()).UpdateCheck!.UpdateAvailable);
        Assert.Empty((await restarted.CreateUpdatePlanAsync(appId, new(manifest))).Changes);
        Assert.Equal("retained", (await fixture.Apps.GetAppAsync(appId))!.Settings[key].Value);

        // A later declaration is still reviewed; the migration exception must not hide schema changes.
        await fixture.WriteManifestAsync("1.0.0", id: appId,
            settingsJson: $$""" "settings": [{"key":"{{key}}","type":"string","secret":true}],""");
        var reintroduced = await restarted.CreateUpdatePlanAsync(appId, new(manifest));
        Assert.Contains($"setting:{key}:secret:False->True", reintroduced.Changes);
        Assert.True(reintroduced.RequiresReview);
    }

    [Theory]
    [InlineData("hosty.harness", "HOSTY_HARNESS_RETENTION_DAYS")]
    [InlineData("hosty.marketplace", "HOSTY_MARKETPLACE_SOURCE_URL")]
    public async Task NativePreference_RuntimeSwitchDoesNotReportRetainedMigrationValueAsRemoved(string appId, string key)
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteSwitchableDockerManifestAsync();
        await File.WriteAllTextAsync(manifest, (await File.ReadAllTextAsync(manifest)).Replace("com.example.notes", appId));
        await fixture.Service.InstallAsync(new(manifest));
        var app = (await fixture.Apps.GetAppAsync(appId))!;
        await fixture.Apps.UpsertAppAsync(app with
        {
            Settings = new Dictionary<string, AppSettingValue>(app.Settings, StringComparer.Ordinal)
            {
                [key] = new(key, "string", "retained", Secret: false),
            },
        });

        var plan = await fixture.Service.CreateRuntimeSwitchPlanAsync(appId, new("docker-alt"));
        Assert.DoesNotContain($"setting:{key}:removed", plan.Changes);
    }
}
