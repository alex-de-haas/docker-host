namespace Haas.Hosty.Cli.Commands;

using System.Diagnostics;

// Liveness checks for a Core process the CLI did not spawn, keyed by the PID recorded in
// control.json. Used to (a) ignore and clean a stale discovery file left by a hard-killed Core,
// and (b) wait for `stop`/`restart`/`update` until the old Core has fully exited before starting a
// new one — the HTTP /core/stop call only signals shutdown, it does not wait for it.
internal static class ProcessLiveness
{
    // True when a process with this id is currently running, on any owner. Process.GetProcessById
    // returns a handle only for a live process and throws ArgumentException otherwise, which is the
    // cheapest cross-platform liveness probe (no signal-send permission required on Unix).
    public static bool IsAlive(int processId)
    {
        if (processId <= 0)
        {
            return false;
        }

        try
        {
            using var process = Process.GetProcessById(processId);
            return true;
        }
        catch (ArgumentException)
        {
            // Documented "no process with this id" signal — definitively not running.
            return false;
        }
        catch (Exception)
        {
            // Any other failure (e.g. a Win32Exception/UnauthorizedAccessException querying a
            // process we cannot access on Windows) is indeterminate, not proof of death. Treat it
            // as alive so a probe error never makes a caller delete a live Core's discovery file or
            // declare a stop complete prematurely. Worst case the wait below times out honestly.
            return true;
        }
    }

    // Polls until the process exits or the timeout elapses. Returns true once it is gone. A
    // non-positive pid is treated as "already gone" so callers without a recorded PID fall through.
    public static async Task<bool> WaitForExitAsync(int processId, TimeSpan timeout, CancellationToken cancellationToken = default)
    {
        if (processId <= 0)
        {
            return true;
        }

        var deadline = DateTimeOffset.UtcNow + timeout;
        while (DateTimeOffset.UtcNow < deadline)
        {
            if (!IsAlive(processId))
            {
                return true;
            }

            await Task.Delay(TimeSpan.FromMilliseconds(200), cancellationToken);
        }

        return !IsAlive(processId);
    }
}
