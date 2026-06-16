using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class NotificationBroadcasterTests
{
    [Fact]
    public async Task Publish_DeliversToSubscribedUser()
    {
        var fixture = await Fixture.CreateAsync();
        using var subscription = fixture.Broadcaster.Subscribe("user_1");

        await fixture.Service.PublishAsync(new CoreScope(), "user_1", NotificationService.AudienceUser, "info", "Live", null, null, null);

        Assert.True(subscription.Reader.TryRead(out var view));
        Assert.Equal("Live", view!.Title);
    }

    [Fact]
    public async Task Publish_DoesNotDeliverToOtherUsers()
    {
        var fixture = await Fixture.CreateAsync();
        using var subscription = fixture.Broadcaster.Subscribe("user_2");

        await fixture.Service.PublishAsync(new CoreScope(), "user_1", NotificationService.AudienceUser, "info", "Live", null, null, null);

        Assert.False(subscription.Reader.TryRead(out _));
    }

    [Fact]
    public async Task Dispose_StopsDeliveryAndCompletesReader()
    {
        var fixture = await Fixture.CreateAsync();
        var subscription = fixture.Broadcaster.Subscribe("user_1");
        subscription.Dispose();

        await fixture.Service.PublishAsync(new CoreScope(), "user_1", NotificationService.AudienceUser, "info", "Live", null, null, null);

        Assert.False(subscription.Reader.TryRead(out _));
        Assert.True(subscription.Reader.Completion.IsCompleted);
    }

    private sealed class Fixture
    {
        private Fixture(NotificationService service, NotificationBroadcaster broadcaster)
        {
            Service = service;
            Broadcaster = broadcaster;
        }

        public NotificationService Service { get; }

        public NotificationBroadcaster Broadcaster { get; }

        public static async Task<Fixture> CreateAsync()
        {
            var root = Path.Combine(Path.GetTempPath(), $"hosty-core-notification-broadcaster-tests-{Guid.NewGuid():N}");
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

            var broadcaster = new NotificationBroadcaster();
            var service = new NotificationService(new NotificationStore(paths), users, broadcaster, clock);
            return new Fixture(service, broadcaster);
        }
    }

    private sealed class FakeClock(DateTimeOffset now) : IClock
    {
        public DateTimeOffset UtcNow { get; set; } = now;
    }
}
