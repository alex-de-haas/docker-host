using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Haas.Hosty.Core;

internal sealed record StorageFileEntry(string RelativePath, ulong Device, ulong Inode, long AllocatedBytes,
    long LogicalBytes, bool Directory, bool SymbolicLink, bool Mount, byte[]? Metadata = null, string? Error = null, ulong InodeHigh = 0);

internal interface IStorageFileSystem
{
    IEnumerable<StorageFileEntry> Walk(string root, CancellationToken ct);
}

// Descriptor-relative traversal pins every ancestor. A directory replaced by a symlink between stat
// and open is refused by openat(O_NOFOLLOW); its replacement cannot redirect the scan outside dataRoot.
// We inspect metadata only, never open app data. The few small registry documents are read through the
// same anchored descriptor with O_NOFOLLOW and projected into names/associations by the scanner.
internal sealed class StorageFileSystem : IStorageFileSystem
{
    public IEnumerable<StorageFileEntry> Walk(string root, CancellationToken ct)
    {
        if (OperatingSystem.IsWindows())
        {
            foreach (var entry in new StorageWindowsFileSystem().Walk(root, ct)) yield return entry;
            yield break;
        }
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())
        {
            yield return Error("", "filesystem_metadata_unavailable");
            yield break;
        }
        var rootFd = Open(root, DirectoryFlags);
        if (rootFd < 0) { yield return Error("", "root_unreadable"); yield break; }
        try
        {
            var identity = Stat(rootFd, ".");
            if (identity is null) { yield return Error("", "filesystem_metadata_unavailable"); yield break; }
            var mounts = MacMounts();
            if (mounts is null) { yield return Error("", "filesystem_metadata_unavailable"); yield break; }
            yield return new("", identity.Value.Device, identity.Value.Inode, identity.Value.Blocks * 512, 0, true, false, false);
            foreach (var entry in WalkDirectory(rootFd, "", MountPathPolicy.ResolveRealPath(root), identity.Value, mounts, 0, ct))
                yield return entry;
        }
        finally { Close(rootFd); }
    }

    private static IEnumerable<StorageFileEntry> WalkDirectory(int fd, string relative, string root,
        FileMetadata boundary, HashSet<string> mounts, int depth, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        if (depth > 256) { yield return Error(relative, "depth_limit"); yield break; }
        var names = ReadNames(fd, ct, out var enumerationError);
        if (enumerationError is not null) yield return Error(relative, enumerationError);
        foreach (var name in names)
        {
            ct.ThrowIfCancellationRequested();
            var path = relative.Length == 0 ? name : relative + "/" + name;
            var metadata = Stat(fd, name);
            if (metadata is null) { yield return Error(path, "entry_unreadable"); continue; }
            var m = metadata.Value;
            var symbolic = (m.Mode & 0xf000) == 0xa000;
            var isDirectory = (m.Mode & 0xf000) == 0x4000;
            var mount = m.Device != boundary.Device || (m.MountId != 0 && m.MountId != boundary.MountId)
                || mounts.Contains(Path.Combine(root, path));
            byte[]? document = null;
            if (!symbolic && !mount && (m.Mode & 0xf000) == 0x8000 && m.Size <= 1024 * 1024 && IsMetadata(path))
                document = ReadMetadata(fd, name, m);
            yield return new(path, m.Device, m.Inode, m.Blocks * 512, isDirectory ? 0 : m.Size,
                isDirectory, symbolic, mount, document,
                IsMetadata(path) && !symbolic && !mount && document is null ? "metadata_unreadable" : null);
            if (!isDirectory || symbolic || mount) continue;
            var child = OpenAt(fd, name, DirectoryFlags);
            if (child < 0) { yield return Error(path, "directory_changed_or_unreadable"); continue; }
            try
            {
                var opened = Stat(child, ".");
                if (opened is null || opened.Value.Device != m.Device || opened.Value.Inode != m.Inode
                    || opened.Value.MountId != m.MountId)
                { yield return Error(path, "directory_changed"); continue; }
                foreach (var entry in WalkDirectory(child, path, root, boundary, mounts, depth + 1, ct)) yield return entry;
            }
            finally { Close(child); }
        }
    }

    // Sorted, bounded sibling names make hardlink ownership repeatable across measurements.
    private static string[] ReadNames(int fd, CancellationToken ct, out string? error)
    {
        error = null;
        var copy = Dup(fd);
        var directory = copy < 0 ? IntPtr.Zero : FdOpenDir(copy);
        if (directory == IntPtr.Zero)
        {
            if (copy >= 0) Close(copy);
            error = "directory_unreadable"; return [];
        }
        var names = new List<string>();
        try
        {
            while (true)
            {
                ct.ThrowIfCancellationRequested();
                Marshal.SetLastPInvokeError(0);
                var pointer = OperatingSystem.IsMacOS() && RuntimeInformation.ProcessArchitecture == Architecture.X64
                    ? DarwinReadDir64(directory) : ReadDir(directory);
                if (pointer == IntPtr.Zero)
                {
                    if (Marshal.GetLastPInvokeError() != 0) error = "directory_unreadable";
                    break;
                }
                var name = Marshal.PtrToStringUTF8(IntPtr.Add(pointer, OperatingSystem.IsMacOS() ? 21 : 19));
                if (string.IsNullOrEmpty(name) || name is "." or "..") continue;
                if (names.Count >= 100_000) { error = "directory_entry_limit"; break; }
                names.Add(name);
            }
        }
        finally { CloseDir(directory); }
        names.Sort(StringComparer.Ordinal);
        return names.ToArray();
    }

    internal static bool IsMetadata(string path)
    {
        var segments = path.Split('/');
        return (segments.Length == 3 && segments[0] == "apps" && segments[2] == "state.json")
            || (segments.Length == 4 && segments[0] == "core" && segments[1] == "development" && segments[2] is "workspaces" or "metadata" && path.EndsWith(".json", StringComparison.Ordinal))
            || (segments.Length == 3 && segments[0] == "core" && segments[1] == "environments" && path.EndsWith(".json", StringComparison.Ordinal));
    }

    private static byte[]? ReadMetadata(int parent, string name, FileMetadata expected)
    {
        var fd = OpenAt(parent, name, NoFollow | CloseOnExec | NonBlocking);
        if (fd < 0) return null;
        using var handle = new SafeFileHandle(new IntPtr(fd), ownsHandle: true);
        // openat cannot race into a FIFO/device: O_NONBLOCK prevents blocking, and a second descriptor
        // stat verifies identity/type before FileStream touches it.
        var actual = Stat(fd, "");
        if (actual is null || actual.Value.Device != expected.Device || actual.Value.Inode != expected.Inode
            || (actual.Value.Mode & 0xf000) != 0x8000 || actual.Value.Size > 1024 * 1024) return null;
        try
        {
            using var stream = new FileStream(handle, FileAccess.Read);
            var bytes = new byte[(int)actual.Value.Size];
            stream.ReadExactly(bytes);
            return stream.ReadByte() == -1 ? bytes : null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return null; }
    }

    private readonly record struct FileMetadata(ulong Device, ulong Inode, uint Mode, long Size, long Blocks, ulong MountId);
    private static FileMetadata? Stat(int fd, string name)
    {
        if (OperatingSystem.IsLinux())
        {
            const uint required = 0x1701; // TYPE | INO | SIZE | BLOCKS | MNT_ID (same-device bind mounts)
            try
            {
                if (Statx(fd, name, 0x100 | (name.Length == 0 ? 0x1000 : 0), required, out var s) != 0
                    || (s.Mask & required) != required || s.Size < 0 || s.Blocks < 0) return null;
                return new(((ulong)s.DeviceMajor << 32) | s.DeviceMinor, s.Inode, s.Mode, s.Size, s.Blocks, s.MountId);
            }
            catch (EntryPointNotFoundException) { return null; }
        }
        DarwinStat d;
        var result = name.Length == 0
            ? (RuntimeInformation.ProcessArchitecture == Architecture.X64 ? DarwinFStat64(fd, out d) : DarwinFStat(fd, out d))
            : (RuntimeInformation.ProcessArchitecture == Architecture.X64 ? DarwinFStatAt64(fd, name, out d, 0x20) : DarwinFStatAt(fd, name, out d, 0x20));
        return result == 0 && d.Size >= 0 && d.Blocks >= 0 ? new((uint)d.Device, d.Inode, d.Mode, d.Size, d.Blocks, 0) : null;
    }

    private static HashSet<string>? MacMounts()
    {
        var result = new HashSet<string>(StringComparer.Ordinal);
        if (!OperatingSystem.IsMacOS()) return result;
        IntPtr buffer;
        var count = RuntimeInformation.ProcessArchitecture == Architecture.X64
            ? GetMountInfo64(out buffer, 2) : GetMountInfo(out buffer, 2); // MNT_NOWAIT
        if (count <= 0) return null;
        for (var i = 0; i < count; i++)
            if (Marshal.PtrToStringUTF8(IntPtr.Add(buffer, i * 2168 + 88)) is { Length: > 0 } path)
                result.Add(Path.TrimEndingDirectorySeparator(path));
        return result;
    }

    private static StorageFileEntry Error(string path, string code) => new(path, 0, 0, 0, 0, false, false, false, Error: code);
    private static int NoFollow => OperatingSystem.IsMacOS() ? 0x100 : 0x20000;
    private static int CloseOnExec => OperatingSystem.IsMacOS() ? 0x1000000 : 0x80000;
    private static int NonBlocking => OperatingSystem.IsMacOS() ? 4 : 0x800;
    private static int DirectoryFlags => NoFollow | CloseOnExec | (OperatingSystem.IsMacOS() ? 0x100000 : 0x10000);
    [StructLayout(LayoutKind.Explicit, Size = 256)] private struct LinuxStatx
    {
        [FieldOffset(0)] public uint Mask;
        [FieldOffset(28)] public ushort Mode;
        [FieldOffset(32)] public ulong Inode;
        [FieldOffset(40)] public long Size;
        [FieldOffset(48)] public long Blocks;
        [FieldOffset(136)] public uint DeviceMajor;
        [FieldOffset(140)] public uint DeviceMinor;
        [FieldOffset(144)] public ulong MountId;
    }
    [StructLayout(LayoutKind.Explicit, Size = 144)] private struct DarwinStat
    {
        [FieldOffset(0)] public int Device;
        [FieldOffset(4)] public ushort Mode;
        [FieldOffset(8)] public ulong Inode;
        [FieldOffset(96)] public long Size;
        [FieldOffset(104)] public long Blocks;
    }
    [DllImport("libc", EntryPoint = "open", SetLastError = true)] private static extern int Open([MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags);
    [DllImport("libc", EntryPoint = "openat", SetLastError = true)] private static extern int OpenAt(int fd, [MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags);
    [DllImport("libc", EntryPoint = "close")] private static extern int Close(int fd);
    [DllImport("libc", EntryPoint = "dup")] private static extern int Dup(int fd);
    [DllImport("libc", EntryPoint = "fdopendir", SetLastError = true)] private static extern IntPtr FdOpenDir(int fd);
    [DllImport("libc", EntryPoint = "readdir", SetLastError = true)] private static extern IntPtr ReadDir(IntPtr directory);
    [DllImport("libSystem.B.dylib", EntryPoint = "readdir$INODE64", SetLastError = true)] private static extern IntPtr DarwinReadDir64(IntPtr directory);
    [DllImport("libc", EntryPoint = "closedir")] private static extern int CloseDir(IntPtr directory);
    [DllImport("libc", EntryPoint = "statx", SetLastError = true)] private static extern int Statx(int fd, [MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags, uint mask, out LinuxStatx stat);
    [DllImport("libSystem.B.dylib", EntryPoint = "fstatat", SetLastError = true)] private static extern int DarwinFStatAt(int fd, [MarshalAs(UnmanagedType.LPUTF8Str)] string path, out DarwinStat stat, int flags);
    [DllImport("libSystem.B.dylib", EntryPoint = "fstatat$INODE64", SetLastError = true)] private static extern int DarwinFStatAt64(int fd, [MarshalAs(UnmanagedType.LPUTF8Str)] string path, out DarwinStat stat, int flags);
    [DllImport("libSystem.B.dylib", EntryPoint = "fstat", SetLastError = true)] private static extern int DarwinFStat(int fd, out DarwinStat stat);
    [DllImport("libSystem.B.dylib", EntryPoint = "fstat$INODE64", SetLastError = true)] private static extern int DarwinFStat64(int fd, out DarwinStat stat);
    [DllImport("libSystem.B.dylib", EntryPoint = "getmntinfo")] private static extern int GetMountInfo(out IntPtr buffer, int flags);
    [DllImport("libSystem.B.dylib", EntryPoint = "getmntinfo$INODE64")] private static extern int GetMountInfo64(out IntPtr buffer, int flags);
}
