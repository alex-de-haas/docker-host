using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Releases;

// Distribution defaults are data. Consumers do not assign semantics to feed names.
internal static class PlatformFeedSource
{
    public static PlatformDistribution Distribution
    {
        get
        {
            using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Hosty.PlatformDistribution.json")
                ?? throw new InvalidOperationException("The platform distribution configuration is missing.");
            return JsonSerializer.Deserialize(stream, PlatformReleaseJson.Default.PlatformDistribution)
                ?? throw new InvalidOperationException("The platform distribution configuration is invalid.");
        }
    }

    public static string CurrentRid => (OperatingSystem.IsWindows() ? "win" : OperatingSystem.IsMacOS() ? "osx"
        : OperatingSystem.IsLinux() ? "linux" : throw new PlatformNotSupportedException("Unsupported operating system."))
        + "-" + RuntimeInformation.OSArchitecture.ToString().ToLowerInvariant();

    // Explicit selection may replace an obsolete/invalid binding; implicit use must preserve it.
    public static async Task<PlatformReleaseSelection> ResolveAsync(PlatformReleaseReader reader, string root,
        string? feedId = null, string? indexRef = null, string? executable = null, CancellationToken ct = default, bool sourceLockHeld = false)
    {
        var saved = PlatformFeedFiles.ReadSource(root);
        if (indexRef is not null || feedId is not null)
            return await reader.ResolveAsync(indexRef ?? saved?.IndexRef ?? Distribution.IndexRef, feedId
                ?? (indexRef is null ? saved?.FeedId : null), saved?.Revision, ct, allowLegacy: indexRef is not null || saved?.LegacyIndex == true);
        if (saved is not null)
        {
            PlatformLegacyMigration.ReconcileSaved(root, saved, sourceLockHeld);
            return await reader.ResolveAsync(saved.IndexRef, saved.FeedId, saved.Revision, ct, allowLegacy: saved.LegacyIndex);
        }

        // A receipt distinguishes a new installer from an unrecognized legacy installation.
        var bootstrap = ReadBootstrap(executable);
        if (bootstrap is not null)
        {
            await VerifyBootstrapAsync(bootstrap, executable!, ct);
            return await reader.ResolveAsync(bootstrap.Selection.Source.IndexRef, bootstrap.Selection.Source.FeedId, ct: ct);
        }
        if (executable is not null && PlatformLegacyPins.Read(executable) is null
            && await PlatformLegacyMigration.TryImportAsync(reader, root, executable, Distribution, sourceLockHeld, ct) is { } migrated)
            return migrated;
        throw new PlatformReleaseException("platform_feed_selection_required",
            "This installation has no verified update source. Select one with 'hosty core feed <id> [--index <reference>]'.");
    }

    public static PlatformInstallReceipt? ReadBootstrap(string? executable)
        => executable is null ? null : CoreLaunchFiles.Read(PlatformFeedFiles.BootstrapPath(executable),
            PlatformReleaseJson.Default.PlatformInstallReceipt);

    public static async Task VerifyBootstrapAsync(PlatformInstallReceipt receipt, string executable, CancellationToken ct)
    {
        if (receipt.SchemaVersion != "hosty-platform-install.0.1" || receipt.Rid != CurrentRid)
            throw new PlatformReleaseException("platform_bootstrap_invalid", "The bootstrap receipt targets a different platform or format.");
        PlatformReleaseReader.ValidateRelease(receipt.Selection.Release,
            PlatformReleaseReader.IsLocalReference(receipt.Selection.Source.IndexRef));
        if (!await PlatformReleaseReader.MatchesAssetAsync(executable,
                PlatformReleaseReader.Asset(receipt.Selection.Release, "cli", receipt.Rid), ct))
            throw new PlatformReleaseException("platform_bootstrap_mismatch", "The installed CLI differs from its bootstrap receipt.");
    }

    public static PlatformUpdateSource PersistSelection(string root, PlatformReleaseSelection selection)
    {
        var previous = PlatformFeedFiles.ReadSource(root);
        return PlatformFeedFiles.SaveSource(root, selection.Source, previous?.Revision);
    }
}
