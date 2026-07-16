using System.Runtime.InteropServices;

namespace Haas.Hosty.Cli.Tests;

// Mutating the process-wide std handle flags races any test class that spawns a child while this runs, so
// keep it out of the parallel pool. The test also restores every handle's original flag in a finally.
[CollectionDefinition("StdHandleMutation", DisableParallelization = true)]
public sealed class StdHandleMutationCollection;

[Collection("StdHandleMutation")]
public sealed class WindowsProcessControlTests
{
    // Regression: Core's update endpoint runs the CLI as `cmd /c "hosty.exe update > core-update.log"`,
    // so the CLI's stdout/stderr are that log's handle. The replacement Core the CLI starts (and the app
    // trees it spawns) inherited the handle, kept core-update.log open, and every later Update-button
    // spawn died on the redirect before the helper ran. Clearing the inherit flag on the CLI's
    // stdout/stderr is the fix — same leak, and same cure, as Core's core.log wedge (#192).
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

    // Regression guard mirroring Core's #205: whenever any stream of a child is redirected, .NET sets
    // STARTF_USESTDHANDLES and Windows requires every handle in STARTUPINFO to be inheritable — an
    // unredirected stdin passes the CLI's own handle, so clearing its flag would hand such a child a
    // broken stdin. stdin was never part of the log-handle leak; it must stay untouched.
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
                "stdin must stay inheritable: it is not the helper log, and clearing it breaks every child's stdin.");
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
