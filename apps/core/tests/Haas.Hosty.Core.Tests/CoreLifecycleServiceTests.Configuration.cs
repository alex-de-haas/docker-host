using System.Text.Json;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private const string UnconfiguredLaunchSettings = """
        "settings": [
          { "key": "APP_MODE", "type": "string", "required": true },
          { "key": "APP_TOKEN", "type": "string", "secret": true, "required": true }
        ],
        """;

    [Fact]
    public async Task ConfigurationReadiness_DefaultInstallLeavesIncompleteAppStoppedWithoutStartFailure()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", settingsJson: UnconfiguredLaunchSettings);

        var result = await fixture.Service.InstallAsync(new AppInstallRequest(manifest, StartOnInstall: true));

        Assert.Equal("installed", result.Status);
        Assert.Equal("stopped", result.App!.RuntimeState);
        Assert.Equal("installed", result.App.OperationStatus);
        Assert.Null(result.App.LastError);
        Assert.True(result.App.Autostart);
        Assert.Equal(0, fixture.Adapter.StartCount);
        Assert.True(result.App.ConfigurationReadiness!.Required);
        Assert.Equal(["APP_MODE", "APP_TOKEN"], result.App.ConfigurationReadiness.MissingSettings);
    }

    [Fact]
    public async Task ConfigurationReadiness_DefaultsAndSecretPresencePermitLaunchWithoutDisclosure()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", settingsJson: """
            "settings": [
              { "key": "APP_MODE", "type": "string", "required": true, "default": "production" },
              { "key": "APP_TOKEN", "type": "string", "secret": true, "required": true, "default": "sensitive-default-token" }
            ],
            """);

        var result = await fixture.Service.InstallAsync(new AppInstallRequest(manifest, StartOnInstall: true));

        Assert.False(result.App!.ConfigurationReadiness!.Required);
        Assert.Equal("running", result.App.RuntimeState);
        Assert.Equal(1, fixture.Adapter.StartCount);
        Assert.DoesNotContain("sensitive-default-token", JsonSerializer.Serialize(result.App, CoreJsonSerializerContext.Default.AppSummary));
    }

    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    [InlineData(null)]
    public async Task ConfigurationReadiness_ExplicitMissingValueOverridesInstallDefault(string? value)
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", settingsJson: """
            "settings": [{ "key": "APP_MODE", "type": "string", "required": true, "default": "production" }],
            """);
        var result = await fixture.Service.InstallAsync(new AppInstallRequest(manifest,
            Settings: new Dictionary<string, string?> { ["APP_MODE"] = value }, StartOnInstall: true));

        Assert.True(result.App!.ConfigurationReadiness!.Required);
        Assert.Equal(0, fixture.Adapter.StartCount);
        Assert.Null(result.App.LastError);
    }

    [Fact]
    public async Task ConfigurationReadiness_ConfigurationSaveClearsWarningAndRequiresExplicitStart()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", settingsJson: UnconfiguredLaunchSettings);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest, Autostart: false, StartOnInstall: true));

        var configured = await fixture.Service.ConfigureAsync("com.example.notes", new AppConfigureRequest(
            new Dictionary<string, string?> { ["APP_MODE"] = "production", ["APP_TOKEN"] = "private-token-value" }));

        Assert.False(configured.App!.ConfigurationReadiness!.Required);
        Assert.Equal("stopped", configured.App.RuntimeState);
        Assert.False(configured.App.Autostart);
        Assert.Equal(0, fixture.Adapter.StartCount);
        Assert.DoesNotContain("private-token-value", JsonSerializer.Serialize(configured.App, CoreJsonSerializerContext.Default.AppSummary));
        var started = await fixture.Service.StartAsync("com.example.notes");
        Assert.Equal("running", started.App!.RuntimeState);
        Assert.Equal(1, fixture.Adapter.StartCount);
    }

    [Fact]
    public async Task ConfigurationReadiness_BootSkipsIncompleteAppsAndKeepsAutostartPreference()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", settingsJson: UnconfiguredLaunchSettings);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        foreach (var attempt in Enumerable.Range(0, 2))
        {
            var result = Assert.Single(await fixture.Service.StartAutostartAppsAsync());
            Assert.True(result.Succeeded);
            Assert.Null(result.ErrorCode);
            Assert.Equal("configuration-required", result.Message);
        }
        Assert.Equal(0, fixture.Adapter.StartCount);
        var app = (await fixture.Apps.GetAppAsync("com.example.notes"))!;
        Assert.Equal("installed", app.OperationStatus);
        Assert.True(app.Autostart);
        Assert.Null(app.LastError);
    }

    [Fact]
    public async Task ConfigurationReadiness_UpdateInstallsIncompleteTargetAndDoesNotRestart()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0"), StartOnInstall: true));
        var target = await fixture.WriteManifestAsync("2.0.0", settingsJson: UnconfiguredLaunchSettings);
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(target));

        var result = await fixture.Service.ApplyUpdateAsync("com.example.notes", new AppUpdateApplyRequest(plan.PlanDigest));

        Assert.True(plan.ConfigurationReadiness!.Required);
        Assert.Equal(["APP_TOKEN"], plan.ConfigurationReadiness.MissingSettings);
        Assert.Equal("updated", result.Status);
        Assert.Equal("2.0.0", result.App!.Version);
        Assert.Equal("stopped", result.App.RuntimeState);
        Assert.Equal("updated", result.App.OperationStatus);
        Assert.Null(result.App.LastError);
        Assert.True(result.App.Autostart);
        Assert.Equal("completed", result.App.UpdateProgress!.Stage);
        Assert.Equal(1, fixture.Adapter.StartCount);
        Assert.Equal(1, fixture.Adapter.StopCount);
        var configured = await fixture.Service.ConfigureAsync("com.example.notes", new AppConfigureRequest(
            new Dictionary<string, string?> { ["APP_TOKEN"] = "new-secret" }));
        Assert.False(configured.App!.ConfigurationReadiness!.Required);
        Assert.Equal("stopped", configured.App.RuntimeState);
        Assert.Equal(1, fixture.Adapter.StartCount);
        await fixture.Service.StartAsync("com.example.notes");
        Assert.Equal(2, fixture.Adapter.StartCount);
    }

    [Fact]
    public async Task ConfigurationReadiness_UpdateApplyRechecksValuesAfterReview()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var settings = """
            "settings": [{ "key": "APP_MODE", "type": "string", "required": true, "default": "production" }],
            """;
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0", settingsJson: settings), StartOnInstall: true));
        var target = await fixture.WriteManifestAsync("2.0.0", settingsJson: settings);
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(target));
        Assert.False(plan.ConfigurationReadiness!.Required);
        await fixture.Service.ConfigureAsync("com.example.notes", new AppConfigureRequest(new Dictionary<string, string?> { ["APP_MODE"] = "" }));

        var result = await fixture.Service.ApplyUpdateAsync("com.example.notes", new AppUpdateApplyRequest(plan.PlanDigest));

        Assert.Equal("updated", result.Status);
        Assert.True(result.App!.ConfigurationReadiness!.Required);
        Assert.Equal("stopped", result.App.RuntimeState);
        Assert.Equal(1, fixture.Adapter.StartCount);
    }

    [Fact]
    public async Task ConfigurationReadiness_MissingMountInstallsWithoutLaunchAndClearsAfterBinding()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", externalMountsJson: RequiredCatalogMountsJson);
        var installed = await fixture.Service.InstallAsync(new AppInstallRequest(manifest, StartOnInstall: true));
        var issue = Assert.Single(installed.App!.ConfigurationReadiness!.Mounts);
        Assert.Equal("catalogRoots", issue.Key);
        Assert.Equal("required", issue.Reason);
        Assert.Equal(0, fixture.Adapter.StartCount);

        var host = CreateExternalDirectory();
        var configured = await fixture.Service.ConfigureMountsAsync("com.example.notes",
            new AppMountsRequest([new AppMountBindingInput("catalogRoots", "movies", host)]));

        Assert.False(configured.App!.ConfigurationReadiness!.Required);
        Assert.Equal("stopped", configured.App.RuntimeState);
        Assert.Equal(0, fixture.Adapter.StartCount);
    }

    [Fact]
    public async Task ConfigurationReadiness_DeletedSharedMountIsNotCountedAsConfigured()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", externalMountsJson: RequiredCatalogMountsJson);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var library = fixture.CreateGlobalMountService();
        await library.UpsertAsync(new GlobalMountUpsertRequest("media", CreateExternalDirectory()));
        await fixture.Service.ConfigureMountsAsync("com.example.notes",
            new AppMountsRequest([new AppMountBindingInput("catalogRoots", GlobalMountName: "media")]));
        await library.DeleteAsync("media", force: true);

        var readiness = Assert.Single(await fixture.Service.ListAppsAsync()).ConfigurationReadiness!;

        Assert.True(readiness.Required);
        Assert.Equal("reference_missing", Assert.Single(readiness.Mounts).Reason);
        Assert.Equal(0, fixture.Adapter.StartCount);
    }

    [Fact]
    public async Task ConfigurationReadiness_InvalidOptionalPathBlocksLaunchWithoutProjectingPath()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var optionalMounts = RequiredCatalogMountsJson.Replace("\"required\": true", "\"required\": false", StringComparison.Ordinal);
        var manifest = await fixture.WriteManifestAsync("1.0.0", externalMountsJson: optionalMounts);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var host = CreateExternalDirectory();
        await fixture.Service.ConfigureMountsAsync("com.example.notes", new AppMountsRequest([new AppMountBindingInput("catalogRoots", "movies", host)]));
        Directory.Delete(host);

        var app = Assert.Single(await fixture.Service.ListAppsAsync());

        Assert.True(app.ConfigurationReadiness!.Required);
        Assert.Equal("source_missing", Assert.Single(app.ConfigurationReadiness.Mounts).Reason);
        Assert.DoesNotContain(host, JsonSerializer.Serialize(app.ConfigurationReadiness, CoreJsonSerializerContext.Default.AppConfigurationReadiness));
        var skipped = Assert.Single(await fixture.Service.StartAutostartAppsAsync());
        Assert.Equal("configuration-required", skipped.Message);
        Assert.Equal(0, fixture.Adapter.StartCount);
    }

    [Fact]
    public async Task ConfigurationReadiness_RetainedValueAndExplicitEmptyKeepExistingPrecedence()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", settingsJson: """
            "settings": [{ "key": "APP_MODE", "type": "string", "required": true, "default": "production" }],
            """);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest, Settings: new Dictionary<string, string?> { ["APP_MODE"] = "" }));
        await fixture.Service.RemoveAsync("com.example.notes", new AppRemoveRequest());
        var plan = await fixture.Service.CreateInstallPlanAsync(new AppInstallPlanRequest(manifest));
        Assert.True(plan.ConfigurationReadiness!.Required);

        var installed = await fixture.Service.InstallAsync(new AppInstallRequest(manifest,
            Settings: new Dictionary<string, string?> { ["APP_MODE"] = "override" }, StartOnInstall: true));

        Assert.False(installed.App!.ConfigurationReadiness!.Required);
        Assert.Equal("running", installed.App.RuntimeState);
        Assert.Equal("override", Assert.Single(installed.App.Settings, setting => setting.Key == "APP_MODE").Value);
    }

    [Fact]
    public async Task ConfigurationReadiness_RestartCannotBypassRequiredSecretGate()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", settingsJson: UnconfiguredLaunchSettings);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Service.RestartAsync("com.example.notes"));

        Assert.Equal("app_required_settings_missing", error.Code);
        Assert.Equal(0, fixture.Adapter.StartCount);
        Assert.Equal(0, fixture.Adapter.StopCount);
    }

    [Fact]
    public async Task ConfigurationReadiness_UnreadableSharedLibraryDoesNotClaimReadyOrExposeItsContents()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", externalMountsJson: RequiredCatalogMountsJson);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var library = fixture.CreateGlobalMountService();
        await library.UpsertAsync(new GlobalMountUpsertRequest("media", CreateExternalDirectory()));
        await fixture.Service.ConfigureMountsAsync("com.example.notes",
            new AppMountsRequest([new AppMountBindingInput("catalogRoots", GlobalMountName: "media")]));
        await File.WriteAllTextAsync(Path.Combine(fixture.Paths.CoreRoot, "global-mounts.json"), "sensitive-invalid-json");

        var readiness = Assert.Single(await fixture.Service.ListAppsAsync()).ConfigurationReadiness!;

        Assert.True(readiness.Required);
        Assert.Equal("mounts_unavailable", readiness.Error);
        Assert.DoesNotContain("sensitive-invalid-json", JsonSerializer.Serialize(readiness, CoreJsonSerializerContext.Default.AppConfigurationReadiness));
        Assert.Equal("configuration-required", Assert.Single(await fixture.Service.StartAutostartAppsAsync()).Message);
        Assert.Equal(0, fixture.Adapter.StartCount);
    }

    [Fact]
    public async Task ConfigurationReadiness_UpdateRechecksDeletedMountAfterReadyReview()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", externalMountsJson: RequiredCatalogMountsJson);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var host = CreateExternalDirectory();
        await fixture.Service.ConfigureMountsAsync("com.example.notes",
            new AppMountsRequest([new AppMountBindingInput("catalogRoots", "movies", host)]));
        await fixture.Service.StartAsync("com.example.notes");
        var target = await fixture.WriteManifestAsync("2.0.0", externalMountsJson: RequiredCatalogMountsJson);
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(target));
        Assert.False(plan.ConfigurationReadiness!.Required);
        Directory.Delete(host);

        var updated = await fixture.Service.ApplyUpdateAsync("com.example.notes", new AppUpdateApplyRequest(plan.PlanDigest));

        Assert.Equal("updated", updated.Status);
        Assert.Equal("stopped", updated.App!.RuntimeState);
        Assert.Equal("completed", updated.App.UpdateProgress!.Stage);
        Assert.Equal("source_missing", Assert.Single(updated.App.ConfigurationReadiness!.Mounts).Reason);
        Assert.Equal(1, fixture.Adapter.StartCount);
    }

    [Fact]
    public async Task ConfigurationReadiness_MountOverlappingTrackedSourceIsNotReady()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", externalMountsJson: RequiredCatalogMountsJson);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var host = CreateExternalDirectory();
        await fixture.Service.ConfigureMountsAsync("com.example.notes",
            new AppMountsRequest([new AppMountBindingInput("catalogRoots", "movies", host)]));
        await fixture.Apps.UpdateAppAsync("com.example.notes", app => app with { ActiveSourcePaths = [host] });

        var readiness = Assert.Single(await fixture.Service.ListAppsAsync()).ConfigurationReadiness!;

        Assert.True(readiness.Required);
        Assert.Equal("source_unsafe", Assert.Single(readiness.Mounts).Reason);
        Assert.DoesNotContain(host, JsonSerializer.Serialize(readiness, CoreJsonSerializerContext.Default.AppConfigurationReadiness));
        Assert.Equal("configuration-required", Assert.Single(await fixture.Service.StartAutostartAppsAsync()).Message);
    }

    [Fact]
    public async Task ConfigurationReadiness_UpdateKeepsUnsafeMountStoppedAndStartStillRefusesIt()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", externalMountsJson: RequiredCatalogMountsJson);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var host = CreateExternalDirectory();
        await fixture.Service.ConfigureMountsAsync("com.example.notes",
            new AppMountsRequest([new AppMountBindingInput("catalogRoots", "movies", host)]));
        await fixture.Service.StartAsync("com.example.notes");
        var target = await fixture.WriteManifestAsync("2.0.0", externalMountsJson: RequiredCatalogMountsJson);
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(target));
        Directory.Delete(host);
        Directory.CreateSymbolicLink(host, fixture.Paths.CoreRoot);
        try
        {
            var updated = await fixture.Service.ApplyUpdateAsync("com.example.notes", new AppUpdateApplyRequest(plan.PlanDigest));

            Assert.Equal("updated", updated.Status);
            Assert.Equal("2.0.0", updated.App!.Version);
            Assert.Equal("stopped", updated.App.RuntimeState);
            Assert.Equal("completed", updated.App.UpdateProgress!.Stage);
            Assert.Equal("source_unsafe", Assert.Single(updated.App.ConfigurationReadiness!.Mounts).Reason);
            Assert.Equal(host, Assert.Single((await fixture.Apps.GetAppAsync("com.example.notes"))!.Mounts!).HostPath);
            Assert.Equal(1, fixture.Adapter.StartCount);
            var error = await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Service.StartAsync("com.example.notes"));
            Assert.Equal("app_mount_path_in_data_root", error.Code);
            Assert.Equal(1, fixture.Adapter.StartCount);
        }
        finally { Directory.Delete(host); }
    }

    [Fact]
    public async Task ConfigurationReadiness_IncompleteUpdateDoesNotBypassSourceAuthority()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));
        await fixture.Apps.UpdateAppAsync("com.example.notes", app => app with
        {
            SourceState = new AppSourceState("local", null, null, null, null, fixture.Paths.AppsRoot, null),
        });
        var target = await fixture.WriteManifestAsync("2.0.0", settingsJson: UnconfiguredLaunchSettings);
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(target));
        Assert.True(plan.ConfigurationReadiness!.Required);

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.ApplyUpdateAsync("com.example.notes", new AppUpdateApplyRequest(plan.PlanDigest)));

        Assert.Equal("source_override_path_forbidden", error.Code);
        Assert.Equal(0, fixture.Adapter.StartCount);
    }

    [Fact]
    public async Task ConfigurationReadiness_UpdateToSingleMountKeepsBindingsStoppedUntilConfigured()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var manifest = await fixture.WriteManifestAsync("1.0.0", externalMountsJson: RequiredCatalogMountsJson);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        var first = CreateExternalDirectory();
        var second = CreateExternalDirectory();
        await fixture.Service.ConfigureMountsAsync("com.example.notes", new AppMountsRequest([
            new AppMountBindingInput("catalogRoots", "first", first),
            new AppMountBindingInput("catalogRoots", "second", second),
        ]));
        await fixture.Service.StartAsync("com.example.notes");
        var target = await fixture.WriteManifestAsync("2.0.0", externalMountsJson:
            RequiredCatalogMountsJson.Replace("\"multiple\": true", "\"multiple\": false", StringComparison.Ordinal));
        var plan = await fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(target));
        Assert.True(plan.RequiresReview);
        Assert.Equal("multiple_not_allowed", Assert.Single(plan.ConfigurationReadiness!.Mounts).Reason);

        var updated = await fixture.Service.ApplyUpdateAsync("com.example.notes", new AppUpdateApplyRequest(plan.PlanDigest));

        Assert.Equal("updated", updated.Status);
        Assert.Equal("completed", updated.App!.UpdateProgress!.Stage);
        Assert.Equal("stopped", updated.App.RuntimeState);
        Assert.Null(updated.App.LastError);
        Assert.True(updated.App.Autostart);
        Assert.Equal(2, Assert.Single(updated.App.Mounts).Bindings.Count);
        Assert.Equal("multiple_not_allowed", Assert.Single(updated.App.ConfigurationReadiness!.Mounts).Reason);
        Assert.Equal(1, fixture.Adapter.StartCount);
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Service.StartAsync("com.example.notes"));
        Assert.Equal("app_mount_multiple_not_allowed", error.Code);
        error = await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Service.RestartAsync("com.example.notes"));
        Assert.Equal("app_mount_multiple_not_allowed", error.Code);
        Assert.Equal(1, fixture.Adapter.StartCount);

        var configured = await fixture.Service.ConfigureMountsAsync("com.example.notes", new AppMountsRequest([
            new AppMountBindingInput("catalogRoots", "first", first),
        ]));
        Assert.False(configured.App!.ConfigurationReadiness!.Required);
        Assert.Equal("stopped", configured.App.RuntimeState);
        Assert.Equal(1, fixture.Adapter.StartCount);
        var started = await fixture.Service.StartAsync("com.example.notes");
        Assert.Equal("running", started.App!.RuntimeState);
        Assert.Equal(2, fixture.Adapter.StartCount);
        Assert.Single(fixture.Adapter.LastContext!.Mounts);
    }
}
