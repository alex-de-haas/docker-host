using Haas.Hosty.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed class UserRetentionSchedulerTests
{
    [Fact]
    public async Task RunCleanupAsync_PurgesAgedDisabledUsersAndWritesAudit()
    {
        var fixture = await Fixture.CreateAsync();
        var now = fixture.Clock.UtcNow;
        await fixture.Users.WriteAsync(new UserDirectoryState(1,
        [
            new HostUserRecord("admin_1", "a@example.test", "Admin", "host.admin", false, now, now),
            new HostUserRecord("user_old", "old@example.test", "Old", "host.user", true, now.AddDays(-40), now.AddDays(-40)),
            new HostUserRecord("user_recent", "recent@example.test", "Recent", "host.user", true, now.AddDays(-2), now.AddDays(-2)),
        ], [], [], []));

        // Default retention is 10 days, so only user_old is past the window.
        await fixture.Scheduler.RunCleanupAsync(CancellationToken.None);

        var state = await fixture.Users.ReadAsync();
        Assert.DoesNotContain(state.Users, user => user.Id == "user_old");
        Assert.Contains(state.Users, user => user.Id == "user_recent");
        Assert.True(File.Exists(fixture.Paths.AuditLogPath));
        Assert.Contains("auth.user.retention.cleanup", await File.ReadAllTextAsync(fixture.Paths.AuditLogPath));
    }

    [Fact]
    public async Task RunCleanupAsync_NoCandidates_WritesNoAudit()
    {
        var fixture = await Fixture.CreateAsync();
        var now = fixture.Clock.UtcNow;
        await fixture.Users.WriteAsync(new UserDirectoryState(1,
        [
            new HostUserRecord("admin_1", "a@example.test", "Admin", "host.admin", false, now, now),
            new HostUserRecord("user_recent", "recent@example.test", "Recent", "host.user", true, now.AddDays(-2), now.AddDays(-2)),
        ], [], [], []));

        await fixture.Scheduler.RunCleanupAsync(CancellationToken.None);

        Assert.False(File.Exists(fixture.Paths.AuditLogPath));
        Assert.Contains((await fixture.Users.ReadAsync()).Users, user => user.Id == "user_recent");
    }

    [Fact]
    public async Task RunCleanupAsync_RetentionDisabled_PurgesNothing()
    {
        var fixture = await Fixture.CreateAsync();
        var now = fixture.Clock.UtcNow;
        await fixture.Settings.UpdateAsync(new Dictionary<string, string?> { [UserRetentionSettings.DisabledRetentionDaysKey] = "0" });
        await fixture.Users.WriteAsync(new UserDirectoryState(1,
        [
            new HostUserRecord("admin_1", "a@example.test", "Admin", "host.admin", false, now, now),
            new HostUserRecord("user_old", "old@example.test", "Old", "host.user", true, now.AddDays(-400), now.AddDays(-400)),
        ], [], [], []));

        await fixture.Scheduler.RunCleanupAsync(CancellationToken.None);

        Assert.False(File.Exists(fixture.Paths.AuditLogPath));
        Assert.Contains((await fixture.Users.ReadAsync()).Users, user => user.Id == "user_old");
    }

    private sealed class Fixture
    {
        private Fixture(CoreDataPaths paths, UserDirectoryStore users, CoreSettingsService settings, UserRetentionScheduler scheduler, FakeClock clock)
        {
            Paths = paths;
            Users = users;
            Settings = settings;
            Scheduler = scheduler;
            Clock = clock;
        }

        public CoreDataPaths Paths { get; }

        public UserDirectoryStore Users { get; }

        public CoreSettingsService Settings { get; }

        public UserRetentionScheduler Scheduler { get; }

        public FakeClock Clock { get; }

        public static async Task<Fixture> CreateAsync()
        {
            var root = Path.Combine(Path.GetTempPath(), $"hosty-core-user-retention-tests-{Guid.NewGuid():N}");
            var paths = new CoreDataPaths(
                DataRoot: root,
                CoreRoot: Path.Combine(root, "core"),
                AppsRoot: Path.Combine(root, "apps"),
                BackupsRoot: Path.Combine(root, "backups"),
                SourcesRoot: Path.Combine(root, "sources"),
                AuthRoot: Path.Combine(root, "core", "auth"),
                AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));
            var users = new UserDirectoryStore(paths);
            var apps = new AppRegistryStore(paths);
            var audit = new AuditStore(paths);
            var clock = new FakeClock(DateTimeOffset.Parse("2026-06-05T10:00:00Z"));
            var passwords = new LocalPasswordAuthService(users, audit, clock);
            var config = new HostyCoreRuntimeConfig(
                DataRoot: root,
                RunDirectory: Path.Combine(root, "core", "run"),
                ControlDiscoveryPath: Path.Combine(root, "core", "run", "control.json"),
                CorePort: 3001,
                ListenUrl: "http://127.0.0.1:3001",
                CorePublicOrigin: "http://127.0.0.1:3001",
                RuntimePublicHost: "localhost",
                ShellSourceOverridePath: null,
                ShellAutostart: false);
            var settings = new CoreSettingsService(new CoreSettingsStore(paths, NullLogger<CoreSettingsStore>.Instance));
            var management = new UserManagementService(
                users, apps, audit, passwords, new CorePublicOriginResolver(config, settings), clock);
            await users.WriteAsync(new UserDirectoryState(1, [], [], [], []));
            var scheduler = new UserRetentionScheduler(management, settings, audit, clock, NullLogger<UserRetentionScheduler>.Instance);
            return new Fixture(paths, users, settings, scheduler, clock);
        }
    }

    private sealed class FakeClock(DateTimeOffset now) : IClock
    {
        public DateTimeOffset UtcNow { get; set; } = now;
    }
}
