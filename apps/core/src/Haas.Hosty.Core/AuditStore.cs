using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;

namespace Haas.Hosty.Core;

internal sealed class AuditStore(CoreDataPaths paths)
{
    // The live log is capped and one previous generation is kept beside it, so the audit trail costs a
    // bounded amount of disk instead of growing for the life of the host. Every login attempt, every
    // credential issue/revoke, every delegated-token exchange — success AND refusal — and every named
    // MCP tool call appends a line here, so "it only grows" is not theoretical on an agent-driven host.
    // Two generations rather than one: rotation must not drop the recent past on the floor the moment
    // it fires, and reads span both files so a window is never truncated by a rotation that just ran.
    private const long MaxLiveLogBytes = 8 * 1024 * 1024;

    // Reads walk the file backwards a block at a time. 64 KiB holds a few hundred audit lines, so the
    // common "newest 50" read touches exactly one block however large the log has grown.
    private const int ReadBlockBytes = 64 * 1024;

    // Appends are serialized so a rotation cannot run underneath another append, which would write
    // into the file that was just moved aside. Audit traffic is auth events rather than a request
    // flood, so a gate around one small write costs nothing worth measuring.
    private readonly SemaphoreSlim appendGate = new(1, 1);

    private bool directoryEnsured;

    // The previous generation, kept beside the live log rather than in a subdirectory so the audit
    // directory's owner-only permissions cover it without a second rule.
    private string RotatedLogPath => paths.AuditLogPath + ".1";

    public async Task AppendAsync(AuditRecord record, CancellationToken cancellationToken = default)
    {
        var line = JsonSerializer.Serialize(record, CoreJsonSerializerContext.Default.AuditRecord);
        var payload = Encoding.UTF8.GetBytes($"{line}{Environment.NewLine}");

        await appendGate.WaitAsync(cancellationToken);
        try
        {
            EnsureDirectory();
            RotateIfOversized();

            // Audit lines carry actor identities, so the log is owner-only. Readers share the file
            // (the tail readers open it while writes continue), hence FileShare.Read.
            await using var stream = SecureFileSystem.CreatePrivateFile(paths.AuditLogPath, FileMode.Append, FileShare.Read);
            await stream.WriteAsync(payload, cancellationToken);
        }
        finally
        {
            appendGate.Release();
        }
    }

    // Once per process rather than once per append: the mkdir + chmod behind this rides on the
    // introspection path, which appends a line for every named MCP tool call.
    private void EnsureDirectory()
    {
        if (directoryEnsured)
        {
            return;
        }

        var directory = Path.GetDirectoryName(paths.AuditLogPath);
        if (!string.IsNullOrWhiteSpace(directory))
        {
            SecureFileSystem.EnsurePrivateDirectory(directory);
        }

        directoryEnsured = true;
    }

    // Rotation is a rename, so it costs the same whatever the file's size, and the rotated file keeps
    // the live log's owner-only mode by construction (same inode). A reader mid-walk is unaffected: it
    // opened the file with FileShare.Delete, so the handle it holds keeps reading the bytes that moved.
    private void RotateIfOversized()
    {
        var live = new FileInfo(paths.AuditLogPath);
        if (!live.Exists || live.Length < MaxLiveLogBytes)
        {
            return;
        }

        try
        {
            File.Move(paths.AuditLogPath, RotatedLogPath, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Losing a rotation costs disk; losing the append loses an audit record. Keep appending to
            // the oversized file and try again on the next one.
        }
    }

    /// <summary>
    /// Recent entries narrowed to one question, newest first.
    /// </summary>
    /// <remarks>
    /// Reads backwards from the end of the log and stops once the window is left behind, rather than
    /// reading the whole file and filtering — so the cost is set by the size of the answer, not by how
    /// long the host has been up.
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

        await foreach (var line in ReadLinesNewestFirstAsync(cancellationToken))
        {
            if (scanned >= scanCeiling)
            {
                break;
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
        var wanted = Math.Clamp(limit, 1, 500);
        var records = new List<AuditRecord>(wanted);
        await foreach (var line in ReadLinesNewestFirstAsync(cancellationToken))
        {
            if (JsonSerializer.Deserialize(line, CoreJsonSerializerContext.Default.AuditRecord) is { } record)
            {
                records.Add(record);
                if (records.Count >= wanted)
                {
                    break;
                }
            }
        }

        return records;
    }

    // The whole trail newest-first: the live log, then the generation it rotated away from. Callers
    // stop as soon as they have their answer, so the rotated file is only ever touched by a read that
    // asked for more history than the live log still holds.
    private async IAsyncEnumerable<string> ReadLinesNewestFirstAsync(
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        foreach (var path in (string[])[paths.AuditLogPath, RotatedLogPath])
        {
            await foreach (var line in ReadLinesBackwardAsync(path, cancellationToken))
            {
                yield return line;
            }
        }
    }

    // Yields a file's non-blank lines last-to-first without materializing it, by reading fixed blocks
    // from the end. A line straddling a block boundary is carried into the next (earlier) block, where
    // its beginning is; splitting on the newline BYTE is safe because no byte of a multi-byte UTF-8
    // sequence can be 0x0A.
    private static async IAsyncEnumerable<string> ReadLinesBackwardAsync(
        string path,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var stream = TryOpenForTailRead(path);
        if (stream is null)
        {
            yield break;
        }

        await using (stream)
        {
            var position = stream.Length;
            var block = new byte[ReadBlockBytes];
            var carry = Array.Empty<byte>();

            while (position > 0)
            {
                cancellationToken.ThrowIfCancellationRequested();
                var take = (int)Math.Min(ReadBlockBytes, position);
                position -= take;
                stream.Seek(position, SeekOrigin.Begin);
                await stream.ReadExactlyAsync(block.AsMemory(0, take), cancellationToken);

                // The carry belongs AFTER this block's bytes: it is the tail of a line whose start is
                // in the block just read.
                var chunk = new byte[take + carry.Length];
                Buffer.BlockCopy(block, 0, chunk, 0, take);
                Buffer.BlockCopy(carry, 0, chunk, take, carry.Length);

                var end = chunk.Length;
                for (var index = chunk.Length - 1; index >= 0; index -= 1)
                {
                    if (chunk[index] != (byte)'\n')
                    {
                        continue;
                    }

                    if (Decode(chunk, index + 1, end - index - 1) is { } line)
                    {
                        yield return line;
                    }

                    end = index;
                }

                // Everything before the leftmost newline continues into the previous block.
                carry = chunk[..end];
            }

            // Whatever is left once the start of the file is reached is its first line, complete.
            if (Decode(carry, 0, carry.Length) is { } first)
            {
                yield return first;
            }
        }
    }

    private static string? Decode(byte[] buffer, int offset, int length)
    {
        if (length <= 0)
        {
            return null;
        }

        // TrimEnd('\r'): AppendAsync writes Environment.NewLine, which is CRLF on Windows.
        var line = Encoding.UTF8.GetString(buffer, offset, length).TrimEnd('\r');
        return string.IsNullOrWhiteSpace(line) ? null : line;
    }

    // FileShare.ReadWrite lets appends continue during a read; FileShare.Delete lets a rotation rename
    // the file out from under this handle, which keeps reading the bytes it opened.
    private static FileStream? TryOpenForTailRead(string path)
    {
        try
        {
            return new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete,
                bufferSize: 4096,
                useAsync: true);
        }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
        {
            return null;
        }
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
