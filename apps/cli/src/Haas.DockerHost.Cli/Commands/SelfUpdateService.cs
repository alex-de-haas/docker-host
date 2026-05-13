namespace Haas.DockerHost.Cli.Commands;

using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Spectre.Console;

internal sealed class SelfUpdateService(CommandContext context)
{
    private const string ReleaseBaseUrl = "https://github.com/alex-de-haas/docker-host/releases/download/cli-dev";

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
        context.Console.MarkupLine($"Downloading CLI artifact [grey]{Markup.Escape(artifact)}[/]...");

        var checksums = await TryDownloadTextAsync(httpClient, checksumsUrl, cancellationToken);
        var artifactBytes = await DownloadBytesAsync(httpClient, artifactUrl, cancellationToken);

        if (TryFindChecksum(checksums, artifact, out var expectedSha256))
        {
            var actualSha256 = Convert.ToHexString(SHA256.HashData(artifactBytes)).ToLowerInvariant();
            if (!string.Equals(actualSha256, expectedSha256, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("Downloaded CLI artifact failed SHA256 verification.");
            }
        }
        else
        {
            context.Console.MarkupLine("[yellow]SHA256SUMS was not available; continuing without checksum verification.[/]");
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
        context.Console.MarkupLine($"[green]CLI updated.[/] Current process continues as {Assembly.GetExecutingAssembly().GetName().Version} until the next invocation.");
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

    private static async Task<string?> TryDownloadTextAsync(HttpClient httpClient, string url, CancellationToken cancellationToken)
    {
        using var response = await httpClient.GetAsync(url, cancellationToken);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }

        response.EnsureSuccessStatusCode();
        return await response.Content.ReadAsStringAsync(cancellationToken);
    }

    private static async Task<byte[]> DownloadBytesAsync(HttpClient httpClient, string url, CancellationToken cancellationToken)
    {
        using var response = await httpClient.GetAsync(url, cancellationToken);
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadAsByteArrayAsync(cancellationToken);
    }

    private static bool TryFindChecksum(string? checksums, string artifact, out string sha256)
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

