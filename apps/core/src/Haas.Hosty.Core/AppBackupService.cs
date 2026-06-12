using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

internal sealed class AppBackupService(CoreDataPaths paths, IClock clock)
{
    private const int AutomaticRetentionCount = 5;
    private const string ManualReason = "manual";
    private static readonly string[] AutomaticReasons = ["pre-update", "pre-restore", "pre-runtime-switch", "scheduled"];
    private static readonly AppBackupRetentionPolicy DefaultRetentionPolicy = new(
        Rules: AutomaticReasons.ToDictionary(
            reason => reason,
            _ => new AppBackupRetentionRule(KeepLast: AutomaticRetentionCount, MaxAgeDays: null),
            StringComparer.Ordinal),
        DeleteOnlyKnownBackup: false);

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
        var archiveInfo = new FileInfo(archivePath);
        var record = new AppBackupRecord(
            AppId: appId,
            BackupId: backupId,
            Reason: reason,
            CreatedAt: clock.UtcNow,
            DataPath: dataPath,
            ArchivePath: archivePath,
            ArchiveSha256: await ComputeSha256Async(archivePath, cancellationToken),
            ArchiveSize: archiveInfo.Length,
            FileCount: Directory.EnumerateFiles(dataPath, "*", SearchOption.AllDirectories).Count(),
            Retention: null);
        await JsonStorage.WriteAsync(metadataPath, record, cancellationToken);

        if (IsAutomaticReason(reason))
        {
            await ApplyAutomaticRetentionAsync(appId, cancellationToken);
        }

        return record;
    }

    public async Task<IReadOnlyList<AppBackupRecord>> ListBackupsAsync(string appId, CancellationToken cancellationToken = default)
    {
        var records = await ReadBackupRecordsAsync(appId, cancellationToken);
        var plan = await CreateCleanupPlanAsync(appId, cancellationToken);
        return records
            .Select(record => record with
            {
                Retention = BuildRetentionStatus(record, plan.Candidates),
            })
            .OrderByDescending(record => record.CreatedAt)
            .ToArray();
    }

    public async Task<bool> DeleteBackupAsync(string appId, string backupId, CancellationToken cancellationToken = default)
    {
        var record = (await ReadBackupRecordsAsync(appId, cancellationToken))
            .FirstOrDefault(candidate => string.Equals(candidate.BackupId, backupId, StringComparison.Ordinal));
        if (record is null)
        {
            return false;
        }

        var backupRoot = GetBackupRoot(appId);
        if (IsSafeBackupPath(record.ArchivePath, backupRoot, ".zip"))
        {
            TryDelete(record.ArchivePath);
        }

        var metadataPath = Path.Combine(backupRoot, $"{backupId}.json");
        if (IsSafeBackupPath(metadataPath, backupRoot, ".json"))
        {
            TryDelete(metadataPath);
        }

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

        var currentSha256 = await ComputeSha256Async(record.ArchivePath, cancellationToken);
        if (!string.Equals(currentSha256, record.ArchiveSha256, StringComparison.OrdinalIgnoreCase))
        {
            throw new AppLifecycleException(
                "backup_archive_corrupt",
                $"Backup archive for '{backupId}' does not match its recorded SHA-256 checksum; restore was aborted before touching app data.");
        }

        if (createPreRestoreBackup)
        {
            _ = await CreateBackupAsync(appId, "pre-restore", cancellationToken);
        }

        var dataPath = GetAppDataPath(appId);
        Directory.CreateDirectory(Path.GetDirectoryName(dataPath)!);
        var stagingPath = $"{dataPath}.restore-{Guid.NewGuid():N}.tmp";
        var replacedPath = $"{dataPath}.replaced-{Guid.NewGuid():N}.tmp";
        try
        {
            Directory.CreateDirectory(stagingPath);
            ZipFile.ExtractToDirectory(record.ArchivePath, stagingPath, overwriteFiles: true);

            if (Directory.Exists(dataPath))
            {
                Directory.Move(dataPath, replacedPath);
            }

            try
            {
                Directory.Move(stagingPath, dataPath);
            }
            catch
            {
                if (!Directory.Exists(dataPath) && Directory.Exists(replacedPath))
                {
                    Directory.Move(replacedPath, dataPath);
                }

                throw;
            }
        }
        finally
        {
            TryDeleteDirectory(stagingPath);
        }

        TryDeleteDirectory(replacedPath);
        return record;
    }

    public static bool IsAutomaticReason(string reason)
        => AutomaticReasons.Contains(reason, StringComparer.Ordinal);

    public async Task<AppBackupCleanupPlan> CreateCleanupPlanAsync(
        string? appId = null,
        CancellationToken cancellationToken = default)
    {
        var appIds = appId is null
            ? EnumerateBackupAppIds()
            : [appId];
        var candidates = new List<AppBackupCleanupCandidate>();

        foreach (var currentAppId in appIds.Order(StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            candidates.AddRange(await CreateCleanupCandidatesForAppAsync(currentAppId, cancellationToken));
        }

        var orderedCandidates = candidates
            .OrderBy(candidate => candidate.AppId, StringComparer.Ordinal)
            .ThenBy(candidate => candidate.BackupId, StringComparer.Ordinal)
            .ThenBy(candidate => candidate.CleanupReason, StringComparer.Ordinal)
            .ToArray();
        var digest = CreatePlanDigest(orderedCandidates);
        return new AppBackupCleanupPlan(
            AppId: appId,
            PlanDigest: digest,
            CreatedAt: clock.UtcNow,
            Policy: DefaultRetentionPolicy,
            Candidates: orderedCandidates);
    }

    public async Task<AppBackupCleanupApplyResponse> ApplyCleanupAsync(
        string? appId,
        AppBackupCleanupApplyRequest request,
        CancellationToken cancellationToken = default)
    {
        var plan = await CreateCleanupPlanAsync(appId, cancellationToken);
        if (!string.Equals(plan.PlanDigest, request.PlanDigest, StringComparison.Ordinal))
        {
            throw new AppLifecycleException(
                "backup_cleanup_plan_digest_mismatch",
                "Backup cleanup plan digest does not match the current cleanup plan.");
        }

        return await ApplyCleanupPlanAsync(plan, automaticOnly: false, cancellationToken);
    }

    public async Task<AppBackupCleanupApplyResponse> ApplyScheduledCleanupAsync(CancellationToken cancellationToken = default)
    {
        var plan = await CreateCleanupPlanAsync(appId: null, cancellationToken);
        return await ApplyCleanupPlanAsync(plan, automaticOnly: true, cancellationToken);
    }

    private async Task ApplyAutomaticRetentionAsync(string appId, CancellationToken cancellationToken)
    {
        var plan = await CreateCleanupPlanAsync(appId, cancellationToken);
        _ = await ApplyCleanupPlanAsync(plan, automaticOnly: true, cancellationToken);
    }

    private async Task<AppBackupCleanupApplyResponse> ApplyCleanupPlanAsync(
        AppBackupCleanupPlan plan,
        bool automaticOnly,
        CancellationToken cancellationToken)
    {
        var deleted = new List<AppBackupCleanupCandidate>();
        var skipped = new List<AppBackupCleanupCandidate>();
        var candidates = automaticOnly
            ? plan.Candidates.Where(candidate => candidate.Automatic)
            : plan.Candidates;

        foreach (var candidate in candidates)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (await TryDeleteCleanupCandidateAsync(candidate, cancellationToken))
            {
                deleted.Add(candidate);
            }
            else
            {
                skipped.Add(candidate);
            }
        }

        return new AppBackupCleanupApplyResponse(plan.PlanDigest, deleted, skipped);
    }

    private async Task<IReadOnlyList<AppBackupRecord>> ReadBackupRecordsAsync(string appId, CancellationToken cancellationToken)
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
                records.Add(record with { Retention = null });
            }
        }

        return records;
    }

    private async Task<IReadOnlyList<AppBackupCleanupCandidate>> CreateCleanupCandidatesForAppAsync(
        string appId,
        CancellationToken cancellationToken)
    {
        var backupRoot = GetBackupRoot(appId);
        if (!Directory.Exists(backupRoot))
        {
            return [];
        }

        var candidates = new Dictionary<string, AppBackupCleanupCandidate>(StringComparer.Ordinal);
        var records = await ReadBackupRecordsAsync(appId, cancellationToken);
        var recordsById = records.ToDictionary(record => record.BackupId, StringComparer.Ordinal);
        var backupIds = new HashSet<string>(recordsById.Keys, StringComparer.Ordinal);

        foreach (var archivePath in Directory.EnumerateFiles(backupRoot, "*.zip").Order(StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            var backupId = Path.GetFileNameWithoutExtension(archivePath);
            backupIds.Add(backupId);
            if (!recordsById.ContainsKey(backupId))
            {
                var orphan = await CreateArchiveOnlyCandidateAsync(appId, backupId, archivePath, cancellationToken);
                AddCandidate(candidates, orphan);
            }
        }

        foreach (var record in records)
        {
            var metadataPath = Path.Combine(backupRoot, $"{record.BackupId}.json");
            if (!File.Exists(record.ArchivePath))
            {
                AddCandidate(candidates, CreateCandidate(
                    record,
                    metadataPath,
                    cleanupReason: "missing-archive",
                    automatic: true));
            }
        }

        foreach (var ruleEntry in DefaultRetentionPolicy.Rules)
        {
            var eligibleRecords = records
                .Where(record =>
                    string.Equals(record.Reason, ruleEntry.Key, StringComparison.Ordinal) &&
                    File.Exists(record.ArchivePath))
                .OrderByDescending(record => record.CreatedAt)
                .ThenByDescending(record => record.BackupId, StringComparer.Ordinal)
                .ToArray();

            if (ruleEntry.Value.KeepLast is int keepLast)
            {
                foreach (var record in eligibleRecords.Skip(keepLast))
                {
                    AddCandidate(candidates, CreateCandidate(
                        record,
                        Path.Combine(backupRoot, $"{record.BackupId}.json"),
                        cleanupReason: $"retention-keep-last-{keepLast}",
                        automatic: true));
                }
            }

            if (ruleEntry.Value.MaxAgeDays is int maxAgeDays)
            {
                var cutoff = clock.UtcNow.AddDays(-maxAgeDays);
                foreach (var record in eligibleRecords.Where(record => record.CreatedAt < cutoff))
                {
                    AddCandidate(candidates, CreateCandidate(
                        record,
                        Path.Combine(backupRoot, $"{record.BackupId}.json"),
                        cleanupReason: $"retention-max-age-{maxAgeDays}-days",
                        automatic: true));
                }
            }
        }

        if (!DefaultRetentionPolicy.DeleteOnlyKnownBackup && backupIds.Count <= 1)
        {
            foreach (var protectedKey in candidates
                .Where(candidate => candidate.Value.CleanupReason != "missing-archive")
                .Select(candidate => candidate.Key)
                .ToArray())
            {
                candidates.Remove(protectedKey);
            }
        }

        return candidates.Values.ToArray();
    }

    private async Task<AppBackupCleanupCandidate> CreateArchiveOnlyCandidateAsync(
        string appId,
        string backupId,
        string archivePath,
        CancellationToken cancellationToken)
    {
        var fileInfo = new FileInfo(archivePath);
        return new AppBackupCleanupCandidate(
            AppId: appId,
            BackupId: backupId,
            Reason: "unknown",
            CleanupReason: "missing-metadata",
            CreatedAt: fileInfo.Exists ? fileInfo.LastWriteTimeUtc : clock.UtcNow,
            ArchivePath: archivePath,
            MetadataPath: Path.Combine(GetBackupRoot(appId), $"{backupId}.json"),
            ArchiveSha256: fileInfo.Exists ? await ComputeSha256Async(archivePath, cancellationToken) : null,
            ArchiveSize: fileInfo.Exists ? fileInfo.Length : null,
            Automatic: false);
    }

    private static AppBackupCleanupCandidate CreateCandidate(
        AppBackupRecord record,
        string metadataPath,
        string cleanupReason,
        bool automatic)
        => new(
            AppId: record.AppId,
            BackupId: record.BackupId,
            Reason: record.Reason,
            CleanupReason: cleanupReason,
            CreatedAt: record.CreatedAt,
            ArchivePath: record.ArchivePath,
            MetadataPath: metadataPath,
            ArchiveSha256: record.ArchiveSha256,
            ArchiveSize: record.ArchiveSize,
            Automatic: automatic);

    private static void AddCandidate(
        Dictionary<string, AppBackupCleanupCandidate> candidates,
        AppBackupCleanupCandidate candidate)
        => candidates.TryAdd($"{candidate.AppId}\0{candidate.BackupId}", candidate);

    private AppBackupRetentionStatus BuildRetentionStatus(
        AppBackupRecord record,
        IReadOnlyList<AppBackupCleanupCandidate> candidates)
    {
        var candidate = candidates.FirstOrDefault(candidate =>
            string.Equals(candidate.AppId, record.AppId, StringComparison.Ordinal) &&
            string.Equals(candidate.BackupId, record.BackupId, StringComparison.Ordinal));
        if (candidate is not null)
        {
            return new AppBackupRetentionStatus(
                Eligible: true,
                Reason: candidate.CleanupReason,
                WouldDeleteInCurrentPlan: true);
        }

        if (string.Equals(record.Reason, ManualReason, StringComparison.Ordinal))
        {
            return new AppBackupRetentionStatus(
                Eligible: false,
                Reason: "manual-kept",
                WouldDeleteInCurrentPlan: false);
        }

        if (DefaultRetentionPolicy.Rules.ContainsKey(record.Reason))
        {
            return new AppBackupRetentionStatus(
                Eligible: true,
                Reason: "retained-by-policy",
                WouldDeleteInCurrentPlan: false);
        }

        return new AppBackupRetentionStatus(
            Eligible: false,
            Reason: "reason-not-managed",
            WouldDeleteInCurrentPlan: false);
    }

    private async Task<bool> TryDeleteCleanupCandidateAsync(
        AppBackupCleanupCandidate candidate,
        CancellationToken cancellationToken)
    {
        var backupRoot = GetBackupRoot(candidate.AppId);
        if (candidate.ArchivePath is not null &&
            !IsSafeBackupPath(candidate.ArchivePath, backupRoot, ".zip"))
        {
            return false;
        }

        if (candidate.MetadataPath is not null &&
            !IsSafeBackupPath(candidate.MetadataPath, backupRoot, ".json"))
        {
            return false;
        }

        var archiveDeleted = false;
        if (candidate.ArchivePath is not null && File.Exists(candidate.ArchivePath))
        {
            if (candidate.ArchiveSha256 is not null)
            {
                var currentSha256 = await ComputeSha256Async(candidate.ArchivePath, cancellationToken);
                if (!string.Equals(currentSha256, candidate.ArchiveSha256, StringComparison.OrdinalIgnoreCase))
                {
                    return false;
                }
            }

            if (!TryDeleteExisting(candidate.ArchivePath))
            {
                return false;
            }

            archiveDeleted = true;
        }

        var metadataDeleted = candidate.MetadataPath is not null && TryDeleteExisting(candidate.MetadataPath);
        return archiveDeleted || metadataDeleted;
    }

    private IEnumerable<string> EnumerateBackupAppIds()
    {
        if (!Directory.Exists(paths.BackupsRoot))
        {
            return [];
        }

        return Directory
            .EnumerateDirectories(paths.BackupsRoot)
            .Select(Path.GetFileName)
            .OfType<string>();
    }

    private static string CreatePlanDigest(IReadOnlyList<AppBackupCleanupCandidate> candidates)
    {
        var payload = new
        {
            Policy = DefaultRetentionPolicy,
            Candidates = candidates.Select(candidate => new
            {
                candidate.AppId,
                candidate.BackupId,
                candidate.Reason,
                candidate.CleanupReason,
                candidate.ArchivePath,
                candidate.MetadataPath,
                candidate.ArchiveSha256,
                candidate.ArchiveSize,
                candidate.Automatic,
            }),
        };
        var json = System.Text.Json.JsonSerializer.Serialize(payload, JsonStorage.Options);
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(json))).ToLowerInvariant();
    }

    private static async Task<string> ComputeSha256Async(string path, CancellationToken cancellationToken)
    {
        await using var stream = File.OpenRead(path);
        return Convert.ToHexString(await SHA256.HashDataAsync(stream, cancellationToken)).ToLowerInvariant();
    }

    private string GetAppDataPath(string appId)
        => Path.Combine(CoreDataPaths.ResolveContainedPath(paths.AppsRoot, appId), "data");

    private string GetBackupRoot(string appId)
        => CoreDataPaths.ResolveContainedPath(paths.BackupsRoot, appId);

    private static bool IsSafeBackupPath(string path, string backupRoot, string extension)
    {
        var fullPath = Path.GetFullPath(path);
        var fullRoot = EnsureTrailingSeparator(Path.GetFullPath(backupRoot));
        var comparison = OperatingSystem.IsWindows()
            ? StringComparison.OrdinalIgnoreCase
            : StringComparison.Ordinal;
        return fullPath.StartsWith(fullRoot, comparison) &&
            string.Equals(Path.GetExtension(fullPath), extension, StringComparison.OrdinalIgnoreCase);
    }

    private static string EnsureTrailingSeparator(string path)
        => path.EndsWith(Path.DirectorySeparatorChar) || path.EndsWith(Path.AltDirectorySeparatorChar)
            ? path
            : path + Path.DirectorySeparatorChar;

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

    private static void TryDeleteDirectory(string path)
    {
        try
        {
            if (Directory.Exists(path))
            {
                Directory.Delete(path, recursive: true);
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Best-effort cleanup; explicit delete can be retried by the operator.
        }
    }

    private static bool TryDeleteExisting(string path)
    {
        try
        {
            if (!File.Exists(path))
            {
                return false;
            }

            File.Delete(path);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return false;
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
    int FileCount,
    AppBackupRetentionStatus? Retention = null);

internal sealed record AppBackupRetentionStatus(
    bool Eligible,
    string Reason,
    bool WouldDeleteInCurrentPlan);

internal sealed record AppBackupRetentionPolicy(
    IReadOnlyDictionary<string, AppBackupRetentionRule> Rules,
    bool DeleteOnlyKnownBackup);

internal sealed record AppBackupRetentionRule(
    int? KeepLast,
    int? MaxAgeDays);

internal sealed record AppBackupCleanupPlan(
    string? AppId,
    string PlanDigest,
    DateTimeOffset CreatedAt,
    AppBackupRetentionPolicy Policy,
    IReadOnlyList<AppBackupCleanupCandidate> Candidates);

internal sealed record AppBackupCleanupCandidate(
    string AppId,
    string BackupId,
    string Reason,
    string CleanupReason,
    DateTimeOffset CreatedAt,
    string? ArchivePath,
    string? MetadataPath,
    string? ArchiveSha256,
    long? ArchiveSize,
    bool Automatic);

internal sealed record AppBackupCleanupApplyRequest(string PlanDigest);

internal sealed record AppBackupCleanupApplyResponse(
    string PlanDigest,
    IReadOnlyList<AppBackupCleanupCandidate> Deleted,
    IReadOnlyList<AppBackupCleanupCandidate> Skipped);
