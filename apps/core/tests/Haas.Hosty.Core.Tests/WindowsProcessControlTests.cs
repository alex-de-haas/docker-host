using System.Runtime.InteropServices;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

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

        var stdout = GetStdHandle(STD_OUTPUT_HANDLE);
        if (stdout == IntPtr.Zero || stdout == new IntPtr(-1))
        {
            return; // No stdout handle in this host — nothing to leak, nothing to assert.
        }

        // Establish a known "before": stdout is inheritable, the state that produced the wedge.
        Assert.True(SetHandleInformation(stdout, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT));
        Assert.True(WindowsProcessControl.IsStandardOutputInheritable());

        WindowsProcessControl.MakeStandardHandlesNonInheritable();

        Assert.False(WindowsProcessControl.IsStandardOutputInheritable());
    }

    private const int STD_OUTPUT_HANDLE = -11;
    private const int HANDLE_FLAG_INHERIT = 0x1;

    [DllImport("kernel32", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(IntPtr hObject, int dwMask, int dwFlags);
}
