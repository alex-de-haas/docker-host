using Haas.Hosty.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed class NotificationRetentionSchedulerTests
{
    [Fact]
    public async Task RunCleanupAsync_PrunesOldReadAndWritesAudit()
    {
        var root = Path.Combine(Path.GetTempPath(), $"hosty-core-notification-retention-tests-{Guid.NewGuid():N}");
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
            1, [new HostUserRecord("user_1", "u1@example.test", "U1", "host.user", false, clock.UtcNow, clock.UtcNow)], [], [], []));

        var notifications = new NotificationService(new NotificationStore(paths), users, new NotificationBroadcaster(), clock);
        await notifications.PublishAsync(new CoreScope(), "user_1", NotificationService.AudienceUser, "info", "Old read", null, null, null);
        var page = await notifications.QueryAsync("user_1", false, false, 50, 0);
        await notifications.MarkReadAsync("user_1", [page.Notifications[0].Id]);

        var audit = new AuditStore(paths);
        var scheduler = new NotificationRetentionScheduler(notifications, audit, clock, NullLogger<NotificationRetentionScheduler>.Instance);

        clock.UtcNow = clock.UtcNow.AddDays(40);
        await scheduler.RunCleanupAsync(CancellationToken.None);

        var remaining = await notifications.QueryAsync("user_1", false, false, 50, 0);
        Assert.Empty(remaining.Notifications);
        Assert.True(File.Exists(paths.AuditLogPath));
        Assert.Contains("notification.retention.cleanup", await File.ReadAllTextAsync(paths.AuditLogPath));
    }

    [Fact]
    public async Task RunCleanupAsync_NoCandidates_WritesNoAudit()
    {
        var root = Path.Combine(Path.GetTempPath(), $"hosty-core-notification-retention-tests-{Guid.NewGuid():N}");
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
            1, [new HostUserRecord("user_1", "u1@example.test", "U1", "host.user", false, clock.UtcNow, clock.UtcNow)], [], [], []));

        var notifications = new NotificationService(new NotificationStore(paths), users, new NotificationBroadcaster(), clock);
        await notifications.PublishAsync(new CoreScope(), "user_1", NotificationService.AudienceUser, "info", "Fresh unread", null, null, null);

        var audit = new AuditStore(paths);
        var scheduler = new NotificationRetentionScheduler(notifications, audit, clock, NullLogger<NotificationRetentionScheduler>.Instance);

        await scheduler.RunCleanupAsync(CancellationToken.None);

        Assert.False(File.Exists(paths.AuditLogPath));
        Assert.Single((await notifications.QueryAsync("user_1", false, false, 50, 0)).Notifications);
    }

    private sealed class FakeClock(DateTimeOffset now) : IClock
    {
        public DateTimeOffset UtcNow { get; set; } = now;
    }
}
