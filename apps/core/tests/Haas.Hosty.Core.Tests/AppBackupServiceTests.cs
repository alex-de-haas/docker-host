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

    // A backup root is a plain directory an operator can edit, so a metadata file may be truncated,
    // hand-written or copied under a second name. None of those may fail a listing or the retention
    // sweep — the sweep runs in a BackgroundService, where an escaping exception stops the host.
    [Fact]
    public async Task MalformedMetadata_DoesNotBreakListingOrScheduledCleanup()
    {
        var fixture = BackupFixture.Create();
        await File.WriteAllTextAsync(Path.Combine(fixture.DataPath, "notes.txt"), "original");
        var good = await fixture.Service.CreateBackupAsync("com.example.notes", "manual");
        Assert.NotNull(good);

        // No backupId at all: the reported repro, which faulted the plan's ToDictionary on a null key.
        var orphanMetadataPath = Path.Combine(fixture.BackupRoot, "b1.json");
        var orphanArchivePath = Path.Combine(fixture.BackupRoot, "b1.zip");
        await File.WriteAllTextAsync(orphanMetadataPath, "{}");
        await File.WriteAllBytesAsync(orphanArchivePath, [0x50, 0x4b, 0x05, 0x06]);

        // A second file claiming the same backupId, which faulted the same call on a duplicate key.
        var duplicateMetadataPath = Path.Combine(fixture.BackupRoot, "zz-duplicate.json");
        File.Copy(Path.Combine(fixture.BackupRoot, $"{good.BackupId}.json"), duplicateMetadataPath);

        // Not JSON at all: JsonStorage.ReadAsync surfaces a JsonException from the enumeration.
        var unparsableMetadataPath = Path.Combine(fixture.BackupRoot, "zz-unparsable.json");
        await File.WriteAllTextAsync(unparsableMetadataPath, "{ this is not json");

        var listed = await fixture.Service.ListBackupsAsync("com.example.notes");
        Assert.Equal([good.BackupId], listed.Select(record => record.BackupId));

        var plan = await fixture.Service.CreateCleanupPlanAsync("com.example.notes");
        Assert.DoesNotContain(plan.Candidates, candidate => string.IsNullOrWhiteSpace(candidate.BackupId));

        var applied = await fixture.Service.ApplyScheduledCleanupAsync();

        // The unusable files are skipped, not deleted: only an operator-confirmed cleanup removes an
        // archive Core has no metadata for, so nothing here is automatic.
        Assert.Empty(applied.Deleted);
        Assert.True(File.Exists(orphanMetadataPath));
        Assert.True(File.Exists(orphanArchivePath));
        Assert.True(File.Exists(duplicateMetadataPath));
        Assert.True(File.Exists(unparsableMetadataPath));
        Assert.True(File.Exists(good.ArchivePath));
    }

    private sealed class BackupFixture
    {
        private BackupFixture(AppBackupService service, string dataPath, string backupRoot, FakeClock clock)
        {
            Service = service;
            DataPath = dataPath;
            BackupRoot = backupRoot;
            Clock = clock;
        }

        public AppBackupService Service { get; }

        public string DataPath { get; }

        public string BackupRoot { get; }

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
            return new BackupFixture(
                new AppBackupService(paths, clock),
                dataPath,
                Path.Combine(paths.BackupsRoot, "com.example.notes"),
                clock);
        }
    }

    private sealed class FakeClock(DateTimeOffset now) : IClock
    {
        public DateTimeOffset UtcNow { get; set; } = now;
    }
}
