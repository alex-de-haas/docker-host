using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

// Guards the publish choke points themselves: the value of routing every commit through one place is
// exactly that no caller has to remember to announce it, so the tests exercise the store's public
// writers rather than the hub.
public sealed class CoreEventPublishingTests
{
    [Fact]
    public async Task UpsertAppAsync_PublishesAppChanged()
    {
        var fixture = Fixture.Create();
        using var subscription = fixture.Events.Subscribe("admin_1", isAdmin: true);

        await fixture.Apps.UpsertAppAsync(Record("com.haas.demo-app"));

        Assert.True(subscription.Reader.TryRead(out var envelope));
        Assert.Equal(CoreEventHub.AppChanged, envelope!.Name);
        Assert.Contains("com.haas.demo-app", envelope.Data, StringComparison.Ordinal);
    }

    [Fact]
    public async Task UpdateAppAsync_PublishesAppChanged()
    {
        // The second public writer funnels through the same private core method — the lifecycle's 22
        // update-in-place call sites all land here.
        var fixture = Fixture.Create();
        await fixture.Apps.UpsertAppAsync(Record("com.haas.demo-app"));
        using var subscription = fixture.Events.Subscribe("admin_1", isAdmin: true);

        await fixture.Apps.UpdateAppAsync("com.haas.demo-app", current => current with { RuntimeState = "running" });

        Assert.True(subscription.Reader.TryRead(out var envelope));
        Assert.Equal(CoreEventHub.AppChanged, envelope!.Name);
    }

    [Fact]
    public async Task RemoveAppAsync_PublishesAppRemoved()
    {
        var fixture = Fixture.Create();
        await fixture.Apps.UpsertAppAsync(Record("com.haas.demo-app"));
        using var subscription = fixture.Events.Subscribe("admin_1", isAdmin: true);

        await fixture.Apps.RemoveAppAsync("com.haas.demo-app");

        Assert.True(subscription.Reader.TryRead(out var envelope));
        Assert.Equal(CoreEventHub.AppRemoved, envelope!.Name);
    }

    [Fact]
    public async Task StoreWithoutHub_StillCommits()
    {
        // The hub is optional for fixtures that construct the store directly; a missing hub must be a
        // no-op, never a failure on the write path.
        var fixture = Fixture.Create(withHub: false);

        var document = await fixture.Apps.UpsertAppAsync(Record("com.haas.demo-app"));

        Assert.Equal("com.haas.demo-app", document.App.Id);
    }

    private static AppRecord Record(string appId) => new(
        Id: appId,
        DisplayName: "Demo",
        Description: null,
        Version: "1.0.0",
        Kind: "runtime",
        System: false,
        Source: "installed",
        ManifestPath: "apps/demo/manifest.json",
        ManifestUrl: null,
        SelectedRuntime: "docker",
        OperationStatus: "installed",
        RuntimeState: "stopped",
        LastOperation: null,
        LastError: null,
        Capabilities: [],
        Settings: new Dictionary<string, AppSettingValue>(StringComparer.Ordinal),
        StorageMappings: [],
        Dependencies: [],
        Endpoints: [],
        InstalledAt: DateTimeOffset.UtcNow,
        UpdatedAt: DateTimeOffset.UtcNow);

    private sealed class Fixture
    {
        private Fixture(AppRegistryStore apps, CoreEventHub events)
        {
            Apps = apps;
            Events = events;
        }

        public AppRegistryStore Apps { get; }

        public CoreEventHub Events { get; }

        public static Fixture Create(bool withHub = true)
        {
            var root = Path.Combine(Path.GetTempPath(), $"hosty-core-event-publishing-tests-{Guid.NewGuid():N}");
            var paths = new CoreDataPaths(
                DataRoot: root,
                CoreRoot: Path.Combine(root, "core"),
                AppsRoot: Path.Combine(root, "apps"),
                BackupsRoot: Path.Combine(root, "backups"),
                SourcesRoot: Path.Combine(root, "sources"),
                AuthRoot: Path.Combine(root, "core", "auth"),
                AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));

            var events = new CoreEventHub();
            return new Fixture(new AppRegistryStore(paths, withHub ? events : null), events);
        }
    }
}
