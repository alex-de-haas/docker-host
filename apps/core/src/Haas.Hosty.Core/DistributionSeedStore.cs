using System.Text.Json;

namespace Haas.Hosty.Core;

// Records that this host has already been seeded with the release's distribution apps. Seeding is a
// one-time event: afterwards the distribution list is a catalog the operator installs from (hosty
// setup, Marketplace) and boot installs nothing at all. The marker is what makes an uninstall stick —
// without it the next boot would simply reinstall whatever the release ships.
internal static class DistributionSeedSchema
{
    public const string Version = "distribution-seed.0.1";
    public const string FileName = "distribution-seed.json";

    // Pre-seeding hosts recorded bootstrap intent here. The file is no longer read for enablement;
    // its mere presence proves the host predates seeding and must not be seeded again.
    public const string LegacyChoicesFileName = "bootstrap-choices.json";
}

internal sealed class DistributionSeedDocument
{
    public string? SchemaVersion { get; init; }
    public DateTimeOffset? SeededAt { get; init; }

    // Ids the seed pass considered, for diagnostics only — nothing reads this back for decisions.
    public IReadOnlyList<string> Apps { get => field ?? []; init; } = [];
}

// Core-owned store for distribution-seed.json in the core data root. Presence is the whole contract,
// so reads never need to parse: a corrupt or unreadable marker still counts as seeded, which is the
// safe direction (a host is never re-seeded by accident).
internal sealed class DistributionSeedStore(CoreDataPaths paths, IClock clock, ILogger<DistributionSeedStore> logger)
{
    private readonly SemaphoreSlim gate = new(1, 1);

    private string FilePath => Path.Combine(paths.CoreRoot, DistributionSeedSchema.FileName);

    private string LegacyChoicesPath => Path.Combine(paths.CoreRoot, DistributionSeedSchema.LegacyChoicesFileName);

    public bool Exists => File.Exists(FilePath);

    // A host that carries the pre-seeding choices file has already made its bootstrap decisions; it is
    // adopted as seeded so the switch to one-time seeding never reinstalls something it removed.
    public bool HasLegacyChoices => File.Exists(LegacyChoicesPath);

    // Idempotent: an existing marker is left untouched (its seededAt is the real one). Returns whether
    // this call wrote it.
    public async Task<bool> MarkSeededAsync(IReadOnlyList<string> appIds, CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            if (File.Exists(FilePath))
            {
                return false;
            }

            await JsonStorage.WriteAsync(
                FilePath,
                new DistributionSeedDocument
                {
                    SchemaVersion = DistributionSeedSchema.Version,
                    SeededAt = clock.UtcNow,
                    Apps = appIds,
                },
                restrictToOwner: true,
                cancellationToken);
            return true;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            // Loud but non-fatal. The cost of a missing marker is that the next boot re-runs the seed
            // pass, which is presence-checked per app and therefore harmless for anything still
            // installed — but it would resurrect an app uninstalled in between, so it is worth a warning.
            logger.LogWarning(ex, "Could not write the distribution seed marker at {Path}; the next boot will run the seed pass again.", FilePath);
            return false;
        }
        finally
        {
            gate.Release();
        }
    }
}
