using System.Diagnostics;
using System.Text.Json;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Cli.Commands;

internal static class CoreBuildRepository
{
    internal static async Task<string?> ReadAsync(string project, CancellationToken ct = default)
    {
        var directory = Path.GetDirectoryName(Path.GetFullPath(project))!;
        var remote = await Git(directory, ["config", "--get", "remote.origin.url"], ct);
        if (CoreBuildProvenance.SafeRepository(remote) is { } url) return url;
        // Registered Core worktrees intentionally have no arbitrary origin remote.
        var top = await Git(directory, ["rev-parse", "--show-toplevel"], ct);
        var common = await Git(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"], ct);
        if (top is null || common is null || !Path.IsPathFullyQualified(common)) return null;
        var id = Path.GetFileName(top);
        if (id.Length != 64 || id.Any(c => !char.IsAsciiHexDigit(c))) return null;
        var repositories = Path.GetDirectoryName(common);
        if (Path.GetFileName(repositories) != "repositories") return null;
        var record = Path.Combine(Path.GetDirectoryName(repositories)!, "workspaces", id + ".json");
        try
        {
            using var json = JsonDocument.Parse(await File.ReadAllTextAsync(record, ct));
            var root = json.RootElement;
            if (!root.TryGetProperty("path", out var path) || path.GetString() is not { } recordedPath
                || Path.GetFileName(recordedPath) != id
                || await Git(recordedPath, ["rev-parse", "--show-toplevel"], ct) != top
                || !root.TryGetProperty("repository", out var repository)) return null;
            return CoreBuildProvenance.SafeRepository(repository.GetString());
        }
        catch (Exception ex) when (ex is IOException or JsonException or ArgumentException or UnauthorizedAccessException or InvalidOperationException) { return null; }
    }

    internal static async Task<string?> ReadOriginAsync(string directory, CancellationToken ct = default)
        => CoreBuildProvenance.SafeRepository(await Git(directory, ["config", "--get", "remote.origin.url"], ct));

    private static async Task<string?> Git(string directory, string[] args, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(TimeSpan.FromSeconds(10));
        var start = new ProcessStartInfo("git") { WorkingDirectory = directory, UseShellExecute = false,
            RedirectStandardError = true, RedirectStandardOutput = true };
        foreach (var arg in args) start.ArgumentList.Add(arg);
        try
        {
            using var process = Process.Start(start)!;
            try
            {
                var output = process.StandardOutput.ReadToEndAsync(timeout.Token);
                var error = process.StandardError.ReadToEndAsync(timeout.Token);
                await process.WaitForExitAsync(timeout.Token);
                await error;
                return process.ExitCode == 0 ? (await output).Trim() : null;
            }
            finally { if (!process.HasExited) process.Kill(true); }
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or IOException) { return null; }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { return null; }
    }
}
