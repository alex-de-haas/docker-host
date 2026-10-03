using System.Text.Json.Nodes;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Theory]
    [InlineData("apps.update")]
    [InlineData("apps.workspaces.manage")]
    [InlineData("apps.publications.manage")]
    public void RetiredPermissions_AreNotAliasesForBroaderGrants(string permission)
    {
        Assert.DoesNotContain(permission, CoreAppPermissions.Known);
        Assert.Equal("app_permissions_unsupported", Assert.Throws<AppLifecycleException>(() =>
            CoreAppPermissions.ResolveGrants([permission], [], [])).Code);
    }

    [Theory]
    [InlineData("apps.update")]
    [InlineData("apps.read")]
    public async Task RequiredPermissions_AutostartDoesNotGrantDeclarations(string permission)
    {
        var adapter = new RecordingRuntimeAdapter("localCommand");
        var fixture = await LifecycleFixture.CreateAsync(localRuntimeAdapter: adapter);
        var path = await WritePermissionManifest(fixture, [], [], live: false);
        await fixture.Service.InstallAsync(new(path, Autostart: false));
        var app = (await fixture.Apps.GetAppAsync("example.permissions"))!;
        var manifest = JsonNode.Parse(await File.ReadAllTextAsync(app.ManifestPath!))!;
        manifest["corePermissions"] = new JsonArray(permission);
        await File.WriteAllTextAsync(app.ManifestPath!, manifest.ToJsonString());
        await fixture.Apps.UpdateAppAsync(app.Id, current => current with { Autostart = true });
        Assert.True(Assert.Single(await fixture.Service.StartAutostartAppsAsync()).Succeeded);
        Assert.Equal(1, adapter.StartCount);
        Assert.Empty((await fixture.Apps.GetAppAsync(app.Id))!.GrantedCorePermissions!);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RequiredPermissions_StartAndRestartWithoutGrant_UntilExplicitApproval(bool restart)
    {
        var adapter = new RecordingRuntimeAdapter("localCommand");
        var fixture = await LifecycleFixture.CreateAsync(localRuntimeAdapter: adapter);
        var path = await WritePermissionManifest(fixture, [], []);
        await fixture.Service.InstallAsync(new(path, Autostart: false));
        await WritePermissionManifest(fixture, [CoreAppPermissions.ReadSkills], []);
        if (restart) await fixture.Service.RestartAsync("example.permissions");
        else await fixture.Service.StartAsync("example.permissions");
        Assert.Equal(1, adapter.StartCount);
        Assert.Empty((await fixture.Apps.GetAppAsync("example.permissions"))!.GrantedCorePermissions!);
        Assert.Contains(CoreAppPermissions.ReadSkills,
            (await fixture.Service.ObservePermissionsAsync("example.permissions", true, default)).MissingRequired);
        await fixture.Service.ApplyOptionalPermissionsAsync(await fixture.Service.CreatePermissionPlanAsync("example.permissions", default), [], default);
        Assert.Contains(CoreAppPermissions.ReadSkills, (await fixture.Apps.GetAppAsync("example.permissions"))!.GrantedCorePermissions!);
    }

    [Fact]
    public async Task RequiredPermissions_UnknownRequirementIsDiagnosticAndCannotBeApproved()
    {
        var adapter = new RecordingRuntimeAdapter("localCommand");
        var fixture = await LifecycleFixture.CreateAsync(localRuntimeAdapter: adapter);
        var path = await WritePermissionManifest(fixture, [], []);
        await fixture.Service.InstallAsync(new(path, Autostart: false));
        await WritePermissionManifest(fixture, ["removed.permission"], []);
        await fixture.Service.StartAsync("example.permissions");
        var state = await fixture.Service.ObservePermissionsAsync("example.permissions", true, default);
        Assert.Equal(["removed.permission"], state.UnsupportedRequired);
        Assert.Empty(state.MissingRequired);
        Assert.Equal("app_permissions_unsupported", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.CreatePermissionPlanAsync("example.permissions", default))).Code);
        Assert.Equal(1, adapter.StartCount);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RequiredPermissions_ObserverKeepsRunningAppWhenGrantIsLost(bool unsupported)
    {
        var adapter = new RecordingRuntimeAdapter("localCommand");
        var fixture = await LifecycleFixture.CreateAsync(localRuntimeAdapter: adapter);
        var path = await WritePermissionManifest(fixture, [CoreAppPermissions.ReadSkills], []);
        await fixture.Service.InstallAsync(new(path, Autostart: false));
        await fixture.Service.StartAsync("example.permissions");
        if (unsupported) await WritePermissionManifest(fixture, ["removed.permission"], []);
        else await fixture.Apps.UpdateAppAsync("example.permissions", app => app with { GrantedCorePermissions = [] });
        await fixture.Service.ObserveAppPermissionsAsync(default);
        await fixture.Service.ObserveAppPermissionsAsync(default);
        Assert.True(AppRuntimeStates.IsUp((await fixture.Apps.GetAppAsync("example.permissions"))!.RuntimeState));
        Assert.Equal(0, adapter.StopCount);
        var observation = (await fixture.Service.ListAppsAsync()).Single().PermissionState!;
        Assert.NotEmpty(unsupported ? observation.UnsupportedRequired : observation.MissingRequired);
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(false, true)]
    [InlineData(true, false)]
    [InlineData(true, true)]
    public async Task PermissionObserver_UnreadableManifestKeepsRuntimeAlive_AndRecovers(bool missing, bool previouslyObserved)
    {
        var adapter = new RecordingRuntimeAdapter("localCommand");
        var fixture = await LifecycleFixture.CreateAsync(localRuntimeAdapter: adapter);
        var path = await WritePermissionManifest(fixture, [CoreAppPermissions.ReadSkills], []);
        await fixture.Service.InstallAsync(new(path, Autostart: false));
        await fixture.Service.StartAsync("example.permissions");
        if (previouslyObserved) await fixture.Service.ObserveAppPermissionsAsync(default);
        var before = (await fixture.Apps.GetAppAsync("example.permissions"))!;
        if (missing) File.Delete(path);
        else await File.WriteAllTextAsync(path, "{incomplete");

        // Repeated passes must not stop an app or hide the error behind a fresh cached observation.
        for (var pass = 0; pass < 2; pass++)
        {
            await fixture.Service.ObserveAppPermissionsAsync(default);
            var state = (await fixture.Service.ListAppsAsync()).Single().PermissionState!;
            Assert.Equal("stale", state.Status);
            Assert.NotNull(state.Error);
            if (previouslyObserved) Assert.Contains(CoreAppPermissions.ReadSkills, state.Required);
            var current = (await fixture.Apps.GetAppAsync(before.Id))!;
            Assert.Equal(before.RuntimeState, current.RuntimeState);
            Assert.Equal(before.OperationStatus, current.OperationStatus);
            Assert.Equal(before.LastError, current.LastError);
            Assert.Equal(0, adapter.StopCount);
        }

        await WritePermissionManifest(fixture, [CoreAppPermissions.ReadSkills], []);
        await fixture.Service.ObserveAppPermissionsAsync(default);
        var recovered = (await fixture.Service.ListAppsAsync()).Single().PermissionState!;
        Assert.Equal("known", recovered.Status);
        Assert.Null(recovered.Error);
        Assert.Equal(1, adapter.StartCount);
        Assert.Equal(0, adapter.StopCount);

        await fixture.Apps.UpdateAppAsync(before.Id, app => app with { GrantedCorePermissions = [] });
        await fixture.Service.ObserveAppPermissionsAsync(default);
        Assert.Equal(0, adapter.StopCount);
    }

    [Fact]
    public async Task PermissionObserver_SkipsBusyLifecycle_AndResumesAfterRelease()
    {
        var adapter = new RecordingRuntimeAdapter("localCommand");
        var fixture = await LifecycleFixture.CreateAsync(localRuntimeAdapter: adapter);
        const string busyId = "aaa.busy";
        await fixture.Service.InstallAsync(new(await fixture.WriteLocalCommandManifestAsync(id: busyId), Autostart: false));
        await fixture.Service.InstallAsync(new(await WritePermissionManifest(fixture, [CoreAppPermissions.ReadSkills], []), Autostart: false));
        await fixture.Service.StartAsync("example.permissions");
        await fixture.Apps.UpdateAppAsync("example.permissions", app => app with { GrantedCorePermissions = [] });
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        adapter.StartContextProbe = async (context, ct) =>
        {
            if (context.App.Id != busyId) return;
            entered.SetResult();
            await release.Task.WaitAsync(ct);
        };
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var start = fixture.Service.StartAsync(busyId, timeout.Token);
        try
        {
            await entered.Task.WaitAsync(timeout.Token);
            using var passTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(2));
            await fixture.Service.ObserveAppPermissionsAsync(passTimeout.Token);
            Assert.False(start.IsCompleted);
            Assert.Equal(0, adapter.StopCount);
            Assert.Contains(CoreAppPermissions.ReadSkills, (await fixture.Service.ListAppsAsync()).Single(a => a.Id == "example.permissions").PermissionState!.MissingRequired);
            var busy = (await fixture.Service.ListAppsAsync()).Single(a => a.Id == busyId).PermissionState!;
            Assert.Null(busy.CheckedAt);
        }
        finally { release.TrySetResult(); await start; }

        var app = (await fixture.Apps.GetAppAsync(busyId))!;
        var manifest = JsonNode.Parse(await File.ReadAllTextAsync(app.ManifestPath!))!;
        manifest["corePermissions"] = new JsonArray("removed.permission");
        await File.WriteAllTextAsync(app.ManifestPath!, manifest.ToJsonString());
        await fixture.Service.ObserveAppPermissionsAsync(default);
        Assert.Equal(0, adapter.StopCount);
        Assert.Contains("removed.permission", (await fixture.Service.ListAppsAsync()).Single(a => a.Id == busyId).PermissionState!.UnsupportedRequired);
    }

    [Fact]
    public async Task OptionalPermissions_UnknownInstalledDeclarationDoesNotBlockStart()
    {
        var adapter = new RecordingRuntimeAdapter("localCommand");
        var fixture = await LifecycleFixture.CreateAsync(localRuntimeAdapter: adapter);
        var path = await WritePermissionManifest(fixture, [], []);
        await fixture.Service.InstallAsync(new(path, Autostart: false));
        await WritePermissionManifest(fixture, [], ["removed.optional"]);
        await fixture.Service.StartAsync("example.permissions");
        Assert.Equal(1, adapter.StartCount);
    }

    private static async Task<string> WritePermissionManifest(LifecycleFixture fixture, string[] required, string[] optional, bool live = true)
    {
        var folder = Path.Combine(fixture.Root, "permission-source");
        Directory.CreateDirectory(folder);
        var path = Path.Combine(folder, "manifest.json");
        var manifest = JsonNode.Parse("""
            {"schemaVersion":"app.0.1","id":"example.permissions","name":"Permissions","version":"0.1.0",
             "runtimeProfiles":[{"key":"local","type":"localCommand","development":true,"default":true}],"defaultRuntime":"local",
             "services":[{"key":"app","runtimes":{"local":{"type":"localCommand","command":"echo unchanged","workingDirectory":"."}}}]}
            """)!;
        manifest["corePermissions"] = new JsonArray(required.Select(p => (JsonNode?)JsonValue.Create(p)).ToArray());
        manifest["optionalCorePermissions"] = new JsonArray(optional.Select(p => (JsonNode?)JsonValue.Create(p)).ToArray());
        manifest["runtimeProfiles"]![0]!["development"] = live;
        await File.WriteAllTextAsync(path, manifest.ToJsonString());
        return path;
    }

    [Fact]
    public async Task PermissionObservation_DetectsLiveEdits_AndApprovalChangesOnlyPermissions()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var path = await WritePermissionManifest(fixture, [], []);
        await fixture.Service.InstallAsync(new(path, Autostart: false));
        var before = (await fixture.Apps.GetAppAsync("example.permissions"))!;
        await WritePermissionManifest(fixture, [CoreAppPermissions.ReadSkills], [CoreAppPermissions.SpeechProviders]);
        var observation = await fixture.Service.ObservePermissionsAsync(before.Id, true, default);
        Assert.Equal("known", observation.Status);
        Assert.Equal([CoreAppPermissions.ReadSkills], observation.MissingRequired);
        Assert.True(observation.ReviewRequired);
        Assert.Empty((await fixture.Apps.GetAppAsync(before.Id))!.GrantedCorePermissions!);
        Assert.Equal(observation, (await fixture.Service.ListAppsAsync()).Single().PermissionState);
        var plan = await fixture.Service.CreatePermissionPlanAsync(before.Id, default);
        await fixture.Service.ApplyOptionalPermissionsAsync(plan, [CoreAppPermissions.SpeechProviders], default);
        var after = (await fixture.Apps.GetAppAsync(before.Id))!;
        Assert.Equal(System.Text.Json.JsonSerializer.Serialize(before, CoreJson.TypeInfo<AppRecord>()), System.Text.Json.JsonSerializer.Serialize(after with {
            RequiredCorePermissions = before.RequiredCorePermissions, OptionalCorePermissions = before.OptionalCorePermissions,
            GrantedCorePermissions = before.GrantedCorePermissions, PermissionRevision = before.PermissionRevision, UpdatedAt = before.UpdatedAt,
        }, CoreJson.TypeInfo<AppRecord>()));
        Assert.Equal([CoreAppPermissions.ReadSkills, CoreAppPermissions.SpeechProviders], after.GrantedCorePermissions);
        Assert.Empty((await fixture.Service.ObservePermissionsAsync(before.Id, true, default)).MissingRequired);
        await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Service.ApplyOptionalPermissionsAsync(plan, [], default));
    }

    [Theory]
    [InlineData("manifest")]
    [InlineData("identity")]
    [InlineData("source")]
    [InlineData("revision")]
    [InlineData("runtime")]
    public async Task PermissionReview_RejectsChangedCandidate(string change)
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var path = await WritePermissionManifest(fixture, [], [CoreAppPermissions.SpeechProviders]);
        await fixture.Service.InstallAsync(new(path, Autostart: false));
        var plan = await fixture.Service.CreatePermissionPlanAsync("example.permissions", default);
        if (change == "manifest")
        {
            var stamp = File.GetLastWriteTimeUtc(path);
            await File.WriteAllTextAsync(path, (await File.ReadAllTextAsync(path)).Replace("echo unchanged", "echo different"));
            File.SetLastWriteTimeUtc(path, stamp); // Same length/stamp must not bypass approval's digest check.
        }
        else await fixture.Apps.UpdateAppAsync(plan.AppId, app => change switch {
            "identity" => app with { InstalledAt = app.InstalledAt.AddSeconds(1) },
            "source" => app with { InstallManifestPath = fixture.Root },
            "runtime" => app with { SelectedRuntime = "other" },
            _ => app with { PermissionRevision = "changed" },
        });
        await Assert.ThrowsAnyAsync<Exception>(() => fixture.Service.ApplyOptionalPermissionsAsync(plan, [CoreAppPermissions.SpeechProviders], default));
        Assert.Empty((await fixture.Apps.GetAppAsync(plan.AppId))!.GrantedCorePermissions!);
    }

    [Fact]
    public async Task PermissionObservation_InvalidSourceRetainsLastKnownState_AndRecovers()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var path = await WritePermissionManifest(fixture, [], []);
        await fixture.Service.InstallAsync(new(path, Autostart: false));
        await WritePermissionManifest(fixture, [CoreAppPermissions.ReadSkills], []);
        var known = await fixture.Service.ObservePermissionsAsync("example.permissions", true, default);
        await File.WriteAllTextAsync(path, "{invalid");
        var stale = await fixture.Service.ObservePermissionsAsync("example.permissions", true, default);
        Assert.Equal("stale", stale.Status);
        Assert.NotNull(stale.Error);
        Assert.Equal(known.Required, stale.Required);
        await WritePermissionManifest(fixture, [], []);
        var recovered = await fixture.Service.ObservePermissionsAsync("example.permissions", true, default);
        Assert.Equal("known", recovered.Status);
        Assert.Null(recovered.Error);
        Assert.Empty(recovered.MissingRequired);
        File.Delete(path);
        Assert.NotNull((await fixture.Service.ObservePermissionsAsync("example.permissions", true, default)).Error);
    }

    [Fact]
    public async Task PermissionReview_TransitionsRemovalLegacyAndOptionalRevocation()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var path = await WritePermissionManifest(fixture, [CoreAppPermissions.ReadSkills], [CoreAppPermissions.SpeechProviders]);
        await fixture.Service.InstallAsync(new(path, Autostart: false, OptionalPermissions: [CoreAppPermissions.SpeechProviders]));
        await fixture.Apps.UpdateAppAsync("example.permissions", app => app with { RequiredCorePermissions = null, OptionalCorePermissions = null, PermissionRevision = null });
        var legacy = await fixture.Service.ObservePermissionsAsync("example.permissions", true, default);
        Assert.True(legacy.ReviewRequired);
        Assert.Equal(2, legacy.Granted.Count);
        await WritePermissionManifest(fixture, [CoreAppPermissions.SpeechProviders], [CoreAppPermissions.ReadSkills]);
        var transition = await fixture.Service.ObservePermissionsAsync("example.permissions", true, default);
        Assert.Empty(transition.MissingRequired);
        Assert.True(transition.ReviewRequired);
        await fixture.Service.ApplyOptionalPermissionsAsync(await fixture.Service.CreatePermissionPlanAsync("example.permissions", default), [], default);
        Assert.Equal([CoreAppPermissions.SpeechProviders], (await fixture.Apps.GetAppAsync("example.permissions"))!.GrantedCorePermissions);
        await WritePermissionManifest(fixture, [], []);
        await fixture.Service.ApplyOptionalPermissionsAsync(await fixture.Service.CreatePermissionPlanAsync("example.permissions", default), [], default);
        Assert.Empty((await fixture.Apps.GetAppAsync("example.permissions"))!.GrantedCorePermissions!);
    }

    [Fact]
    public async Task PermissionObservation_LockedRuntimeUsesInstalledManifest()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var path = await WritePermissionManifest(fixture, [], [], live: false);
        await fixture.Service.InstallAsync(new(path, Autostart: false));
        await WritePermissionManifest(fixture, [CoreAppPermissions.ReadSkills], [], live: false);
        var observation = await fixture.Service.ObservePermissionsAsync("example.permissions", true, default);
        Assert.Equal("known", observation.Status);
        Assert.Empty(observation.Required);
        Assert.False(observation.ReviewRequired);
    }
}
