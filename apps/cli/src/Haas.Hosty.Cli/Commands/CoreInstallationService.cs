namespace Haas.Hosty.Cli.Commands;

using Haas.Hosty.Cli.Configuration;
using Spectre.Console;

internal sealed class CoreInstallationService(CommandContext context)
{
    internal async Task<CoreInstallationResult> EnsureInstalledAsync(CancellationToken cancellationToken = default)
    {
        var executablePath = GetInstalledExecutablePath(context.Environment);
        if (File.Exists(executablePath))
        {
            return CoreInstallationResult.AlreadyCurrent(executablePath);
        }

        context.Console.MarkupLine("[yellow]Hosty Core executable is not installed; downloading it now.[/]");
        return await DownloadAndInstallAsync(executablePath, releaseTag: null, cancellationToken);
    }

    internal async Task<CoreInstallationResult> UpdateAsync(string? releaseTag = null, CancellationToken cancellationToken = default)
    {
        var executablePath = GetInstalledExecutablePath(context.Environment);
        return await DownloadAndInstallAsync(executablePath, releaseTag, cancellationToken);
    }

    internal static string GetInstalledExecutablePath(HostyEnvironment environment)
        => Path.Combine(
            environment.RootDirectory,
            "core",
            "bin",
            ReleaseArtifactNames.GetInstalledCoreExecutableName());

    private async Task<CoreInstallationResult> DownloadAndInstallAsync(
        string executablePath,
        string? releaseTag,
        CancellationToken cancellationToken)
    {
        var artifact = ReleaseArtifactNames.GetCoreArtifactName();
        var releaseArtifacts = new ReleaseArtifactService(context, releaseTag);

        // No overall client timeout: the default 100 s would cancel a large streamed Core-binary download
        // even under ResponseHeadersRead; cancellation comes from the caller's token instead (L-M1).
        using var httpClient = new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
        var checksums = await releaseArtifacts.DownloadChecksumsAsync(httpClient, cancellationToken);
        var expectedSha256 = ReleaseArtifactService.RequireChecksum(checksums, artifact);
        if (File.Exists(executablePath) &&
            SelfUpdateService.CurrentExecutableMatches(executablePath, expectedSha256))
        {
            context.Console.MarkupLine("[green]Hosty Core is already up to date.[/]");
            return CoreInstallationResult.AlreadyCurrent(executablePath);
        }

        var artifactBytes = await releaseArtifacts.DownloadArtifactAsync(httpClient, artifact, cancellationToken);
        var artifactSha256 = SelfUpdateService.CalculateSha256(artifactBytes);
        if (!string.Equals(artifactSha256, expectedSha256, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("Downloaded Hosty Core artifact failed SHA256 verification.");
        }

        var wasInstalled = !File.Exists(executablePath);
        var directory = Path.GetDirectoryName(executablePath) ??
            throw new InvalidOperationException("Unable to resolve Hosty Core install directory.");
        Directory.CreateDirectory(directory);

        var tempPath = executablePath + ".download";
        await File.WriteAllBytesAsync(tempPath, artifactBytes, cancellationToken);
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(
                tempPath,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute |
                UnixFileMode.GroupRead | UnixFileMode.GroupExecute |
                UnixFileMode.OtherRead | UnixFileMode.OtherExecute);
        }

        ReplaceOrInstallExecutable(tempPath, executablePath);

        context.Console.MarkupLine(wasInstalled
            ? "[green]Hosty Core installed.[/]"
            : "[green]Hosty Core updated.[/]");
        return wasInstalled
            ? CoreInstallationResult.Installed(executablePath)
            : CoreInstallationResult.Updated(executablePath);
    }

    private static void ReplaceOrInstallExecutable(string tempPath, string executablePath)
    {
        if (!OperatingSystem.IsWindows())
        {
            File.Move(tempPath, executablePath, overwrite: true);
            return;
        }

        if (!File.Exists(executablePath))
        {
            File.Move(tempPath, executablePath);
            return;
        }

        SelfUpdateService.ReplaceExecutable(tempPath, executablePath);
    }
}

internal readonly record struct CoreInstallationResult(bool WasChanged, bool WasInstalled, string ExecutablePath)
{
    public static CoreInstallationResult AlreadyCurrent(string executablePath)
        => new(false, false, executablePath);

    public static CoreInstallationResult Installed(string executablePath)
        => new(true, true, executablePath);

    public static CoreInstallationResult Updated(string executablePath)
        => new(true, false, executablePath);
}
