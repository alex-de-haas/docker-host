using Haas.Hosty.Launch;
using Haas.Hosty.Releases;

namespace Haas.Hosty.Core;

internal sealed record CorePlatformFeedState(PlatformUpdateSource? Source, PlatformFeedIndex Index, string IndexRef);
internal sealed record CorePlatformFeedRequest(string IndexRef, string FeedId, string? ExpectedRevision);
internal sealed record CorePlatformUpdateRequest(string OfferId, string RequestId);
internal sealed record CorePlatformUpdateResult(string Id, string Status, string ReleaseId, string? Error = null);

internal sealed class CorePlatformFeedService(HostyCoreRuntimeConfig config, IHttpClientFactory clients,
    CoreUpdateCheckService checker)
{
    private PlatformReleaseReader Reader() => new(clients.CreateClient(CoreUpdateCheckService.HttpClientName));
    public async Task<CorePlatformFeedState> GetAsync(CancellationToken ct, string? indexRef = null)
    {
        var source = PlatformFeedFiles.ReadSource(config.DataRoot);
        if (indexRef is not null) PlatformReleaseReader.ValidateReference(indexRef, allowLocal: false);
        var reference = indexRef ?? source?.IndexRef ?? PlatformFeedSource.Distribution.IndexRef;
        var (index, _) = await Reader().ReadIndexAsync(reference, ct, allowLegacy: indexRef is not null || source?.LegacyIndex == true);
        return new(source, index, reference);
    }
    public async Task<PlatformUpdateSource> SelectAsync(CorePlatformFeedRequest input, CancellationToken ct)
    {
        // HTTP selection never grants read access to arbitrary files on the host.
        PlatformReleaseReader.ValidateReference(input.IndexRef, allowLocal: false);
        var selection = await Reader().ResolveAsync(input.IndexRef, input.FeedId, ct: ct, allowLegacy: true);
        using var lease = CoreLaunchFiles.Lock(config.DataRoot);
        CoreLaunchFiles.AssertNoPendingOperations(config.DataRoot);
        return PlatformFeedFiles.SaveSource(config.DataRoot, selection.Source, input.ExpectedRevision);
    }
    public Task<CorePlatformUpdateResult> ApplyAsync(CorePlatformUpdateRequest input, CancellationToken ct)
        => ApplyAsync(input, ct, CoreCliLauncher.ResolveCliPath,
            (cli, id) => CoreCliLauncher.SpawnDetached(cli, ["update", "--operation-id", id], config, "core-update.log"));

    internal async Task<CorePlatformUpdateResult> ApplyAsync(CorePlatformUpdateRequest input, CancellationToken ct,
        Func<string?> resolveCliPath, Action<string, string> spawnUpdate)
    {
        var path = PlatformAcceptedUpdates.PathFor(config.DataRoot, input.RequestId);
        using var lease = CoreLaunchFiles.Lock(config.DataRoot);
        if (PlatformAcceptedUpdates.Read(config.DataRoot, input.RequestId) is { } retained)
        {
            if (retained.OfferId != input.OfferId) throw new PlatformReleaseException("platform_update_replay_conflict", "Request ID already names another offer.");
            if (retained.Status != "completed")
            {
                var retryCli = resolveCliPath() ?? throw new PlatformReleaseException("cli_not_found", "The installed CLI could not be located.");
                lease.Dispose();
                return StartUpdate(retained, retryCli, spawnUpdate);
            }
            return Status(retained);
        }
        CoreLaunchFiles.AssertNoPendingOperations(config.DataRoot);
        var offer = CoreLaunchFiles.Read(checker.OfferPath(input.OfferId), CoreJson.TypeInfo<CorePlatformOffer>())
            ?? throw new PlatformReleaseException("platform_offer_not_found", "Refresh update availability before applying.");
        if (DateTimeOffset.UtcNow - offer.CheckedAt > TimeSpan.FromMinutes(10))
            throw new PlatformReleaseException("platform_offer_expired", "The offer expired. Refresh update availability.");
        var source = PlatformFeedFiles.ReadSource(config.DataRoot);
        if (source is null || source.Revision != offer.Selection.Source.Revision)
            throw new PlatformReleaseException("platform_offer_stale", "The selected update source changed. Refresh update availability.");
        await Reader().CheckAssetsAsync(offer.Selection, PlatformFeedSource.CurrentRid, ct);
        var cli = resolveCliPath() ?? throw new PlatformReleaseException("cli_not_found", "The installed CLI could not be located.");
        var accepted = new PlatformUpdateAcceptance(input.RequestId, input.OfferId, config.DataRoot, offer.Selection, DateTimeOffset.UtcNow);
        CoreLaunchFiles.Write(path, accepted, PlatformAcceptanceJson.Default.PlatformUpdateAcceptance);
        // The durable acceptance fences other operations while the helper takes over launch.lock.
        // Windows probes the helper before returning, so its launch cannot run under a parent-held lock.
        lease.Dispose();
        return StartUpdate(accepted, cli, spawnUpdate);
    }

    private CorePlatformUpdateResult StartUpdate(PlatformUpdateAcceptance accepted, string cli,
        Action<string, string> spawnUpdate)
    {
        // Retry reuses the retained request/selection. The helper reads only this frozen receipt.
        try { spawnUpdate(cli, accepted.Id); }
        catch (Exception error)
        {
            try
            {
                using var lease = CoreLaunchFiles.Lock(config.DataRoot);
                var current = PlatformAcceptedUpdates.Read(config.DataRoot, accepted.Id);
                var journal = CoreLaunchFiles.Read(PlatformUpdateTransaction.JournalPath(config.DataRoot), PlatformUpdateJson.Default.PlatformUpdateOperation);
                if (current is { Status: not "completed" } && journal?.Id != accepted.Id)
                    CoreLaunchFiles.Write(PlatformAcceptedUpdates.PathFor(config.DataRoot, accepted.Id),
                        current with { Error = error.Message }, PlatformAcceptanceJson.Default.PlatformUpdateAcceptance);
            }
            catch (IOException)
            {
                // A running helper may already own the lock; preserve its progress and the spawn error.
            }
            throw;
        }
        return GetOperation(accepted.Id);
    }
    public CorePlatformUpdateResult GetOperation(string id)
        => Status(PlatformAcceptedUpdates.Read(config.DataRoot, id)
            ?? throw new PlatformReleaseException("platform_operation_not_found", "The update operation was not found."));
    private CorePlatformUpdateResult Status(PlatformUpdateAcceptance accepted)
    {
        if (accepted.Status == "completed") return new(accepted.Id, "completed", accepted.Selection.Release.ReleaseId);
        var journal = CoreLaunchFiles.Read(PlatformUpdateTransaction.JournalPath(config.DataRoot), PlatformUpdateJson.Default.PlatformUpdateOperation);
        return journal?.Id == accepted.Id
            ? new(accepted.Id, journal.Phase, journal.Selection.Release.ReleaseId, journal.Error)
            : new(accepted.Id, "accepted", accepted.Selection.Release.ReleaseId, accepted.Error);
    }
}
