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
//   4. The Process AND its stdout/stderr readers are always disposed. Process.Dispose() deliberately
//      leaves caller-referenced stdio readers open, so without explicit disposal each run parks two
//      pipe FDs on the finalizer queue — at the docker scrape cadence that exhausts the process FD
//      limit within the hour (observed live: catalog fetches then fail EMFILE, silently).
internal static class ProcessRunner
{
    public static async Task<ProcessRunResult> RunAsync(
        ProcessStartInfo startInfo,
        TimeSpan? timeout = null,
        CancellationToken cancellationToken = default)
    {
        startInfo.RedirectStandardOutput = true;
        startInfo.RedirectStandardError = true;
        // Own stdin too, even though nothing here writes to it. Redirecting any stream makes .NET set
        // STARTF_USESTDHANDLES, and Windows then requires every handle in STARTUPINFO to be inheritable —
        // an unredirected stdin hands the child Core's own handle, whatever state it is in (Core runs
        // detached under `cmd /c "core.exe > core.log 2>&1"`, and WindowsProcessControl used to clear its
        // inherit flag outright). A child holding a broken stdin dies the moment it re-spawns: docker
        // exec'ing a cli-plugin failed with "The request is not supported". An owned pipe, closed
        // immediately below, gives every child a valid stdin at EOF regardless of how Core was launched.
        // Both callers are non-interactive captures, and EOF is the better answer for them anyway — it
        // stops git blocking forever on a credential prompt nobody can type into.
        startInfo.RedirectStandardInput = true;
        startInfo.UseShellExecute = false;

        using var process = new Process { StartInfo = startInfo };

        // Start exceptions (missing binary, etc.) propagate to the caller, which wraps them in its own
        // domain exception (DockerUnavailableException / AppLifecycleException).
        process.Start();
        process.StandardInput.Close();

        using var deadlineCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        if (timeout is { } limit)
        {
            deadlineCts.CancelAfter(limit);
        }

        // Accessing StandardOutput/StandardError puts the streams in sync-read mode, which makes their
        // disposal the caller's job (see header point 4) — hold them so the finally below can do it.
        var stdoutReader = process.StandardOutput;
        var stderrReader = process.StandardError;
        try
        {
            // Drain both pipes to EOF on an uncancellable token so that after a kill (below) they complete
            // naturally with whatever was captured; only WaitForExit observes the deadline/cancellation.
            var stdoutTask = stdoutReader.ReadToEndAsync(CancellationToken.None);
            var stderrTask = stderrReader.ReadToEndAsync(CancellationToken.None);

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

            // WhenAll first so both reads are awaited (and observed) even if one faults — awaiting them in
            // sequence would leave the second unawaited on the first's exception, racing its disposal below.
            await Task.WhenAll(stdoutTask, stderrTask);
            var stdout = await stdoutTask;
            var stderr = await stderrTask;
            return new ProcessRunResult(process.ExitCode, stdout, stderr, TimedOut: false);
        }
        finally
        {
            // Both read tasks have been awaited on every path that reaches here, so disposing cannot
            // race an in-flight read.
            stdoutReader.Dispose();
            stderrReader.Dispose();
        }
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
