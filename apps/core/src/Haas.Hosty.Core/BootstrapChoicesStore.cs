using System.Text.Json;

namespace Haas.Hosty.Core;

// The operator's bootstrap intent: which distribution-list entries are enabled on this host. Only
// intent lives here — never a manifest location (locations resolve from the release-owned
// distribution list each boot, so they cannot go stale). Absent file means "follow the release
// defaults". See docs/ideas/generic-bootstrap.md.
internal static class BootstrapChoicesSchema
{
    public const string Version = "bootstrap-choices.0.1";
    public const string FileName = "bootstrap-choices.json";
}

internal sealed class BootstrapChoicesDocument
{
    public string? SchemaVersion { get; init; }
    public IReadOnlyDictionary<string, BootstrapChoiceEntry> Apps { get => field ?? EmptyApps; init; } = EmptyApps;

    private static readonly IReadOnlyDictionary<string, BootstrapChoiceEntry> EmptyApps =
        new Dictionary<string, BootstrapChoiceEntry>(StringComparer.Ordinal);

    public bool? EnabledFor(string appId)
        => Apps.TryGetValue(appId, out var choice) ? choice.Enabled : null;
}

internal sealed class BootstrapChoiceEntry
{
    public bool? Enabled { get; init; }
}

// Core-owned store for bootstrap-choices.json in the core data root. Reads are memoized (choices
// change through this store or between boots); writes are atomic temp+rename via JsonStorage and
// serialized behind a semaphore, per the private-file rule.
internal sealed class BootstrapChoicesStore(CoreDataPaths paths, ILogger<BootstrapChoicesStore> logger)
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private BootstrapChoicesDocument? cached;
    private bool loaded;

    private string FilePath => Path.Combine(paths.CoreRoot, BootstrapChoicesSchema.FileName);

    // File presence is checked directly (not via a null load): a corrupted file must still count as
    // present, so the boot migration never clobbers an operator's file it merely failed to parse.
    public bool Exists => File.Exists(FilePath);

    public async Task<BootstrapChoicesDocument?> LoadAsync(CancellationToken cancellationToken = default)
    {
        if (loaded)
        {
            return cached;
        }

        await gate.WaitAsync(cancellationToken);
        try
        {
            if (!loaded)
            {
                cached = await ReadCoreAsync(cancellationToken);
                loaded = true;
            }

            return cached;
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task SetEnabledAsync(string appId, bool enabled, CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            var current = loaded ? cached : await ReadCoreAsync(cancellationToken);
            var apps = new Dictionary<string, BootstrapChoiceEntry>(StringComparer.Ordinal);
            foreach (var (id, choice) in current?.Apps ?? new Dictionary<string, BootstrapChoiceEntry>(StringComparer.Ordinal))
            {
                apps[id] = choice;
            }

            apps[appId] = new BootstrapChoiceEntry { Enabled = enabled };
            var document = new BootstrapChoicesDocument
            {
                SchemaVersion = BootstrapChoicesSchema.Version,
                Apps = apps,
            };
            await JsonStorage.WriteAsync(FilePath, document, restrictToOwner: true, cancellationToken);
            cached = document;
            loaded = true;
        }
        finally
        {
            gate.Release();
        }
    }

    // Writes the document only when no choices file exists yet — the boot migration's seed. Returns
    // false when a file (even an unparseable one) is already present.
    public async Task<bool> SeedIfAbsentAsync(BootstrapChoicesDocument document, CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            if (File.Exists(FilePath))
            {
                return false;
            }

            var seeded = new BootstrapChoicesDocument
            {
                SchemaVersion = BootstrapChoicesSchema.Version,
                Apps = document.Apps,
            };
            await JsonStorage.WriteAsync(FilePath, seeded, restrictToOwner: true, cancellationToken);
            cached = seeded;
            loaded = true;
            return true;
        }
        finally
        {
            gate.Release();
        }
    }

    private async Task<BootstrapChoicesDocument?> ReadCoreAsync(CancellationToken cancellationToken)
    {
        BootstrapChoicesDocument? document;
        try
        {
            document = await JsonStorage.ReadAsync<BootstrapChoicesDocument>(FilePath, cancellationToken);
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            // Loud but non-fatal: the host boots on release defaults; the operator's file is left in
            // place untouched so it can be inspected and repaired.
            logger.LogError(ex, "Bootstrap choices file at {Path} could not be read or parsed; booting with release defaults.", FilePath);
            return null;
        }

        if (document is not null &&
            !string.Equals(document.SchemaVersion, BootstrapChoicesSchema.Version, StringComparison.Ordinal))
        {
            logger.LogError(
                "Bootstrap choices file at {Path} declares schemaVersion '{SchemaVersion}' but this Core understands '{Expected}'; booting with release defaults.",
                FilePath,
                document.SchemaVersion,
                BootstrapChoicesSchema.Version);
            return null;
        }

        return document;
    }
}
