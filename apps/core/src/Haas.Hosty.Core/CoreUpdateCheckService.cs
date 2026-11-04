using Haas.Hosty.Launch;
using Haas.Hosty.Releases;
using System.Security.Cryptography;

namespace Haas.Hosty.Core;

internal sealed class CoreUpdateCheckService(IHttpClientFactory httpClientFactory, HostyCoreRuntimeConfig config,
    ILogger<CoreUpdateCheckService> logger)
{
    internal const string HttpClientName = "core-update";
    private readonly SemaphoreSlim gate = new(1, 1);
    private CoreUpdateStatus? cached;
    private string? cachedRevision;
    private static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(5);

    public async Task<CoreUpdateStatus> GetStatusAsync(bool forceRefresh, CancellationToken ct)
    {
        await gate.WaitAsync(ct);
        try
        {
            var source = PlatformFeedFiles.ReadSource(config.DataRoot);
            if (PlatformAcceptedUpdates.Pending(config.DataRoot) is { } pending)
                return new(CoreStatusResponse.PlatformVersionString, false, pending.Selection.Source.FeedId, DateTimeOffset.UtcNow,
                    pending.Error, pending.Selection.Release.Version, FeedId: pending.Selection.Source.FeedId,
                    ReleaseId: pending.Selection.Release.ReleaseId, OfferId: pending.OfferId, Readiness: "recovery-required",
                    SourceRevision: pending.Selection.Source.Revision, OperationId: pending.Id);
            if (!forceRefresh && cached is { } status && source?.Revision == cachedRevision && DateTimeOffset.UtcNow - status.CheckedAt < CacheTtl)
                return status;
            cachedRevision = source?.Revision;
            cached = MergeStatus(cached, await CheckAsync(source, ct));
            return cached;
        }
        catch (Exception ex) when (ex is InvalidOperationException or IOException or System.Text.Json.JsonException)
        {
            return cached = MergeStatus(cached, Failure(null, ex));
        }
        finally { gate.Release(); }
    }

    internal static CoreUpdateStatus MergeStatus(CoreUpdateStatus? previous, CoreUpdateStatus status)
        => status.Error is null ? status with { LastSuccessfulCheckAt = status.CheckedAt }
            : previous is not null && previous.CurrentVersion == status.CurrentVersion && previous.ReleaseTag == status.ReleaseTag
                ? status with { UpdateAvailable = false, OfferId = null,
                    LastSuccessfulCheckAt = previous.LastSuccessfulCheckAt ?? (previous.Error is null ? previous.CheckedAt : null) }
                : status;

    private async Task<CoreUpdateStatus> CheckAsync(PlatformUpdateSource? source, CancellationToken ct)
    {
        var current = CoreStatusResponse.PlatformVersionString;
        var executable = Environment.ProcessPath;
        if (executable is null || Path.GetFileName(executable) is not ("hosty-core" or "hosty-core.exe")
            || CoreLaunchIdentity.Current().Mode == "dev")
            return new(current, false, source?.FeedId ?? "", DateTimeOffset.UtcNow, null, Readiness: "not-applicable", FeedId: source?.FeedId);
        try
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
            deadline.CancelAfter(TimeSpan.FromSeconds(20));
            var reader = new PlatformReleaseReader(httpClientFactory.CreateClient(HttpClientName));
            var selection = await PlatformFeedSource.ResolveAsync(reader, config.DataRoot, executable: CoreCliLauncher.ResolveCliPath(), ct: deadline.Token);
            if (PlatformFeedFiles.ReadSource(config.DataRoot) is null)
            {
                using var sourceLease = CoreLaunchFiles.Lock(config.DataRoot);
                var existing = PlatformFeedFiles.ReadSource(config.DataRoot);
                if (existing is null) selection = selection with { Source = PlatformFeedFiles.SaveSource(config.DataRoot, selection.Source, null) };
                else if (existing.IndexRef != selection.Source.IndexRef || existing.FeedId != selection.Source.FeedId)
                    throw new PlatformReleaseException("platform_update_source_stale", "The selected source changed during update checking.");
                else selection = selection with { Source = existing };
            }
            await reader.CheckAssetsAsync(selection, PlatformFeedSource.CurrentRid, deadline.Token);
            var core = PlatformReleaseReader.Asset(selection.Release, "core", PlatformFeedSource.CurrentRid);
            var cli = PlatformReleaseReader.Asset(selection.Release, "cli", PlatformFeedSource.CurrentRid);
            var cliPath = CoreCliLauncher.ResolveCliPath();
            var available = !await PlatformReleaseReader.MatchesAssetAsync(executable, core, deadline.Token)
                || cliPath is null || !await PlatformReleaseReader.MatchesAssetAsync(cliPath, cli, deadline.Token);
            if (available && (!Version.TryParse(selection.Release.Version, out var targetVersion)
                || !Version.TryParse(current, out var installedVersion) || targetVersion < installedVersion
                || targetVersion == installedVersion && !await PlatformReleaseReader.MatchesAssetAsync(executable, core, deadline.Token)))
                return new(current, false, selection.Source.FeedId, DateTimeOffset.UtcNow, null,
                    selection.Release.Version, FeedId: selection.Source.FeedId, ReleaseId: selection.Release.ReleaseId,
                    Readiness: "no-forward-update", SourceRevision: selection.Source.Revision);
            string? offerId = null;
            if (available)
            {
                offerId = Guid.NewGuid().ToString("N");
                var offer = new CorePlatformOffer(offerId, selection, DateTimeOffset.UtcNow);
                CoreLaunchFiles.Write(OfferPath(offerId), offer, CoreJson.TypeInfo<CorePlatformOffer>());
                foreach (var old in Directory.EnumerateFiles(Path.GetDirectoryName(OfferPath(offerId))!, "*.json")
                    .Where(p => File.GetLastWriteTimeUtc(p) < DateTime.UtcNow.AddHours(-1)))
                { try { File.Delete(old); } catch (IOException) { } }
            }
            return new(current, available, selection.Source.FeedId, DateTimeOffset.UtcNow, null,
                selection.Release.Version, FeedId: selection.Source.FeedId, ReleaseId: selection.Release.ReleaseId,
                OfferId: offerId, Readiness: "ready", SourceRevision: selection.Source.Revision);
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or InvalidOperationException or System.Text.Json.JsonException
            || ex is OperationCanceledException && !ct.IsCancellationRequested)
        {
            logger.LogDebug(ex, "Platform feed readiness check failed.");
            return Failure(source, ex);
        }
    }

    internal string OfferPath(string id)
    {
        if (!Guid.TryParseExact(id, "N", out _)) throw new ArgumentException("Invalid platform offer ID.");
        return Path.Combine(config.DataRoot, "core", "update-offers", id + ".json");
    }

    private static CoreUpdateStatus Failure(PlatformUpdateSource? source, Exception error)
        => new(CoreStatusResponse.PlatformVersionString, false, source?.FeedId ?? "", DateTimeOffset.UtcNow,
            error.Message, FeedId: source?.FeedId, Readiness: "unavailable",
            ErrorCode: error is PlatformReleaseException typed ? typed.Code : "platform_update_check_failed", SourceRevision: source?.Revision);

    internal static string? SanitizeVersion(string body)
    {
        var version = body.Trim();
        return version.Length is > 0 and <= 64 && char.IsAsciiDigit(version[0])
            && version.All(c => char.IsAsciiLetterOrDigit(c) || c is '.' or '-' or '+') ? version : null;
    }
}

// ReleaseTag remains a compatibility display field; it now carries the selected feed ID.
internal sealed record CoreUpdateStatus(string CurrentVersion, bool UpdateAvailable, string ReleaseTag,
    DateTimeOffset CheckedAt, string? Error, string? AvailableVersion = null, DateTimeOffset? LastSuccessfulCheckAt = null,
    string? FeedId = null, string? ReleaseId = null, string? OfferId = null, string? Readiness = null,
    string? ErrorCode = null, string? SourceRevision = null, string? OperationId = null);
internal sealed record CorePlatformOffer(string Id, PlatformReleaseSelection Selection, DateTimeOffset CheckedAt);
internal sealed record CoreProductChannelRef(string? ReleaseTag);
