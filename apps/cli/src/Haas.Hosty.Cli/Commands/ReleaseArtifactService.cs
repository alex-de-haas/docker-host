namespace Haas.Hosty.Cli.Commands;

using System.Net;
using System.Text;
using Spectre.Console;

internal sealed class ReleaseArtifactService(CommandContext context, string? releaseTag = null)
{
    // Rolling development tag every main build force-pushes; the default when no channel selects another.
    internal const string DefaultReleaseTag = "cli-dev";
    private const string ReleaseBaseUrlFormat = "https://github.com/alex-de-haas/docker-host/releases/download/{0}";
    private const int DownloadBufferSize = 81920;

    // The channel's release tag actually drives which GitHub release the CLI/Core binaries are pulled
    // from — previously this was hard-pinned to cli-dev, so `--channel <x>` silently installed cli-dev
    // regardless (L-H3). An empty/whitespace tag falls back to the rolling default.
    private readonly string releaseBaseUrl = string.Format(
        System.Globalization.CultureInfo.InvariantCulture,
        ReleaseBaseUrlFormat,
        ResolveTag(releaseTag));

    internal async Task<string?> DownloadChecksumsAsync(
        HttpClient httpClient,
        CancellationToken cancellationToken)
    {
        var checksumsBytes = await TryDownloadBytesAsync(
            httpClient,
            $"{releaseBaseUrl}/SHA256SUMS",
            "SHA256SUMS",
            cancellationToken);

        return checksumsBytes is null ? null : Encoding.UTF8.GetString(checksumsBytes);
    }

    internal async Task<byte[]> DownloadArtifactAsync(
        HttpClient httpClient,
        string artifact,
        CancellationToken cancellationToken)
        => await DownloadBytesAsync(
            httpClient,
            $"{releaseBaseUrl}/{artifact}",
            artifact,
            cancellationToken);

    // A release tag becomes a URL path segment, so constrain it to safe git-tag characters (no '/' and no
    // ".." so it can't traverse the releases path); anything else (or empty) falls back to the rolling
    // default rather than building a malformed/hostile URL.
    internal static string ResolveTag(string? releaseTag)
    {
        var tag = releaseTag?.Trim();
        if (string.IsNullOrEmpty(tag) ||
            tag.Contains("..", StringComparison.Ordinal) ||
            !tag.All(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or '-'))
        {
            return DefaultReleaseTag;
        }

        return tag;
    }

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

    internal static string RequireChecksum(string? checksums, string artifact)
        => TryFindChecksum(checksums, artifact, out var sha256)
            ? sha256
            : throw new InvalidOperationException(
                $"SHA256SUMS was unavailable or has no entry for '{artifact}'. Aborting instead of installing an unverified binary.");

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
            if (parts.Length < 2)
            {
                continue;
            }

            var filename = parts[^1].TrimStart('*');
            if (string.Equals(filename, artifact, StringComparison.Ordinal))
            {
                sha256 = parts[0];
                return true;
            }
        }

        return false;
    }
}
