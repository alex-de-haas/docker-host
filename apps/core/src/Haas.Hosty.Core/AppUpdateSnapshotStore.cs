using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace Haas.Hosty.Core;

internal sealed record CachedUpdatePlan(
    AppUpdatePlan Plan,
    RuntimeAppManifestSelection Selection,
    string CurrentManifestDigest,
    IReadOnlyList<AppServiceArtifactProbe> ArtifactProbes,
    string? ResolvedSourceCommit,
    DateTimeOffset CreatedAt)
{
    public string CacheId { get; init; } = Guid.NewGuid().ToString("N");
}

internal sealed record AppUpdateSnapshot(int SchemaVersion, string Base, CachedUpdatePlan? Plan, AppUpdateAvailability? Verdict);

internal sealed record AppUpdateBase(
    string Id, DateTimeOffset InstalledAt, string Version, string? Runtime,
    string ManifestHash, string? ManifestPath, string? ManifestUrl, string? InstallManifestPath,
    string? FeedsUrl, string? FeedId, AppSourceState? Source,
    IReadOnlyDictionary<string, bool>? DevelopmentModes,
    IReadOnlyDictionary<string, ArtifactLock>? ArtifactLocks);

// One atomic document keeps the verdict and the exact reviewed target together. It lives outside
// app data/backups: restoring app data must not restore an old approval. All reads are local.
internal sealed class AppUpdateSnapshotStore(CoreDataPaths paths, ILogger logger)
{
    private readonly ConcurrentDictionary<string, SemaphoreSlim> locks = new(StringComparer.Ordinal);
    private string Root => Path.Combine(paths.CoreRoot, "update-checks");
    internal string PathFor(string appId) => CoreDataPaths.ResolveContainedPath(Root, appId + ".json");

    public IEnumerable<string> AppIds => Directory.Exists(Root)
        ? Directory.EnumerateFiles(Root, "*.json").Select(path => Path.GetFileNameWithoutExtension(path)).ToArray()
        : [];

    public async Task<AppUpdateSnapshot?> ChangeAsync(
        string appId, Func<AppUpdateSnapshot?, AppUpdateSnapshot?> change,
        CancellationToken cancellationToken = default)
    {
        var gate = locks.GetOrAdd(appId, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancellationToken);
        try
        {
            var path = PathFor(appId);
            AppUpdateSnapshot? previous = null;
            try
            {
                previous = await JsonStorage.ReadAsync<AppUpdateSnapshot>(path, cancellationToken);
                if (previous is not null && (previous.SchemaVersion != 1 || string.IsNullOrEmpty(previous.Base) ||
                    (previous.Plan is { } plan && (plan.Plan?.AppId != appId || plan.Selection?.Manifest is null ||
                        plan.Selection.RuntimeProfile is null || plan.Selection.Services is null ||
                        plan.ArtifactProbes is null || string.IsNullOrEmpty(plan.CacheId)))))
                {
                    previous = null;
                }
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
            {
                logger.LogWarning(ex, "Could not restore update snapshot for {AppId}; a new check can replace it.", appId);
            }

            var next = change(previous);
            if (next is null)
            {
                if (File.Exists(path)) File.Delete(path);
            }
            else if (!ReferenceEquals(next, previous))
            {
                await JsonStorage.WriteOwnerFileAsync(path, next, cancellationToken);
            }
            return next;
        }
        finally { gate.Release(); }
    }
}
