namespace Haas.Hosty.Core;

internal sealed record WorkspaceRecipeRequest(string RequestId, string AppId, string WorktreeId, string Runtime);
internal sealed record WorkspaceRecipeReceipt(string WorkspaceId, WorkspaceRecipeRequest Request, DateTimeOffset Installation);

internal sealed partial class CoreLifecycleService
{
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
        var path = WorkspaceRecipePath(app.Id, tree.Id);
        var current = await JsonStorage.ReadAsync<WorkspaceExecutionRecipe>(path, ct);
        var prior = current?.Requests?.FirstOrDefault(r => r.RequestId == request.RequestId);
        if (prior is not null)
        {
            if (prior != request || current!.Installation != app.InstalledAt)
                throw DevError("request_conflict", "This recipe requestId belongs to different arguments or installation.");
            return current;
        }
        var result = new WorkspaceExecutionRecipe(app.Id, app.InstalledAt, request.Runtime,
            [.. (current?.Installation == app.InstalledAt ? current.Requests ?? [] : []), request]);
        // Selection and replay receipt commit together; an old retry never overwrites a newer recipe.
        await JsonStorage.WriteAsync(path, result, true, ct);
        events?.PublishWorkspaceChange("*");
        return result;
    }, ct, developmentOperation: true);
}

