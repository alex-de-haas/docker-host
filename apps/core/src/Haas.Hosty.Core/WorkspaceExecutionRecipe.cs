namespace Haas.Hosty.Core;

internal sealed record WorkspaceRecipeRequest(string RequestId, string AppId, string WorktreeId, string Runtime);
internal sealed record WorkspaceRecipeReceipt(string WorkspaceId, WorkspaceRecipeRequest Request, DateTimeOffset Installation);
internal sealed record WorkspaceExecutionSelection(string AppId, string WorkspaceId, DateTimeOffset Installation,
    string WorktreeId, string Runtime, WorkspaceRecipeReceipt[] Receipts)
{
    internal WorkspaceExecutionRecipe Recipe() => new(AppId, Installation, Runtime,
        Receipts.Where(r => r.Installation == Installation).Select(r => r.Request).ToArray(), WorktreeId);
}

internal sealed partial class CoreLifecycleService
{
    private string WorkspaceSelectionPath(string appId, string workspaceId) => CoreDataPaths.ResolveContainedPath(
        Path.Combine(AppExecutionStore.DirectoryFor(paths, appId), "workspace-recipes"), workspaceId + ".json");

    internal Task<WorkspaceExecutionRecipe> ConfigureWorkspaceRecipeAsync(string workspaceId,
        WorkspaceRecipeRequest request, string userId, string? principal, CancellationToken ct)
        => WithAppLockAsync(request.AppId, async () =>
    {
        _ = AppExecutionStore.FileFor(paths, request.AppId, request.RequestId);
        var app = await RequireAppAsync(request.AppId, ct);
        var tree = await DevWorkspaces.Read(request.WorktreeId, null, ct);
        if (tree.WorkspaceId != workspaceId || tree.Owner.UserId != userId ||
            principal is not null && tree.Owner.External?.PrincipalId != principal)
            throw DevError("workspace_forbidden", "Use a worktree owned by the current user and credential.");
        await DevWorkspaces.CheckDevTreeAsync(tree, app, tree.Owner, ct);
        var installed = await manifests.LoadAsync(app.ManifestPath!, request.Runtime, ct);
        if (!installed.RuntimeProfile.Development)
            throw DevError("recipe_invalid", "Choose an installed development recipe for workspace source.");
        var path = WorkspaceSelectionPath(app.Id, tree.WorkspaceId);
        var current = await ReadWorkspaceSelectionAsync(app.Id, tree.WorkspaceId, ct);
        var prior = current?.Receipts.FirstOrDefault(r => r.Request.RequestId == request.RequestId);
        if (prior is not null)
        {
            if (prior.Request != request || prior.WorkspaceId != tree.WorkspaceId || prior.Installation != app.InstalledAt)
                throw DevError("request_conflict", "This recipe requestId belongs to different arguments or installation.");
            return current!.Recipe();
        }
        // Legacy receipts stay authoritative for replay, but do not replace a newer aggregate choice.
        var legacy = await JsonStorage.ReadAsync<WorkspaceExecutionRecipe>(WorkspaceRecipePath(app.Id, tree.Id), ct);
        var legacyPrior = legacy?.Requests?.FirstOrDefault(r => r.RequestId == request.RequestId);
        if (legacyPrior is not null)
        {
            if (legacyPrior != request || legacy!.Installation != app.InstalledAt)
                throw DevError("request_conflict", "This recipe requestId belongs to different arguments or installation.");
            return current?.Recipe() ?? legacy! with { WorktreeId = tree.Id };
        }
        var result = new WorkspaceExecutionSelection(app.Id, tree.WorkspaceId, app.InstalledAt, tree.Id,
            request.Runtime, [.. current?.Receipts ?? [], new(tree.WorkspaceId, request, app.InstalledAt)]);
        // The selected tree/runtime and all replay receipts commit in one atomic metadata replacement.
        await JsonStorage.WriteAsync(path, result, true, ct);
        events?.PublishWorkspaceChange("*");
        return result.Recipe();
    }, ct, developmentOperation: true);

    private async Task<WorkspaceExecutionSelection?> ReadWorkspaceSelectionAsync(string appId, string workspaceId, CancellationToken ct)
    {
        WorkspaceExecutionSelection? value;
        try { value = await JsonStorage.ReadAsync<WorkspaceExecutionSelection>(WorkspaceSelectionPath(appId, workspaceId), ct); }
        catch (System.Text.Json.JsonException)
        { throw DevError("recipe_invalid", "Workspace runtime metadata is unreadable. Restore it before configuring or selecting a runtime."); }
        if (value is null) return null;
        static bool TreeId(string? id) => id is { Length: 64 } && id.All(char.IsAsciiHexDigit);
        if (value.AppId != appId || value.WorkspaceId != workspaceId || !TreeId(value.WorktreeId) ||
            string.IsNullOrWhiteSpace(value.Runtime) || value.Receipts is not { Length: > 0 } ||
            value.Receipts.Any(r => r is null || r.Request is null || r.WorkspaceId != workspaceId ||
                r.Request.AppId != appId || !TreeId(r.Request.WorktreeId) || string.IsNullOrWhiteSpace(r.Request.Runtime) ||
                !Guid.TryParseExact(r.Request.RequestId, "D", out _)) ||
            value.Receipts.Select(r => r.Request.RequestId).Distinct(StringComparer.Ordinal).Count() != value.Receipts.Length)
            throw DevError("recipe_invalid", "Workspace runtime metadata is incomplete. Restore it before configuring or selecting a runtime.");
        return value;
    }

    private sealed record WorkspaceTreeSelection(string? WorktreeId, string? Runtime, string? Unavailable = null);

    private async Task<WorkspaceTreeSelection> ResolveWorkspaceTreeAsync(AppRecord app, string workspaceId,
        string[] candidates, string? explicitTree, string? activeTree, CancellationToken ct)
    {
        if (candidates.Length == 0)
            return new(null, null, "This application's workspace source is unavailable.");
        var configured = await ReadWorkspaceSelectionAsync(app.Id, workspaceId, ct);
        if (configured is null || configured.Installation != app.InstalledAt || configured.AppId != app.Id || configured.WorkspaceId != workspaceId)
            configured = null;
        string? tree;
        if (explicitTree is not null) tree = candidates.Contains(explicitTree, StringComparer.Ordinal) ? explicitTree : null;
        else if (configured is not null)
        {
            if (!candidates.Contains(configured.WorktreeId, StringComparer.Ordinal))
                return new(null, null, "The configured worktree is unavailable. Configure this application's workspace again.");
            tree = configured.WorktreeId;
        }
        else if (activeTree is not null && candidates.Contains(activeTree, StringComparer.Ordinal)) tree = activeTree;
        else if (candidates.Length == 1) tree = candidates[0];
        else
        {
            // Older setup persisted only per-tree recipes. Honor a single reviewed binding, never
            // infer an order between independent records or treat an implicit runtime as a choice.
            var legacy = new List<string>();
            foreach (var id in candidates)
                if (await JsonStorage.ReadAsync<WorkspaceExecutionRecipe>(WorkspaceRecipePath(app.Id, id), ct)
                    is { Requests.Length: > 0 } recipe && recipe.Installation == app.InstalledAt)
                    legacy.Add(id);
            tree = legacy.Count == 1 ? legacy[0] : null;
        }
        return tree is null ? new(null, null, "Choose this application's worktree during workspace setup.")
            : new(tree, configured?.WorktreeId == tree ? configured.Runtime : null);
    }
}
