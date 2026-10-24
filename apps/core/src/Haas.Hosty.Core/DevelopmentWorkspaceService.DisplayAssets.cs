namespace Haas.Hosty.Core;

internal sealed partial class DevelopmentWorkspaceService
{
    // Display reads use the factual active consumer, rather than admitting a new source/runtime
    // transition (which requires an idle writer). Assignment authorization stays at the asset route.
    internal async Task<string?> ActiveAppDisplayRootAsync(AppRecord app, CancellationToken ct)
    {
        var operation = await AppDevStore.ReadAsync(paths, app, ct);
        if (operation is not { Phase: "active", WorktreeId: { } id } ||
            operation.Installation != app.InstalledAt || app.SelectedRuntime != operation.TargetRuntime ||
            app.SourceState?.LocalOverridePath != operation.SourcePath)
            return null;

        var tree = await Read(id, operation.Actor.WorkspaceOwner, ct);
        var bindings = tree.Apps.Where(a => a.AppId == app.Id && a.Installation == app.InstalledAt).ToArray();
        if (tree.State != "active" || tree.Operations.Any(o => o.State is "pending" or "unknown") ||
            tree.Path != operation.SourcePath || bindings.Length != 1 || bindings[0].Subpath != app.SourceState.ManifestSubpath)
            return null;

        await ValidateTree(tree, ct);
        await WorkspaceGrantAsync(tree, ct);
        var binding = bindings[0];
        var root = tree.Path;
        if (!string.IsNullOrEmpty(binding.Subpath) &&
            !CoreDataPaths.TryResolveContainedRelativePath(tree.Path, binding.Subpath, out root))
            return null;
        // ValidateTree rejects a replaced tree root; reject linked app folders as well.
        return Directory.Exists(root) && !CoreDataPaths.ContainsSymbolicLink(tree.Path, root) ? root : null;
    }
}
