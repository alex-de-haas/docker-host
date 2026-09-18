using System.Security.Cryptography;

namespace Haas.Hosty.Core;

internal sealed partial class CoreLifecycleService
{
    private static async Task<string> UpdateBaseAsync(AppRecord app, CancellationToken cancellationToken)
    {
        var manifestHash = app.ManifestPath is { } path && File.Exists(path)
            ? Convert.ToHexString(SHA256.HashData(await File.ReadAllBytesAsync(path, cancellationToken)))
            : "missing";
        return HashPlanSeed(new AppUpdateBase(app.Id, app.InstalledAt, app.Version, app.SelectedRuntime,
            manifestHash, app.ManifestPath, app.ManifestUrl, app.InstallManifestPath, app.FeedsUrl,
            app.FollowedFeedId, app.SourceState is { } source ? source with { UpdatedAt = null } : null,
            app.ArtifactLocks));
    }

    private async Task<AppUpdateSnapshot?> ReadUpdateSnapshotAsync(
        AppRecord app, CancellationToken cancellationToken, bool? live = null, bool rejectStale = false)
    {
        live ??= ResolveLiveSourcePath(app, await ResolveRuntimeProfilesAsync(app, cancellationToken)) is not null;
        var fingerprint = await UpdateBaseAsync(app, cancellationToken);
        var stale = false;
        var snapshot = await updateSnapshots.ChangeAsync(app.Id, current =>
        {
            // Explicit reviews can approve permissions for a live source app. They are not fleet
            // update offers, but listing the app must not erase the plan before it is approved.
            var liveReview = live.Value && current?.Plan?.LiveSourceReview == true;
            stale = current?.Plan is not null && ((live.Value && !liveReview) || current.Base != fingerprint);
            if (current?.Base != fingerprint || (live.Value && !liveReview)) return null;
            return liveReview && current.Verdict is not null ? current with { Verdict = null } : current;
        }, cancellationToken);
        if (rejectStale && stale)
            throw new AppLifecycleException("update_plan_stale",
                "The app changed since this update was reviewed. Reopen the update to review it, then apply.");
        return snapshot;
    }
}
