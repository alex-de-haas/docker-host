using System.Diagnostics;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

// These exercise real child processes via a POSIX shell, so they are scoped to non-Windows hosts
// (CI runs on Linux; dev on macOS). Each returns early on Windows rather than assert nothing.
public sealed class ProcessRunnerTests
{
    [Fact]
    public async Task RunAsync_LargeStderrWhileStdoutOpen_DoesNotDeadlock()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        // ~120 KiB of stderr — well past the ~64 KiB pipe buffer that deadlocks a sequential
        // stdout-then-stderr reader. A 30 s ceiling turns a regression into a fast failure, not a hang.
        var result = await ProcessRunner.RunAsync(
            Shell("printf ready; i=0; while [ $i -lt 6000 ]; do printf 'stderrstderrstderr\\n' 1>&2; i=$((i+1)); done"),
            TimeSpan.FromSeconds(30));

        Assert.False(result.TimedOut);
        Assert.Equal(0, result.ExitCode);
        Assert.Equal("ready", result.StandardOutput);
        Assert.True(result.StandardError.Length > 64 * 1024, $"expected >64 KiB stderr, got {result.StandardError.Length}");
    }

    [Fact]
    public async Task RunAsync_OwnsChildStdinRatherThanInheritingCores()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        var startInfo = Shell("cat");

        var result = await ProcessRunner.RunAsync(startInfo, TimeSpan.FromSeconds(10));

        // Owning stdin is the whole point, so assert the redirect itself: an unredirected stdin hands the
        // child Core's own handle, which on Windows may be unusable (Core runs detached, and its inherit
        // flag was once cleared outright while STARTF_USESTDHANDLES demands an inheritable one). A child
        // holding a broken stdin dies the moment it re-spawns — docker exec'ing a cli-plugin failed with
        // "The request is not supported". This is the half that catches the redirect being dropped: the
        // EOF assertions below cannot, because a test host's own stdin is already at EOF, so `cat` would
        // exit cleanly even with an inherited handle.
        Assert.True(startInfo.RedirectStandardInput);
        Assert.False(result.TimedOut);
        Assert.Equal(0, result.ExitCode);
        Assert.Equal("", result.StandardOutput);
    }

    [Fact]
    public async Task RunAsync_DeadlineExceeded_KillsAndReportsTimeout()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        var stopwatch = Stopwatch.StartNew();
        var result = await ProcessRunner.RunAsync(Shell("sleep 30"), TimeSpan.FromSeconds(1));
        stopwatch.Stop();

        Assert.True(result.TimedOut);
        Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(15), $"expected a prompt kill, took {stopwatch.Elapsed}");
    }

    [Fact]
    public async Task RunAsync_ExternalCancellation_PropagatesAndKills()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(200));
        var stopwatch = Stopwatch.StartNew();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => ProcessRunner.RunAsync(Shell("sleep 30"), timeout: null, cts.Token));

        stopwatch.Stop();
        Assert.True(stopwatch.Elapsed < TimeSpan.FromSeconds(15), $"expected a prompt kill, took {stopwatch.Elapsed}");
    }

    private static ProcessStartInfo Shell(string command)
    {
        var startInfo = new ProcessStartInfo("/bin/sh");
        startInfo.ArgumentList.Add("-c");
        startInfo.ArgumentList.Add(command);
        return startInfo;
    }
}
