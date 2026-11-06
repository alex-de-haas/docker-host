using System.Runtime.InteropServices;

namespace Haas.Hosty.Core;

// Mutable bytes are reusable only while the filesystem identity, size, mtime AND ctime match.
// Authorization and contained-path checks remain in SourceDocumentService on every read.
internal sealed class SourceDocumentWorktreeCache(long byteLimit = 32 * 1024 * 1024)
{
    private sealed record Entry(DocumentFileStamp Stamp, byte[] Bytes, LinkedListNode<string> Node, long Weight);
    private readonly object gate = new();
    private readonly Dictionary<string, Entry> entries = new(StringComparer.Ordinal);
    private readonly LinkedList<string> order = new();
    private readonly SemaphoreSlim[] readers = Enumerable.Range(0, 64).Select(_ => new SemaphoreSlim(1)).ToArray();
    private long size;
    private int loads, hits;
    internal (int Entries, long Bytes, int Loads, int Hits) Statistics
    { get { lock (gate) return (entries.Count, size, loads, hits); } }

    internal async Task<byte[]> ReadAsync(string path, Func<CancellationToken, Task<byte[]>> read, CancellationToken ct)
    {
        var reader = readers[(uint)StringComparer.Ordinal.GetHashCode(path) % readers.Length];
        await reader.WaitAsync(ct);
        try
        {
            var before = DocumentFileStamp.Read(path);
            if (before is null) await AppSourceService.RequireRegularFileAsync(path, ct);
            else if (!before.Value.Regular) throw Unsupported();
            lock (gate)
            {
                if (before is { } stamp && entries.TryGetValue(path, out var entry) && entry.Stamp == stamp)
                {
                    order.Remove(entry.Node); order.AddLast(entry.Node); hits++;
                    return entry.Bytes;
                }
                Remove(path);
            }
            ct.ThrowIfCancellationRequested();
            var bytes = await read(ct);
            Interlocked.Increment(ref loads);
            var after = DocumentFileStamp.Read(path);
            if (before != after) throw new AppLifecycleException("source_document_conflict", "Worktree document changed while it was read.");
            if (after is { Regular: true } current)
            {
                var weight = bytes.LongLength + path.Length * 2L + 256;
                lock (gate)
                {
                    if (weight <= byteLimit)
                    {
                        while (size + weight > byteLimit && order.First is { } first) Remove(first.Value);
                        entries[path] = new(current, bytes, order.AddLast(path), weight); size += weight;
                    }
                }
            }
            return bytes;
        }
        finally { reader.Release(); }
    }
    private void Remove(string path)
    {
        if (!entries.Remove(path, out var previous)) return;
        size -= previous.Weight; order.Remove(previous.Node);
    }
    private static AppLifecycleException Unsupported()
        => new("source_file_unsupported", "Only regular source files can be read; special files require an external workflow.");
}

// Both Unix ABIs expose nanosecond ctime, so a same-size edit with restored mtime still expires
// the entry. Unsupported platforms/filesystems use the uncached, regular-file-checked reader.
internal readonly record struct DocumentFileStamp(ulong Device, ulong Inode, uint Mode, long Size,
    long ModifiedSeconds, long ModifiedNanos, long ChangedSeconds, long ChangedNanos)
{
    internal bool Regular => (Mode & 0xf000) == 0x8000;
    internal static DocumentFileStamp? Read(string path) => Read(path, out _);
    internal static DocumentFileStamp? Read(string path, out bool missing)
    {
        missing = false;
        if (OperatingSystem.IsLinux())
        {
            const uint required = 0x3c1; // TYPE, MTIME, CTIME, INO, SIZE
            try
            {
                if (Statx(-100, path, 0x100, 0x7ff, out var s) != 0)
                { missing = Marshal.GetLastPInvokeError() is 2 or 20; return null; }
                if ((s.Mask & required) != required) return null;
                return new(((ulong)s.DeviceMajor << 32) | s.DeviceMinor, s.Inode, s.Mode, s.Size,
                    s.ModifiedSeconds, s.ModifiedNanos, s.ChangedSeconds, s.ChangedNanos);
            }
            catch (EntryPointNotFoundException) { return null; }
        }
        if (OperatingSystem.IsMacOS())
        {
            DarwinStat s;
            var result = RuntimeInformation.ProcessArchitecture == Architecture.X64 ? DarwinLStat64(path, out s) : DarwinLStat(path, out s);
            if (result != 0) missing = Marshal.GetLastPInvokeError() is 2 or 20;
            return result == 0 ? new((uint)s.Device, s.Inode, s.Mode, s.Size,
                s.ModifiedSeconds, s.ModifiedNanos, s.ChangedSeconds, s.ChangedNanos) : null;
        }
        return null;
    }
    // Linux uapi statx: fixed layout on arm64 and x86_64.
    [StructLayout(LayoutKind.Explicit, Size = 256)]
    private struct LinuxStatx
    {
        [FieldOffset(0)] public uint Mask;
        [FieldOffset(28)] public ushort Mode;
        [FieldOffset(32)] public ulong Inode;
        [FieldOffset(40)] public long Size;
        [FieldOffset(96)] public long ChangedSeconds;
        [FieldOffset(104)] public uint ChangedNanos;
        [FieldOffset(112)] public long ModifiedSeconds;
        [FieldOffset(120)] public uint ModifiedNanos;
        [FieldOffset(136)] public uint DeviceMajor;
        [FieldOffset(140)] public uint DeviceMinor;
    }
    // Darwin SDK sys/stat.h, __DARWIN_STRUCT_STAT64 (64-bit inode ABI).
    [StructLayout(LayoutKind.Explicit, Size = 144)]
    private struct DarwinStat
    {
        [FieldOffset(0)] public int Device;
        [FieldOffset(4)] public ushort Mode;
        [FieldOffset(8)] public ulong Inode;
        [FieldOffset(48)] public long ModifiedSeconds;
        [FieldOffset(56)] public long ModifiedNanos;
        [FieldOffset(64)] public long ChangedSeconds;
        [FieldOffset(72)] public long ChangedNanos;
        [FieldOffset(96)] public long Size;
    }
    [DllImport("libc", EntryPoint = "statx", SetLastError = true)]
    private static extern int Statx(int directory, [MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags, uint mask, out LinuxStatx stat);
    [DllImport("libSystem.B.dylib", EntryPoint = "lstat", SetLastError = true)]
    private static extern int DarwinLStat([MarshalAs(UnmanagedType.LPUTF8Str)] string path, out DarwinStat stat);
    [DllImport("libSystem.B.dylib", EntryPoint = "lstat$INODE64", SetLastError = true)]
    private static extern int DarwinLStat64([MarshalAs(UnmanagedType.LPUTF8Str)] string path, out DarwinStat stat);
}
