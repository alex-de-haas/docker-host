namespace Haas.Hosty.Cli.Commands;

using System.Security.Cryptography;
using Spectre.Console;

internal sealed class SelfUpdateService(CommandContext context)
{
    public async Task<SelfUpdateResult> UpdateAsync(CancellationToken cancellationToken = default)
    {
        var processPath = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(processPath))
        {
            throw new InvalidOperationException("Unable to resolve the current hosty executable path.");
        }

        var executableName = Path.GetFileName(processPath);
        if (!IsManagedExecutableName(executableName))
        {
            throw new InvalidOperationException($"Refusing to replace '{processPath}' because it is not a managed hosty executable.");
        }

        var artifact = ReleaseArtifactNames.GetCliArtifactName();
        var releaseArtifacts = new ReleaseArtifactService(context);

        using var httpClient = new HttpClient();
        var checksums = await releaseArtifacts.DownloadChecksumsAsync(
            httpClient,
            cancellationToken);

        var hasExpectedSha256 = ReleaseArtifactService.TryFindChecksum(checksums, artifact, out var expectedSha256);
        if (hasExpectedSha256 && CurrentExecutableMatches(processPath, expectedSha256))
        {
            context.Console.MarkupLine("[green]CLI is already up to date.[/]");
            return SelfUpdateResult.AlreadyCurrent(processPath);
        }

        var artifactBytes = await releaseArtifacts.DownloadArtifactAsync(
            httpClient,
            artifact,
            cancellationToken);

        var artifactSha256 = CalculateSha256(artifactBytes);
        if (hasExpectedSha256)
        {
            if (!string.Equals(artifactSha256, expectedSha256, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("Downloaded CLI artifact failed SHA256 verification.");
            }
        }
        else
        {
            context.Console.MarkupLine("[yellow]SHA256SUMS was not available; continuing without checksum verification.[/]");
        }

        if (CurrentExecutableMatches(processPath, artifactSha256))
        {
            context.Console.MarkupLine("[green]CLI is already up to date.[/]");
            return SelfUpdateResult.AlreadyCurrent(processPath);
        }

        var tempPath = processPath + ".download";
        await File.WriteAllBytesAsync(tempPath, artifactBytes, cancellationToken);
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(
                tempPath,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute |
                UnixFileMode.GroupRead | UnixFileMode.GroupExecute |
                UnixFileMode.OtherRead | UnixFileMode.OtherExecute);
        }

        ReplaceExecutable(tempPath, processPath);
        context.Console.MarkupLine("[green]CLI updated.[/] New version installed.");
        return SelfUpdateResult.Updated(processPath);
    }

    internal static bool CurrentExecutableMatches(string processPath, string artifactSha256)
        => string.Equals(CalculateFileSha256(processPath), artifactSha256, StringComparison.OrdinalIgnoreCase);

    internal static string CalculateSha256(byte[] bytes)
        => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    internal static void ReplaceExecutable(string tempPath, string processPath)
    {
        if (!OperatingSystem.IsWindows())
        {
            File.Move(tempPath, processPath, overwrite: true);
            return;
        }

        var backupPath = processPath + ".bak";
        File.Move(processPath, backupPath, overwrite: true);

        try
        {
            File.Move(tempPath, processPath);
        }
        catch
        {
            TryRestoreWindowsBackup(backupPath, processPath);
            throw;
        }

        TryDeleteFile(backupPath);
    }

    internal static bool IsManagedExecutableName(string executableName)
        => string.Equals(executableName, "hosty", StringComparison.Ordinal) ||
            string.Equals(executableName, "hosty.exe", StringComparison.OrdinalIgnoreCase);

    private static void TryRestoreWindowsBackup(string backupPath, string processPath)
    {
        try
        {
            if (!File.Exists(processPath) && File.Exists(backupPath))
            {
                File.Move(backupPath, processPath);
            }
        }
        catch
        {
            // Best-effort rollback; preserve the original replacement error.
        }
    }

    private static void TryDeleteFile(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch
        {
            // The renamed executable can remain locked by the current process on Windows.
        }
    }

    private static string CalculateFileSha256(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    internal static ProgressColumn[] CreateDownloadProgressColumns(long? contentLength)
        => ReleaseArtifactService.CreateDownloadProgressColumns(contentLength);

    internal static bool TryFindChecksum(string? checksums, string artifact, out string sha256)
        => ReleaseArtifactService.TryFindChecksum(checksums, artifact, out sha256);
}

internal readonly record struct SelfUpdateResult(bool WasUpdated, string ExecutablePath)
{
    public static SelfUpdateResult AlreadyCurrent(string executablePath)
        => new(false, executablePath);

    public static SelfUpdateResult Updated(string executablePath)
        => new(true, executablePath);
}
