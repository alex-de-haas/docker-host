using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private const string ObservedApp = "example.permissions";

    private static AppPermissionObserver PermissionObserver(LifecycleFixture fixture) => new(fixture.Service,
        fixture.Apps, fixture.Manifests, NullLogger<AppPermissionObserver>.Instance);

    private static async Task<AppPermissionObservation> CachedObservation(LifecycleFixture fixture)
        => fixture.Service.CachedPermissions((await fixture.Apps.GetAppAsync(ObservedApp))!);

    private static async Task WaitForPermission(Func<Task<bool>> condition)
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!await condition()) await Task.Delay(25, deadline.Token);
    }

    [Fact]
    public async Task PermissionObserver_IdleRunningAppAndUnrelatedWritesDoNotReobserve()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var source = await WritePermissionManifest(fixture, [], [], live: false);
        await fixture.Service.InstallAsync(new(source, Autostart: false));
        await fixture.Apps.UpdateAppAsync(ObservedApp, app => app with { RuntimeState = "running" });
        using var observer = PermissionObserver(fixture);
        await observer.StartAsync(default);
        try
        {
            await WaitForPermission(async () => (await CachedObservation(fixture)).CheckedAt is not null);
            var before = await CachedObservation(fixture);
            // Longer than the removed timer: even a running app keeps the same observed snapshot.
            await Task.Delay(5500);
            await fixture.Apps.UpdateAppAsync(ObservedApp, app => app with { DisplayName = "Renamed", LastOperation = "health" });
            await Task.Delay(400);
            Assert.Same(before, await CachedObservation(fixture));
            Assert.Empty(before.Required);
        }
        finally { await observer.StopAsync(default); }
    }

    [Fact]
    public async Task PermissionObserver_InstalledManifestSaveRefreshesOnlyAfterCoreMutation()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var source = await WritePermissionManifest(fixture, [], [], live: false);
        await fixture.Service.InstallAsync(new(source, Autostart: false));
        using var observer = PermissionObserver(fixture);
        await observer.StartAsync(default);
        try
        {
            await WaitForPermission(async () => (await CachedObservation(fixture)).CheckedAt is not null);
            var before = await CachedObservation(fixture);
            await WritePermissionManifest(fixture, [CoreAppPermissions.ReadSkills], [], live: false);
            await Task.Delay(400);
            Assert.Same(before, await CachedObservation(fixture));
            var app = (await fixture.Apps.GetAppAsync(ObservedApp))!;
            var selection = await fixture.Manifests.LoadAsync(source, forceRead: true);
            await fixture.Manifests.SaveManifestCopyAsync(selection, Path.GetDirectoryName(app.ManifestPath!)!);
            await WaitForPermission(async () => (await CachedObservation(fixture)).MissingRequired.Contains(CoreAppPermissions.ReadSkills));
            Assert.Empty((await fixture.Apps.GetAppAsync(ObservedApp))!.GrantedCorePermissions!);
        }
        finally { await observer.StopAsync(default); }
    }

    [Fact]
    public async Task PermissionObserver_RegistryChangesAndRemovalInvalidateObservations()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        using var observer = PermissionObserver(fixture);
        await observer.StartAsync(default);
        try
        {
            var source = await WritePermissionManifest(fixture, [CoreAppPermissions.ReadSkills], [], live: false);
            await fixture.Service.InstallAsync(new(source, Autostart: false));
            await WaitForPermission(async () => (await CachedObservation(fixture)).CheckedAt is not null);
            await fixture.Apps.UpdateAppAsync(ObservedApp, app => app with { GrantedCorePermissions = [] });
            await WaitForPermission(async () => (await CachedObservation(fixture)).MissingRequired.Contains(CoreAppPermissions.ReadSkills));
            var app = (await fixture.Apps.GetAppAsync(ObservedApp))!;
            await fixture.Apps.RemoveAppAsync(ObservedApp);
            await WaitForPermission(() => Task.FromResult(fixture.Service.CachedPermissions(app).CheckedAt is null));
        }
        finally { await observer.StopAsync(default); }
    }

    [Fact]
    public async Task PermissionObserver_LiveAtomicSaveWithSameStampRefreshesPermissions()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var source = await WritePermissionManifest(fixture, [CoreAppPermissions.ReadApps], []);
        await fixture.Service.InstallAsync(new(source, Autostart: false));
        using var observer = PermissionObserver(fixture);
        await observer.StartAsync(default);
        try
        {
            await WaitForPermission(async () => (await CachedObservation(fixture)).CheckedAt is not null);
            var stamp = File.GetLastWriteTimeUtc(source);
            var json = await File.ReadAllTextAsync(source);
            var replacement = json.Replace(CoreAppPermissions.ReadApps, CoreAppPermissions.ReadCore);
            Assert.Equal(json.Length, replacement.Length);
            await File.WriteAllTextAsync(source + ".tmp", replacement);
            File.SetLastWriteTimeUtc(source + ".tmp", stamp);
            File.Move(source + ".tmp", source, overwrite: true);
            await WaitForPermission(async () => (await CachedObservation(fixture)).MissingRequired.Contains(CoreAppPermissions.ReadCore));
            Assert.Equal([CoreAppPermissions.ReadApps], (await fixture.Apps.GetAppAsync(ObservedApp))!.GrantedCorePermissions);
        }
        finally { await observer.StopAsync(default); }
    }

    [Fact]
    public async Task PermissionObserver_LiveDirectoryReplacementAndInvalidEditsRecover()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var source = await WritePermissionManifest(fixture, [], []);
        await fixture.Service.InstallAsync(new(source, Autostart: false));
        using var observer = PermissionObserver(fixture);
        await observer.StartAsync(default);
        try
        {
            await WaitForPermission(async () => (await CachedObservation(fixture)).CheckedAt is not null);
            var folder = Path.GetDirectoryName(source)!;
            Directory.Move(folder, folder + "-old");
            await WaitForPermission(async () => (await CachedObservation(fixture)).Status == "stale");
            await WritePermissionManifest(fixture, [CoreAppPermissions.ReadSkills], []);
            await WaitForPermission(async () => (await CachedObservation(fixture)).Required.Contains(CoreAppPermissions.ReadSkills));
            await File.WriteAllTextAsync(source, "{unfinished");
            await WaitForPermission(async () => (await CachedObservation(fixture)).Status == "stale");
            await WritePermissionManifest(fixture, [], []);
            await WaitForPermission(async () => (await CachedObservation(fixture)) is { Status: "known", Required.Count: 0 });
        }
        finally { await observer.StopAsync(default); }
    }

    [Fact]
    public async Task PermissionObserver_AtomicDirectoryReplacementRearmsTheNewDirectory()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var source = await WritePermissionManifest(fixture, [], []);
        await fixture.Service.InstallAsync(new(source, Autostart: false));
        using var observer = PermissionObserver(fixture);
        await observer.StartAsync(default);
        try
        {
            await WaitForPermission(async () => (await CachedObservation(fixture)).CheckedAt is not null);
            var folder = Path.GetDirectoryName(source)!;
            var replacement = folder + "-new";
            Directory.CreateDirectory(replacement);
            var json = JsonNode.Parse(await File.ReadAllTextAsync(source))!;
            json["corePermissions"] = new JsonArray(CoreAppPermissions.ReadSkills);
            await File.WriteAllTextAsync(Path.Combine(replacement, "manifest.json"), json.ToJsonString());
            Directory.Move(folder, folder + "-old");
            Directory.Move(replacement, folder);
            await WaitForPermission(async () => (await CachedObservation(fixture)).Required.Contains(CoreAppPermissions.ReadSkills));
            await File.WriteAllTextAsync(source, "{unfinished in replacement");
            await WaitForPermission(async () => (await CachedObservation(fixture)).Status == "stale");
        }
        finally { await observer.StopAsync(default); }
    }

    [Fact]
    public async Task PermissionObserver_SourceRebindingStopsObservingOldManifest()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var source = await WritePermissionManifest(fixture, [], []);
        await fixture.Service.InstallAsync(new(source, Autostart: false));
        using var observer = PermissionObserver(fixture);
        await observer.StartAsync(default);
        try
        {
            await WaitForPermission(async () => (await CachedObservation(fixture)).CheckedAt is not null);
            var next = Path.Combine(fixture.Root, "second", "manifest.json");
            Directory.CreateDirectory(Path.GetDirectoryName(next)!);
            File.Copy(source, next);
            await fixture.Apps.UpdateAppAsync(ObservedApp, app => app with { InstallManifestPath = next, SourceState = null });
            await WaitForPermission(async () => (await CachedObservation(fixture)).CheckedAt is not null);
            var before = await CachedObservation(fixture);
            await File.WriteAllTextAsync(source, "{invalid old source");
            await Task.Delay(500);
            Assert.Same(before, await CachedObservation(fixture));
            await File.WriteAllTextAsync(next, "{invalid selected source");
            await WaitForPermission(async () => (await CachedObservation(fixture)).Status == "stale");
        }
        finally { await observer.StopAsync(default); }
    }

    [Fact]
    public async Task PermissionObserver_UnmaterializedCheckoutIsWatchedAndMissingCheckoutStaysStale()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var source = await WritePermissionManifest(fixture, [], []);
        await fixture.Service.InstallAsync(new(source, Autostart: false));
        var checkout = Path.Combine(fixture.Root, "checkout.v2");
        await fixture.Apps.UpdateAppAsync(ObservedApp, app => app with
        {
            ManifestUrl = "https://example.test/manifest.json", InstallManifestPath = null,
            SourceState = new("git", "https://example.test/repo.git", null, null, checkout, null, null),
        });
        using var observer = PermissionObserver(fixture);
        await observer.StartAsync(default);
        try
        {
            await WaitForPermission(async () => (await CachedObservation(fixture)).CheckedAt is not null);
            Assert.Equal("known", (await CachedObservation(fixture)).Status);
            Directory.CreateDirectory(checkout);
            var json = JsonNode.Parse(await File.ReadAllTextAsync(source))!;
            json["corePermissions"] = new JsonArray(CoreAppPermissions.ReadSkills);
            await File.WriteAllTextAsync(Path.Combine(checkout, "manifest.json"), json.ToJsonString());
            await WaitForPermission(async () => (await CachedObservation(fixture)).Required.Contains(CoreAppPermissions.ReadSkills));
            Directory.Delete(checkout, true);
            await WaitForPermission(async () => (await CachedObservation(fixture)).Status == "stale");
            Assert.Equal([CoreAppPermissions.ReadSkills], (await CachedObservation(fixture)).Required);
            Directory.CreateDirectory(checkout);
            File.Copy(source, Path.Combine(checkout, "manifest.json"));
            await WaitForPermission(async () => (await CachedObservation(fixture)) is { Status: "known", Required.Count: 0 });
        }
        finally { await observer.StopAsync(default); }
    }

    [Fact]
    public async Task PermissionObserver_BusyAppRetainsFileInvalidationUntilReleased()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var source = await WritePermissionManifest(fixture, [], []);
        await fixture.Service.InstallAsync(new(source, Autostart: false));
        using var observer = PermissionObserver(fixture);
        await observer.StartAsync(default);
        try
        {
            await WaitForPermission(async () => (await CachedObservation(fixture)).CheckedAt is not null);
            var before = await CachedObservation(fixture);
            var mutex = fixture.Apps.OperationLock(ObservedApp);
            await mutex.WaitAsync();
            try
            {
                await WritePermissionManifest(fixture, [CoreAppPermissions.ReadSkills], []);
                await Task.Delay(500);
                Assert.Same(before, await CachedObservation(fixture));
            }
            finally { mutex.Release(); }
            await WaitForPermission(async () => (await CachedObservation(fixture)).MissingRequired.Contains(CoreAppPermissions.ReadSkills));
        }
        finally { await observer.StopAsync(default); }
    }

    [Fact]
    public async Task PermissionObservation_ExplicitRefreshBypassesSameStampParserCache()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var source = await WritePermissionManifest(fixture, [CoreAppPermissions.ReadApps], []);
        await fixture.Service.InstallAsync(new(source, Autostart: false));
        await fixture.Service.ObservePermissionsAsync(ObservedApp, true, default);
        var stamp = File.GetLastWriteTimeUtc(source);
        await File.WriteAllTextAsync(source, (await File.ReadAllTextAsync(source)).Replace(CoreAppPermissions.ReadApps, CoreAppPermissions.ReadCore));
        File.SetLastWriteTimeUtc(source, stamp);
        Assert.Equal([CoreAppPermissions.ReadCore], (await fixture.Service.ObservePermissionsAsync(ObservedApp, true, default)).Required);
    }
}

public sealed class LiveManifestWatchesTests
{
    [Fact]
    public async Task Watchers_ShareDirectoriesFilterNoiseRecoverErrorsAndRelease()
    {
        var root = Directory.CreateTempSubdirectory("permission-watches-").FullName;
        var notifications = new ConcurrentQueue<string>();
        using var watches = new LiveManifestWatches(notifications.Enqueue);
        try
        {
            var one = Path.Combine(root, "one.json");
            var two = Path.Combine(root, "two.json");
            File.WriteAllText(one, "{}"); File.WriteAllText(two, "{}");
            watches.Set("one", one, root + Path.DirectorySeparatorChar);
            var count = watches.DirectoryCount;
            Assert.Equal(2, count); // Source directory plus its parent, not the filesystem root.
            watches.Set("two", two);
            Assert.Equal(count, watches.DirectoryCount);
            File.WriteAllText(Path.Combine(root, "unrelated.json"), "{}");
            await Task.Delay(300);
            Assert.Empty(notifications);
            watches.Failed(root);
            Assert.Contains("one", notifications); Assert.Contains("two", notifications);
            watches.Set("one", one);
            notifications.Clear();
            File.WriteAllText(one, "{changed}");
            using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(5));
            while (notifications.IsEmpty) await Task.Delay(25, deadline.Token);
            Assert.All(notifications, id => Assert.Equal("one", id));
            watches.Set("one", null); watches.Set("two", null);
            Assert.Equal(0, watches.DirectoryCount);
        }
        finally { watches.Dispose(); Directory.Delete(root, true); }
    }
}
