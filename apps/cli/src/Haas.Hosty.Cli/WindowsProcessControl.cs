using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Haas.Hosty.Cli;

// Windows-only: stop the CLI's own inheritable handles from leaking into the child processes it spawns.
// Counterpart of Core's WindowsProcessControl (PR #192, corrected by #205) for the other side of the
// spawn chain.
//
// Core's admin update/restart endpoints launch this CLI as `cmd.exe /c "hosty.exe update >
// core-update.log 2>&1"`, so the CLI's stdout/stderr *are* the core-update.log file handle. When the CLI
// then starts the replacement Core detached (`cmd.exe /c "hosty-core.exe > core.log 2>&1"`), .NET calls
// CreateProcess with bInheritHandles=TRUE — and the new Core, plus every localCommand tree it spawns,
// inherits that core-update.log handle and keeps the file open indefinitely. The next update spawn's
// `> core-update.log` redirect then fails with a sharing violation before the helper CLI ever runs, so
// the Shell's Update button silently does nothing while the update-available badge stays on.
//
// Clearing HANDLE_FLAG_INHERIT on the CLI's stdout/stderr at startup breaks that leak for every child
// the CLI spawns. Per-spawn redirect pipes are unaffected: .NET marks those inheritable just for the
// child that uses them. No-op off Windows — POSIX opens these descriptors close-on-exec.
//
// stdin is deliberately left alone, for the same reason Core's variant leaves it alone (#205): whenever
// any stream of a child is redirected, .NET sets STARTF_USESTDHANDLES and Windows requires *every*
// handle in STARTUPINFO to be inheritable — an unredirected stdin passes the CLI's own handle, and
// clearing its flag would hand each such child a broken stdin.
internal static class WindowsProcessControl
{
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;
    private const int HANDLE_FLAG_INHERIT = 0x1;
    private static readonly IntPtr InvalidHandleValue = new(-1);

    [DllImport("kernel32", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(IntPtr hObject, int dwMask, int dwFlags);

    [DllImport("kernel32", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetHandleInformation(IntPtr hObject, out int lpdwFlags);

    // Clears the inherit flag on stdout/stderr so any child the CLI spawns with bInheritHandles does not
    // inherit them. Best-effort and idempotent — a handle that is absent or already non-inheritable is
    // simply skipped. stdin is excluded on purpose; see the note on the class.
    [SupportedOSPlatform("windows")]
    public static void MakeStandardHandlesNonInheritable()
    {
        foreach (var id in new[] { STD_OUTPUT_HANDLE, STD_ERROR_HANDLE })
        {
            var handle = GetStdHandle(id);
            if (handle == IntPtr.Zero || handle == InvalidHandleValue)
            {
                continue;
            }

            _ = SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0);
        }
    }

    // Test hook: whether the current stdout handle still carries the inherit flag. False when the handle
    // is absent, so callers assert the post-condition (flag cleared) rather than a specific handle state.
    [SupportedOSPlatform("windows")]
    internal static bool IsStandardOutputInheritable()
    {
        var handle = GetStdHandle(STD_OUTPUT_HANDLE);
        if (handle == IntPtr.Zero || handle == InvalidHandleValue)
        {
            return false;
        }

        return GetHandleInformation(handle, out var flags) && (flags & HANDLE_FLAG_INHERIT) != 0;
    }
}
