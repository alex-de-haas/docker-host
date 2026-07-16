using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class CoreCliLauncherTests : IDisposable
{
    private readonly string logDirectory = Directory.CreateTempSubdirectory("hosty-cli-launcher-tests").FullName;

    public void Dispose()
    {
        try
        {
            Directory.Delete(logDirectory, recursive: true);
        }
        catch (IOException)
        {
            // A file kept open by the lock-simulation test on Windows; the OS temp cleaner gets it later.
        }
    }

    // Every spawn logs to its own file: a reused name wedges the next spawn's redirect on Windows once
    // the previous helper's handle leaked into a surviving process tree (the core.log failure of #192,
    // reproduced by the Shell's Update button with core-update.log).
    [Fact]
    public void BuildLogFileName_StampsTheBaseName()
    {
        var timestamp = new DateTimeOffset(2026, 7, 16, 13, 0, 45, 123, TimeSpan.Zero);

        Assert.Equal("core-update-20260716-130045123.log", CoreCliLauncher.BuildLogFileName("core-update.log", timestamp));
        Assert.Equal("core-restart-20260716-130045123.log", CoreCliLauncher.BuildLogFileName("core-restart.log", timestamp));
    }

    [Fact]
    public void BuildLogFileName_UsesUtcRegardlessOfOffset()
    {
        var local = new DateTimeOffset(2026, 7, 16, 15, 0, 45, 123, TimeSpan.FromHours(2));

        Assert.Equal("core-update-20260716-130045123.log", CoreCliLauncher.BuildLogFileName("core-update.log", local));
    }

    [Fact]
    public void CleanUpStaleLogs_RemovesTimestampedAndLegacyLogsForTheBaseNameOnly()
    {
        var staleTimestamped = CreateLog("core-update-20260716-110900000.log");
        var staleLegacy = CreateLog("core-update.log");
        var otherOperation = CreateLog("core-restart-20260716-110900000.log");
        var unrelated = CreateLog("core.log");

        CoreCliLauncher.CleanUpStaleLogs(logDirectory, "core-update.log");

        Assert.False(File.Exists(staleTimestamped));
        Assert.False(File.Exists(staleLegacy));
        Assert.True(File.Exists(otherOperation));
        Assert.True(File.Exists(unrelated));
    }

    // The sweep must only claim names BuildLogFileName could have produced: a prefix-sharing file an
    // operator left in the logs directory is not a stale spawn log, even though the wildcard matches it.
    [Fact]
    public void CleanUpStaleLogs_LeavesPrefixSharingFilesWithoutTheStamp()
    {
        var operatorNotes = CreateLog("core-update-notes.log");
        var malformedStamp = CreateLog("core-update-20269999-999999999.log");
        var staleTimestamped = CreateLog("core-update-20260716-110900000.log");

        CoreCliLauncher.CleanUpStaleLogs(logDirectory, "core-update.log");

        Assert.True(File.Exists(operatorNotes));
        Assert.True(File.Exists(malformedStamp));
        Assert.False(File.Exists(staleTimestamped));
    }

    // The exact situation on a wedged host: an old log is still held open by a process tree that
    // inherited its handle. Cleanup must skip it silently — the spawn proceeds on a fresh name.
    [Fact]
    public void CleanUpStaleLogs_LeavesAnOpenLogWithoutThrowing()
    {
        var heldLog = CreateLog("core-update-20260716-110900000.log");
        var deletableLog = CreateLog("core-update.log");

        using var holder = new FileStream(heldLog, FileMode.Open, FileAccess.Read, FileShare.None);
        CoreCliLauncher.CleanUpStaleLogs(logDirectory, "core-update.log");

        Assert.False(File.Exists(deletableLog));
        // Only Windows refuses to delete an open file; POSIX unlinks it. Either way the call returned.
        if (OperatingSystem.IsWindows())
        {
            Assert.True(File.Exists(heldLog));
        }
    }

    [Fact]
    public void CleanUpStaleLogs_ToleratesAMissingDirectory()
    {
        CoreCliLauncher.CleanUpStaleLogs(Path.Combine(logDirectory, "does-not-exist"), "core-update.log");
    }

    private string CreateLog(string fileName)
    {
        var path = Path.Combine(logDirectory, fileName);
        File.WriteAllText(path, "log");
        return path;
    }
}
