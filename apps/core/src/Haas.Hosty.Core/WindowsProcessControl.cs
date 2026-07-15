using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Haas.Hosty.Core;

// Windows-only: stop Core's own inheritable handles from leaking into the child processes it spawns.
//
// The CLI launches Core as `cmd.exe /c "core.exe > core.log 2>&1"`, so Core's stdout/stderr *are* the
// core.log file handle. When Core later starts a localCommand service it spawns the child with redirected
// stdio, which forces .NET to call CreateProcess with bInheritHandles=TRUE — and the child then inherits
// *every* inheritable handle Core holds, including that core.log handle. A localCommand process that
// outlives Core (a keep-apps restart, or an orphan) keeps core.log open, so the next Core launch's
// `> core.log` redirect fails with a sharing violation and core.exe never starts. The operator sees a
// control-discovery timeout with core.log frozen at the previous shutdown and nothing bound on the Core
// port — exactly because the new process died before it could bind or log anything.
//
// Clearing HANDLE_FLAG_INHERIT on Core's standard handles at startup breaks that leak for every child
// Core spawns (localCommand, the docker/git CLI runners, the detached CLI launcher). The per-spawn
// redirect pipes are unaffected: .NET marks those inheritable just for the child that reads them, so
// localCommand log capture keeps working. No-op off Windows — POSIX opens these descriptors close-on-exec.
internal static class WindowsProcessControl
{
    private const int STD_INPUT_HANDLE = -10;
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

    // Clears the inherit flag on stdin/stdout/stderr so any child Core spawns with bInheritHandles (i.e.
    // any redirected-stdio spawn) does not inherit them. Best-effort and idempotent — a handle that is
    // absent (service with no console) or already non-inheritable is simply skipped.
    [SupportedOSPlatform("windows")]
    public static void MakeStandardHandlesNonInheritable()
    {
        foreach (var id in new[] { STD_OUTPUT_HANDLE, STD_ERROR_HANDLE, STD_INPUT_HANDLE })
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
