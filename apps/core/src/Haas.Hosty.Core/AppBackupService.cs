using System.IO.Compression;
using System.Security.Cryptography;

namespace Haas.Hosty.Core;

internal sealed class AppBackupService(CoreDataPaths paths, IClock clock)
{
    private const int PreUpdateRetentionCount = 5;

    public async Task<AppBackupRecord?> CreateBackupAsync(
        string appId,
        string reason,
        CancellationToken cancellationToken = default)
    {
        var dataPath = GetAppDataPath(appId);
        if (!Directory.Exists(dataPath))
        {
            return null;
        }

        var backupRoot = GetBackupRoot(appId);
        Directory.CreateDirectory(backupRoot);
        var backupId = $"{clock.UtcNow:yyyyMMddHHmmssfff}_{reason}";
        var archivePath = Path.Combine(backupRoot, $"{backupId}.zip");
        var metadataPath = Path.Combine(backupRoot, $"{backupId}.json");

        ZipFile.CreateFromDirectory(dataPath, archivePath, CompressionLevel.Optimal, includeBaseDirectory: false);
        var archiveBytes = await File.ReadAllBytesAsync(archivePath, cancellationToken);
        var record = new AppBackupRecord(
            AppId: appId,
            BackupId: backupId,
            Reason: reason,
            CreatedAt: clock.UtcNow,
            DataPath: dataPath,
            ArchivePath: archivePath,
            ArchiveSha256: Convert.ToHexString(SHA256.HashData(archiveBytes)).ToLowerInvariant(),
            ArchiveSize: archiveBytes.Length,
            FileCount: Directory.EnumerateFiles(dataPath, "*", SearchOption.AllDirectories).Count());
        await JsonStorage.WriteAsync(metadataPath, record, cancellationToken);

        if (string.Equals(reason, "pre-update", StringComparison.Ordinal))
        {
            await ApplyPreUpdateRetentionAsync(appId, cancellationToken);
        }

        return record;
    }

    public async Task<IReadOnlyList<AppBackupRecord>> ListBackupsAsync(string appId, CancellationToken cancellationToken = default)
    {
        var backupRoot = GetBackupRoot(appId);
        if (!Directory.Exists(backupRoot))
        {
            return [];
        }

        var records = new List<AppBackupRecord>();
        foreach (var metadataPath in Directory.EnumerateFiles(backupRoot, "*.json").Order(StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var record = await JsonStorage.ReadAsync<AppBackupRecord>(metadataPath, cancellationToken);
            if (record is not null)
            {
                records.Add(record);
            }
        }

        return records.OrderByDescending(record => record.CreatedAt).ToArray();
    }

    public async Task<bool> DeleteBackupAsync(string appId, string backupId, CancellationToken cancellationToken = default)
    {
        var record = (await ListBackupsAsync(appId, cancellationToken))
            .FirstOrDefault(candidate => string.Equals(candidate.BackupId, backupId, StringComparison.Ordinal));
        if (record is null)
        {
            return false;
        }

        TryDelete(record.ArchivePath);
        TryDelete(Path.Combine(GetBackupRoot(appId), $"{backupId}.json"));
        return true;
    }

    public Task DeleteAllBackupsAsync(string appId, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var backupRoot = GetBackupRoot(appId);
        if (Directory.Exists(backupRoot))
        {
            Directory.Delete(backupRoot, recursive: true);
        }

        return Task.CompletedTask;
    }

    public async Task<AppBackupRecord?> RestoreBackupAsync(
        string appId,
        string backupId,
        bool createPreRestoreBackup,
        CancellationToken cancellationToken = default)
    {
        var record = (await ListBackupsAsync(appId, cancellationToken))
            .FirstOrDefault(candidate => string.Equals(candidate.BackupId, backupId, StringComparison.Ordinal));
        if (record is null || !File.Exists(record.ArchivePath))
        {
            return null;
        }

        if (createPreRestoreBackup)
        {
            _ = await CreateBackupAsync(appId, "pre-restore", cancellationToken);
        }

        var dataPath = GetAppDataPath(appId);
        if (Directory.Exists(dataPath))
        {
            Directory.Delete(dataPath, recursive: true);
        }

        Directory.CreateDirectory(dataPath);
        ZipFile.ExtractToDirectory(record.ArchivePath, dataPath, overwriteFiles: true);
        return record;
    }

    private async Task ApplyPreUpdateRetentionAsync(string appId, CancellationToken cancellationToken)
    {
        var preUpdateBackups = (await ListBackupsAsync(appId, cancellationToken))
            .Where(record => string.Equals(record.Reason, "pre-update", StringComparison.Ordinal))
            .OrderByDescending(record => record.CreatedAt)
            .Skip(PreUpdateRetentionCount)
            .ToArray();

        foreach (var backup in preUpdateBackups)
        {
            TryDelete(backup.ArchivePath);
            TryDelete(Path.Combine(GetBackupRoot(appId), $"{backup.BackupId}.json"));
        }
    }

    private string GetAppDataPath(string appId)
        => Path.Combine(paths.AppsRoot, appId, "data");

    private string GetBackupRoot(string appId)
        => Path.Combine(paths.BackupsRoot, appId);

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path))
            {
                File.Delete(path);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Best-effort cleanup; explicit delete can be retried by the operator.
        }
    }
}

internal sealed record AppBackupRecord(
    string AppId,
    string BackupId,
    string Reason,
    DateTimeOffset CreatedAt,
    string DataPath,
    string ArchivePath,
    string ArchiveSha256,
    long ArchiveSize,
    int FileCount);
