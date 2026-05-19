namespace Haas.DockerHost.Cli.Commands;

using System.Diagnostics;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Spectre.Console;

internal sealed class SelfUpdateService(CommandContext context)
{
    private const string ReleaseBaseUrl = "https://github.com/alex-de-haas/docker-host/releases/download/cli-dev";
    private const int DownloadBufferSize = 81920;
    internal static readonly IReadOnlyList<string> HostOnlyUpdateArguments = ["update", "--host-only"];

    public async Task<SelfUpdateResult> UpdateAsync(CancellationToken cancellationToken = default)
    {
        var processPath = Environment.ProcessPath;
        if (string.IsNullOrWhiteSpace(processPath))
        {
            throw new InvalidOperationException("Unable to resolve the current docker-host executable path.");
        }

        var executableName = Path.GetFileName(processPath);
        if (!string.Equals(executableName, "docker-host", StringComparison.Ordinal) &&
            !string.Equals(executableName, "docker-host.exe", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException($"Refusing to replace '{processPath}' because it is not the docker-host executable.");
        }

        var artifact = GetArtifactName();
        var artifactUrl = $"{ReleaseBaseUrl}/{artifact}";
        var checksumsUrl = $"{ReleaseBaseUrl}/SHA256SUMS";

        using var httpClient = new HttpClient();
        var checksums = await DownloadChecksumsAsync(
            httpClient,
            checksumsUrl,
            cancellationToken);

        var hasExpectedSha256 = TryFindChecksum(checksums, artifact, out var expectedSha256);
        if (hasExpectedSha256 && CurrentExecutableMatches(processPath, expectedSha256))
        {
            context.Console.MarkupLine("[green]CLI ready up to date.[/]");
            return SelfUpdateResult.AlreadyCurrent(processPath);
        }

        var artifactBytes = await DownloadArtifactAsync(
            httpClient,
            artifactUrl,
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
            context.Console.MarkupLine("[green]CLI ready up to date.[/]");
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

        WarmRelaunchSupport();
        File.Move(tempPath, processPath, overwrite: true);
        context.Console.MarkupLine("[green]CLI updated.[/] New version installed.");
        return SelfUpdateResult.Updated(processPath);
    }

    internal static bool CurrentExecutableMatches(string processPath, string artifactSha256)
        => string.Equals(CalculateFileSha256(processPath), artifactSha256, StringComparison.OrdinalIgnoreCase);

    internal static string CalculateSha256(byte[] bytes)
        => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    internal static async Task<int> RunUpdatedExecutableAsync(
        string executablePath,
        IReadOnlyList<string> arguments,
        CancellationToken cancellationToken = default)
    {
        using var process = Process.Start(CreateRelaunchStartInfo(executablePath, arguments))
            ?? throw new InvalidOperationException($"Unable to start the updated docker-host executable at '{executablePath}'.");

        await process.WaitForExitAsync(cancellationToken);
        return process.ExitCode;
    }

    internal static ProcessStartInfo CreateRelaunchStartInfo(string executablePath, IReadOnlyList<string> arguments)
    {
        var startInfo = new ProcessStartInfo(executablePath)
        {
            UseShellExecute = false,
        };

        foreach (var argument in arguments)
        {
            startInfo.ArgumentList.Add(argument);
        }

        return startInfo;
    }

    private static void WarmRelaunchSupport()
    {
        using var currentProcess = Process.GetCurrentProcess();
        _ = currentProcess.Id;
        _ = typeof(ProcessStartInfo).Assembly.FullName;
    }

    private static string CalculateFileSha256(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private static string GetArtifactName()
    {
        var architecture = RuntimeInformation.OSArchitecture switch
        {
            Architecture.Arm64 => "arm64",
            Architecture.X64 => "x64",
            _ => throw new PlatformNotSupportedException($"Unsupported architecture {RuntimeInformation.OSArchitecture}."),
        };

        if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
        {
            return $"docker-host-darwin-{architecture}";
        }

        if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
        {
            return $"docker-host-linux-{architecture}";
        }

        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            if (architecture != "x64")
            {
                throw new PlatformNotSupportedException("Windows CLI release assets are published for x64 only.");
            }

            return "docker-host-windows-x64.exe";
        }

        throw new PlatformNotSupportedException($"Unsupported OS {RuntimeInformation.OSDescription}.");
    }

    private async Task<string?> DownloadChecksumsAsync(
        HttpClient httpClient,
        string checksumsUrl,
        CancellationToken cancellationToken)
    {
        var checksumsBytes = await TryDownloadBytesAsync(
            httpClient,
            checksumsUrl,
            "SHA256SUMS",
            cancellationToken);

        return checksumsBytes is null ? null : Encoding.UTF8.GetString(checksumsBytes);
    }

    private async Task<byte[]> DownloadArtifactAsync(
        HttpClient httpClient,
        string artifactUrl,
        string artifact,
        CancellationToken cancellationToken)
        => await DownloadBytesAsync(
            httpClient,
            artifactUrl,
            artifact,
            cancellationToken);

    private async Task<byte[]?> TryDownloadBytesAsync(
        HttpClient httpClient,
        string url,
        string description,
        CancellationToken cancellationToken)
    {
        using var response = await httpClient.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }

        response.EnsureSuccessStatusCode();
        return await ReadResponseBytesWithProgressAsync(response, description, cancellationToken);
    }

    private async Task<byte[]> DownloadBytesAsync(
        HttpClient httpClient,
        string url,
        string description,
        CancellationToken cancellationToken)
    {
        using var response = await httpClient.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();
        return await ReadResponseBytesWithProgressAsync(response, description, cancellationToken);
    }

    private async Task<byte[]> ReadResponseBytesWithProgressAsync(
        HttpResponseMessage response,
        string description,
        CancellationToken cancellationToken)
    {
        var contentLength = response.Content.Headers.ContentLength;
        return await context.Console
            .Progress()
            .AutoClear(true)
            .HideCompleted(true)
            .Columns(CreateDownloadProgressColumns(contentLength))
            .StartAsync(progressContext => ReadResponseBytesAsync(
                response,
                description,
                progressContext,
                cancellationToken));
    }

    internal static ProgressColumn[] CreateDownloadProgressColumns(long? contentLength)
        => contentLength is > 0
            ? [
                new TaskDescriptionColumn(),
                new ProgressBarColumn(),
                new PercentageColumn(),
                new DownloadedColumn(),
                new TransferSpeedColumn(),
                new RemainingTimeColumn(),
            ]
            : [
                new TaskDescriptionColumn(),
                new SpinnerColumn(Spinner.Known.Dots),
                new DownloadedColumn(),
                new TransferSpeedColumn(),
            ];

    private static async Task<byte[]> ReadResponseBytesAsync(
        HttpResponseMessage response,
        string description,
        ProgressContext progressContext,
        CancellationToken cancellationToken)
    {
        var contentLength = response.Content.Headers.ContentLength;
        var maxValue = contentLength is > 0 ? contentLength.Value : 1;
        var progressTask = progressContext.AddTask(Markup.Escape(description), maxValue: maxValue);
        if (contentLength is null)
        {
            progressTask.IsIndeterminate();
        }

        await using var contentStream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var output = new MemoryStream(
            contentLength is > 0 and <= int.MaxValue
                ? (int)contentLength.Value
                : 0);
        var buffer = new byte[DownloadBufferSize];
        long downloaded = 0;

        while (true)
        {
            var bytesRead = await contentStream.ReadAsync(buffer, cancellationToken);
            if (bytesRead == 0)
            {
                break;
            }

            output.Write(buffer.AsSpan(0, bytesRead));
            downloaded += bytesRead;
            if (contentLength is null)
            {
                progressTask.MaxValue = Math.Max(progressTask.MaxValue, downloaded + 1);
            }

            progressTask.Value = downloaded;
        }

        if (contentLength is null)
        {
            progressTask.IsIndeterminate(false);
            progressTask.MaxValue = Math.Max(downloaded, 1);
        }

        if (downloaded > 0)
        {
            progressTask.Value = downloaded;
        }

        progressTask.StopTask();
        return output.ToArray();
    }

    internal static bool TryFindChecksum(string? checksums, string artifact, out string sha256)
    {
        sha256 = string.Empty;
        if (string.IsNullOrWhiteSpace(checksums))
        {
            return false;
        }

        foreach (var line in checksums.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (parts.Length >= 2 && string.Equals(parts[^1], artifact, StringComparison.Ordinal))
            {
                sha256 = parts[0];
                return true;
            }
        }

        return false;
    }
}

internal readonly record struct SelfUpdateResult(bool WasUpdated, string ExecutablePath)
{
    public static SelfUpdateResult AlreadyCurrent(string executablePath)
        => new(false, executablePath);

    public static SelfUpdateResult Updated(string executablePath)
        => new(true, executablePath);
}
