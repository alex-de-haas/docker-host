using Haas.Hosty.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed class AppBackupRetentionSchedulerTests
{
    // The scheduler's first pass runs at startup, so a backup root Core cannot parse used to throw
    // out of the BackgroundService and take the host down with it — Core would not start at all.
    [Fact]
    public async Task RunCleanupAsync_SurvivesUnusableBackupMetadata()
    {
        var root = Path.Combine(Path.GetTempPath(), $"hosty-core-backup-retention-tests-{Guid.NewGuid():N}");
        var paths = new CoreDataPaths(
            DataRoot: root,
            CoreRoot: Path.Combine(root, "core"),
            AppsRoot: Path.Combine(root, "apps"),
            BackupsRoot: Path.Combine(root, "backups"),
            SourcesRoot: Path.Combine(root, "sources"),
            AuthRoot: Path.Combine(root, "core", "auth"),
            AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));

        var backupRoot = Path.Combine(paths.BackupsRoot, "com.example.notes");
        Directory.CreateDirectory(backupRoot);
        var metadataPath = Path.Combine(backupRoot, "b1.json");
        var archivePath = Path.Combine(backupRoot, "b1.zip");
        await File.WriteAllTextAsync(metadataPath, "{}");
        await File.WriteAllBytesAsync(archivePath, [0x50, 0x4b, 0x05, 0x06]);

        var clock = new FakeClock(DateTimeOffset.Parse("2026-06-05T10:00:00Z"));
        var scheduler = new AppBackupRetentionScheduler(
            new AppBackupService(paths, clock),
            new AuditStore(paths),
            clock,
            NullLogger<AppBackupRetentionScheduler>.Instance);

        await scheduler.RunCleanupAsync(CancellationToken.None);

        // Nothing to clean automatically, so the pass is a no-op: no audit entry, files untouched.
        Assert.False(File.Exists(paths.AuditLogPath));
        Assert.True(File.Exists(metadataPath));
        Assert.True(File.Exists(archivePath));
    }

    private sealed class FakeClock(DateTimeOffset now) : IClock
    {
        public DateTimeOffset UtcNow { get; set; } = now;
    }
}
