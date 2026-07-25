using System.Text.Json;

namespace Haas.Hosty.Core;

// Records that this host has been seeded with the release's distribution apps. Seeding is a one-time
// event: afterwards the distribution list is a catalog the operator installs from (hosty setup,
// Marketplace) and boot installs nothing on its own. The marker is what makes an uninstall stick —
// without it the next boot would simply reinstall whatever the release ships.
//
// The marker also carries the *unfinished* part of that one event. A seed pass whose installs partly
// failed records the ids it could not install under `pending`, and the next boot retries exactly
// those and nothing else. Without that list the retry would be impossible: the first successful
// install already makes the host count as seeded, so a transient failure would drop a default app
// permanently.
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

    // Ids the seed pass considered, for diagnostics.
    public IReadOnlyList<string> Apps { get => field ?? []; init; } = [];

    // Default entries the seed pass meant to install but could not. Non-empty means seeding is
    // incomplete; the next boot retries these and clears the ones that land.
    public IReadOnlyList<string> Pending { get => field ?? []; init; } = [];
}

// Core-owned store for distribution-seed.json in the core data root. Writes are atomic temp+rename
// via JsonStorage and serialized behind a semaphore, per the private-file rule. An unreadable or
// wrong-schema marker still counts as present with nothing pending, which is the safe direction: a
// host is never re-seeded by accident because its marker could not be parsed.
internal sealed class DistributionSeedStore(CoreDataPaths paths, IClock clock, ILogger<DistributionSeedStore> logger)
{
    private readonly SemaphoreSlim gate = new(1, 1);

    private string FilePath => Path.Combine(paths.CoreRoot, DistributionSeedSchema.FileName);

    private string LegacyChoicesPath => Path.Combine(paths.CoreRoot, DistributionSeedSchema.LegacyChoicesFileName);

    public bool Exists => File.Exists(FilePath);

    // A host that carries the pre-seeding choices file has already made its bootstrap decisions; it is
    // adopted as seeded so the switch to one-time seeding never reinstalls something it removed.
    public bool HasLegacyChoices => File.Exists(LegacyChoicesPath);

    public async Task<DistributionSeedDocument?> LoadAsync(CancellationToken cancellationToken = default)
    {
        DistributionSeedDocument? document;
        try
        {
            document = await JsonStorage.ReadAsync<DistributionSeedDocument>(FilePath, cancellationToken);
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            logger.LogError(ex, "Distribution seed marker at {Path} could not be read; this host is treated as fully seeded.", FilePath);
            return null;
        }

        if (document is not null &&
            !string.Equals(document.SchemaVersion, DistributionSeedSchema.Version, StringComparison.Ordinal))
        {
            logger.LogError(
                "Distribution seed marker at {Path} declares schemaVersion '{SchemaVersion}' but this Core understands '{Expected}'; this host is treated as fully seeded.",
                FilePath,
                document.SchemaVersion,
                DistributionSeedSchema.Version);
            return null;
        }

        return document;
    }

    // Writes (or rewrites) the marker. `seededAt` carries the original timestamp forward when a later
    // boot clears pending entries, so it always records when seeding actually started.
    public async Task SaveAsync(
        IReadOnlyList<string> appIds,
        IReadOnlyList<string> pending,
        DateTimeOffset? seededAt = null,
        CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            await JsonStorage.WriteAsync(
                FilePath,
                new DistributionSeedDocument
                {
                    SchemaVersion = DistributionSeedSchema.Version,
                    SeededAt = seededAt ?? clock.UtcNow,
                    Apps = appIds,
                    Pending = pending,
                },
                restrictToOwner: true,
                cancellationToken);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            // Loud but non-fatal. Without the marker the next boot re-runs the seed pass, which
            // installs only what is absent — harmless for anything still installed, but it would
            // resurrect an app uninstalled in between, so it is worth a warning. Note that a host
            // which got at least one app installed is already treated as seeded on the next boot, so
            // in practice the retry only rewrites the marker.
            logger.LogWarning(ex, "Could not write the distribution seed marker at {Path}.", FilePath);
        }
        finally
        {
            gate.Release();
        }
    }
}
