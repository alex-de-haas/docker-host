using System.Runtime.InteropServices;

namespace Haas.Hosty.Core;

// CreationTime is synthesized from mutable ctime/mtime on Linux filesystems without birth time.
// A metadata-only health check must not mistake ordinary child writes for root replacement.
internal readonly record struct WorkspaceDirectoryIdentity(ulong Device, ulong Inode, long CreatedTicks)
{
    internal static WorkspaceDirectoryIdentity? Read(string path)
    {
        if (!OperatingSystem.IsLinux())
            return Directory.Exists(path) ? new(0, 0, Directory.GetCreationTimeUtc(path).Ticks) : null;
        const uint typeAndInode = 0x101; // STATX_TYPE | STATX_INO
        const int noFollow = 0x100; // AT_SYMLINK_NOFOLLOW
        if (Statx(-100, path, noFollow, typeAndInode, out var stat) != 0
            || (stat.Mask & typeAndInode) != typeAndInode || (stat.Mode & 0xf000) != 0x4000) return null;
        return new(((ulong)stat.DeviceMajor << 32) | stat.DeviceMinor, stat.Inode, 0);
    }

    // Linux's statx ABI has fixed offsets and a 256-byte result on both supported architectures.
    [StructLayout(LayoutKind.Explicit, Size = 256)]
    private struct LinuxStatx
    {
        [FieldOffset(0)] public uint Mask;
        [FieldOffset(28)] public ushort Mode;
        [FieldOffset(32)] public ulong Inode;
        [FieldOffset(136)] public uint DeviceMajor;
        [FieldOffset(140)] public uint DeviceMinor;
    }

    [DllImport("libc", EntryPoint = "statx", SetLastError = true)]
    private static extern int Statx(int directory, [MarshalAs(UnmanagedType.LPUTF8Str)] string path,
        int flags, uint mask, out LinuxStatx stat);
}
