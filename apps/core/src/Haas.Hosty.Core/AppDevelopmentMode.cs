using System.Text.Json.Serialization;

namespace Haas.Hosty.Core;

// This journal stores execution references, not settings, passwords or copies of app data.
internal sealed record AppDevActor(string UserId, string Via, WorkspaceOwner? WorkspaceOwner = null, bool TrustedLocalOperator = false);
internal sealed record AppDevRequest(string RequestId, string Action, string? TargetRuntime = null,
    string? WorktreeId = null, string? PlanDigest = null, bool AcceptDataChanges = false);
internal sealed record AppDevPlan(string AppId, string Action, string PlanDigest, string? OperationId,
    string? CurrentRuntime, string? TargetRuntime, string? WorktreeId, string? SourcePath, string? Head,
    string[] Changes, bool DataChanged, string[] OutsideBackup);
internal sealed record AppDevReceipt(string RequestId, string Fingerprint, string Action, string State);
internal sealed record AppDevOperation(string Id, string AppId, DateTimeOffset Installation, AppDevActor Actor,
    string TargetRuntime, string SourcePath, string? WorktreeId, string ManifestDigest, string PreviousManifest,
    string? PreviousRuntime, AppSourceState? PreviousSource, IReadOnlyDictionary<string, ArtifactLock>? PreviousArtifacts,
    bool WasRunning, string ConfigurationHash, string Phase, string? BackupId = null, string? DataHash = null,
    string? Error = null, AppDevReceipt[]? Receipts = null, string? SourceHead = null)
{
    [JsonIgnore] public bool Active => Phase != "returned";
}
internal sealed record AppDevStatus(string AppId, string? OperationId, string Phase, string? WorktreeId,
    string? SourcePath, string? PreviousRuntime, string? TargetRuntime, string? BackupId, string? Error,
    AppSummary App, AppDevReceipt[] Receipts);

internal static class AppDevStore
{
    internal static string Root(CoreDataPaths paths, string appId) =>
        CoreDataPaths.ResolveContainedPath(Path.Combine(paths.CoreRoot, "development-modes"), appId);
    internal static string Record(CoreDataPaths paths, string appId, string id)
    {
        if (!Guid.TryParseExact(id, "D", out _)) throw new AppLifecycleException("dev_request_invalid", "Use a UUID requestId and preserve it after an uncertain response.");
        return Path.Combine(Root(paths, appId), id + ".json");
    }
    internal static Task<AppDevOperation?> ReadAsync(CoreDataPaths paths, AppRecord app, CancellationToken ct)
        => app.DevModeId is { } id ? ReadAsync(paths, app.Id, id, ct) : Task.FromResult<AppDevOperation?>(null);
    internal static async Task<AppDevOperation?> ReadAsync(CoreDataPaths paths, string appId, string id, CancellationToken ct)
    {
        AppDevOperation? op;
        try { op = await JsonStorage.ReadAsync<AppDevOperation>(Record(paths, appId, id), ct); }
        catch (Exception ex) when (ex is System.Text.Json.JsonException or IOException or UnauthorizedAccessException)
        { throw new AppLifecycleException("dev_state_unavailable", "Development operation record is unreadable. Restore the journal before changing this app."); }
        if (op is null || op.Id != id || op.AppId != appId || op.Phase is not
            ("prepared" or "stopped" or "backed-up" or "bound" or "starting" or "active" or "restarting" or "return-stopped" or "return-bound" or "return-starting" or "returned"))
            throw new AppLifecycleException("dev_state_unavailable", "Development operation record is unavailable or inconsistent. Restore the journal before changing this app.");
        return op;
    }
    internal static async Task<bool> ContainsRequestAsync(CoreDataPaths paths, string appId, string requestId, CancellationToken ct)
    {
        var root = Root(paths, appId);
        if (!Directory.Exists(root)) return false;
        foreach (var file in Directory.EnumerateFiles(root, "*.json"))
        {
            var id = Path.GetFileNameWithoutExtension(file);
            if (!Guid.TryParseExact(id, "D", out _)) continue;
            var operation = await ReadAsync(paths, appId, id, ct);
            if (operation?.Receipts?.Any(r => r.RequestId == requestId) == true) return true;
        }
        return false;
    }
    internal static Task SaveAsync(CoreDataPaths paths, AppDevOperation operation, CancellationToken ct)
        => JsonStorage.WriteAsync(Record(paths, operation.AppId, operation.Id), operation, restrictToOwner: true, ct);
}

internal sealed record AppDevSummary(string OperationId, string Phase, string? PreviousRuntime);
