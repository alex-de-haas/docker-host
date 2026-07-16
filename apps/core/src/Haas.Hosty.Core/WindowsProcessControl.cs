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
// Clearing HANDLE_FLAG_INHERIT on Core's stdout/stderr at startup breaks that leak for every child
// Core spawns (localCommand, the docker/git CLI runners, the detached CLI launcher). The per-spawn
// redirect pipes are unaffected: .NET marks those inheritable just for the child that reads them, so
// localCommand log capture keeps working. No-op off Windows — POSIX opens these descriptors close-on-exec.
//
// stdin is deliberately left alone. core.log is Core's stdout/stderr, so stdin was never part of the
// leak — and clearing its flag actively broke child processes. Redirecting any stream makes .NET set
// STARTF_USESTDHANDLES, and Windows then requires *every* handle in STARTUPINFO to be inheritable; an
// unredirected stdin passes Core's own handle, so clearing it handed each child a broken stdin. A CLI
// that re-spawns then dies on it: `docker buildx imagetools inspect` failed with "fork/exec
// docker-buildx.exe: The request is not supported.", which left every multi-arch image's digest
// unresolvable (the `manifest inspect` fallback cannot read an index digest) and surfaced to operators
// as "registry unreachable" plus update plans that flap between a real digest and "unknown".
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

    // Clears the inherit flag on stdout/stderr so any child Core spawns with bInheritHandles (i.e. any
    // redirected-stdio spawn) does not inherit them. Best-effort and idempotent — a handle that is
    // absent (service with no console) or already non-inheritable is simply skipped. stdin is excluded
    // on purpose; see the note on the class.
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
