using System.Runtime.InteropServices;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

// Mutating the process-wide std handle flags races any test class that spawns a child while this runs, so
// keep it out of the parallel pool. The test also restores every handle's original flag in a finally.
[CollectionDefinition("StdHandleMutation", DisableParallelization = true)]
public sealed class StdHandleMutationCollection;

[Collection("StdHandleMutation")]
public sealed class WindowsProcessControlTests
{
    // Regression: a localCommand child that outlives Core kept core.log open (Core's redirected stdout was
    // inherited because .NET spawns redirected-stdio children with bInheritHandles=TRUE), so the next Core
    // start's `> core.log` redirect failed and core.exe never launched. Clearing the inherit flag on the
    // std handles is the fix. The leak is Windows-only (POSIX opens std descriptors close-on-exec).
    [Fact]
    public void MakeStandardHandlesNonInheritable_ClearsInheritFlagOnStdout()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var stdin = GetStdHandle(STD_INPUT_HANDLE);
        var stdout = GetStdHandle(STD_OUTPUT_HANDLE);
        var stderr = GetStdHandle(STD_ERROR_HANDLE);

        if (!IsValid(stdout))
        {
            return; // No stdout handle in this host — nothing to leak, nothing to assert.
        }

        // Capture the original inherit state of every handle we may touch, so the finally can restore it
        // and this test leaves the runner process exactly as it found it.
        var stdinFlag = OriginalInheritFlag(stdin);
        var stdoutFlag = OriginalInheritFlag(stdout);
        var stderrFlag = OriginalInheritFlag(stderr);

        // Establish a known "before": stdout is inheritable, the state that produced the wedge. Some hosts
        // (e.g. a console handle in certain CI environments) reject this — skip gracefully rather than fail.
        if (!SetHandleInformation(stdout, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT))
        {
            return;
        }

        try
        {
            Assert.True(WindowsProcessControl.IsStandardOutputInheritable());

            WindowsProcessControl.MakeStandardHandlesNonInheritable();

            Assert.False(WindowsProcessControl.IsStandardOutputInheritable());
        }
        finally
        {
            Restore(stdin, stdinFlag);
            Restore(stdout, stdoutFlag);
            Restore(stderr, stderrFlag);
        }
    }

    // Regression: clearing stdin's inherit flag alongside stdout/stderr handed every child a broken stdin.
    // .NET passes Core's own stdin handle in STARTUPINFO whenever any stream is redirected, and Windows
    // requires all three handles there to be inheritable. Children that re-spawn died on it — `docker
    // buildx imagetools inspect` failed with "fork/exec docker-buildx.exe: The request is not supported.",
    // which left every multi-arch image's digest unresolvable (the `manifest inspect` fallback cannot read
    // an index digest) and reached operators as "registry unreachable". core.log is Core's stdout/stderr,
    // so stdin was never part of the leak this class exists to fix.
    [Fact]
    public void MakeStandardHandlesNonInheritable_LeavesStdinInheritable()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }

        var stdin = GetStdHandle(STD_INPUT_HANDLE);
        var stdout = GetStdHandle(STD_OUTPUT_HANDLE);
        var stderr = GetStdHandle(STD_ERROR_HANDLE);

        if (!IsValid(stdin))
        {
            return; // No stdin handle in this host — nothing to preserve, nothing to assert.
        }

        var stdinFlag = OriginalInheritFlag(stdin);
        var stdoutFlag = OriginalInheritFlag(stdout);
        var stderrFlag = OriginalInheritFlag(stderr);

        // Establish a known "before": stdin is inheritable, the state a child needs it to be in.
        if (!SetHandleInformation(stdin, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT))
        {
            return;
        }

        try
        {
            WindowsProcessControl.MakeStandardHandlesNonInheritable();

            Assert.True(
                GetHandleInformation(stdin, out var flags) && (flags & HANDLE_FLAG_INHERIT) != 0,
                "stdin must stay inheritable: it is not core.log, and clearing it breaks every child's stdin.");
        }
        finally
        {
            Restore(stdin, stdinFlag);
            Restore(stdout, stdoutFlag);
            Restore(stderr, stderrFlag);
        }
    }

    private static bool IsValid(IntPtr handle) => handle != IntPtr.Zero && handle != new IntPtr(-1);

    // The handle's current inherit bit, or null when it is invalid or cannot be queried (nothing to restore).
    private static int? OriginalInheritFlag(IntPtr handle)
        => IsValid(handle) && GetHandleInformation(handle, out var flags) ? flags & HANDLE_FLAG_INHERIT : null;

    private static void Restore(IntPtr handle, int? flag)
    {
        if (flag is int original)
        {
            _ = SetHandleInformation(handle, HANDLE_FLAG_INHERIT, original);
        }
    }

    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;
    private const int HANDLE_FLAG_INHERIT = 0x1;

    [DllImport("kernel32", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(IntPtr hObject, int dwMask, int dwFlags);

    [DllImport("kernel32", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetHandleInformation(IntPtr hObject, out int lpdwFlags);
}
