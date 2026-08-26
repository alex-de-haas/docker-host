using System.Text;
using System.Text.Json;

namespace Haas.Hosty.Core;

internal sealed class AuditStore(CoreDataPaths paths)
{
    public async Task AppendAsync(AuditRecord record, CancellationToken cancellationToken = default)
    {
        var directory = Path.GetDirectoryName(paths.AuditLogPath);
        if (!string.IsNullOrWhiteSpace(directory))
        {
            SecureFileSystem.EnsurePrivateDirectory(directory);
        }

        // Audit lines carry actor identities, so the log is owner-only. Readers share the file
        // (ReadRecentAsync opens it while writes continue), hence FileShare.Read.
        var line = JsonSerializer.Serialize(record, CoreJsonSerializerContext.Default.AuditRecord);
        var payload = Encoding.UTF8.GetBytes($"{line}{Environment.NewLine}");
        await using var stream = SecureFileSystem.CreatePrivateFile(paths.AuditLogPath, FileMode.Append, FileShare.Read);
        await stream.WriteAsync(payload, cancellationToken);
    }

    /// <summary>
    /// Recent entries narrowed to one question, newest first.
    /// </summary>
    /// <remarks>
    /// Scans backwards from the end and stops once the window is left behind, rather than reading the
    /// whole log and filtering. Nothing trims this file, so it only grows: a read that costs the whole
    /// history is one that gets slower for the life of the host, and this is the first caller expected
    /// to run often enough for that to matter.
    /// <para>
    /// <paramref name="scanCeiling"/> bounds the work even when nothing matches — a filter that finds
    /// three entries in a million-line file must not read the million.
    /// </para>
    /// </remarks>
    public async Task<AuditSearchResult> SearchAsync(
        AuditQuery query,
        DateTimeOffset now,
        int scanCeiling = 20_000,
        CancellationToken cancellationToken = default)
    {
        var limit = Math.Clamp(query.Limit, 1, 200);
        var rangeSeconds = Math.Clamp(query.RangeSeconds, 60, 30 * 24 * 60 * 60);
        var since = now.AddSeconds(-rangeSeconds);

        var matches = new List<AuditRecord>();
        var scanned = 0;
        var reachedWindowStart = false;

        if (File.Exists(paths.AuditLogPath))
        {
            var lines = await File.ReadAllLinesAsync(paths.AuditLogPath, cancellationToken);
            for (var index = lines.Length - 1; index >= 0 && scanned < scanCeiling; index -= 1)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var line = lines[index];
                if (string.IsNullOrWhiteSpace(line))
                {
                    continue;
                }

                scanned += 1;
                if (JsonSerializer.Deserialize(line, CoreJsonSerializerContext.Default.AuditRecord) is not { } record)
                {
                    continue;
                }

                // The log is append-ordered, so the first entry older than the window means every
                // entry before it is too.
                if (record.CreatedAt < since)
                {
                    reachedWindowStart = true;
                    break;
                }

                if (!Matches(record, query))
                {
                    continue;
                }

                matches.Add(record);
                if (matches.Count >= limit)
                {
                    break;
                }
            }
        }

        return new AuditSearchResult(
            matches,
            new AuditWindow(
                rangeSeconds,
                rangeSeconds != query.RangeSeconds,
                limit,
                limit != query.Limit,
                matches.Count,
                // "There may be more", never a count: the scan stopped early, and saying how many were
                // missed would be a number this read did not earn. Reported when the limit filled or the
                // ceiling was hit without reaching the window's start — both mean the answer is partial.
                matches.Count >= limit || (!reachedWindowStart && scanned >= scanCeiling)));
    }

    private static bool Matches(AuditRecord record, AuditQuery query)
    {
        if (!string.IsNullOrWhiteSpace(query.ResourceId) &&
            !string.Equals(record.ResourceId, query.ResourceId, StringComparison.Ordinal))
        {
            return false;
        }

        if (!string.IsNullOrWhiteSpace(query.ActionPrefix) &&
            !record.Action.StartsWith(query.ActionPrefix, StringComparison.Ordinal))
        {
            return false;
        }

        return string.IsNullOrWhiteSpace(query.Outcome) ||
            string.Equals(record.Outcome, query.Outcome, StringComparison.OrdinalIgnoreCase);
    }

    public async Task<IReadOnlyList<AuditRecord>> ReadRecentAsync(int limit = 100, CancellationToken cancellationToken = default)
    {
        if (!File.Exists(paths.AuditLogPath))
        {
            return [];
        }

        var lines = await File.ReadAllLinesAsync(paths.AuditLogPath, cancellationToken);
        return lines
            .Where(line => !string.IsNullOrWhiteSpace(line))
            .Reverse()
            .Take(Math.Clamp(limit, 1, 500))
            .Select(line => JsonSerializer.Deserialize(line, CoreJsonSerializerContext.Default.AuditRecord))
            .OfType<AuditRecord>()
            .ToArray();
    }
}

/// <summary>One question asked of the audit log.</summary>
internal sealed record AuditQuery(
    string? ResourceId = null,
    string? ActionPrefix = null,
    string? Outcome = null,
    int RangeSeconds = 24 * 60 * 60,
    int Limit = 50);

/// <summary>
/// What the read found, and what it was allowed to look at.
/// </summary>
/// <remarks>
/// The window travels with every result because a caller that cannot see a clamp reports "nothing
/// happened" when it means "nothing in the newest fifty" — a false statement about the host rather
/// than a report about the query.
/// </remarks>
internal sealed record AuditSearchResult(IReadOnlyList<AuditRecord> Entries, AuditWindow Window);

internal sealed record AuditWindow(
    int RangeSeconds,
    bool RangeClamped,
    int Limit,
    bool LimitClamped,
    int Returned,
    bool Truncated);

internal sealed record AuditRecord(
    string Id,
    string Action,
    string ResourceType,
    string? ResourceId,
    string Outcome,
    string? ActorUserId,
    DateTimeOffset CreatedAt,
    IReadOnlyDictionary<string, string> Details);
