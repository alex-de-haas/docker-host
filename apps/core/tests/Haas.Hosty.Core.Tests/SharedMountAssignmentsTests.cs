using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private const string SharedAssignmentSlots = """
        "externalMounts": {
          "catalogRoots": { "multiple": true, "service": "app" },
          "downloads": { "multiple": true, "service": "app", "mode": "ro" },
          "single": { "multiple": false, "service": "app" }
        },
        """;

    private static async Task<LifecycleFixture> CreateSharedAssignmentFixture()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        await fixture.Service.InstallAsync(new AppInstallRequest(await fixture.WriteManifestAsync("1.0.0", externalMountsJson: SharedAssignmentSlots)));
        var library = fixture.CreateGlobalMountService();
        await library.UpsertAsync(new GlobalMountUpsertRequest("media", CreateExternalDirectory()));
        await library.UpsertAsync(new GlobalMountUpsertRequest("other", CreateExternalDirectory()));
        return fixture;
    }

    [Fact]
    public async Task ConfigureSharedMountsAsync_MovesOnlyChosenReferencesAndDoesNotRestart()
    {
        var fixture = await CreateSharedAssignmentFixture();
        await fixture.Service.ConfigureMountsAsync("com.example.notes", new([
            new("catalogRoots", GlobalMountName: "other"),
            new("catalogRoots", "inline", CreateExternalDirectory()),
            new("catalogRoots", GlobalMountName: "media")
        ]));
        await fixture.Service.StartAsync("com.example.notes");
        var before = (await fixture.Apps.GetAppAsync("com.example.notes"))!;
        var context = fixture.Adapter.LastContext;
        var result = await fixture.Service.ConfigureSharedMountsAsync("com.example.notes", "media", new(["downloads"], ["catalogRoots"]));
        var after = (await fixture.Apps.GetAppAsync("com.example.notes"))!;
        Assert.Equal(before.Mounts!.Where(binding => binding.GlobalMountName != "media"), after.Mounts!.Where(binding => binding.GlobalMountName != "media"));
        Assert.Equal("downloads", Assert.Single(after.Mounts!, binding => binding.GlobalMountName == "media").Key);
        Assert.Equal("running", after.RuntimeState);
        Assert.Same(context, fixture.Adapter.LastContext);
        Assert.Equal("configured", result.Status);
        await fixture.Service.ConfigureSharedMountsAsync("com.example.notes", "media", new([], ["downloads"]));
        Assert.DoesNotContain((await fixture.Apps.GetAppAsync("com.example.notes"))!.Mounts!, binding => binding.GlobalMountName == "media");
    }

    [Fact]
    public async Task ConfigureSharedMountsAsync_ConcurrentOtherMountEditSurvivesButSameMountConflicts()
    {
        var fixture = await CreateSharedAssignmentFixture();
        await fixture.Service.ConfigureSharedMountsAsync("com.example.notes", "other", new(["catalogRoots"], []));
        await fixture.Service.ConfigureSharedMountsAsync("com.example.notes", "media", new(["downloads"], []));
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Service.ConfigureSharedMountsAsync("com.example.notes", "media", new(["single"], [])));
        Assert.Equal("app_mount_bindings_changed", error.Code);
        var mounts = (await fixture.Apps.GetAppAsync("com.example.notes"))!.Mounts!;
        Assert.Contains(mounts, binding => binding.GlobalMountName == "other" && binding.Key == "catalogRoots");
        Assert.Contains(mounts, binding => binding.GlobalMountName == "media" && binding.Key == "downloads");
    }

    [Theory]
    [InlineData("single", "app_mount_multiple_not_allowed")]
    [InlineData("unknown", "app_mount_slot_unknown")]
    public async Task ConfigureSharedMountsAsync_InvalidAssignmentPreservesAllBindings(string key, string code)
    {
        var fixture = await CreateSharedAssignmentFixture();
        await fixture.Service.ConfigureMountsAsync("com.example.notes", new([new("single", GlobalMountName: "other")]));
        var before = (await fixture.Apps.GetAppAsync("com.example.notes"))!.Mounts;
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Service.ConfigureSharedMountsAsync("com.example.notes", "media", new([key], [])));
        Assert.Equal(code, error.Code);
        Assert.Equal(before, (await fixture.Apps.GetAppAsync("com.example.notes"))!.Mounts);
    }

    [Fact]
    public async Task ConfigureSharedMountsAsync_MissingKeysOrLibraryEntryCannotClearBindings()
    {
        var fixture = await CreateSharedAssignmentFixture();
        await fixture.Service.ConfigureSharedMountsAsync("com.example.notes", "media", new(["downloads"], []));
        var missing = await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Service.ConfigureSharedMountsAsync("com.example.notes", "media", new()));
        Assert.Equal("app_mount_keys_required", missing.Code);
        var absent = await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Service.ConfigureSharedMountsAsync("com.example.notes", "missing", new([], [])));
        Assert.Equal("global_mount_not_found", absent.Code);
        Assert.Single((await fixture.Apps.GetAppAsync("com.example.notes"))!.Mounts!);
    }
}
