namespace Haas.Hosty.Cli.Commands;

using Haas.Hosty.Cli.Configuration;
using Spectre.Console;
using Haas.Hosty.Launch;
using Haas.Hosty.Releases;

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
        using var client = new HttpClient { Timeout = Timeout.InfiniteTimeSpan };
        var reader = new PlatformReleaseReader(client);
        var cliPath = Environment.ProcessPath ?? throw new InvalidOperationException("The installed CLI path is unavailable.");
        if (PlatformLegacyPins.Read(cliPath) is { } legacy && PlatformFeedFiles.ReadSource(context.Environment.RootDirectory) is null)
        {
            if (!SelfUpdateService.CurrentExecutableMatches(cliPath, legacy.CliSha256))
                throw new PlatformReleaseException("platform_legacy_pin_mismatch", "The installed CLI differs from its legacy pin receipt.");
            var artifact = ReleaseArtifactNames.GetCoreArtifactName();
            var reference = $"https://github.com/{legacy.Repository}/releases/download/{legacy.Tag}/{artifact}";
            using var response = await client.GetAsync(reference, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
            response.EnsureSuccessStatusCode();
            if (response.RequestMessage?.RequestUri?.Scheme != "https") throw new InvalidOperationException("Legacy asset redirected away from HTTPS.");
            if (response.Content.Headers.ContentLength is not { } size || size <= 0)
                throw new InvalidOperationException("Legacy asset size is unavailable; select a feed or a complete immutable release.");
            var legacyAsset = new PlatformReleaseAsset("core", legacy.Rid, artifact, reference, size, legacy.CoreSha256, legacy.CoreSha256, "legacy checksum snapshot");
            var legacyStaged = executablePath + ".bootstrap";
            await reader.StageAssetAsync(legacyAsset, legacyStaged, false, cancellationToken);
            File.Move(legacyStaged, executablePath, overwrite: false);
            return CoreInstallationResult.Installed(executablePath);
        }
        var bootstrap = PlatformFeedSource.ReadBootstrap(cliPath);
        PlatformReleaseSelection selection;
        if (bootstrap is not null)
        {
            await PlatformFeedSource.VerifyBootstrapAsync(bootstrap, cliPath, cancellationToken);
            selection = bootstrap.Selection;
        }
        else
        {
            selection = await PlatformFeedSource.ResolveAsync(reader, context.Environment.RootDirectory, executable: cliPath, ct: cancellationToken);
            if (!await PlatformReleaseReader.MatchesAssetAsync(cliPath, PlatformReleaseReader.Asset(selection.Release, "cli", PlatformFeedSource.CurrentRid), cancellationToken))
                throw new PlatformReleaseException("platform_pair_mismatch", "The selected Core belongs to another CLI release. Run hosty update to prepare the pair.");
        }
        var asset = PlatformReleaseReader.Asset(selection.Release, "core", PlatformFeedSource.CurrentRid);
        var staged = executablePath + ".bootstrap";
        await reader.StageAssetAsync(asset, staged, PlatformReleaseReader.IsLocalReference(selection.Source.IndexRef), cancellationToken);
        Directory.CreateDirectory(Path.GetDirectoryName(executablePath)!);
        File.Move(staged, executablePath, overwrite: false);
        var previous = PlatformFeedFiles.ReadSource(context.Environment.RootDirectory);
        if (previous is null) PlatformFeedFiles.SaveSource(context.Environment.RootDirectory, selection.Source, null);
        CoreLaunchFiles.Write(PlatformFeedFiles.ReceiptPath(context.Environment.RootDirectory),
            new PlatformInstallReceipt("hosty-platform-install.0.1", selection, PlatformFeedSource.CurrentRid, DateTimeOffset.UtcNow),
            PlatformReleaseJson.Default.PlatformInstallReceipt);
        return CoreInstallationResult.Installed(executablePath);
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
