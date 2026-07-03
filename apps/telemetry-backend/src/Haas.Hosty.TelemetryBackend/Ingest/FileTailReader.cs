using System.Text;

namespace Haas.Hosty.TelemetryBackend;

// A chunk of newly-appended log/trace file bytes decoded to text, plus the byte offset to resume from
// next tick. Content is aligned to whole lines (a trailing partial line is left for next time).
internal readonly record struct FileTailRead(string Content, long NextOffset);

// Reads newly-appended content from an otelcol file sink, resuming from the caller's byte offset and
// aligning to whole lines so a half-flushed final line is re-read next tick rather than parsed
// incomplete. Resets to the start when the file is shorter than the offset (the exporter rotated /
// truncated). Caps the per-tick read so a large backlog cannot spike memory. Returns null when the file
// is absent or unreadable this tick. Ported from Core's FileLogTailReader (Phase 2).
internal sealed class FileTailReader
{
    private const long MaxBytesPerRead = 4 * 1024 * 1024;

    public async Task<FileTailRead?> ReadAsync(string path, long fromOffset, CancellationToken cancellationToken = default)
    {
        try
        {
            if (!File.Exists(path))
            {
                return null;
            }

            await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            var length = stream.Length;
            // A file shorter than where we left off means it rotated/truncated: start over from 0.
            var start = fromOffset < 0 || fromOffset > length ? 0 : fromOffset;
            var available = length - start;
            if (available <= 0)
            {
                return new FileTailRead(string.Empty, length);
            }

            // Skip ahead past a large backlog (e.g. after a long stall) to bound this tick's read.
            if (available > MaxBytesPerRead)
            {
                start = length - MaxBytesPerRead;
                available = MaxBytesPerRead;
            }

            stream.Seek(start, SeekOrigin.Begin);
            var buffer = new byte[(int)available];
            var total = 0;
            while (total < buffer.Length)
            {
                var read = await stream.ReadAsync(buffer.AsMemory(total), cancellationToken);
                if (read == 0)
                {
                    break;
                }

                total += read;
            }

            if (total <= 0)
            {
                return new FileTailRead(string.Empty, start);
            }

            // Consume only through the last complete line; the trailing partial waits for next tick.
            var lastNewline = Array.LastIndexOf(buffer, (byte)'\n', total - 1, total);
            if (lastNewline < 0)
            {
                return new FileTailRead(string.Empty, start);
            }

            var consume = lastNewline + 1;
            var content = Encoding.UTF8.GetString(buffer, 0, consume);
            return new FileTailRead(content, start + consume);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }
}
