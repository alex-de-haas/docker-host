using System.Collections.Concurrent;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging;

namespace Haas.Hosty.Core;

internal sealed class AppBackupService(CoreDataPaths paths, IClock clock, ILogger<AppBackupService>? logger = null)
{
    private const int AutomaticRetentionCount = 5;
    private const string ManualReason = "manual";

    // Reason recorded for backups an app triggers through its service token (e.g. before
    // applying its own migrations). Unlike "manual", these are kept-last-N retention-managed:
    // an app may request one on every startup, so retaining them forever would leak storage.
    public const string AppInitiatedReason = "app-initiated";
    private static readonly string[] AutomaticReasons = ["pre-update", "pre-restore", "pre-runtime-switch", "pre-development-mode", "scheduled"];
    private static readonly string[] RetentionManagedReasons = [.. AutomaticReasons, AppInitiatedReason];
    private static readonly AppBackupRetentionPolicy DefaultRetentionPolicy = new(
        Rules: RetentionManagedReasons.ToDictionary(
            reason => reason,
            _ => new AppBackupRetentionRule(KeepLast: AutomaticRetentionCount, MaxAgeDays: null),
            StringComparer.Ordinal),
        DeleteOnlyKnownBackup: false);

    // An orphaned archive — a .zip whose .json metadata is gone — is hashed so the apply path can
    // prove the file did not change between the plan that listed it and the delete that removes it.
    // That hash is the only expensive thing in a cleanup plan, and the plan is rebuilt on every
    // backups-list request, after every retention-managed backup, and every 6 hours by the scheduler —
    // while an orphan is never deleted automatically (Automatic: false), so the same archive stayed
    // there being re-read in full, indefinitely. Keyed by the file's identity rather than its path
    // alone: an archive that changed is re-hashed, so the guard keeps its meaning exactly.
    private readonly ConcurrentDictionary<string, (FileStamp Stamp, string Sha256)> orphanArchiveDigests = new(StringComparer.Ordinal);

    public async Task<AppBackupRecord?> CreateBackupAsync(
        string appId,
        string reason,
        string? note = null,
        CancellationToken cancellationToken = default)
    {
        var dataPath = GetAppDataPath(appId);
        if (!Directory.Exists(dataPath))
        {
            return null;
        }

        // A backup archive is a complete copy of the app's data, so the whole tree is owner-only:
        // the directory (nothing bind-mounts it) and every archive and metadata file inside it.
        var backupRoot = GetBackupRoot(appId);
        SecureFileSystem.EnsurePrivateDirectory(backupRoot);
        // A short random suffix keeps the id unique even when two backups are requested in the
        // same millisecond (more likely now that apps can trigger backups programmatically),
        // so the CreateNew-based archive creation below never collides.
        var backupId = $"{clock.UtcNow:yyyyMMddHHmmssfff}_{reason}_{Convert.ToHexString(RandomNumberGenerator.GetBytes(4)).ToLowerInvariant()}";
        var archivePath = Path.Combine(backupRoot, $"{backupId}.zip");
        var metadataPath = Path.Combine(backupRoot, $"{backupId}.json");

        // Synchronous writer, so the stream is opened synchronously too.
        using (var archiveStream = SecureFileSystem.CreatePrivateFile(archivePath, FileMode.CreateNew, FileShare.None, FileOptions.None))
        {
            ZipFile.CreateFromDirectory(dataPath, archiveStream, CompressionLevel.Optimal, includeBaseDirectory: false);
        }

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
            Note: note,
            Retention: null);
        await JsonStorage.WriteAsync(metadataPath, record, restrictToOwner: true, cancellationToken);

        if (IsRetentionManagedReason(reason))
        {
            await ApplyAutomaticRetentionAsync(appId, cancellationToken);
        }

        return record;
    }

    public async Task<IReadOnlyList<AppBackupRecord>> ListBackupsAsync(string appId, CancellationToken cancellationToken = default)
    {
        // The records are handed to the plan builder rather than letting it re-read them: every
        // metadata file in the app's backup folder was otherwise opened and deserialized twice per
        // request, once here and once inside the plan.
        var records = await ReadBackupRecordsAsync(appId, cancellationToken);
        var plan = await CreateCleanupPlanCoreAsync(appId, records, cancellationToken);
        // One lookup keyed by app + backup id, so annotating N records costs N rather than N × plan
        // candidates.
        var candidatesByBackup = plan.Candidates.ToDictionary(
            candidate => $"{candidate.AppId}\0{candidate.BackupId}",
            StringComparer.Ordinal);
        return records
            .Select(record => record with
            {
                Retention = BuildRetentionStatus(record, candidatesByBackup),
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
        // The archive path comes out of an operator-editable metadata file, so it is not trusted to
        // point anywhere in particular: a hand-written record could otherwise make Core hash and
        // extract an arbitrary host file into the app's data directory. Deletion already enforces the
        // same containment rule; restore is the read side of it.
        if (record is null ||
            !IsSafeBackupPath(record.ArchivePath, GetBackupRoot(appId), ".zip") ||
            !File.Exists(record.ArchivePath))
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
            _ = await CreateBackupAsync(appId, "pre-restore", cancellationToken: cancellationToken);
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

    // Reasons the operator/app may not pass explicitly: Core owns these lifecycle reasons
    // and the app-initiated reason has retention semantics callers must not impersonate.
    public static bool IsReservedReason(string reason)
        => IsAutomaticReason(reason) || string.Equals(reason, AppInitiatedReason, StringComparison.Ordinal);

    private static bool IsRetentionManagedReason(string reason)
        => DefaultRetentionPolicy.Rules.ContainsKey(reason);

    public Task<AppBackupCleanupPlan> CreateCleanupPlanAsync(
        string? appId = null,
        CancellationToken cancellationToken = default)
        => CreateCleanupPlanCoreAsync(appId, knownRecords: null, cancellationToken);

    // `knownRecords` lets a caller that has already read one app's metadata hand it over instead of
    // paying for the parse twice; it applies only to a single-app plan, since that is the only shape
    // in which the caller can know it holds the complete set.
    private async Task<AppBackupCleanupPlan> CreateCleanupPlanCoreAsync(
        string? appId,
        IReadOnlyList<AppBackupRecord>? knownRecords,
        CancellationToken cancellationToken)
    {
        var appIds = appId is null
            ? EnumerateBackupAppIds()
            : [appId];
        var candidates = new List<AppBackupCleanupCandidate>();

        foreach (var currentAppId in appIds.Order(StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();
            candidates.AddRange(await CreateCleanupCandidatesForAppAsync(
                currentAppId,
                appId is null ? null : knownRecords,
                cancellationToken));
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

    // The backup root is operator-visible on disk, so a metadata file can be hand-edited, truncated by
    // a crash, or copied under a new name. Every unusable file is skipped with a warning rather than
    // faulting the read: one bad file must not break a listing, and the retention sweep runs from a
    // BackgroundService where an escaping exception takes the whole host down.
    //
    // Callers may assume every returned record has a non-empty BackupId/Reason, an AppId equal to the
    // requested one, and a BackupId unique within the result — those are dictionary keys, path segments
    // and policy lookups downstream, where a null throws far away from the file that caused it.
    //
    // ArchivePath is deliberately *not* validated here: a record pointing nowhere is still worth
    // returning so the sweep can collect it as a missing-archive candidate, and an operator who moves
    // HOSTY_DATA_ROOT leaves every stored path stale without their backups deserving to vanish from the
    // listing. Every path that reads, extracts or deletes an archive runs IsSafeBackupPath first.
    private async Task<IReadOnlyList<AppBackupRecord>> ReadBackupRecordsAsync(string appId, CancellationToken cancellationToken)
    {
        var backupRoot = GetBackupRoot(appId);
        if (!Directory.Exists(backupRoot))
        {
            return [];
        }

        var records = new List<AppBackupRecord>();
        var claimedBackupIds = new HashSet<string>(StringComparer.Ordinal);
        foreach (var metadataPath in Directory.EnumerateFiles(backupRoot, "*.json").Order(StringComparer.Ordinal))
        {
            cancellationToken.ThrowIfCancellationRequested();

            AppBackupRecord? record;
            try
            {
                record = await JsonStorage.ReadAsync<AppBackupRecord>(metadataPath, cancellationToken);
            }
            catch (Exception ex) when (ex is System.Text.Json.JsonException or IOException or UnauthorizedAccessException)
            {
                logger?.LogWarning(ex, "Skipping unreadable Hosty backup metadata file {MetadataPath}.", metadataPath);
                continue;
            }

            if (record is null)
            {
                continue;
            }

            if (string.IsNullOrWhiteSpace(record.AppId) ||
                string.IsNullOrWhiteSpace(record.BackupId) ||
                string.IsNullOrWhiteSpace(record.Reason))
            {
                logger?.LogWarning(
                    "Skipping Hosty backup metadata file {MetadataPath}: appId, backupId or reason is missing.",
                    metadataPath);
                continue;
            }

            // The directory owns the identity, not the file's contents. A record claiming a different
            // app would otherwise produce a cleanup candidate that resolves against *that* app's backup
            // root, letting one app's stray metadata file delete another app's archives.
            if (!string.Equals(record.AppId, appId, StringComparison.Ordinal))
            {
                logger?.LogWarning(
                    "Skipping Hosty backup metadata file {MetadataPath}: it claims app {ClaimedAppId} but sits in the backup directory of {AppId}.",
                    metadataPath,
                    record.AppId,
                    appId);
                continue;
            }

            // Ordinal enumeration makes "first file wins" deterministic across runs.
            if (!claimedBackupIds.Add(record.BackupId))
            {
                logger?.LogWarning(
                    "Skipping Hosty backup metadata file {MetadataPath}: backup id {BackupId} is already claimed by an earlier file.",
                    metadataPath,
                    record.BackupId);
                continue;
            }

            records.Add(record with { Retention = null });
        }

        return records;
    }

    private async Task<IReadOnlyList<AppBackupCleanupCandidate>> CreateCleanupCandidatesForAppAsync(
        string appId,
        IReadOnlyList<AppBackupRecord>? knownRecords,
        CancellationToken cancellationToken)
    {
        var backupRoot = GetBackupRoot(appId);
        if (!Directory.Exists(backupRoot))
        {
            return [];
        }

        var candidates = new Dictionary<string, AppBackupCleanupCandidate>(StringComparer.Ordinal);
        var records = knownRecords ?? await ReadBackupRecordsAsync(appId, cancellationToken);
        // Safe to key on: ReadBackupRecordsAsync drops records with a missing or duplicate BackupId.
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
            ArchiveSha256: fileInfo.Exists ? await ResolveOrphanArchiveDigestAsync(archivePath, cancellationToken) : null,
            ArchiveSize: fileInfo.Exists ? fileInfo.Length : null,
            Automatic: false);
    }

    private async Task<string> ResolveOrphanArchiveDigestAsync(string archivePath, CancellationToken cancellationToken)
    {
        // Read the stamp before the bytes: a rewrite racing this read is then caught by the NEXT
        // plan, rather than being cached under the stamp it had before the change.
        var stamp = FileStamp.Read(archivePath);
        if (orphanArchiveDigests.TryGetValue(archivePath, out var cached) && cached.Stamp == stamp)
        {
            return cached.Sha256;
        }

        var sha256 = await ComputeSha256Async(archivePath, cancellationToken);
        orphanArchiveDigests[archivePath] = (stamp, sha256);
        return sha256;
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
        IReadOnlyDictionary<string, AppBackupCleanupCandidate> candidatesByBackup)
    {
        if (candidatesByBackup.TryGetValue($"{record.AppId}\0{record.BackupId}", out var candidate))
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
        var payload = new AppBackupRetentionDigestPayload(
            DefaultRetentionPolicy,
            candidates.Select(candidate => new AppBackupRetentionDigestCandidate(
                candidate.AppId,
                candidate.BackupId,
                candidate.Reason,
                candidate.CleanupReason,
                candidate.ArchivePath,
                candidate.MetadataPath,
                candidate.ArchiveSha256,
                candidate.ArchiveSize,
                candidate.Automatic)).ToArray());
        var json = System.Text.Json.JsonSerializer.Serialize(payload, CoreJsonSerializerContext.Default.AppBackupRetentionDigestPayload);
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

    // Nullable path: a metadata file may omit archivePath entirely, and Path.GetFullPath(null) throws.
    // An absent path is never a safe path, so callers get "false" instead of an exception.
    private static bool IsSafeBackupPath(string? path, string backupRoot, string extension)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return false;
        }

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
    string? Note = null,
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

internal sealed record AppBackupRetentionDigestPayload(
    AppBackupRetentionPolicy Policy,
    IReadOnlyList<AppBackupRetentionDigestCandidate> Candidates);

internal sealed record AppBackupRetentionDigestCandidate(
    string AppId,
    string BackupId,
    string Reason,
    string CleanupReason,
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
