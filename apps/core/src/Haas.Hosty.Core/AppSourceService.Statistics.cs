using System.Globalization;

namespace Haas.Hosty.Core;

internal sealed partial class AppSourceService
{
    private const int MaxNewFileStatsBytes = 4 * 1024 * 1024;
    private const int MaxNewStatsTotalBytes = 16 * 1024 * 1024;

    public async Task<AppSourceStatus> GetWorktreeStatusAsync(string appId, CancellationToken cancellationToken = default)
    {
        var status = await ReadWorktreeStatusAsync(appId, cancellationToken);
        if (status.State is not ("clean" or "changes")) return status;
        var files = status.Files.ToArray();
        var tracked = new Dictionary<string, (AppSourceLineStats? Stats, bool Binary)>(StringComparer.Ordinal);
        var trackedComplete = status.Head is null || !files.Any(file => file.Status != "??");
        if (!trackedComplete)
        {
            try
            {
                // One compact result for the whole app scope, not one process/full patch per file.
                // HEAD -> worktree includes staging exactly once, including edits reverted on disk.
                var result = await WorktreeGitAsync(status.ScopePath!,
                    ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "--no-renames", "--relative", status.Head!, "--", "."],
                    cancellationToken, limit: MaxStatusOutput);
                trackedComplete = result.StandardOutput.Length <= MaxStatusOutput;
                foreach (var entry in result.StandardOutput.Split('\0').SkipLast(1))
                {
                    // Split only twice: a literal Git filename may contain tabs and newlines.
                    var parts = entry.Split('\t', 3);
                    if (parts.Length != 3) { trackedComplete = false; continue; }
                    if (parts[0] == "-" && parts[1] == "-") tracked[parts[2]] = (null, true);
                    else if (long.TryParse(parts[0], NumberStyles.None, CultureInfo.InvariantCulture, out var added)
                        && long.TryParse(parts[1], NumberStyles.None, CultureInfo.InvariantCulture, out var deleted))
                        tracked[parts[2]] = (new(added, deleted), false);
                    else trackedComplete = false;
                }
            }
            catch (AppLifecycleException) { /* Statistics failure must not hide the changed-file list. */ }
        }

        // Git numstat omits untracked files. Count their bytes in bounded chunks, without fetching
        // their full previews or spawning Git per file. The regular-file check rejects Unix FIFOs.
        using var newFilesDeadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        newFilesDeadline.CancelAfter(TimeSpan.FromSeconds(2));
        var regularNewFiles = new HashSet<string>(StringComparer.Ordinal);
        try
        {
            regularNewFiles = await FindRegularNewFilesAsync(status.ScopePath!,
                files.Where(file => status.Head is null || file.Status == "??").Select(file => file.Path), newFilesDeadline.Token);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or AppLifecycleException) { }
        var remainingBytes = MaxNewStatsTotalBytes;
        for (var index = 0; index < files.Length; index++)
        {
            var file = files[index];
            if (file.Status.Contains('U') || file.Status is "AA" or "DD" || !IsRegularSourcePath(status.ScopePath!, file.Path)) continue;
            if (status.Head is not null && file.Status != "??")
            {
                if (tracked.TryGetValue(file.Path, out var stats)) files[index] = file with { LineStats = stats.Stats, Binary = stats.Binary };
                else if (trackedComplete) files[index] = file with { LineStats = new(0, 0) };
                continue;
            }
            if (remainingBytes <= 0 || newFilesDeadline.IsCancellationRequested || !regularNewFiles.Contains(file.Path)) continue;
            try
            {
                var fullPath = Path.Combine(status.ScopePath!, file.Path);
                await using var stream = File.OpenRead(fullPath);
                var buffer = new byte[8192];
                long lines = 0;
                var bytes = 0;
                var lastByte = -1;
                var complete = false;
                var binary = false;
                while (remainingBytes > 0 && bytes <= MaxNewFileStatsBytes)
                {
                    var count = await stream.ReadAsync(buffer.AsMemory(0, Math.Min(buffer.Length, remainingBytes)), newFilesDeadline.Token);
                    if (count == 0) { complete = true; break; }
                    bytes += count;
                    remainingBytes -= count;
                    if (buffer.AsSpan(0, count).Contains((byte)0)) { binary = true; break; }
                    lines += buffer.AsSpan(0, count).Count((byte)'\n');
                    lastByte = buffer[count - 1];
                }
                if (!IsRegularSourcePath(status.ScopePath!, file.Path)) continue;
                if (binary) files[index] = file with { Binary = true };
                else if (complete && bytes <= MaxNewFileStatsBytes)
                    files[index] = file with { LineStats = new(lines + (lastByte >= 0 && lastByte != '\n' ? 1 : 0), 0) };
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested) { }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or AppLifecycleException) { }
        }
        cancellationToken.ThrowIfCancellationRequested();
        var totalsKnown = !status.Truncated && files.All(file => file.LineStats is not null || file.Binary);
        return status with
        {
            Files = files,
            LineStats = totalsKnown ? new(files.Sum(file => file.LineStats?.Additions ?? 0), files.Sum(file => file.LineStats?.Deletions ?? 0)) : null
        };
    }

    private static async Task<HashSet<string>> FindRegularNewFilesAsync(string scope, IEnumerable<string> paths,
        CancellationToken cancellationToken)
    {
        var regular = new HashSet<string>(StringComparer.Ordinal);
        foreach (var batch in paths.Where(path => IsRegularSourcePath(scope, path)).Chunk(64))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (OperatingSystem.IsWindows())
            {
                foreach (var path in batch)
                {
                    var fullPath = Path.Combine(scope, path);
                    if (File.Exists(fullPath) && (File.GetAttributes(fullPath) & FileAttributes.Device) == 0) regular.Add(path);
                }
                continue;
            }
            // POSIX test is a shell builtin. Check a bounded batch with one process instead of
            // starting /bin/test for every untracked file. Paths are positional arguments only;
            // none are interpolated into shell code. NUL output preserves literal tabs/newlines.
            var start = new System.Diagnostics.ProcessStartInfo("/bin/sh") { WorkingDirectory = scope };
            start.ArgumentList.Add("-c");
            start.ArgumentList.Add("for path do if test -f \"$path\" && test ! -L \"$path\"; then printf '%s\\0' \"$path\"; fi; done");
            start.ArgumentList.Add("hosty-source-file-check");
            foreach (var path in batch) start.ArgumentList.Add(path);
            var result = await ProcessRunner.RunAsync(start, TimeSpan.FromSeconds(2), cancellationToken, outputLimit: MaxStatusOutput);
            if (result.TimedOut || result.ExitCode != 0) break;
            foreach (var path in result.StandardOutput.Split('\0').SkipLast(1)) regular.Add(path);
        }
        return regular;
    }
}
