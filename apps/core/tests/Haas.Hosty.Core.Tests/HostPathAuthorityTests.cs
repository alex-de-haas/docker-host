using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task OperatorSourceSelection_AcceptsRegisteredWorkspace()
    {
        var (f, _) = await SourceFixtureAsync();
        var workspaces = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var workspace = await workspaces.PrepareAsync(WorkspaceTestOwner(f), WorkspaceRequest(), default);
        await f.Sources.SetLocalOverrideAsync(SourceTestApp, new(workspace.Path));
        Assert.Equal(MountPathPolicy.ResolveRealPath(workspace.Path), (await f.Apps.GetAppAsync(SourceTestApp))!.SourceState!.LocalOverridePath);
        await f.Sources.ClearLocalOverrideAsync(SourceTestApp);
        Assert.Null((await f.Apps.GetAppAsync(SourceTestApp))!.SourceState!.LocalOverridePath);
    }

    [Fact]
    public async Task SourceAndMountWrites_SerializeAndRejectBothOrderings()
    {
        var (f, _) = await SourceFixtureAsync();
        var outside = Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "hosty-authority-" + Guid.NewGuid().ToString("N"))).FullName;
        try
        {
            var globals = new GlobalMountService(new(f.Paths), f.Apps, new(f.Paths));
            // Source holds the shared gate through persistence; an already waiting mount writer
            // must observe the new source even though it started before that source was recorded.
            Task? pendingMount = null;
            await f.Sources.WithSourceLockAsync(SourceTestApp, async app =>
            {
                pendingMount = globals.UpsertAsync(new("shared", outside));
                Assert.False(pendingMount.IsCompleted);
                await f.Sources.SetLocalOverrideCoreAsync(app, new(outside), default);
                return true;
            }, default);
            var error = await Assert.ThrowsAsync<AppLifecycleException>(() => pendingMount!);
            Assert.Equal("app_mount_path_is_source", error.Code);
            await f.Sources.ClearLocalOverrideAsync(SourceTestApp);
            await globals.UpsertAsync(new("shared", outside));
            error = await Assert.ThrowsAsync<AppLifecycleException>(() => f.Sources.SetLocalOverrideAsync(SourceTestApp, new(outside)));
            Assert.Equal("source_override_path_forbidden", error.Code);
            var alias = outside + "-alias";
            Directory.CreateSymbolicLink(alias, outside);
            try
            {
                error = await Assert.ThrowsAsync<AppLifecycleException>(() => f.Sources.SetLocalOverrideAsync(SourceTestApp, new(alias)));
                Assert.Equal("source_override_path_forbidden", error.Code);
            }
            finally { Directory.Delete(alias); }
        }
        finally { Directory.Delete(outside, true); }
    }

    [Fact]
    public async Task SourceSetAndClear_WaitForLifecycleOperation()
    {
        var (f, origin) = await SourceFixtureAsync();
        var mutex = f.Apps.OperationLock(SourceTestApp);
        await mutex.WaitAsync();
        var setting = f.Sources.SetLocalOverrideAsync(SourceTestApp, new(origin));
        var clearing = f.Sources.ClearLocalOverrideAsync(SourceTestApp);
        Assert.False(setting.IsCompleted); Assert.False(clearing.IsCompleted);
        mutex.Release();
        await Task.WhenAll(setting, clearing);
        Assert.Null((await f.Apps.GetAppAsync(SourceTestApp))!.SourceState!.LocalOverridePath);
    }

    [Fact]
    public async Task Mounts_CannotExposeDataRootThroughParentOrSymlink()
    {
        var (f, _) = await SourceFixtureAsync();
        var policy = new MountPathPolicy(f.Paths);
        var parent = Path.GetDirectoryName(f.Paths.DataRoot)!;
        var error = Assert.Throws<AppLifecycleException>(() => policy.EnsureAllowed(parent));
        Assert.Equal("app_mount_path_in_data_root", error.Code);
        var link = Path.Combine(f.Root, "parent-link");
        Directory.CreateSymbolicLink(link, parent);
        error = Assert.Throws<AppLifecycleException>(() => policy.EnsureAllowed(link));
        Assert.Equal("app_mount_path_in_data_root", error.Code);
    }
    [Fact]
    public async Task SourceParentOfWritableMount_IsForbidden()
    {
        var (f, _) = await SourceFixtureAsync();
        var outside = Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "hosty-source-parent-" + Guid.NewGuid().ToString("N"))).FullName;
        try
        {
            var globals = new GlobalMountService(new(f.Paths), f.Apps, new(f.Paths));
            await globals.UpsertAsync(new("nested", Path.Combine(outside, "code")));
            var error = await Assert.ThrowsAsync<AppLifecycleException>(() => f.Sources.SetLocalOverrideAsync(SourceTestApp, new(outside)));
            Assert.Equal("source_override_path_forbidden", error.Code);
        }
        finally { Directory.Delete(outside, true); }
    }

    [Fact]
    public async Task CaseAliases_CannotBypassProtectedRoots()
    {
        if (!OperatingSystem.IsMacOS() && !OperatingSystem.IsWindows()) return;
        var (f, _) = await SourceFixtureAsync();
        var storage = Directory.CreateDirectory(Path.Combine(f.Paths.AppsRoot, "attacker", "data")).FullName;
        var alias = storage.ToUpperInvariant();
        // Case-sensitive volumes have distinct names and do not reproduce this alias attack.
        if (!Directory.Exists(alias)) return;
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => f.Sources.SetLocalOverrideAsync(SourceTestApp, new(alias)));
        Assert.Equal("source_override_path_forbidden", error.Code);
        error = Assert.Throws<AppLifecycleException>(() => new MountPathPolicy(f.Paths).EnsureAllowed(f.Paths.DataRoot.ToUpperInvariant()));
        Assert.Equal("app_mount_path_in_data_root", error.Code);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RemovedDesiredMount_RemainsProtectedUntilRuntimeStops(bool shared)
    {
        var f = await CreateSharedAssignmentFixture();
        var outside = CreateExternalDirectory();
        if (shared) await f.CreateGlobalMountService().UpsertAsync(new("active", outside));
        await f.Service.ConfigureMountsAsync("com.example.notes", new([shared
            ? new AppMountBindingInput("single", GlobalMountName: "active")
            : new AppMountBindingInput("single", "active", outside)]));
        await f.Service.StartAsync("com.example.notes");
        Assert.Contains(f.Adapter.LastContext!.Mounts, m => m.HostPath == MountPathPolicy.ResolveRealPath(outside));
        // A legacy running installation gets the same protection before its first config edit.
        await f.Apps.UpdateAppAsync("com.example.notes", a => a with { ActiveMountPaths = null });
        await f.Service.ConfigureMountsAsync("com.example.notes", new([]));
        if (shared) await f.CreateGlobalMountService().DeleteAsync("active", false);
        var persisted = (await new AppRegistryStore(f.Paths).GetAppAsync("com.example.notes"))!;
        Assert.Empty(persisted.Mounts!);
        Assert.Contains(MountPathPolicy.ResolveRealPath(outside), persisted.ActiveMountPaths!);
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => f.Sources.SetLocalOverrideAsync("com.example.notes", new(outside)));
        Assert.Equal("source_override_path_forbidden", error.Code);
        await f.Service.StopAsync("com.example.notes");
        await f.Sources.SetLocalOverrideAsync("com.example.notes", new(outside));
    }

}
