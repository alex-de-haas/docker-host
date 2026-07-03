using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class LocalCommandProcessReclaimTests
{
    [Fact]
    public async Task PidFile_RoundTripsThroughJsonStorage()
    {
        var appRoot = CreateTempDirectory();
        try
        {
            var pidFile = new LocalCommandPidFile(
                Pid: 4242,
                StartedAtUtc: new DateTimeOffset(2026, 7, 3, 12, 0, 0, TimeSpan.Zero),
                AppId: "com.example.app",
                ServiceKey: "web",
                ProcessGroup: true);

            await LocalCommandProcessReclaim.WriteAsync(appRoot, pidFile);

            var path = LocalCommandProcessReclaim.PidFilePath(appRoot, "web");
            Assert.True(File.Exists(path));
            var round = await JsonStorage.ReadAsync<LocalCommandPidFile>(path);
            Assert.Equal(pidFile, round);
        }
        finally
        {
            TryDeleteDirectory(appRoot);
        }
    }

    [Fact]
    public void StartTimeMatches_WithinToleranceIsTrue_BeyondIsFalse()
    {
        var recorded = new DateTimeOffset(2026, 7, 3, 12, 0, 0, TimeSpan.Zero);

        Assert.True(LocalCommandProcessReclaim.StartTimeMatches(recorded, recorded.UtcDateTime));
        Assert.True(LocalCommandProcessReclaim.StartTimeMatches(recorded, recorded.UtcDateTime.AddSeconds(1)));
        Assert.False(LocalCommandProcessReclaim.StartTimeMatches(recorded, recorded.UtcDateTime.AddSeconds(10)));
    }

    [Fact]
    public async Task ReclaimAsync_WithNoPidFile_ReturnsFalse()
    {
        var appRoot = CreateTempDirectory();
        try
        {
            var reclaimed = await LocalCommandProcessReclaim.ReclaimAsync(appRoot, "missing");
            Assert.False(reclaimed);
        }
        finally
        {
            TryDeleteDirectory(appRoot);
        }
    }

    [Fact]
    public async Task ReclaimAsync_WithStaleDeadPid_ReturnsFalseAndDeletesFile()
    {
        if (OperatingSystem.IsWindows())
        {
            return; // The child here is a POSIX shell; Core runs sh only off-Windows.
        }

        var appRoot = CreateTempDirectory();
        try
        {
            using var dead = StartShell("exit 0");
            await dead.WaitForExitAsync();
            var deadPid = dead.Id;

            await LocalCommandProcessReclaim.WriteAsync(
                appRoot,
                new LocalCommandPidFile(deadPid, DateTimeOffset.UtcNow, "com.example.app", "svc", ProcessGroup: false));

            var reclaimed = await LocalCommandProcessReclaim.ReclaimAsync(appRoot, "svc");

            Assert.False(reclaimed);
            Assert.False(File.Exists(LocalCommandProcessReclaim.PidFilePath(appRoot, "svc")));
        }
        finally
        {
            TryDeleteDirectory(appRoot);
        }
    }

    [Fact]
    public async Task ReclaimAsync_KillsLiveUntrackedProcess()
    {
        if (OperatingSystem.IsWindows())
        {
            return; // The child here is a POSIX shell; Core runs sh only off-Windows.
        }

        var appRoot = CreateTempDirectory();
        System.Diagnostics.Process? live = null;
        try
        {
            live = StartShell("sleep 30");
            await LocalCommandProcessReclaim.WriteAsync(
                appRoot,
                new LocalCommandPidFile(
                    live.Id,
                    live.StartTime.ToUniversalTime(),
                    "com.example.app",
                    "svc",
                    ProcessGroup: false));

            var reclaimed = await LocalCommandProcessReclaim.ReclaimAsync(appRoot, "svc");

            Assert.True(reclaimed);
            Assert.True(live.HasExited);
            Assert.False(File.Exists(LocalCommandProcessReclaim.PidFilePath(appRoot, "svc")));
        }
        finally
        {
            if (live is not null && !live.HasExited)
            {
                try
                {
                    live.Kill(entireProcessTree: true);
                }
                catch (InvalidOperationException)
                {
                }
            }

            live?.Dispose();
            TryDeleteDirectory(appRoot);
        }
    }

    private static System.Diagnostics.Process StartShell(string command)
    {
        var process = new System.Diagnostics.Process
        {
            StartInfo = new System.Diagnostics.ProcessStartInfo
            {
                FileName = "/bin/sh",
                UseShellExecute = false,
            },
        };
        process.StartInfo.ArgumentList.Add("-c");
        process.StartInfo.ArgumentList.Add(command);
        process.Start();
        return process;
    }

    private static string CreateTempDirectory()
    {
        var path = Path.Combine(Path.GetTempPath(), $"hosty-reclaim-tests-{Guid.NewGuid():N}");
        Directory.CreateDirectory(path);
        return path;
    }

    private static void TryDeleteDirectory(string path)
    {
        try
        {
            Directory.Delete(path, recursive: true);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}
