using Haas.Hosty.Launch;

namespace Haas.Hosty.Core;

/// <summary>An explicit package or registered-workspace execution choice.</summary>
internal sealed record AppExecutionTargetRequest(string RequestId, string Kind, string? Runtime = null,
    string? WorkspaceId = null, string? WorktreeId = null);
internal sealed record AppExecutionChoice(string Kind, string? Runtime, string? WorkspaceId, string? WorktreeId,
    string Name, bool Available = true, string? Unavailable = null);
internal sealed record AppExecutionTargets(string AppId, AppExecutionChoice Current, string? PackageRuntime,
    AppExecutionChoice[] Choices);
internal sealed record AppExecutionInventory(AppExecutionTargets[] Apps);
internal sealed record AppExecutionStatus(string RequestId, string State, AppSummary? App = null,
    string? Code = null, string? Error = null, InstallationPrepare? Review = null);
internal sealed record AppPackageBaseline(DateTimeOffset Installation, string Runtime);
internal sealed record AppExecutionOwner(DateTimeOffset Installation, string RequestId);
internal sealed record WorkspaceExecutionRecipe(string AppId, DateTimeOffset Installation, string Runtime, WorkspaceRecipeRequest[]? Requests = null, string? WorktreeId = null);
internal sealed record AppExecutionOperation(string AppId, AppExecutionTargetRequest Request,
    WorkspaceActivationActor Actor, DateTimeOffset Installation, string ExpectedBinding, string Fingerprint,
    string State = "running", string Phase = "pending", RuntimePreparation? Prepared = null,
    string? CandidateDigest = null, string? SourceHead = null, string? Code = null, string? Error = null,
    InstallationPrepare? Review = null, string? OnlyWorkspaceId = null, string? PreviousRequestId = null, string? PreparationLeaseId = null);
internal sealed record WorkspaceExecutionResult(string AppId, string State, string? Code = null, string? Error = null,
    InstallationPrepare? Review = null);
internal sealed record WorkspaceExecutionStatus(string RequestId, string State, WorkspaceExecutionResult[] Apps);
internal sealed record WorkspaceExecutionOperation(string WorkspaceId, AppExecutionTargetRequest Request,
    WorkspaceActivationActor Actor, string[] Apps, string Fingerprint, string State = "running");

internal static class AppExecutionStore
{
    internal static string Root(CoreDataPaths paths) => Path.Combine(paths.CoreRoot, "execution-targets");
    internal static string DirectoryFor(CoreDataPaths paths, string appId) =>
        CoreDataPaths.ResolveContainedPath(Root(paths), appId);
    internal static string FileFor(CoreDataPaths paths, string appId, string requestId)
    {
        if (!Guid.TryParseExact(requestId, "D", out _))
            throw new AppLifecycleException("execution_request_invalid", "Use a UUID requestId and retain it for recovery.");
        return Path.Combine(DirectoryFor(paths, appId), requestId + ".json");
    }
    internal static string GroupFile(CoreDataPaths paths, string workspaceId, string requestId)
    {
        if (workspaceId.Length != 64 || workspaceId.Any(c => !char.IsAsciiHexDigit(c)))
            throw new AppLifecycleException("workspace_invalid", "Use the registered workspace ID.");
        return FileFor(paths, "workspace-" + workspaceId, requestId);
    }
    internal static Task SaveAsync(CoreDataPaths paths, AppExecutionOperation operation, CancellationToken ct) =>
        JsonStorage.WriteAsync(FileFor(paths, operation.AppId, operation.Request.RequestId), operation, true, ct);
    internal static Task<AppExecutionOperation?> ReadAsync(CoreDataPaths paths, string appId, string requestId, CancellationToken ct) =>
        JsonStorage.ReadAsync<AppExecutionOperation>(FileFor(paths, appId, requestId), ct);
    internal static Task SaveGroupAsync(CoreDataPaths paths, WorkspaceExecutionOperation operation, CancellationToken ct) =>
        JsonStorage.WriteAsync(GroupFile(paths, operation.WorkspaceId, operation.Request.RequestId), operation, true, ct);
    internal static string Fingerprint(AppExecutionTargetRequest request, WorkspaceActivationActor actor, string? onlyWorkspaceId) =>
        DevelopmentWorkspaceService.Hash(CoreJson.Text(request) + "\n" + CoreJson.Text(actor) + "\n" + onlyWorkspaceId);
    internal static string Binding(AppRecord app) => DevelopmentWorkspaceService.Hash(string.Join("\n",
        app.InstalledAt.ToString("O"), app.SelectedRuntime, app.DevModeId, CoreJson.Text(app.SourceState)));
    internal static void Validate(AppExecutionTargetRequest request)
    {
        if (request.Kind is not ("package" or "workspace") ||
            request.Kind == "package" && (request.WorkspaceId is not null || request.WorktreeId is not null) ||
            request.Kind == "workspace" && request.WorkspaceId is null)
            throw new AppLifecycleException("execution_target_invalid", "Choose an installed package runtime or a registered workspace.");
    }
}
