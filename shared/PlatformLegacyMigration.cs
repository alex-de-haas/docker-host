using System.Text.Json;
using System.Text.Json.Serialization;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Releases;

internal sealed record PlatformBridge(string SchemaVersion, string ReleaseId, string ReleaseRef, string ReleaseSha256,
    string Repository, string Tag, string MigratedFeedId, string IndexRef, string Status, DateTimeOffset Cutoff);
internal sealed record PlatformSourceMigrationResult(string SchemaVersion, string Status, string BridgeReleaseId,
    string? PreviousSha256, PlatformUpdateSource Selected, DateTimeOffset MigratedAt);

[JsonSerializable(typeof(PlatformBridge))]
[JsonSerializable(typeof(PlatformSourceMigrationResult))]
[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, RespectNullableAnnotations = true)]
internal partial class PlatformMigrationJson : JsonSerializerContext;

internal static class PlatformLegacyMigration
{
    public static async Task<PlatformReleaseSelection?> TryImportAsync(PlatformReleaseReader reader, string root,
        string executable, PlatformDistribution distribution, bool sourceLockHeld, CancellationToken ct)
    {
        if (distribution.BridgeRef is null) return null;
        var oldPath = Path.Combine(root, "core", "product-channel.json");
        var backupPath = oldPath + ".pre-feeds";
        var journalPath = Path.Combine(root, "core", "update-source-migration.json");
        var oldBytes = File.Exists(oldPath) ? await File.ReadAllBytesAsync(oldPath, ct)
            : File.Exists(backupPath) ? await File.ReadAllBytesAsync(backupPath, ct) : null;
        if (oldBytes is not null && !IsKnownSelection(oldBytes, distribution)) return null;
        var bytes = await reader.ReadDocumentAsync(distribution.BridgeRef, false, ct);
        var bridge = JsonSerializer.Deserialize(bytes, PlatformMigrationJson.Default.PlatformBridge);
        if (bridge is null || bridge.SchemaVersion != "hosty-platform-bridge.0.1" || bridge.Status != "frozen"
            || bridge.Repository != distribution.LegacyRepository || bridge.Tag != distribution.LegacyReleaseTag
            || bridge.IndexRef != distribution.IndexRef || bridge.MigratedFeedId != distribution.MigratedFeedId
            || !ArtifactIdentity.IsHash(bridge.ReleaseId) || !ArtifactIdentity.IsHash(bridge.ReleaseSha256) || bridge.Cutoff == default)
            throw new PlatformReleaseException("platform_bridge_invalid", "The retained transition release has no verified cutoff. Select a feed explicitly.");
        var descriptorBytes = await reader.ReadDocumentAsync(bridge.ReleaseRef, false, ct);
        if (PlatformReleaseReader.Hash(descriptorBytes) != bridge.ReleaseSha256)
            throw new PlatformReleaseException("platform_bridge_invalid", "The transition descriptor changed.");
        var release = JsonSerializer.Deserialize(descriptorBytes, PlatformReleaseJson.Default.PlatformRelease)
            ?? throw new PlatformReleaseException("platform_bridge_invalid", "The transition release is missing.");
        PlatformReleaseReader.ValidateRelease(release);
        if (release.SchemaVersion != "hosty-platform-release.0.1" || release.ReleaseId != bridge.ReleaseId
            || !await PlatformReleaseReader.MatchesAssetAsync(executable, PlatformReleaseReader.Asset(release, "cli", PlatformFeedSource.CurrentRid), ct))
            return null;
        // Resolve the destination before touching any old configuration. A failed/unseeded feed is not a migration.
        var selection = await reader.ResolveAsync(distribution.IndexRef, distribution.MigratedFeedId, ct: ct);
        await reader.CheckAssetsAsync(selection, PlatformFeedSource.CurrentRid, ct);
        using var lease = sourceLockHeld ? null : CoreLaunchFiles.Lock(root);
        CoreLaunchFiles.AssertNoPendingOperations(root);
        if (PlatformFeedFiles.ReadSource(root) is { } current)
            return await reader.ResolveAsync(current.IndexRef, current.FeedId, current.Revision, ct, current.LegacyIndex);
        var currentBytes = File.Exists(oldPath) ? await File.ReadAllBytesAsync(oldPath, ct)
            : File.Exists(backupPath) ? await File.ReadAllBytesAsync(backupPath, ct) : null;
        if (HashOrNull(currentBytes) != HashOrNull(oldBytes))
            throw new PlatformReleaseException("platform_update_source_stale", "The legacy selection changed during migration.");
        var result = new PlatformSourceMigrationResult("hosty-platform-source-migration.0.1", "prepared", bridge.ReleaseId,
            HashOrNull(oldBytes), selection.Source, DateTimeOffset.UtcNow);
        var retained = CoreLaunchFiles.Read(journalPath, PlatformMigrationJson.Default.PlatformSourceMigrationResult);
        if (retained is not null && (retained.BridgeReleaseId != result.BridgeReleaseId || retained.PreviousSha256 != result.PreviousSha256))
            throw new PlatformReleaseException("platform_migration_conflict", "The retained migration belongs to another legacy source.");
        CoreLaunchFiles.Write(journalPath, result, PlatformMigrationJson.Default.PlatformSourceMigrationResult);
        if (File.Exists(oldPath))
        {
            if (File.Exists(backupPath))
            {
                if (HashOrNull(await File.ReadAllBytesAsync(backupPath, ct)) != result.PreviousSha256)
                    throw new PlatformReleaseException("platform_migration_conflict", "The retained legacy backup differs; it was not overwritten.");
                File.Delete(oldPath);
            }
            else File.Move(oldPath, backupPath);
        }
        var saved = PlatformFeedFiles.SaveSource(root, selection.Source, null);
        CoreLaunchFiles.Write(journalPath, result with { Status = "completed", Selected = saved }, PlatformMigrationJson.Default.PlatformSourceMigrationResult);
        return selection with { Source = saved };
    }

    internal static void ReconcileSaved(string root, PlatformUpdateSource source, bool sourceLockHeld)
    {
        var path = Path.Combine(root, "core", "update-source-migration.json");
        var retained = CoreLaunchFiles.Read(path, PlatformMigrationJson.Default.PlatformSourceMigrationResult);
        if (retained?.Status != "prepared") return;
        using var lease = sourceLockHeld ? null : CoreLaunchFiles.Lock(root);
        var current = PlatformFeedFiles.ReadSource(root);
        if (current?.Revision != source.Revision) return;
        if (retained.Selected.IndexRef != source.IndexRef || retained.Selected.FeedId != source.FeedId) return;
        CoreLaunchFiles.Write(path, retained with { Status = "completed", Selected = source }, PlatformMigrationJson.Default.PlatformSourceMigrationResult);
    }

    internal static bool IsKnownSelection(byte[] bytes, PlatformDistribution distribution)
    {
        try
        {
            using var document = JsonDocument.Parse(bytes);
            var value = document.RootElement;
            var known = new HashSet<string>(["id", "label", "cliVersion", "coreArtifactPrefix", "shellManifestPath", "releaseTag"], StringComparer.Ordinal);
            if (value.ValueKind != JsonValueKind.Object || value.EnumerateObject().Any(p => !known.Contains(p.Name))
                || value.EnumerateObject().Select(p => p.Name).Distinct(StringComparer.Ordinal).Count() != value.EnumerateObject().Count()) return false;
            string? Get(string name) => value.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.String ? property.GetString() : null;
            return Get("id") == distribution.LegacyFeedId && Get("releaseTag") == distribution.LegacyReleaseTag
                && Get("coreArtifactPrefix") == "hosty-core" && Get("shellManifestPath") == distribution.LegacyShellManifestPath;
        }
        catch (JsonException) { return false; }
    }
    private static string? HashOrNull(byte[]? bytes) => bytes is null ? null : PlatformReleaseReader.Hash(bytes);
}
