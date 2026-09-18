using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Win32.SafeHandles;

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
    private static readonly TimeSpan JobTerminationTimeout = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan JobPollInterval = TimeSpan.FromMilliseconds(50);
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;
    private const int HANDLE_FLAG_INHERIT = 0x1;
    private const uint JOB_OBJECT_ASSIGN_PROCESS = 0x0001;
    private const uint JOB_OBJECT_QUERY = 0x0004;
    private const uint JOB_OBJECT_TERMINATE = 0x0008;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private static readonly IntPtr InvalidHandleValue = new(-1);

    [DllImport("kernel32", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetHandleInformation(IntPtr hObject, int dwMask, int dwFlags);

    [DllImport("kernel32", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetHandleInformation(IntPtr hObject, out int lpdwFlags);

    [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeJobHandle CreateJobObject(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeJobHandle OpenJobObject(uint dwDesiredAccess, [MarshalAs(UnmanagedType.Bool)] bool bInheritHandle, string lpName);

    [DllImport("kernel32", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        SafeJobHandle hJob,
        JobObjectInformationClass jobObjectInformationClass,
        ref JobObjectExtendedLimitInformation lpJobObjectInformation,
        uint cbJobObjectInformationLength);

    [DllImport("kernel32", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(SafeJobHandle hJob, IntPtr hProcess);

    [DllImport("kernel32", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJob(IntPtr processHandle, SafeJobHandle jobHandle, [MarshalAs(UnmanagedType.Bool)] out bool result);

    [DllImport("kernel32", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(SafeJobHandle hJob, uint uExitCode);

    [DllImport("kernel32", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(
        SafeJobHandle hJob,
        JobObjectInformationClass jobObjectInformationClass,
        out JobObjectBasicAccountingInformation lpJobObjectInformation,
        uint cbJobObjectInformationLength,
        IntPtr lpReturnLength);

    [DllImport("kernel32")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr hObject);

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

    // The independent runner owns this handle for long-lived services; Core owns it only for setup
    // commands and legacy direct-spawn fixtures. Closing the last handle kills the member tree.
    [SupportedOSPlatform("windows")]
    public static WindowsKillOnCloseJob CreateKillOnCloseJob(string? name = null)
    {
        name ??= $"Local\\Hosty.LocalCommand.{Guid.NewGuid():N}";
        var handle = CreateJobObject(IntPtr.Zero, name);
        if (handle.IsInvalid)
        {
            var error = Marshal.GetLastPInvokeError();
            handle.Dispose();
            throw new Win32Exception(error, "Failed to create a Windows job object for a localCommand service.");
        }

        var limits = new JobObjectExtendedLimitInformation
        {
            BasicLimitInformation = new JobObjectBasicLimitInformation
            {
                LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
        };
        if (!SetInformationJobObject(
                handle,
                JobObjectInformationClass.ExtendedLimitInformation,
                ref limits,
                (uint)Marshal.SizeOf<JobObjectExtendedLimitInformation>()))
        {
            var error = Marshal.GetLastPInvokeError();
            handle.Dispose();
            throw new Win32Exception(error, "Failed to configure the Windows job object for a localCommand service.");
        }

        return new WindowsKillOnCloseJob(name, handle);
    }

    // Derive the name from the verified OS process identity so a replacement Core can open it
    // only for explicit Stop. Core keeps no job handle during normal operation or handover.
    internal static string RunnerJobName(System.Diagnostics.Process runner)
        => $"Local\\Hosty.LocalCommand.Runner.{runner.Id}.{runner.StartTime.ToUniversalTime().Ticks}";

    [SupportedOSPlatform("windows")]
    internal static WindowsKillOnCloseJob? TryOpenRunnerJob(System.Diagnostics.Process runner)
    {
        var name = RunnerJobName(runner);
        var handle = OpenJobObject(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, false, name);
        if (handle.IsInvalid)
        {
            var error = Marshal.GetLastPInvokeError();
            handle.Dispose();
            if (error == 2) return null; // A runner from before named-job support, or already exited.
            throw new IOException("Could not open the localCommand runner job.", new Win32Exception(error));
        }

        try
        {
            if (!IsProcessInJob(runner.Handle, handle, out var member) || !member)
                throw new IOException("LocalCommand runner job membership could not be verified.");
            return new WindowsKillOnCloseJob(name, handle);
        }
        catch
        {
            handle.Dispose();
            throw;
        }
    }

    // Called inside the re-execed shim, before it starts cmd.exe. Assigning the shim first is what
    // closes the race in Process.Kill(entireProcessTree): every later npm/tsx/node descendant inherits
    // membership from birth, so a fast-exiting parent cannot escape the stop-time kill.
    [SupportedOSPlatform("windows")]
    public static void AssignCurrentProcessToJob(string name)
    {
        using var handle = OpenJobObject(JOB_OBJECT_ASSIGN_PROCESS, bInheritHandle: false, name);
        if (handle.IsInvalid)
        {
            throw new Win32Exception(Marshal.GetLastPInvokeError(), $"Failed to open Windows job object '{name}'.");
        }

        if (!AssignProcessToJobObject(handle, GetCurrentProcess()))
        {
            throw new Win32Exception(Marshal.GetLastPInvokeError(), $"Failed to join Windows job object '{name}'.");
        }
    }

    internal sealed class WindowsKillOnCloseJob(string name, SafeJobHandle handle) : IDisposable
    {
        public string Name { get; } = name;

        // The runner itself is a job member. Keep its owning handle alive when a launcher exits
        // before its service descendants; an explicit Stop kills the runner and closes the job.
        public async Task WaitForDescendantsAsync()
        {
            while (true)
            {
                if (!TryGetActiveProcessCount(out var activeProcesses))
                    throw new Win32Exception(Marshal.GetLastPInvokeError(), "Failed to inspect the localCommand job.");
                if (activeProcesses <= 1) return;
                await Task.Delay(JobPollInterval);
            }
        }

        // Termination itself is asynchronous with respect to process teardown. Polling ActiveProcesses
        // keeps StopAsync from returning while a dying Node process still holds the app's port. The
        // A failed/expired wait must fail Stop instead of reporting success while ports remain held.
        // Dispose retains KILL_ON_JOB_CLOSE as the final fallback.
        public async Task TerminateAndWaitAsync(CancellationToken cancellationToken = default)
        {
            if (handle.IsClosed || handle.IsInvalid)
            {
                return;
            }

            if (!TerminateJobObject(handle, 137))
                throw new IOException("Failed to terminate the localCommand job.", new Win32Exception(Marshal.GetLastPInvokeError()));
            var stopwatch = System.Diagnostics.Stopwatch.StartNew();
            while (stopwatch.Elapsed < JobTerminationTimeout)
            {
                if (!TryGetActiveProcessCount(out var activeProcesses))
                    throw new IOException("Failed to inspect the stopping localCommand job.", new Win32Exception(Marshal.GetLastPInvokeError()));
                if (activeProcesses == 0) return;
                await Task.Delay(JobPollInterval, cancellationToken);
            }
            throw new IOException("Timed out waiting for the localCommand job to stop.");
        }

        public void Dispose() => handle.Dispose();

        private bool TryGetActiveProcessCount(out uint activeProcesses)
        {
            activeProcesses = 0;
            if (handle.IsClosed || handle.IsInvalid ||
                !QueryInformationJobObject(
                    handle,
                    JobObjectInformationClass.BasicAccountingInformation,
                    out var accounting,
                    (uint)Marshal.SizeOf<JobObjectBasicAccountingInformation>(),
                    IntPtr.Zero))
            {
                return false;
            }

            activeProcesses = accounting.ActiveProcesses;
            return true;
        }
    }

    internal sealed class SafeJobHandle() : SafeHandleZeroOrMinusOneIsInvalid(ownsHandle: true)
    {
        protected override bool ReleaseHandle() => CloseHandle(handle);
    }

    private enum JobObjectInformationClass
    {
        BasicAccountingInformation = 1,
        ExtendedLimitInformation = 9,
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicAccountingInformation
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectBasicLimitInformation
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JobObjectExtendedLimitInformation
    {
        public JobObjectBasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }
}
