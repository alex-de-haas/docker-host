namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task ConfigurationReadiness_IncompleteUpdateReleasesStoppedRuntimePathsAndPreservesDesiredConfiguration()
    {
        var prepared = await PrepareUpdateWithObsoleteRuntimePathsAsync();
        var fixture = prepared.Fixture;
        try
        {
            var globals = fixture.CreateGlobalMountService();
            var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
                fixture.Sources.SetLocalOverrideAsync(prepared.Running.Id, new(prepared.ObsoleteMount)));
            Assert.Equal("source_override_path_forbidden", error.Code);
            error = await Assert.ThrowsAsync<AppLifecycleException>(() => globals.UpsertAsync(new("old-code", prepared.ObsoleteSource)));
            Assert.Equal("app_mount_path_is_source", error.Code);

            var result = await fixture.Service.ApplyUpdateAsync(prepared.Running.Id, new(prepared.Plan.PlanDigest));

            Assert.Equal("updated", result.Status);
            Assert.Equal("stopped", result.App!.RuntimeState);
            Assert.True(result.App.ConfigurationReadiness!.Required);
            Assert.Equal(1, fixture.Adapter.StopCount);
            Assert.Equal(1, fixture.Adapter.StartCount);
            // Read through a new store so this verifies persisted authority rather than only a response projection.
            var stopped = (await new AppRegistryStore(fixture.Paths).GetAppAsync(prepared.Running.Id))!;
            Assert.Null(stopped.ActiveMountPaths);
            Assert.Null(stopped.ActiveSourcePaths);
            Assert.Equal(prepared.Running.Mounts, stopped.Mounts);
            Assert.Equal(prepared.Running.SourceState, stopped.SourceState);
            Assert.Equal(prepared.Running.StorageMappings, stopped.StorageMappings);
            Assert.Equal(prepared.KeptMount, Assert.Single(stopped.Mounts!).HostPath);
            Assert.Equal(MountPathPolicy.ResolveRealPath(prepared.KeptSource), stopped.SourceState!.LocalOverridePath);

            // Desired code and mount bindings remain protected; only the obsolete process reservations disappear.
            error = await Assert.ThrowsAsync<AppLifecycleException>(() => globals.UpsertAsync(new("still-code", prepared.KeptSource)));
            Assert.Equal("app_mount_path_is_source", error.Code);
            error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
                fixture.Sources.SetLocalOverrideAsync(prepared.Running.Id, new(prepared.KeptMount)));
            Assert.Equal("source_override_path_forbidden", error.Code);
            await globals.UpsertAsync(new("old-code", prepared.ObsoleteSource));
            await fixture.Sources.SetLocalOverrideAsync(prepared.Running.Id, new(prepared.ObsoleteMount));
        }
        finally { DeleteObsoleteRuntimePathFixtureDirectories(prepared); }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ConfigurationReadiness_UpdateWithoutConfirmedStopRetainsRuntimePathAuthority(bool returnsRunning)
    {
        var prepared = await PrepareUpdateWithObsoleteRuntimePathsAsync();
        var fixture = prepared.Fixture;
        try
        {
            if (returnsRunning) fixture.Adapter.StopRuntimeState = "running";
            else fixture.Adapter.FailOnStopCount = fixture.Adapter.StopCount + 1;

            var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
                fixture.Service.ApplyUpdateAsync(prepared.Running.Id, new(prepared.Plan.PlanDigest)));

            Assert.Equal("runtime_stop_failed", error.Code);
            var retained = (await new AppRegistryStore(fixture.Paths).GetAppAsync(prepared.Running.Id))!;
            Assert.Equal("1.0.0", retained.Version);
            Assert.Equal("running", retained.RuntimeState);
            Assert.Equal(prepared.Running.ActiveMountPaths, retained.ActiveMountPaths);
            Assert.Equal(prepared.Running.ActiveSourcePaths, retained.ActiveSourcePaths);
            Assert.Equal(prepared.Running.Mounts, retained.Mounts);
            Assert.Equal(prepared.Running.SourceState, retained.SourceState);
            Assert.Equal(1, fixture.Adapter.StartCount);
            error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
                fixture.Sources.SetLocalOverrideAsync(prepared.Running.Id, new(prepared.ObsoleteMount)));
            Assert.Equal("source_override_path_forbidden", error.Code);
            error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
                fixture.CreateGlobalMountService().UpsertAsync(new("old-code", prepared.ObsoleteSource)));
            Assert.Equal("app_mount_path_is_source", error.Code);
        }
        finally { DeleteObsoleteRuntimePathFixtureDirectories(prepared); }
    }

    private static async Task<(LifecycleFixture Fixture, string ObsoleteMount, string KeptMount, string ObsoleteSource,
        string KeptSource, AppRecord Running, AppUpdatePlan Plan)> PrepareUpdateWithObsoleteRuntimePathsAsync()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var obsoleteMount = CreateExternalDirectory();
        var keptMount = CreateExternalDirectory();
        var obsoleteSource = CreateExternalDirectory();
        var keptSource = CreateExternalDirectory();
        var manifest = await fixture.WriteManifestAsync("1.0.0", externalMountsJson: RequiredCatalogMountsJson);
        await fixture.Service.InstallAsync(new AppInstallRequest(manifest));
        await fixture.Service.ConfigureMountsAsync("com.example.notes", new([
            new AppMountBindingInput("catalogRoots", "old", obsoleteMount),
            new AppMountBindingInput("catalogRoots", "kept", keptMount),
        ]));
        await fixture.Sources.SetLocalOverrideAsync("com.example.notes", new(obsoleteSource));
        await fixture.Service.StartAsync("com.example.notes");
        // Change desired configuration while the old process remains alive, using the real mutation paths.
        await fixture.Service.ConfigureMountsAsync("com.example.notes", new([new AppMountBindingInput("catalogRoots", "kept", keptMount)]));
        await fixture.Sources.SetLocalOverrideAsync("com.example.notes", new(keptSource));
        var running = (await fixture.Apps.GetAppAsync("com.example.notes"))!;
        Assert.Contains(MountPathPolicy.ResolveRealPath(obsoleteMount), running.ActiveMountPaths!);
        Assert.Contains(MountPathPolicy.ResolveRealPath(obsoleteSource), running.ActiveSourcePaths!);
        var target = await fixture.WriteManifestAsync("2.0.0", settingsJson: UnconfiguredLaunchSettings, externalMountsJson: RequiredCatalogMountsJson);
        var plan = await fixture.Service.CreateUpdatePlanAsync(running.Id, new(target));
        Assert.True(plan.ConfigurationReadiness!.Required);
        return (fixture, obsoleteMount, keptMount, obsoleteSource, keptSource, running, plan);
    }

    private static void DeleteObsoleteRuntimePathFixtureDirectories((LifecycleFixture Fixture, string ObsoleteMount,
        string KeptMount, string ObsoleteSource, string KeptSource, AppRecord Running, AppUpdatePlan Plan) prepared)
    {
        foreach (var path in new[] { prepared.ObsoleteMount, prepared.KeptMount, prepared.ObsoleteSource, prepared.KeptSource })
            Directory.Delete(path, recursive: true);
    }
}
