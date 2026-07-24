using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class CoreEventHubTests
{
    [Fact]
    public async Task PublishNotification_DeliversToSubscribedUser()
    {
        var fixture = await Fixture.CreateAsync();
        using var subscription = fixture.Events.Subscribe("user_1", isAdmin: false);

        await fixture.Service.PublishAsync(new CoreScope(), "user_1", NotificationService.AudienceUser, "info", "Live", null, null, null);

        Assert.True(subscription.Reader.TryRead(out var envelope));
        Assert.Equal(CoreEventHub.NotificationEvent, envelope!.Name);
        Assert.Contains("\"Live\"", envelope.Data, StringComparison.Ordinal);
    }

    [Fact]
    public async Task PublishNotification_DoesNotDeliverToOtherUsers()
    {
        var fixture = await Fixture.CreateAsync();
        using var subscription = fixture.Events.Subscribe("user_2", isAdmin: false);

        await fixture.Service.PublishAsync(new CoreScope(), "user_1", NotificationService.AudienceUser, "info", "Live", null, null, null);

        Assert.False(subscription.Reader.TryRead(out _));
    }

    [Fact]
    public async Task Dispose_StopsDeliveryAndCompletesReader()
    {
        var fixture = await Fixture.CreateAsync();
        var subscription = fixture.Events.Subscribe("user_1", isAdmin: false);
        subscription.Dispose();

        await fixture.Service.PublishAsync(new CoreScope(), "user_1", NotificationService.AudienceUser, "info", "Live", null, null, null);

        Assert.False(subscription.Reader.TryRead(out _));
        Assert.True(subscription.Reader.Completion.IsCompleted);
    }

    [Fact]
    public async Task PublishAppEvent_DeliversToAdminSubscribers()
    {
        var fixture = await Fixture.CreateAsync();
        using var subscription = fixture.Events.Subscribe("user_1", isAdmin: true);

        fixture.Events.PublishAppEvent(CoreEventHub.AppChanged, "com.haas.demo-app");

        Assert.True(subscription.Reader.TryRead(out var envelope));
        Assert.Equal(CoreEventHub.AppChanged, envelope!.Name);
        Assert.Contains("com.haas.demo-app", envelope.Data, StringComparison.Ordinal);
    }

    [Fact]
    public async Task PublishAppEvent_SkipsNonAdminSubscribers()
    {
        // Domain events name apps host-wide, while GET /api/apps filters itself per user — fanning
        // them out to a non-admin session would leak the existence of apps it was never assigned.
        var fixture = await Fixture.CreateAsync();
        using var subscription = fixture.Events.Subscribe("user_1", isAdmin: false);

        fixture.Events.PublishAppEvent(CoreEventHub.AppChanged, "com.haas.demo-app");

        Assert.False(subscription.Reader.TryRead(out _));
    }

    [Fact]
    public async Task PublishAppEvent_DropsOldestInsteadOfBlockingPublishers()
    {
        // Publishers call in while holding locks (the AppRegistryStore per-app mutex), so a stalled
        // reader must never apply back-pressure. Losing hints is harmless: the client resyncs.
        var fixture = await Fixture.CreateAsync();
        using var subscription = fixture.Events.Subscribe("user_1", isAdmin: true);

        for (var i = 0; i < 200; i++)
        {
            fixture.Events.PublishAppEvent(CoreEventHub.AppChanged, $"app_{i}");
        }

        var drained = 0;
        while (subscription.Reader.TryRead(out _))
        {
            drained++;
        }

        Assert.Equal(64, drained); // The bounded capacity, not the 200 published.
    }

    private sealed class Fixture
    {
        private Fixture(NotificationService service, CoreEventHub events)
        {
            Service = service;
            Events = events;
        }

        public NotificationService Service { get; }

        public CoreEventHub Events { get; }

        public static async Task<Fixture> CreateAsync()
        {
            var root = Path.Combine(Path.GetTempPath(), $"hosty-core-event-hub-tests-{Guid.NewGuid():N}");
            var paths = new CoreDataPaths(
                DataRoot: root,
                CoreRoot: Path.Combine(root, "core"),
                AppsRoot: Path.Combine(root, "apps"),
                BackupsRoot: Path.Combine(root, "backups"),
                SourcesRoot: Path.Combine(root, "sources"),
                AuthRoot: Path.Combine(root, "core", "auth"),
                AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));

            var clock = new FakeClock(DateTimeOffset.Parse("2026-06-05T10:00:00Z"));
            var users = new UserDirectoryStore(paths);
            await users.WriteAsync(new UserDirectoryState(
                1,
                [
                    new HostUserRecord("user_1", "u1@example.test", "U1", "host.user", false, clock.UtcNow, clock.UtcNow),
                    new HostUserRecord("user_2", "u2@example.test", "U2", "host.user", false, clock.UtcNow, clock.UtcNow),
                ],
                [], [], []));

            var events = new CoreEventHub();
            var service = new NotificationService(new NotificationStore(paths), users, events, clock);
            return new Fixture(service, events);
        }
    }

    private sealed class FakeClock(DateTimeOffset now) : IClock
    {
        public DateTimeOffset UtcNow { get; set; } = now;
    }
}
