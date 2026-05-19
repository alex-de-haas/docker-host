namespace Haas.DockerHost.Cli.Commands;

using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Spectre.Console;

internal sealed class SelfUpdateService(CommandContext context)
{
    private const string ReleaseBaseUrl = "https://github.com/alex-de-haas/docker-host/releases/download/cli-dev";
    private const int DownloadBufferSize = 81920;

    public async Task UpdateAsync(CancellationToken cancellationToken = default)
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
            return;
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
            return;
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

        File.Move(tempPath, processPath, overwrite: true);
        context.Console.MarkupLine($"[green]CLI updated.[/] New version installed. Current process continues as {Assembly.GetExecutingAssembly().GetName().Version} until the next invocation.");
    }

    internal static bool CurrentExecutableMatches(string processPath, string artifactSha256)
        => string.Equals(CalculateFileSha256(processPath), artifactSha256, StringComparison.OrdinalIgnoreCase);

    internal static string CalculateSha256(byte[] bytes)
        => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

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
        var checksumsBytes = await DownloadWithProgressAsync(
            progressContext => TryDownloadBytesAsync(
                httpClient,
                checksumsUrl,
                "SHA256SUMS",
                progressContext,
                cancellationToken));

        return checksumsBytes is null ? null : Encoding.UTF8.GetString(checksumsBytes);
    }

    private async Task<byte[]> DownloadArtifactAsync(
        HttpClient httpClient,
        string artifactUrl,
        string artifact,
        CancellationToken cancellationToken)
        => await DownloadWithProgressAsync(
            progressContext => DownloadBytesAsync(
                httpClient,
                artifactUrl,
                artifact,
                progressContext,
                cancellationToken));

    private async Task<T> DownloadWithProgressAsync<T>(Func<ProgressContext, Task<T>> download)
        => await context.Console
            .Progress()
            .AutoClear(true)
            .HideCompleted(true)
            .Columns(
                new TaskDescriptionColumn(),
                new ProgressBarColumn(),
                new PercentageColumn(),
                new DownloadedColumn(),
                new TransferSpeedColumn(),
                new RemainingTimeColumn())
            .StartAsync(download);

    private static async Task<byte[]?> TryDownloadBytesAsync(
        HttpClient httpClient,
        string url,
        string description,
        ProgressContext progressContext,
        CancellationToken cancellationToken)
    {
        using var response = await httpClient.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }

        response.EnsureSuccessStatusCode();
        return await ReadResponseBytesAsync(response, description, progressContext, cancellationToken);
    }

    private static async Task<byte[]> DownloadBytesAsync(
        HttpClient httpClient,
        string url,
        string description,
        ProgressContext progressContext,
        CancellationToken cancellationToken)
    {
        using var response = await httpClient.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        response.EnsureSuccessStatusCode();
        return await ReadResponseBytesAsync(response, description, progressContext, cancellationToken);
    }

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
