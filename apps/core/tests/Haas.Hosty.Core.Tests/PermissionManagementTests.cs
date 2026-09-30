using System.Text.Json.Nodes;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
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
