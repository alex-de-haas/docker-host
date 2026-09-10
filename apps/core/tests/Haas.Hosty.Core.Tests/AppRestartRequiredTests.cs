using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task RestartRequired_SettingsChangesSurviveCoreRestartAndClearOnRevertOrRestart()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));
        Assert.False((await fixture.Service.ConfigureAsync("com.example.notes", new(Settings: new Dictionary<string, string?> { ["APP_MODE"] = "before-start" }))).App!.RestartRequired);
        await fixture.Service.StartAsync("com.example.notes");
        var noOp = await fixture.Service.ConfigureAsync("com.example.notes", new(Settings: new Dictionary<string, string?> { ["APP_MODE"] = "before-start" }, Autostart: false));
        Assert.False(noOp.App!.RestartRequired);
        var changed = await fixture.Service.ConfigureAsync("com.example.notes", new(Settings: new Dictionary<string, string?> { ["APP_MODE"] = "changed" }));
        Assert.True(changed.App!.RestartRequired);
        Assert.True(Assert.Single(await fixture.RecreateService().ListAppsAsync()).RestartRequired);
        var reverted = await fixture.Service.ConfigureAsync("com.example.notes", new(Settings: new Dictionary<string, string?> { ["APP_MODE"] = "before-start" }));
        Assert.False(reverted.App!.RestartRequired);
        await fixture.Service.ConfigureAsync("com.example.notes", new(Settings: new Dictionary<string, string?> { ["APP_MODE"] = "changed" }));
        Assert.False((await fixture.Service.RestartAsync("com.example.notes")).App!.RestartRequired);
        Assert.Equal("changed", fixture.Adapter.LastContext!.App.Settings["APP_MODE"].Value);
    }

    [Fact]
    public async Task RestartRequired_LegacyRunningAppCapturesBaselineBeforeSettingsEdit()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));
        await fixture.Service.StartAsync("com.example.notes");
        await fixture.Apps.UpdateAppAsync("com.example.notes", app => app with { AppliedConfigurationHash = null });
        var result = await fixture.Service.ConfigureAsync("com.example.notes", new(Settings: new Dictionary<string, string?> { ["APP_MODE"] = "edited" }));
        Assert.True(result.App!.RestartRequired);
        Assert.NotNull((await fixture.Apps.GetAppAsync("com.example.notes"))!.AppliedConfigurationHash);
    }

    [Fact]
    public async Task RestartRequired_SharedAssignmentsAndLibraryEditsCompareEffectiveMounts()
    {
        var fixture = await CreateSharedAssignmentFixture();
        await fixture.Service.ConfigureSharedMountsAsync("com.example.notes", "media", new(["catalogRoots"], []));
        await fixture.Service.StartAsync("com.example.notes");
        var noOp = await fixture.Service.ConfigureSharedMountsAsync("com.example.notes", "media", new(["catalogRoots"], ["catalogRoots"]));
        Assert.False(noOp.App!.RestartRequired);
        var moved = await fixture.Service.ConfigureSharedMountsAsync("com.example.notes", "media", new(["downloads"], ["catalogRoots"]));
        Assert.True(moved.App!.RestartRequired);
        Assert.False((await fixture.Service.RestartAsync("com.example.notes")).App!.RestartRequired);
        var library = fixture.CreateGlobalMountService();
        var original = (await library.FindAsync("media"))!;
        await library.UpsertAsync(new("media", original.HostPath, Description: "Display-only edit"));
        Assert.False(Assert.Single(await fixture.Service.ListAppsAsync()).RestartRequired);
        // The downloads slot is already read-only: tightening the library cap is not a runtime change.
        await library.UpsertAsync(new("media", original.HostPath, Mode: "ro"));
        Assert.False(Assert.Single(await fixture.Service.ListAppsAsync()).RestartRequired);
        await library.UpsertAsync(new("media", CreateExternalDirectory(), Mode: "ro"));
        Assert.True(Assert.Single(await fixture.RecreateService().ListAppsAsync()).RestartRequired);
        await library.UpsertAsync(new("media", original.HostPath));
        Assert.False(Assert.Single(await fixture.Service.ListAppsAsync()).RestartRequired);
    }

    [Fact]
    public async Task RestartRequired_LegacyLibraryEditAndInlineMountEditCaptureBaseline()
    {
        var fixture = await CreateSharedAssignmentFixture();
        await fixture.Service.ConfigureSharedMountsAsync("com.example.notes", "media", new(["catalogRoots"], []));
        await fixture.Service.StartAsync("com.example.notes");
        await fixture.Apps.UpdateAppAsync("com.example.notes", app => app with { AppliedConfigurationHash = null });
        await fixture.CreateGlobalMountService().UpsertAsync(new("media", CreateExternalDirectory()));
        Assert.True(Assert.Single(await fixture.Service.ListAppsAsync()).RestartRequired);
        await fixture.Service.RestartAsync("com.example.notes");
        await fixture.Apps.UpdateAppAsync("com.example.notes", app => app with { AppliedConfigurationHash = null });
        var result = await fixture.Service.ConfigureMountsAsync("com.example.notes", new([new("catalogRoots", "inline", CreateExternalDirectory())]));
        Assert.True(result.App!.RestartRequired);
    }

    [Fact]
    public async Task RestartRequired_FailedRestartDoesNotRecordUnappliedConfiguration()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0")));
        await fixture.Service.StartAsync("com.example.notes");
        var applied = (await fixture.Apps.GetAppAsync("com.example.notes"))!.AppliedConfigurationHash;
        await fixture.Service.ConfigureAsync("com.example.notes", new(Settings: new Dictionary<string, string?> { ["APP_MODE"] = "edited" }));
        fixture.Adapter.FailOnStartCount = 2;
        await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Service.RestartAsync("com.example.notes"));
        Assert.Equal(applied, (await fixture.Apps.GetAppAsync("com.example.notes"))!.AppliedConfigurationHash);
        Assert.False(Assert.Single(await fixture.Service.ListAppsAsync()).RestartRequired); // stopped: next start applies it
        Assert.False((await fixture.Service.StartAsync("com.example.notes")).App!.RestartRequired);
        Assert.NotEqual(applied, (await fixture.Apps.GetAppAsync("com.example.notes"))!.AppliedConfigurationHash);
    }
    [Fact]
    public async Task RestartRequired_TracksCanonicalMountTargetAcrossSymlinkChanges()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0", externalMountsJson: RequiredCatalogMountsJson)));
        var alias = CreateExternalDirectory();
        var firstTarget = CreateExternalDirectory();
        var nextTarget = CreateExternalDirectory();
        await fixture.Service.ConfigureMountsAsync("com.example.notes", new([new("catalogRoots", "movies", alias)]));
        Directory.Delete(alias);
        Directory.CreateSymbolicLink(alias, firstTarget);
        try
        {
            Assert.False((await fixture.Service.StartAsync("com.example.notes")).App!.RestartRequired);
            Assert.Equal(MountPathPolicy.ResolveRealPath(firstTarget), Assert.Single(fixture.Adapter.LastContext!.Mounts).HostPath);
            Assert.False(Assert.Single(await fixture.RecreateService().ListAppsAsync()).RestartRequired);
            Directory.Delete(alias);
            Directory.CreateSymbolicLink(alias, nextTarget);
            Assert.True(Assert.Single(await fixture.Service.ListAppsAsync()).RestartRequired);
            Assert.False((await fixture.Service.RestartAsync("com.example.notes")).App!.RestartRequired);
            Assert.Equal(MountPathPolicy.ResolveRealPath(nextTarget), Assert.Single(fixture.Adapter.LastContext!.Mounts).HostPath);
        }
        finally
        {
            if (OperatingSystem.IsWindows()) Directory.Delete(alias);
            else File.Delete(alias);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RestartRequired_UnresolvablePathDoesNotBlockListingOrRepair(bool legacy)
    {
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0", externalMountsJson: RequiredCatalogMountsJson)));
        var alias = CreateExternalDirectory();
        await fixture.Service.ConfigureMountsAsync("com.example.notes", new([new("catalogRoots", "movies", alias)]));
        await fixture.Service.StartAsync("com.example.notes");
        if (legacy) await fixture.Apps.UpdateAppAsync("com.example.notes", app => app with { AppliedConfigurationHash = null });
        Directory.Delete(alias);
        Directory.CreateSymbolicLink(alias, alias);
        try
        {
            Assert.Equal(!legacy, Assert.Single(await fixture.Service.ListAppsAsync()).RestartRequired);
            var repaired = await fixture.Service.ConfigureMountsAsync("com.example.notes", new([new("catalogRoots", "movies", CreateExternalDirectory())]));
            Assert.True(repaired.App!.RestartRequired);
            Assert.False((await fixture.Service.RestartAsync("com.example.notes")).App!.RestartRequired);
        }
        finally
        {
            if (OperatingSystem.IsWindows()) Directory.Delete(alias);
            else File.Delete(alias);
        }
    }

}
