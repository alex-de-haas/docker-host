using System.Diagnostics;

namespace Haas.Hosty.Core;

internal readonly record struct ProcessRunResult(int ExitCode, string StandardOutput, string StandardError, bool TimedOut);

// One process-execution primitive shared by the docker CLI runner and the git runner. It closes the class
// of defects both call sites had independently:
//   1. Sequential stdout→stderr ReadToEndAsync deadlocks when a child fills the stderr pipe buffer
//      (~64 KiB) while stdout is still open. Both streams are drained concurrently here.
//   2. Cancellation previously abandoned the awaits but left the child — and a wedged docker daemon —
//      running. The whole process tree is now killed on cancellation/timeout.
//   3. An optional overall deadline bounds a genuinely stuck child.
//   4. The Process is always disposed.
internal static class ProcessRunner
{
    public static async Task<ProcessRunResult> RunAsync(
        ProcessStartInfo startInfo,
        TimeSpan? timeout = null,
        CancellationToken cancellationToken = default)
    {
        startInfo.RedirectStandardOutput = true;
        startInfo.RedirectStandardError = true;
        startInfo.UseShellExecute = false;

        using var process = new Process { StartInfo = startInfo };

        // Start exceptions (missing binary, etc.) propagate to the caller, which wraps them in its own
        // domain exception (DockerUnavailableException / AppLifecycleException).
        process.Start();

        using var deadlineCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        if (timeout is { } limit)
        {
            deadlineCts.CancelAfter(limit);
        }

        // Drain both pipes to EOF on an uncancellable token so that after a kill (below) they complete
        // naturally with whatever was captured; only WaitForExit observes the deadline/cancellation.
        var stdoutTask = process.StandardOutput.ReadToEndAsync(CancellationToken.None);
        var stderrTask = process.StandardError.ReadToEndAsync(CancellationToken.None);

        try
        {
            await process.WaitForExitAsync(deadlineCts.Token);
        }
        catch (OperationCanceledException)
        {
            KillProcessTree(process);
            var stdoutPartial = await ReadSafelyAsync(stdoutTask);
            var stderrPartial = await ReadSafelyAsync(stderrTask);

            // A genuine host/operator cancellation propagates; our own deadline firing is reported instead.
            if (cancellationToken.IsCancellationRequested)
            {
                throw;
            }

            return new ProcessRunResult(-1, stdoutPartial, stderrPartial, TimedOut: true);
        }

        var stdout = await stdoutTask;
        var stderr = await stderrTask;
        return new ProcessRunResult(process.ExitCode, stdout, stderr, TimedOut: false);
    }

    private static void KillProcessTree(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch (Exception ex) when (ex is InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException)
        {
            // Already exited or not killable — best-effort.
        }
    }

    private static async Task<string> ReadSafelyAsync(Task<string> readTask)
    {
        try
        {
            return await readTask;
        }
        catch (Exception ex) when (ex is IOException or OperationCanceledException or ObjectDisposedException)
        {
            return string.Empty;
        }
    }
}
