using System.Runtime.InteropServices;
using System.Security.Cryptography;

namespace Haas.Hosty.Core;

// Fast "is a newer Core available?" check for the Shell sidebar. Mirrors what `hosty update` compares:
// the installed hosty-core executable's SHA256 against the platform Core artifact's entry in the
// release SHA256SUMS. No download of the binary, no Core restart — one small HTTPS GET. The result is
// TTL-cached (and refreshes are de-duplicated) so a chatty sidebar can't storm GitHub, and only a
// managed installed executable is ever compared (a dev/source `dotnet` run reports "no update").
internal sealed class CoreUpdateCheckService(
    IHttpClientFactory httpClientFactory,
    HostyCoreRuntimeConfig config,
    ILogger<CoreUpdateCheckService> logger)
{
    internal const string HttpClientName = "core-update";
    private const string ReleaseBaseUrlFormat = "https://github.com/alex-de-haas/docker-host/releases/download/{0}";
    private const string DefaultReleaseTag = "cli-dev";
    // Short TTL so a hotfix release surfaces quickly on its own; callers can also force a fresh check
    // (the Shell forces one when the admin opens the platform panel, so no CLI trip is needed).
    private static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan FetchTimeout = TimeSpan.FromSeconds(6);

    private readonly SemaphoreSlim gate = new(1, 1);
    private CoreUpdateStatus? cached;
    // The running executable never changes on disk under us, so its hash is computed once and reused.
    private string? installedExeSha256;

    public async Task<CoreUpdateStatus> GetStatusAsync(bool forceRefresh, CancellationToken cancellationToken)
    {
        if (!forceRefresh && cached is { } fresh && !IsStale(fresh))
        {
            return fresh;
        }

        await gate.WaitAsync(cancellationToken);
        try
        {
            // Re-check under the lock: another caller may have refreshed while we waited.
            if (!forceRefresh && cached is { } stillFresh && !IsStale(stillFresh))
            {
                return stillFresh;
            }

            var status = await CheckAsync(cancellationToken);
            cached = status;
            return status;
        }
        finally
        {
            gate.Release();
        }
    }

    private static bool IsStale(CoreUpdateStatus status)
        => DateTimeOffset.UtcNow - status.CheckedAt >= CacheTtl;

    private async Task<CoreUpdateStatus> CheckAsync(CancellationToken cancellationToken)
    {
        var currentVersion = CoreStatusResponse.PlatformVersionString;
        var releaseTag = ResolveReleaseTag();

        // Only a managed installed Core exe can be matched against a release artifact by hash. A dev/source
        // run (the process path is the dotnet host) or an unknown path reports "no update" so the sidebar
        // button never shows where an update can't actually be applied.
        var exePath = Environment.ProcessPath;
        var artifactName = TryGetCoreArtifactName();
        if (exePath is null || artifactName is null || !IsManagedCoreExecutable(exePath))
        {
            return new CoreUpdateStatus(currentVersion, false, releaseTag, DateTimeOffset.UtcNow, null);
        }

        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            timeout.CancelAfter(FetchTimeout);

            var checksums = await DownloadChecksumsAsync(releaseTag, timeout.Token);
            if (checksums is null || !TryFindChecksum(checksums, artifactName, out var expected))
            {
                return new CoreUpdateStatus(currentVersion, false, releaseTag, DateTimeOffset.UtcNow, "Release checksums were unavailable.");
            }

            var installed = await GetInstalledExeSha256Async(exePath, timeout.Token);
            var updateAvailable = !string.Equals(installed, expected, StringComparison.OrdinalIgnoreCase);
            return new CoreUpdateStatus(currentVersion, updateAvailable, releaseTag, DateTimeOffset.UtcNow, null);
        }
        catch (Exception ex) when (
            ex is HttpRequestException or IOException or InvalidOperationException ||
            // Our local FetchTimeout tripping is a graceful "check failed"; a genuine caller cancellation
            // (request aborted) must propagate rather than be swallowed as a normal result.
            (ex is OperationCanceledException && !cancellationToken.IsCancellationRequested))
        {
            logger.LogDebug(ex, "Core update check against release tag {ReleaseTag} did not complete.", releaseTag);
            return new CoreUpdateStatus(currentVersion, false, releaseTag, DateTimeOffset.UtcNow, "Update check failed.");
        }
    }

    private async Task<string?> DownloadChecksumsAsync(string releaseTag, CancellationToken cancellationToken)
    {
        var baseUrl = string.Format(System.Globalization.CultureInfo.InvariantCulture, ReleaseBaseUrlFormat, releaseTag);
        var client = httpClientFactory.CreateClient(HttpClientName);
        using var response = await client.GetAsync($"{baseUrl}/SHA256SUMS", HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (response.StatusCode == System.Net.HttpStatusCode.NotFound)
        {
            return null;
        }

        response.EnsureSuccessStatusCode();
        return await response.Content.ReadAsStringAsync(cancellationToken);
    }

    private async Task<string> GetInstalledExeSha256Async(string exePath, CancellationToken cancellationToken)
    {
        if (installedExeSha256 is { } cachedHash)
        {
            return cachedHash;
        }

        await using var stream = File.OpenRead(exePath);
        var hash = await SHA256.HashDataAsync(stream, cancellationToken);
        return installedExeSha256 = Convert.ToHexString(hash).ToLowerInvariant();
    }

    // Reads the operator-selected product channel's release tag (persisted by `hosty update --channel`),
    // falling back to the rolling default. Sanitized to a safe git-tag shape so it can't traverse the
    // releases URL path.
    private string ResolveReleaseTag()
    {
        var channelPath = Path.Combine(config.DataRoot, "core", "product-channel.json");
        try
        {
            if (File.Exists(channelPath))
            {
                using var stream = File.OpenRead(channelPath);
                var channel = System.Text.Json.JsonSerializer.Deserialize(stream, CoreJson.TypeInfo<CoreProductChannelRef>());
                if (SanitizeTag(channel?.ReleaseTag) is { } tag)
                {
                    return tag;
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Text.Json.JsonException)
        {
            logger.LogDebug(ex, "Could not read product channel from {Path}; using the default release tag.", channelPath);
        }

        return DefaultReleaseTag;
    }

    private static string? SanitizeTag(string? releaseTag)
    {
        var tag = releaseTag?.Trim();
        if (string.IsNullOrEmpty(tag) ||
            tag.Contains("..", StringComparison.Ordinal) ||
            !tag.All(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '_' or '-'))
        {
            return null;
        }

        return tag;
    }

    private static bool IsManagedCoreExecutable(string exePath)
    {
        var name = Path.GetFileName(exePath);
        return string.Equals(name, "hosty-core", StringComparison.Ordinal) ||
            string.Equals(name, "hosty-core.exe", StringComparison.OrdinalIgnoreCase);
    }

    // The platform Core release artifact for the running OS/arch, matching the CLI's naming. Null on an
    // unsupported platform so the check degrades to "no update" instead of throwing.
    private static string? TryGetCoreArtifactName()
    {
        var architecture = RuntimeInformation.OSArchitecture switch
        {
            Architecture.Arm64 => "arm64",
            Architecture.X64 => "x64",
            _ => null,
        };
        if (architecture is null)
        {
            return null;
        }

        if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX))
        {
            return $"hosty-core-darwin-{architecture}";
        }

        if (RuntimeInformation.IsOSPlatform(OSPlatform.Linux))
        {
            return $"hosty-core-linux-{architecture}";
        }

        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            return architecture == "x64" ? "hosty-core-windows-x64.exe" : null;
        }

        return null;
    }

    // Parses a `sha256  filename` SHA256SUMS body for the given artifact's digest (matches the CLI parser).
    private static bool TryFindChecksum(string checksums, string artifact, out string sha256)
    {
        sha256 = string.Empty;
        foreach (var line in checksums.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            if (parts.Length < 2)
            {
                continue;
            }

            if (string.Equals(parts[^1].TrimStart('*'), artifact, StringComparison.Ordinal))
            {
                sha256 = parts[0];
                return true;
            }
        }

        return false;
    }
}

// Response for GET /api/core/update-status. UpdateAvailable is false whenever the check can't be made
// (dev run, unreachable release, unsupported platform); Error carries a short reason for logs/tooltips.
internal sealed record CoreUpdateStatus(
    string CurrentVersion,
    bool UpdateAvailable,
    string ReleaseTag,
    DateTimeOffset CheckedAt,
    string? Error);

// Minimal view over {DataRoot}/core/product-channel.json (written by the CLI); only the release tag is read.
internal sealed record CoreProductChannelRef(string? ReleaseTag);
