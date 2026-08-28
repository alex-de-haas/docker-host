using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class NotificationServiceTests
{
    [Fact]
    public async Task PublishAsync_CoreBroadcast_FansOutToEnabledUsersOnly()
    {
        var fixture = await Fixture.CreateAsync();

        var result = await fixture.Service.PublishAsync(
            new CoreScope(), NotificationService.BroadcastTarget, NotificationService.AudienceUser,
            "info", "Hello", null, null, null);

        Assert.Equal("created", result.Status);
        Assert.Equal(3, result.RecipientCount); // admin, alice, bob — disabled user excluded
    }

    [Fact]
    public async Task PublishAsync_AppScope_TargetsOnlyAssignedUsers()
    {
        var fixture = await Fixture.CreateAsync();

        var result = await fixture.Service.PublishAsync(
            new AppScope("com.example.app"), NotificationService.BroadcastTarget, NotificationService.AudienceUser,
            "info", "App says hi", null, null, null);

        Assert.Equal("created", result.Status);
        Assert.Equal(2, result.RecipientCount); // alice + admin are assigned; bob is not
    }

    [Fact]
    public async Task PublishAsync_HostAdminAudience_TargetsOnlyAdmins()
    {
        var fixture = await Fixture.CreateAsync();

        var result = await fixture.Service.PublishAsync(
            new CoreScope(), NotificationService.BroadcastTarget, NotificationService.AudienceHostAdmin,
            "warning", "Disk 90%", null, null, null);

        Assert.Equal("created", result.Status);
        Assert.Equal(1, result.RecipientCount); // only user_admin
    }

    [Fact]
    public async Task PublishAsync_UnknownTarget_ReportsNoRecipients()
    {
        var fixture = await Fixture.CreateAsync();

        var result = await fixture.Service.PublishAsync(
            new CoreScope(), "user_ghost", NotificationService.AudienceUser,
            "info", "Nobody home", null, null, null);

        Assert.Equal("no_recipients", result.Status);
        Assert.Equal(0, result.RecipientCount);
    }

    [Fact]
    public async Task PublishAsync_DuplicateDedupeKeyWhileUnread_IsDeduplicated()
    {
        var fixture = await Fixture.CreateAsync();

        var first = await fixture.Service.PublishAsync(
            new CoreScope(), "user_alice", NotificationService.AudienceUser,
            "info", "Build done", null, null, dedupeKey: "build-42");
        var second = await fixture.Service.PublishAsync(
            new CoreScope(), "user_alice", NotificationService.AudienceUser,
            "info", "Build done", null, null, dedupeKey: "build-42");

        Assert.Equal("created", first.Status);
        Assert.Equal("deduplicated", second.Status);
        Assert.Equal(0, second.RecipientCount);
    }

    [Fact]
    public async Task QueryAsync_ReturnsNewestFirstWithUnreadCount()
    {
        var fixture = await Fixture.CreateAsync();
        await fixture.Service.PublishAsync(new CoreScope(), "user_alice", NotificationService.AudienceUser, "info", "First", null, null, null);
        fixture.Clock.UtcNow = fixture.Clock.UtcNow.AddMinutes(1);
        await fixture.Service.PublishAsync(new CoreScope(), "user_alice", NotificationService.AudienceUser, "info", "Second", null, null, null);

        var page = await fixture.Service.QueryAsync("user_alice", includeHostAdmin: false, unreadOnly: false, limit: 50, offset: 0);

        Assert.Equal(2, page.Notifications.Count);
        Assert.Equal("Second", page.Notifications[0].Title);
        Assert.Equal("First", page.Notifications[1].Title);
        Assert.Equal(2, page.UnreadCount);
        Assert.Equal(2, page.Pagination.Total);
    }

    [Fact]
    public async Task QueryAsync_HidesHostAdminAudienceFromNonAdmin()
    {
        var fixture = await Fixture.CreateAsync();
        // Force a host-admin record onto a non-admin recipient to exercise the defensive filter
        // (e.g. a user demoted after the notification was created).
        await fixture.Store.UpdateAsync<int>(state => (state with
        {
            Notifications =
            [
                .. state.Notifications,
                new NotificationRecord("ntf_admin", "user_bob", new NotificationSource("core", null),
                    NotificationService.AudienceHostAdmin, "warning", "Admin only", null, null, null,
                    fixture.Clock.UtcNow, null),
            ],
        }, 0));

        var asUser = await fixture.Service.QueryAsync("user_bob", includeHostAdmin: false, unreadOnly: false, 50, 0);
        var asAdmin = await fixture.Service.QueryAsync("user_bob", includeHostAdmin: true, unreadOnly: false, 50, 0);

        Assert.Empty(asUser.Notifications);
        Assert.Single(asAdmin.Notifications);
    }

    [Fact]
    public async Task MarkReadAsync_SpecificId_MarksOnlyThatNotification()
    {
        var fixture = await Fixture.CreateAsync();
        await fixture.Service.PublishAsync(new CoreScope(), "user_alice", NotificationService.AudienceUser, "info", "A", null, null, null);
        await fixture.Service.PublishAsync(new CoreScope(), "user_alice", NotificationService.AudienceUser, "info", "B", null, null, null);
        var page = await fixture.Service.QueryAsync("user_alice", false, false, 50, 0);
        var firstId = page.Notifications[0].Id;

        var result = await fixture.Service.MarkReadAsync("user_alice", [firstId]);

        Assert.Equal(1, result.Updated);
        Assert.Equal(1, result.UnreadCount);
    }

    [Fact]
    public async Task MarkReadAsync_NullIds_MarksAllRecipientNotifications()
    {
        var fixture = await Fixture.CreateAsync();
        await fixture.Service.PublishAsync(new CoreScope(), "user_alice", NotificationService.AudienceUser, "info", "A", null, null, null);
        await fixture.Service.PublishAsync(new CoreScope(), "user_alice", NotificationService.AudienceUser, "info", "B", null, null, null);

        var result = await fixture.Service.MarkReadAsync("user_alice", ids: null);

        Assert.Equal(2, result.Updated);
        Assert.Equal(0, result.UnreadCount);
    }

    [Fact]
    public async Task PurgeByDedupePrefixAsync_RemovesCoreAdvisoriesReadAndUnread()
    {
        var fixture = await Fixture.CreateAsync();
        await fixture.Service.PublishAsync(new CoreScope(), "user_alice", NotificationService.AudienceUser,
            "warning", "Dependency stopped", null, null, "dependency-stopped:com.a:com.b");
        await fixture.Service.PublishAsync(new CoreScope(), "user_alice", NotificationService.AudienceUser,
            "info", "Unrelated", null, null, "update-applied:com.a");
        var page = await fixture.Service.QueryAsync("user_alice", false, false, 50, 0);
        await fixture.Service.MarkReadAsync("user_alice", [page.Notifications.Single(n => n.Title == "Dependency stopped").Id]);

        var purged = await fixture.Service.PurgeByDedupePrefixAsync(["dependency-stopped:"]);

        var remaining = await fixture.Service.QueryAsync("user_alice", false, false, 50, 0);
        Assert.Equal(1, purged);
        Assert.Equal("Unrelated", Assert.Single(remaining.Notifications).Title);
    }

    [Fact]
    public async Task PurgeByDedupePrefixAsync_LeavesAppOwnedKeysAlone()
    {
        // An app picks its own dedupe key, so matching the prefix alone would delete a legitimate
        // app notification on every single boot. Only Core produced the advisories being retired.
        var fixture = await Fixture.CreateAsync();
        await fixture.Service.PublishAsync(new AppScope("com.example.app"), "user_alice", NotificationService.AudienceUser,
            "info", "App owned", null, null, "dependency-stopped:mine");

        var purged = await fixture.Service.PurgeByDedupePrefixAsync(["dependency-stopped:"]);

        var remaining = await fixture.Service.QueryAsync("user_alice", false, false, 50, 0);
        Assert.Equal(0, purged);
        Assert.Equal("App owned", Assert.Single(remaining.Notifications).Title);
    }

    [Fact]
    public async Task ApplyRetentionAsync_PrunesOldReadButKeepsUnread()
    {
        var fixture = await Fixture.CreateAsync();
        await fixture.Service.PublishAsync(new CoreScope(), "user_alice", NotificationService.AudienceUser, "info", "Old read", null, null, null);
        await fixture.Service.PublishAsync(new CoreScope(), "user_alice", NotificationService.AudienceUser, "info", "Old unread", null, null, null);
        var page = await fixture.Service.QueryAsync("user_alice", false, false, 50, 0);
        var readId = page.Notifications.Single(n => n.Title == "Old read").Id;
        await fixture.Service.MarkReadAsync("user_alice", [readId]);

        fixture.Clock.UtcNow = fixture.Clock.UtcNow.AddDays(40);
        var pruned = await fixture.Service.ApplyRetentionAsync();

        var remaining = await fixture.Service.QueryAsync("user_alice", false, false, 50, 0);
        Assert.Equal(1, pruned);
        Assert.Single(remaining.Notifications);
        Assert.Equal("Old unread", remaining.Notifications[0].Title);
    }

    [Fact]
    public async Task ApplyRetentionAsync_CapsUnreadAtThePerUserBudgetKeepingTheNewest()
    {
        // Unread was the one class with no ceiling, so an operator who never opens the bell grew this
        // document without bound — and publishing is a whole-document read-modify-write, so every
        // later publish paid for the growth.
        var fixture = await Fixture.CreateAsync();
        for (var index = 0; index < NotificationService.MaxPerUser + 5; index += 1)
        {
            await fixture.Service.PublishAsync(
                new CoreScope(), "user_alice", NotificationService.AudienceUser, "info", $"Advisory {index:D3}", null, null, null);
            fixture.Clock.UtcNow = fixture.Clock.UtcNow.AddMinutes(1);
        }

        var pruned = await fixture.Service.ApplyRetentionAsync();

        var remaining = await fixture.Service.QueryAsync("user_alice", false, false, NotificationService.MaxPerUser, 0);
        Assert.Equal(5, pruned);
        Assert.Equal(NotificationService.MaxPerUser, remaining.Notifications.Count);
        // The newest survive: the oldest unread advisories are the ones least likely to still matter.
        Assert.Equal("Advisory 104", remaining.Notifications[0].Title);
        Assert.DoesNotContain(remaining.Notifications, record => record.Title == "Advisory 000");
    }

    [Fact]
    public async Task ApplyRetentionAsync_KeepsRecentlyReadNotificationCreatedLongAgo()
    {
        var fixture = await Fixture.CreateAsync();
        await fixture.Service.PublishAsync(new CoreScope(), "user_alice", NotificationService.AudienceUser, "info", "Created long ago", null, null, null);
        fixture.Clock.UtcNow = fixture.Clock.UtcNow.AddDays(59);
        var page = await fixture.Service.QueryAsync("user_alice", false, false, 50, 0);
        await fixture.Service.MarkReadAsync("user_alice", [page.Notifications[0].Id]); // ReadAt = T0 + 59d
        fixture.Clock.UtcNow = fixture.Clock.UtcNow.AddDays(1); // now T0 + 60d; cutoff T0 + 30d; ReadAt is within the window

        var pruned = await fixture.Service.ApplyRetentionAsync();

        var remaining = await fixture.Service.QueryAsync("user_alice", false, false, 50, 0);
        Assert.Equal(0, pruned); // not pruned: read recently, even though created 60 days ago
        Assert.Single(remaining.Notifications);
    }

    [Fact]
    public async Task NotificationState_DeserializesMissingNotificationsAsEmpty()
    {
        var root = Path.Combine(Path.GetTempPath(), $"hosty-core-notification-null-tests-{Guid.NewGuid():N}");
        var statePath = Path.Combine(root, "core", "notifications", "notifications.json");
        Directory.CreateDirectory(Path.GetDirectoryName(statePath)!);
        await File.WriteAllTextAsync(statePath, "{\"schemaVersion\":1}");
        var store = new NotificationStore(new CoreDataPaths(
            DataRoot: root,
            CoreRoot: Path.Combine(root, "core"),
            AppsRoot: Path.Combine(root, "apps"),
            BackupsRoot: Path.Combine(root, "backups"),
            SourcesRoot: Path.Combine(root, "sources"),
            AuthRoot: Path.Combine(root, "core", "auth"),
            AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson")));

        var state = await store.ReadAsync();

        Assert.NotNull(state.Notifications);
        Assert.Empty(state.Notifications);
    }

    private sealed class Fixture
    {
        private Fixture(NotificationService service, NotificationStore store, FakeClock clock)
        {
            Service = service;
            Store = store;
            Clock = clock;
        }

        public NotificationService Service { get; }

        public NotificationStore Store { get; }

        public FakeClock Clock { get; }

        public static async Task<Fixture> CreateAsync()
        {
            var root = Path.Combine(Path.GetTempPath(), $"hosty-core-notification-tests-{Guid.NewGuid():N}");
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
            HostUserRecord User(string id, string role, bool disabled) =>
                new(id, $"{id}@example.test", id, role, disabled, clock.UtcNow, clock.UtcNow);
            var directory = new UserDirectoryState(
                1,
                [User("user_admin", "host.admin", false), User("user_alice", "host.user", false), User("user_bob", "host.user", false), User("user_dis", "host.user", true)],
                [],
                [new AppAssignmentRecord("com.example.app", "user_alice", clock.UtcNow), new AppAssignmentRecord("com.example.app", "user_admin", clock.UtcNow)],
                []);
            await users.WriteAsync(directory);

            var store = new NotificationStore(paths);
            var service = new NotificationService(store, users, new CoreEventHub(), clock);
            return new Fixture(service, store, clock);
        }
    }

    private sealed class FakeClock(DateTimeOffset now) : IClock
    {
        public DateTimeOffset UtcNow { get; set; } = now;
    }
}
