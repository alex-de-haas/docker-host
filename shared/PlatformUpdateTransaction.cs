using System.Security.Cryptography;
using System.Text.Json.Serialization;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Releases;

internal sealed record PlatformCoreObservation(CoreLaunchIdentity Launch, string Version, string? ListenUrl = null,
    string? CorePublicOrigin = null, string? RuntimePublicHost = null);
internal sealed record PlatformReplacement(string Role, string Target, string Staged, string Backup,
    string? PreviousSha256, PlatformReleaseAsset Asset);
internal sealed record PlatformUpdateOperation(string SchemaVersion, string Id, string Root,
    PlatformReleaseSelection Selection, string Rid, string Phase, PlatformCoreObservation? PreviousCore,
    IReadOnlyList<PlatformReplacement> Replacements, DateTimeOffset CreatedAt, DateTimeOffset? LaunchRequestedAt = null,
    PlatformCoreObservation? ReadyCore = null, string? Error = null);
internal sealed record PlatformUpdateOwner(string Root, string OperationId);

[JsonSourceGenerationOptions(PropertyNamingPolicy = JsonKnownNamingPolicy.CamelCase, RespectNullableAnnotations = true)]
[JsonSerializable(typeof(PlatformUpdateOperation))]
[JsonSerializable(typeof(PlatformUpdateOwner))]
internal partial class PlatformUpdateJson : JsonSerializerContext;

internal interface IPlatformUpdateHost
{
    Task<PlatformCoreObservation?> ObserveAsync(CancellationToken ct);
    Task<bool> StopAsync(CancellationToken ct);
    Task<bool> StartAsync(PlatformCoreObservation? previous, CancellationToken ct);
}

// The caller owns both the shared executable lock and the selected data root's launch lock.
// Every externally visible step has a durable intent before the step and a receipt afterwards.
internal sealed class PlatformUpdateTransaction(PlatformReleaseReader reader, IPlatformUpdateHost host)
{
    public static string JournalPath(string root) => Path.Combine(root, "core", "platform-update.json");
    public static string OwnerPath(string cliPath) => cliPath + ".update-owner.json";
    public static FileStream LockExecutable(string cliPath)
        => new(cliPath + ".update.lock", FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);

    public static PlatformUpdateOperation? Pending(string root)
    {
        var operation = CoreLaunchFiles.Read(JournalPath(root), PlatformUpdateJson.Default.PlatformUpdateOperation);
        if (operation is null || operation.Phase == "completed") return null;
        if (operation.SchemaVersion != "hosty-platform-update.0.1" || !Guid.TryParseExact(operation.Id, "N", out _)
            || !SamePath(root, operation.Root))
            throw new PlatformReleaseException("platform_operation_invalid", "The retained platform operation is invalid. Inspect its journal before continuing.");
        return operation;
    }

    public async Task<PlatformUpdateOperation> ExecuteAsync(string root, string cliPath, string corePath,
        PlatformReleaseSelection? selection, CancellationToken ct = default, string? requestId = null)
    {
        root = Path.GetFullPath(root); cliPath = Path.GetFullPath(cliPath); corePath = Path.GetFullPath(corePath);
        if (requestId is not null && !Guid.TryParseExact(requestId, "N", out _)) throw new ArgumentException("Invalid update request ID.");
        var completed = CoreLaunchFiles.Read(JournalPath(root), PlatformUpdateJson.Default.PlatformUpdateOperation);
        if (requestId is not null && completed?.Id == requestId && completed.Phase == "completed")
        {
            if (PlatformAcceptedUpdates.Read(root, requestId) is { } acceptance)
                CoreLaunchFiles.Write(PlatformAcceptedUpdates.PathFor(root, requestId), acceptance with { Status = "completed", Error = null }, PlatformAcceptanceJson.Default.PlatformUpdateAcceptance);
            return completed;
        }
        var operation = Pending(root);
        if (operation is not null && requestId is not null && operation.Id != requestId)
            throw new PlatformReleaseException("platform_update_pending", "A different platform update is pending.");
        var owner = CoreLaunchFiles.Read(OwnerPath(cliPath), PlatformUpdateJson.Default.PlatformUpdateOwner);
        if (owner is not null && (!SamePath(owner.Root, root) || owner.OperationId != operation?.Id))
        {
            var owned = CoreLaunchFiles.Read(JournalPath(owner.Root), PlatformUpdateJson.Default.PlatformUpdateOperation);
            if (owned?.Id != owner.OperationId || owned.Phase != "completed")
                throw new PlatformReleaseException("platform_cli_update_pending", "This shared CLI has a pending update in another data root. Resume that operation first.");
        }
        if (operation is null)
        {
            if (selection is null) throw new ArgumentNullException(nameof(selection));
            PlatformReleaseReader.ValidateRelease(selection.Release, PlatformReleaseReader.IsLocalReference(selection.Source.IndexRef));
            var id = requestId ?? Guid.NewGuid().ToString("N");
            var rid = PlatformFeedSource.CurrentRid;
            var replacements = new[] { (Role: "core", Path: corePath), (Role: "cli", Path: cliPath) }
                .Select(item => new PlatformReplacement(item.Role, item.Path, item.Path + "." + id + ".next",
                    item.Path + "." + id + ".previous", File.Exists(item.Path) ? FileHash(item.Path) : null,
                    PlatformReleaseReader.Asset(selection.Release, item.Role, rid))).ToArray();
            operation = new("hosty-platform-update.0.1", id, root, selection, rid, "preparing",
                await host.ObserveAsync(ct), replacements, DateTimeOffset.UtcNow);
            Save(operation);
        }
        ValidateTargets(operation, cliPath, corePath);
        CoreLaunchFiles.Write(OwnerPath(cliPath), new PlatformUpdateOwner(root, operation.Id), PlatformUpdateJson.Default.PlatformUpdateOwner);
        try
        {
            if (operation.Phase == "preparing")
            {
                foreach (var replacement in operation.Replacements)
                    await reader.StageAssetAsync(replacement.Asset, replacement.Staged,
                        PlatformReleaseReader.IsLocalReference(operation.Selection.Source.IndexRef), ct);
                // Keep independently verified previous bytes before any replacement or stop.
                foreach (var replacement in operation.Replacements)
                {
                    if (replacement.PreviousSha256 is null) continue;
                    if (!File.Exists(replacement.Backup))
                    {
                        if (FileHash(replacement.Target) != replacement.PreviousSha256)
                            throw new PlatformReleaseException("platform_installation_changed", "An installed executable changed while the update was being prepared.");
                        File.Copy(replacement.Target, replacement.Backup, overwrite: false);
                    }
                    if (FileHash(replacement.Backup) != replacement.PreviousSha256)
                        throw new PlatformReleaseException("platform_backup_invalid", "Previous executable backup failed verification.");
                }
                operation = Save(operation with { Phase = "prepared", Error = null });
            }
            if (operation.Phase is "prepared" or "stopping")
            {
                // Repeat staging verification after recovery and before disrupting the old Core.
                foreach (var replacement in operation.Replacements)
                    if (!await PlatformReleaseReader.MatchesAssetAsync(replacement.Staged, replacement.Asset, ct))
                        throw new PlatformReleaseException("platform_staging_changed", "A prepared executable changed. The current Core remains untouched.");
                var live = await host.ObserveAsync(ct);
                if (live is not null && !SameInstance(live, operation.PreviousCore))
                    throw new PlatformReleaseException("platform_core_changed", "A different Core process is running. Inspect the retained update before continuing.");
                if (operation.PreviousCore?.Launch.Mode != "dev" && live is not null)
                {
                    operation = Save(operation with { Phase = "stopping", Error = null });
                    if (!await host.StopAsync(ct) || await host.ObserveAsync(ct) is not null)
                        throw new PlatformReleaseException("platform_stop_failed", "Core did not stop cleanly. Neither executable was replaced.");
                }
                operation = Save(operation with { Phase = "replacing", Error = null });
            }
            if (operation.Phase == "replacing")
            {
                var live = await host.ObserveAsync(ct);
                if (live is not null && (operation.PreviousCore?.Launch.Mode != "dev" || !SameInstance(live, operation.PreviousCore)))
                    throw new PlatformReleaseException("platform_core_changed", "Core started during replacement; update is suspended.");
                try
                {
                    foreach (var replacement in operation.Replacements)
                    {
                        if (await PlatformReleaseReader.MatchesAssetAsync(replacement.Target, replacement.Asset, ct)) continue;
                        if (!await PlatformReleaseReader.MatchesAssetAsync(replacement.Staged, replacement.Asset, ct))
                            throw new PlatformReleaseException("platform_staging_changed", "A prepared executable is missing or changed; the frozen update cannot continue.");
                        if (File.Exists(replacement.Target) && FileHash(replacement.Target) != replacement.PreviousSha256)
                            throw new PlatformReleaseException("platform_installation_changed", "An executable was changed outside this operation.");
                        Replace(replacement.Staged, replacement.Target, operation.Id);
                    }
                }
                catch
                {
                    // No target process has been started yet. Restore only files still owned by this
                    // transaction; preserve the frozen intent and backups for a later retry.
                    await RestoreBeforeLaunchAsync(operation, ct);
                    operation = Save(operation with { Phase = "preparing" });
                    throw;
                }
                operation = Save(operation with { Phase = "installed", Error = null });
            }
            if (operation.Phase == "installed" && operation.ReadyCore is null && operation.PreviousCore is { Launch.Mode: not "dev" })
                operation = Save(operation with { Phase = "launching", LaunchRequestedAt = DateTimeOffset.UtcNow, Error = null });
            if (operation.Phase == "launching")
            {
                var live = await host.ObserveAsync(ct);
                if (live is null)
                {
                    if (!await host.StartAsync(operation.PreviousCore, ct))
                        throw new PlatformReleaseException("platform_start_failed", "The target Core did not become ready. Its binaries and recovery journal are retained; application data was not rolled back.");
                    live = await host.ObserveAsync(ct);
                }
                if (live is null || live.Version != operation.Selection.Release.Version || live.Launch.Mode != "release"
                    || live.Launch.StartedAt < operation.LaunchRequestedAt || SameInstance(live, operation.PreviousCore))
                    throw new PlatformReleaseException("platform_readiness_failed", "The expected replacement Core process was not verified. Inspect status/logs and resume this operation.");
                operation = Save(operation with { ReadyCore = live, Phase = "installed", Error = null });
            }
            if (operation.Phase != "installed")
                throw new PlatformReleaseException("platform_operation_invalid", "Unknown platform update phase.");
            foreach (var replacement in operation.Replacements)
                if (!await PlatformReleaseReader.MatchesAssetAsync(replacement.Target, replacement.Asset, ct))
                    throw new PlatformReleaseException("platform_installation_changed", "Installed bytes differ from the frozen release; no completion receipt was written.");
            var receipt = new PlatformInstallReceipt("hosty-platform-install.0.1", operation.Selection, operation.Rid, DateTimeOffset.UtcNow);
            CoreLaunchFiles.Write(PlatformFeedFiles.ReceiptPath(root), receipt, PlatformReleaseJson.Default.PlatformInstallReceipt);
            CoreLaunchFiles.Write(PlatformFeedFiles.BootstrapPath(cliPath), receipt, PlatformReleaseJson.Default.PlatformInstallReceipt);
            operation = Save(operation with { Phase = "completed", Error = null });
            if (PlatformAcceptedUpdates.Read(root, operation.Id) is { } accepted)
                CoreLaunchFiles.Write(PlatformAcceptedUpdates.PathFor(root, operation.Id), accepted with { Status = "completed", Error = null }, PlatformAcceptanceJson.Default.PlatformUpdateAcceptance);
            return operation;
        }
        catch (Exception error)
        {
            Save(operation with { Error = error.Message });
            throw;
        }
    }

    private static async Task RestoreBeforeLaunchAsync(PlatformUpdateOperation operation, CancellationToken ct)
    {
        foreach (var replacement in operation.Replacements)
        {
            if (File.Exists(replacement.Target) && !await PlatformReleaseReader.MatchesAssetAsync(replacement.Target, replacement.Asset, ct)
                && FileHash(replacement.Target) != replacement.PreviousSha256)
                throw new PlatformReleaseException("platform_restore_conflict", "Recovery refused to overwrite a file changed outside this update.");
            if (replacement.PreviousSha256 is null) { File.Delete(replacement.Target); continue; }
            if (!File.Exists(replacement.Backup) || FileHash(replacement.Backup) != replacement.PreviousSha256)
                throw new PlatformReleaseException("platform_backup_invalid", "Recovery backup is unavailable; inspect retained operation files.");
            var temporary = replacement.Target + "." + operation.Id + ".restore";
            File.Copy(replacement.Backup, temporary, overwrite: true);
            Replace(temporary, replacement.Target, operation.Id + "-restore");
        }
    }

    private static void Replace(string prepared, string target, string id)
    {
        // Windows permits renaming a loaded CLI image but not overwriting it. The renamed file is
        // retained until no process references it. POSIX replacement is one atomic rename.
        if (OperatingSystem.IsWindows() && File.Exists(target)) File.Move(target, target + "." + id + ".retired", overwrite: true);
        File.Move(prepared, target, overwrite: !OperatingSystem.IsWindows());
    }

    private static PlatformUpdateOperation Save(PlatformUpdateOperation operation)
    {
        CoreLaunchFiles.Write(JournalPath(operation.Root), operation, PlatformUpdateJson.Default.PlatformUpdateOperation);
        return operation;
    }

    private static void ValidateTargets(PlatformUpdateOperation operation, string cli, string core)
    {
        if (operation.Rid != PlatformFeedSource.CurrentRid || operation.Replacements.Count != 2)
            throw new PlatformReleaseException("platform_operation_invalid", "The retained update targets another platform.");
        foreach (var role in new[] { "cli", "core" })
        {
            var item = operation.Replacements.SingleOrDefault(r => r.Role == role);
            var target = role == "cli" ? cli : core;
            if (item is null || !SamePath(item.Target, target) || item.Staged != target + "." + operation.Id + ".next"
                || item.Backup != target + "." + operation.Id + ".previous"
                || item.Asset != PlatformReleaseReader.Asset(operation.Selection.Release, role, operation.Rid))
                throw new PlatformReleaseException("platform_operation_invalid", "The retained update's executable targets do not match this installation.");
        }
    }

    private static bool SamePath(string first, string second) => string.Equals(Path.GetFullPath(first), Path.GetFullPath(second),
        OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);
    private static bool SameInstance(PlatformCoreObservation? first, PlatformCoreObservation? second)
        => first is not null && second is not null && first.Launch.ProcessId == second.Launch.ProcessId
            && first.Launch.StartedAt == second.Launch.StartedAt;
    private static string FileHash(string path)
    {
        using var stream = File.OpenRead(path);
        return Convert.ToHexStringLower(SHA256.HashData(stream));
    }
}
