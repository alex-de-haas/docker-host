using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class AppBackupServiceTests
{
    [Fact]
    public async Task RestoreBackupAsync_ReplacesDataWithArchiveContent()
    {
        var fixture = BackupFixture.Create();
        await File.WriteAllTextAsync(Path.Combine(fixture.DataPath, "notes.txt"), "original");
        var backup = await fixture.Service.CreateBackupAsync("com.example.notes", "manual");
        Assert.NotNull(backup);
        await File.WriteAllTextAsync(Path.Combine(fixture.DataPath, "notes.txt"), "changed");
        await File.WriteAllTextAsync(Path.Combine(fixture.DataPath, "extra.txt"), "extra");

        var restored = await fixture.Service.RestoreBackupAsync("com.example.notes", backup.BackupId, createPreRestoreBackup: false);

        Assert.NotNull(restored);
        Assert.Equal("original", await File.ReadAllTextAsync(Path.Combine(fixture.DataPath, "notes.txt")));
        Assert.False(File.Exists(Path.Combine(fixture.DataPath, "extra.txt")));
        Assert.DoesNotContain(
            Directory.EnumerateFileSystemEntries(Path.GetDirectoryName(fixture.DataPath)!),
            entry => entry.EndsWith(".tmp", StringComparison.Ordinal));
    }

    [Fact]
    public async Task CreateBackupAsync_SameInstant_ProducesDistinctBackups()
    {
        // The fixture clock does not advance between calls, so both backups share a timestamp.
        // Without the random id suffix the second create would collide on the archive path.
        var fixture = BackupFixture.Create();
        await File.WriteAllTextAsync(Path.Combine(fixture.DataPath, "notes.txt"), "data");

        var first = await fixture.Service.CreateBackupAsync("com.example.notes", "manual");
        var second = await fixture.Service.CreateBackupAsync("com.example.notes", "manual");

        Assert.NotNull(first);
        Assert.NotNull(second);
        Assert.NotEqual(first.BackupId, second.BackupId);
        Assert.Equal(2, (await fixture.Service.ListBackupsAsync("com.example.notes")).Count);
    }

    [Fact]
    public async Task RestoreBackupAsync_RejectsCorruptArchiveBeforeTouchingData()
    {
        var fixture = BackupFixture.Create();
        await File.WriteAllTextAsync(Path.Combine(fixture.DataPath, "notes.txt"), "original");
        var backup = await fixture.Service.CreateBackupAsync("com.example.notes", "manual");
        Assert.NotNull(backup);
        await File.WriteAllTextAsync(Path.Combine(fixture.DataPath, "notes.txt"), "live");
        await File.AppendAllTextAsync(backup.ArchivePath, "corruption");

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.RestoreBackupAsync("com.example.notes", backup.BackupId, createPreRestoreBackup: false));

        Assert.Equal("backup_archive_corrupt", error.Code);
        Assert.Equal("live", await File.ReadAllTextAsync(Path.Combine(fixture.DataPath, "notes.txt")));
    }

    [Fact]
    public async Task RestoreBackupAsync_LeavesLiveDataWhenArchiveExtractionFails()
    {
        var fixture = BackupFixture.Create();
        await File.WriteAllTextAsync(Path.Combine(fixture.DataPath, "notes.txt"), "original");
        var backup = await fixture.Service.CreateBackupAsync("com.example.notes", "manual");
        Assert.NotNull(backup);
        var truncated = (await File.ReadAllBytesAsync(backup.ArchivePath))[..16];
        await File.WriteAllBytesAsync(backup.ArchivePath, truncated);
        var metadataPath = Path.Combine(Path.GetDirectoryName(backup.ArchivePath)!, $"{backup.BackupId}.json");
        var record = await JsonStorage.ReadAsync<AppBackupRecord>(metadataPath);
        Assert.NotNull(record);
        await JsonStorage.WriteAsync(metadataPath, record with
        {
            ArchiveSha256 = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(truncated)).ToLowerInvariant(),
        });
        await File.WriteAllTextAsync(Path.Combine(fixture.DataPath, "notes.txt"), "live");

        await Assert.ThrowsAnyAsync<Exception>(() =>
            fixture.Service.RestoreBackupAsync("com.example.notes", backup.BackupId, createPreRestoreBackup: false));

        Assert.Equal("live", await File.ReadAllTextAsync(Path.Combine(fixture.DataPath, "notes.txt")));
    }

    private sealed class BackupFixture
    {
        private BackupFixture(AppBackupService service, string dataPath, FakeClock clock)
        {
            Service = service;
            DataPath = dataPath;
            Clock = clock;
        }

        public AppBackupService Service { get; }

        public string DataPath { get; }

        public FakeClock Clock { get; }

        public static BackupFixture Create()
        {
            var root = Path.Combine(Path.GetTempPath(), $"hosty-core-backup-tests-{Guid.NewGuid():N}");
            var paths = new CoreDataPaths(
                DataRoot: root,
                CoreRoot: Path.Combine(root, "core"),
                AppsRoot: Path.Combine(root, "apps"),
                BackupsRoot: Path.Combine(root, "backups"),
                SourcesRoot: Path.Combine(root, "sources"),
                AuthRoot: Path.Combine(root, "core", "auth"),
                AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));
            var dataPath = Path.Combine(paths.AppsRoot, "com.example.notes", "data");
            Directory.CreateDirectory(dataPath);
            var clock = new FakeClock(DateTimeOffset.Parse("2026-06-05T10:00:00Z"));
            return new BackupFixture(new AppBackupService(paths, clock), dataPath, clock);
        }
    }

    private sealed class FakeClock(DateTimeOffset now) : IClock
    {
        public DateTimeOffset UtcNow { get; set; } = now;
    }
}
