using System.Buffers.Binary;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace Haas.Hosty.Core;

// Enumerate directory handles rather than paths. Omitting FILE_SHARE_DELETE pins every open
// ancestor against rename/removal; final handle paths also reject an ancestor changed into a
// reparse point in place. All reparse points, including mounted folders, remain untraversed.
internal sealed class StorageWindowsFileSystem : IStorageFileSystem
{
    private const uint ReadAttributes = 0x80, ReadData = 1, ShareReadWrite = 3;
    private const uint OpenExisting = 3, OpenReparseAndBackup = 0x02200000;
    private const uint ReparsePoint = 0x400, MountPointTag = 0xa0000003;
    private const int MaximumDirectoryEntries = 100_000, MaximumMetadataBytes = 1024 * 1024;

    public IEnumerable<StorageFileEntry> Walk(string root, CancellationToken ct)
    {
        if (!OperatingSystem.IsWindows())
        { yield return Error("", "filesystem_metadata_unavailable"); yield break; }
        using var handle = Open(Path.GetFullPath(root), ReadAttributes | ReadData);
        if (handle.IsInvalid) { yield return Error("", "root_unreadable"); yield break; }
        var metadata = Read(handle);
        var canonicalRoot = FinalPath(handle);
        if (metadata is null || canonicalRoot is null)
        { yield return Error("", "filesystem_metadata_unavailable"); yield break; }
        if (!metadata.Value.Directory || metadata.Value.Reparse)
        { yield return Error("", "root_unreadable"); yield break; }
        yield return Entry("", metadata.Value);
        var context = new ScanContext();
        foreach (var entry in WalkDirectory(handle, canonicalRoot, "", metadata.Value.Volume, 0, context, ct))
            yield return entry;
    }

    private static IEnumerable<StorageFileEntry> WalkDirectory(SafeFileHandle directory, string root,
        string relative, ulong volume, int depth, ScanContext context, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (depth > 256) { yield return Error(relative, "depth_limit"); yield break; }
        var (names, error) = ReadNames(directory, context, ct);
        if (error is not null) yield return Error(relative, error);
        foreach (var name in names)
        {
            ct.ThrowIfCancellationRequested();
            if (context.Timer.Elapsed > StorageUsageScanner.MaximumDuration)
            { yield return Error(relative, "scan_limit"); yield break; }
            var path = relative.Length == 0 ? name : relative + "/" + name;
            var fullPath = Path.Combine(root, path.Replace('/', '\\'));
            using var item = Open(fullPath, ReadAttributes);
            if (item.IsInvalid) { yield return Error(path, "entry_unreadable"); continue; }
            var metadata = Read(item);
            if (metadata is null) { yield return Error(path, "entry_unreadable"); continue; }
            var m = metadata.Value;
            if (m.Reparse)
            {
                yield return new(path, m.Volume, m.IdLow, 0, 0, m.Directory,
                    !m.Mount, m.Mount, InodeHigh: m.IdHigh);
                continue;
            }
            if (!SamePath(FinalPath(item), fullPath))
            { yield return Error(path, "entry_changed"); continue; }
            if (m.Volume != volume)
            {
                yield return new(path, m.Volume, m.IdLow, 0, 0, m.Directory, false, true, InodeHigh: m.IdHigh);
                continue;
            }
            byte[]? bytes = null;
            var isMetadata = !m.Directory && StorageFileSystem.IsMetadata(path);
            if (isMetadata && m.Logical <= MaximumMetadataBytes) bytes = ReadMetadata(fullPath, m);
            yield return Entry(path, m, bytes, isMetadata && bytes is null ? "metadata_unreadable" : null);
            if (!m.Directory) continue;
            using var child = Open(fullPath, ReadAttributes | ReadData);
            var opened = child.IsInvalid ? null : Read(child);
            if (opened is null || opened.Value.Reparse || !opened.Value.Directory
                || !SameIdentity(opened.Value, m) || !SamePath(FinalPath(child), fullPath))
            { yield return Error(path, "directory_changed_or_unreadable"); continue; }
            foreach (var entry in WalkDirectory(child, root, path, volume, depth + 1, context, ct)) yield return entry;
        }
    }

    private static (string[] Names, string? Error) ReadNames(SafeFileHandle directory, ScanContext context,
        CancellationToken ct)
    {
        var names = new List<string>();
        var buffer = new byte[64 * 1024];
        var first = true;
        while (true)
        {
            ct.ThrowIfCancellationRequested();
            if (context.Timer.Elapsed > StorageUsageScanner.MaximumDuration
                || context.NamesSeen >= StorageUsageScanner.MaximumEntries)
                return (Ordered(), "scan_limit");
            if (!GetDirectoryInformation(directory, first ? 11 : 10, buffer, (uint)buffer.Length))
                return (Ordered(), Marshal.GetLastPInvokeError() is 18 or 38 ? null : "directory_unreadable");
            first = false;
            string[] batch;
            try { batch = ParseDirectoryBuffer(buffer); }
            catch (InvalidDataException) { return (Ordered(), "directory_unreadable"); }
            foreach (var name in batch)
            {
                if (names.Count >= MaximumDirectoryEntries) return (Ordered(), "directory_entry_limit");
                if (++context.NamesSeen > StorageUsageScanner.MaximumEntries) return (Ordered(), "scan_limit");
                names.Add(name);
            }
        }
        string[] Ordered() => names.Order(StringComparer.Ordinal).ToArray();
    }

    // FILE_ID_BOTH_DIR_INFO is aligned to eight bytes on both Windows architectures. Each name
    // starts at byte 104 and has an explicit UTF-16 byte length, rather than a required terminator.
    // https://learn.microsoft.com/windows/win32/api/winbase/ns-winbase-file_id_both_dir_info
    internal static string[] ParseDirectoryBuffer(byte[] buffer)
    {
        var names = new List<string>();
        var offset = 0;
        while (true)
        {
            if (buffer.Length - offset < 104) throw new InvalidDataException();
            var next = BinaryPrimitives.ReadUInt32LittleEndian(buffer.AsSpan(offset));
            var length = BinaryPrimitives.ReadUInt32LittleEndian(buffer.AsSpan(offset + 60));
            var available = next == 0 ? buffer.Length - offset : (long)next;
            if (available < 104 || available > buffer.Length - offset || (length & 1) != 0
                || length > available - 104 || next != 0 && (next & 7) != 0)
                throw new InvalidDataException();
            var name = Encoding.Unicode.GetString(buffer, offset + 104, (int)length);
            if (name is not "." and not "..")
            {
                if (name.Length == 0 || name.IndexOfAny(['/', '\\', ':', '\0']) >= 0) throw new InvalidDataException();
                names.Add(name);
            }
            if (next == 0) return names.ToArray();
            offset += (int)next;
        }
    }

    private static Metadata? Read(SafeFileHandle handle)
    {
        if (!GetAttributeInformation(handle, 9, out var attributes, 8)
            || !GetIdentityInformation(handle, 18, out var identity, 24)
            || !GetStandardInformation(handle, 1, out var standard, 24)
            || standard.Allocated < 0 || standard.Logical < 0) return null;
        var allocated = standard.Allocated;
        // The compression query also reports physical allocation for sparse streams. StandardInfo
        // alone can include reserved, unallocated ranges for compressed/sparse files.
        if (standard.Directory == 0 && (attributes.Attributes & (0x200 | 0x800)) != 0)
        {
            if (!GetCompressionInformation(handle, 8, out var compression, 16) || compression.Allocated < 0) return null;
            allocated = compression.Allocated;
        }
        return new(identity.Volume, identity.IdLow, identity.IdHigh, allocated,
            standard.Directory != 0 ? 0 : standard.Logical, standard.Directory != 0,
            (attributes.Attributes & ReparsePoint) != 0, attributes.Tag == MountPointTag);
    }

    private static byte[]? ReadMetadata(string path, Metadata expected)
    {
        using var handle = Open(path, ReadAttributes | ReadData);
        if (handle.IsInvalid) return null;
        var actual = Read(handle);
        if (actual is null || actual.Value.Reparse || actual.Value.Directory || actual.Value.Logical > MaximumMetadataBytes
            || !SameIdentity(actual.Value, expected) || !SamePath(FinalPath(handle), path)) return null;
        try
        {
            using var stream = new FileStream(handle, FileAccess.Read);
            var bytes = new byte[(int)actual.Value.Logical];
            stream.ReadExactly(bytes);
            return stream.ReadByte() == -1 ? bytes : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return null; }
    }

    private static string? FinalPath(SafeFileHandle handle)
    {
        var path = new StringBuilder(32768);
        var length = GetFinalPathNameByHandle(handle, path, (uint)path.Capacity, 0);
        return length is > 0 and < 32768 ? Path.TrimEndingDirectorySeparator(path.ToString()) : null;
    }
    private static bool SamePath(string? actual, string expected)
        => actual is not null && string.Equals(actual, Path.TrimEndingDirectorySeparator(expected), StringComparison.OrdinalIgnoreCase);
    private static bool SameIdentity(Metadata a, Metadata b) => a.Volume == b.Volume && a.IdLow == b.IdLow && a.IdHigh == b.IdHigh;
    private static SafeFileHandle Open(string path, uint access)
        => CreateFile(path, access, ShareReadWrite, IntPtr.Zero, OpenExisting, OpenReparseAndBackup, IntPtr.Zero);
    private static StorageFileEntry Entry(string path, Metadata value, byte[]? bytes = null, string? error = null)
        => new(path, value.Volume, value.IdLow, value.Allocated, value.Logical, value.Directory,
            false, false, bytes, error, value.IdHigh);
    private static StorageFileEntry Error(string path, string code) => new(path, 0, 0, 0, 0, false, false, false, Error: code);
    private sealed class ScanContext { internal readonly Stopwatch Timer = Stopwatch.StartNew(); internal int NamesSeen; }
    private readonly record struct Metadata(ulong Volume, ulong IdLow, ulong IdHigh, long Allocated, long Logical,
        bool Directory, bool Reparse, bool Mount);

    [StructLayout(LayoutKind.Explicit, Size = 24)] private struct StandardInfo
    {
        [FieldOffset(0)] public long Allocated;
        [FieldOffset(8)] public long Logical;
        [FieldOffset(16)] public uint Links;
        [FieldOffset(20)] public byte DeletePending;
        [FieldOffset(21)] public byte Directory;
    }
    [StructLayout(LayoutKind.Explicit, Size = 24)] private struct IdentityInfo
    {
        [FieldOffset(0)] public ulong Volume;
        [FieldOffset(8)] public ulong IdLow;
        [FieldOffset(16)] public ulong IdHigh;
    }
    [StructLayout(LayoutKind.Explicit, Size = 8)] private struct AttributeInfo
    {
        [FieldOffset(0)] public uint Attributes;
        [FieldOffset(4)] public uint Tag;
    }
    [StructLayout(LayoutKind.Explicit, Size = 16)] private struct CompressionInfo
    {
        [FieldOffset(0)] public long Allocated;
    }

    [DllImport("kernel32.dll", EntryPoint = "CreateFileW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", EntryPoint = "GetFinalPathNameByHandleW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(SafeFileHandle file, StringBuilder path, uint characters, uint flags);
    [DllImport("kernel32.dll", EntryPoint = "GetFileInformationByHandleEx", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetDirectoryInformation(SafeFileHandle file, int information, [Out] byte[] buffer, uint length);
    [DllImport("kernel32.dll", EntryPoint = "GetFileInformationByHandleEx", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetAttributeInformation(SafeFileHandle file, int information, out AttributeInfo buffer, uint length);
    [DllImport("kernel32.dll", EntryPoint = "GetFileInformationByHandleEx", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetIdentityInformation(SafeFileHandle file, int information, out IdentityInfo buffer, uint length);
    [DllImport("kernel32.dll", EntryPoint = "GetFileInformationByHandleEx", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetStandardInformation(SafeFileHandle file, int information, out StandardInfo buffer, uint length);
    [DllImport("kernel32.dll", EntryPoint = "GetFileInformationByHandleEx", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)] private static extern bool GetCompressionInformation(SafeFileHandle file, int information, out CompressionInfo buffer, uint length);
}
