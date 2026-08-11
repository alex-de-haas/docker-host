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
    public async Task BackupAndRestore_IgnoreTheCacheSibling()
    {
        var fixture = BackupFixture.Create();
        await File.WriteAllTextAsync(Path.Combine(fixture.DataPath, "notes.txt"), "kept");
        // The cache directory sits beside data/, which is the entire exclusion mechanism:
        // this test pins the layout so a cache move into data/ cannot go unnoticed.
        var cachePath = Path.Combine(Path.GetDirectoryName(fixture.DataPath)!, "cache");
        Directory.CreateDirectory(cachePath);
        await File.WriteAllTextAsync(Path.Combine(cachePath, "entry.idx"), "derived");

        var backup = await fixture.Service.CreateBackupAsync("com.example.notes", "manual");

        Assert.NotNull(backup);
        using (var archive = System.IO.Compression.ZipFile.OpenRead(backup.ArchivePath))
        {
            Assert.Contains(archive.Entries, entry => entry.Name == "notes.txt");
            Assert.DoesNotContain(archive.Entries, entry => entry.FullName.Contains("cache", StringComparison.Ordinal));
        }

        await File.WriteAllTextAsync(Path.Combine(fixture.DataPath, "notes.txt"), "changed");
        var restored = await fixture.Service.RestoreBackupAsync("com.example.notes", backup.BackupId, createPreRestoreBackup: false);

        Assert.NotNull(restored);
        Assert.Equal("kept", await File.ReadAllTextAsync(Path.Combine(fixture.DataPath, "notes.txt")));
        Assert.Equal("derived", await File.ReadAllTextAsync(Path.Combine(cachePath, "entry.idx")));
    }

    [Fact]
    public async Task CreateBackupAsync_WritesTheArchiveAndMetadataOwnerOnly()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        // An archive is a full copy of the app's data, so it must not inherit the umask default.
        var fixture = BackupFixture.Create();
        await File.WriteAllTextAsync(Path.Combine(fixture.DataPath, "notes.txt"), "secret");

        var backup = await fixture.Service.CreateBackupAsync("com.example.notes", "manual");

        Assert.NotNull(backup);
        var ownerOnlyFile = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        Assert.Equal(ownerOnlyFile, File.GetUnixFileMode(backup.ArchivePath));
        Assert.Equal(ownerOnlyFile, File.GetUnixFileMode(Path.ChangeExtension(backup.ArchivePath, ".json")));
        Assert.Equal(
            UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute,
            File.GetUnixFileMode(Path.GetDirectoryName(backup.ArchivePath)!));
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

    // A metadata file may omit archivePath entirely. Deleting such a backup must still clear the
    // record instead of throwing out of Path.GetFullPath(null) deep inside the containment check.
    [Fact]
    public async Task DeleteBackupAsync_RemovesMetadataWhenArchivePathIsMissing()
    {
        var fixture = BackupFixture.Create();
        Directory.CreateDirectory(fixture.BackupRoot);
        var metadataPath = Path.Combine(fixture.BackupRoot, "b2.json");
        await File.WriteAllTextAsync(metadataPath, MetadataJson("com.example.notes", "b2", archivePath: null));

        var deleted = await fixture.Service.DeleteBackupAsync("com.example.notes", "b2");

        Assert.True(deleted);
        Assert.False(File.Exists(metadataPath));
    }

    // The directory owns the app identity. A record claiming another app must not reach the cleanup
    // plan, where the candidate would resolve against that app's backup root and delete its files.
    [Fact]
    public async Task CleanupPlan_IgnoresMetadataClaimingAnotherApp()
    {
        var fixture = BackupFixture.Create();
        await File.WriteAllTextAsync(Path.Combine(fixture.DataPath, "notes.txt"), "original");
        var good = await fixture.Service.CreateBackupAsync("com.example.notes", "manual");
        Assert.NotNull(good);

        var otherBackupRoot = Path.Combine(Path.GetDirectoryName(fixture.BackupRoot)!, "com.example.other");
        Directory.CreateDirectory(otherBackupRoot);
        await File.WriteAllTextAsync(
            Path.Combine(fixture.BackupRoot, "impostor.json"),
            MetadataJson("com.example.other", "impostor", Path.Combine(otherBackupRoot, "impostor.zip")));

        var listed = await fixture.Service.ListBackupsAsync("com.example.notes");
        Assert.Equal([good.BackupId], listed.Select(record => record.BackupId));

        var plan = await fixture.Service.CreateCleanupPlanAsync("com.example.notes");
        Assert.All(plan.Candidates, candidate => Assert.Equal("com.example.notes", candidate.AppId));
    }

    // archivePath is operator-editable, so restore must refuse a path outside the app's backup root:
    // otherwise a hand-written record makes Core extract an arbitrary host archive over app data.
    [Fact]
    public async Task RestoreBackupAsync_RefusesArchivePathOutsideBackupRoot()
    {
        var fixture = BackupFixture.Create();
        await File.WriteAllTextAsync(Path.Combine(fixture.DataPath, "notes.txt"), "live");

        // A real, intact archive that simply does not belong to this app's backup root.
        var plantedSource = Path.Combine(fixture.Root, "planted-source");
        Directory.CreateDirectory(plantedSource);
        await File.WriteAllTextAsync(Path.Combine(plantedSource, "pwned.txt"), "planted");
        var plantedArchive = Path.Combine(fixture.Root, "planted.zip");
        System.IO.Compression.ZipFile.CreateFromDirectory(plantedSource, plantedArchive);
        var plantedSha256 = Convert.ToHexString(
            System.Security.Cryptography.SHA256.HashData(await File.ReadAllBytesAsync(plantedArchive))).ToLowerInvariant();

        Directory.CreateDirectory(fixture.BackupRoot);
        await File.WriteAllTextAsync(
            Path.Combine(fixture.BackupRoot, "escape.json"),
            MetadataJson("com.example.notes", "escape", plantedArchive, plantedSha256));

        var restored = await fixture.Service.RestoreBackupAsync("com.example.notes", "escape", createPreRestoreBackup: false);

        Assert.Null(restored);
        Assert.False(File.Exists(Path.Combine(fixture.DataPath, "pwned.txt")));
        Assert.Equal("live", await File.ReadAllTextAsync(Path.Combine(fixture.DataPath, "notes.txt")));
    }

    // Hand-rolled rather than serialized from AppBackupRecord: these tests need shapes the record
    // cannot express, such as an absent archivePath.
    private static string MetadataJson(string appId, string backupId, string? archivePath, string archiveSha256 = "")
    {
        var archive = archivePath is null
            ? string.Empty
            : $"\"archivePath\":{System.Text.Json.JsonSerializer.Serialize(archivePath)},";
        return $$"""
            {
              "appId": {{System.Text.Json.JsonSerializer.Serialize(appId)}},
              "backupId": {{System.Text.Json.JsonSerializer.Serialize(backupId)}},
              "reason": "manual",
              "createdAt": "2026-06-05T10:00:00+00:00",
              "dataPath": "",
              {{archive}}
              "archiveSha256": {{System.Text.Json.JsonSerializer.Serialize(archiveSha256)}},
              "archiveSize": 0,
              "fileCount": 0
            }
            """;
    }

    private sealed class BackupFixture
    {
        private BackupFixture(AppBackupService service, string root, string dataPath, string backupRoot, FakeClock clock)
        {
            Service = service;
            Root = root;
            DataPath = dataPath;
            BackupRoot = backupRoot;
            Clock = clock;
        }

        public AppBackupService Service { get; }

        public string Root { get; }

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
                root,
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
