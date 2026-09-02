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
    // Enough for any version line with room to spare, small enough that a wrong file is discarded
    // rather than read into memory.
    private const int MaxVersionMarkerLength = 256;

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

            // Both files come from the same release; fetching them back to back would spend two
            // round-trips of the same short budget on what is one look at the channel. The marker
            // runs on the caller's token rather than this timeout, and owns its deadline: sharing
            // the budget let a marker request that outlived a completed checksum fetch cancel into
            // the outer catch and report "Update check failed" for a comparison that had already
            // succeeded. An optional field must not be able to suppress the verdict.
            var checksumsTask = DownloadChecksumsAsync(releaseTag, timeout.Token);
            var availableVersionTask = DownloadAvailableVersionAsync(releaseTag, cancellationToken);
            await Task.WhenAll(checksumsTask, availableVersionTask);
            var checksums = await checksumsTask;
            var availableVersion = await availableVersionTask;
            if (checksums is null || !TryFindChecksum(checksums, artifactName, out var expected))
            {
                return new CoreUpdateStatus(currentVersion, false, releaseTag, DateTimeOffset.UtcNow, "Release checksums were unavailable.", availableVersion);
            }

            var installed = await GetInstalledExeSha256Async(exePath, timeout.Token);
            var updateAvailable = !string.Equals(installed, expected, StringComparison.OrdinalIgnoreCase);
            return new CoreUpdateStatus(currentVersion, updateAvailable, releaseTag, DateTimeOffset.UtcNow, null, availableVersion);
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

    // The release's VERSION marker: the version an update from this channel would install. Purely
    // additive to the verdict, so every failure mode ends at null — a release published before the
    // marker existed (404), an unreachable host, or a body that does not read like a version at all.
    // The body is length-capped before parsing: this is an untrusted download whose only job is to be
    // rendered, and a client must never be handed a megabyte of prose as a "version".
    private async Task<string?> DownloadAvailableVersionAsync(string releaseTag, CancellationToken cancellationToken)
    {
        // Its own deadline, linked to the caller only. The filter below then reads unambiguously: an
        // OperationCanceledException while the caller's token is still live is this deadline firing,
        // which is a marker we could not read; a cancelled caller (the request went away) is not, and
        // propagates like any other.
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(FetchTimeout);
        try
        {
            var baseUrl = string.Format(System.Globalization.CultureInfo.InvariantCulture, ReleaseBaseUrlFormat, releaseTag);
            var client = httpClientFactory.CreateClient(HttpClientName);
            using var response = await client.GetAsync($"{baseUrl}/VERSION", HttpCompletionOption.ResponseHeadersRead, timeout.Token);
            if (!response.IsSuccessStatusCode)
            {
                return null;
            }

            // Bounded read rather than ReadAsStringAsync: the cap is only worth anything if it is
            // applied to the transfer, not to a string that has already been materialized.
            await using var stream = await response.Content.ReadAsStreamAsync(timeout.Token);
            var buffer = new byte[MaxVersionMarkerLength];
            var read = await stream.ReadAtLeastAsync(buffer, buffer.Length, throwOnEndOfStream: false, timeout.Token);
            return SanitizeVersion(System.Text.Encoding.UTF8.GetString(buffer, 0, read));
        }
        catch (Exception ex) when (
            ex is HttpRequestException or IOException or InvalidOperationException ||
            (ex is OperationCanceledException && !cancellationToken.IsCancellationRequested))
        {
            logger.LogDebug(ex, "Core release version marker for tag {ReleaseTag} was not readable.", releaseTag);
            return null;
        }
    }

    // Accepts only what a released platform version can look like: one short line starting with a
    // digit, then digits, dots, and the letters/hyphens a prerelease suffix uses. Anything else — an
    // error page, a body long enough to have been truncated by the read cap, a file that is simply
    // not this one — is not a version and is reported as none.
    //
    // The leading digit is load-bearing, not decoration: clients render this next to a version they
    // prefix themselves, so a marker written as `v0.97.0` would reach the Shell's platform row as
    // `vv0.97.0`. The marker carries the bare version; a `v` belongs to whoever displays it.
    internal static string? SanitizeVersion(string body)
    {
        var version = body.Trim();
        return version.Length is > 0 and <= 64 &&
            char.IsAsciiDigit(version[0]) &&
            version.All(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '-' or '+')
                ? version
                : null;
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
    string? Error,
    // The version the release channel is publishing, from the release's own VERSION marker. Display
    // only: `UpdateAvailable` is and stays the hash comparison, so a missing, unreadable, or
    // implausible marker degrades to null rather than changing the verdict. Null is expected against
    // a release published before the marker existed — a client then names no version, exactly as it
    // did before this field. Additive — older clients ignore it.
    string? AvailableVersion = null);

// Minimal view over {DataRoot}/core/product-channel.json (written by the CLI); only the release tag is read.
internal sealed record CoreProductChannelRef(string? ReleaseTag);
