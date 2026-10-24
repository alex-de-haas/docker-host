using Haas.Hosty.Launch;

namespace Haas.Hosty.Core;

internal sealed record CoreExecutionTarget(string WorkspaceId, string WorktreeId, string Label,
    string? ProjectPath, string? Unavailable);
internal sealed record CoreExecutionReturnTarget(CoreLaunchIdentity Launch);
internal sealed record CoreExecutionActivation(string Id, string WorkspaceId, string? CoreWorktreeId,
    string? CoreProject, string Phase, bool CoreReturned, CoreLaunchIdentity PreviousCore,
    CoreLaunchIdentity? ActivatedCore, CoreExecutionReturnTarget? CoreReturnTarget,
    string? ReplacesCoreActivationId, string? Error);
internal sealed record CoreRetainedActivation(string WorkspaceId, CoreExecutionActivation Activation);
internal sealed record CoreExecutionTargetInventory(CoreExecutionTarget[] Targets, CoreRetainedActivation[] Activations);

// Menu discovery reads authorized metadata only. Fresh Git observations, executable hashes and
// lifecycle approval belong to the selected workspace's authoritative activation review.
internal sealed class CoreExecutionTargetService(WorkspaceInspectionService inspection,
    CoreDevelopmentService core, CoreDataPaths paths)
{
    internal async Task<CoreExecutionTargetInventory> InventoryAsync(string userId, CancellationToken ct)
    {
        var source = await core.SourceSettingsAsync(ct);
        var inventory = await inspection.ListAsync(userId, ct, ownedOnly: true);
        var authorized = inventory.Workspaces.Select(workspace => workspace.Id).ToHashSet(StringComparer.Ordinal);
        var targets = new List<CoreExecutionTarget>();
        string? configured = null, sourceError = null;
        if (source.RepositoryUrl is not null)
        {
            try
            {
                configured = core.NormalizeRepository(source.RepositoryUrl);
                // Validate the existing configured connection, as activation review does. This
                // constructs an in-memory reference; it never creates or broadens a source grant.
                _ = await core.SourceGrantAsync(source, userId, ct);
            }
            catch (Exception ex) when (ex is AppLifecycleException or ArgumentException or IOException)
            { sourceError = ex.Message; }
        }
        foreach (var workspace in inventory.Workspaces.Where(workspace => workspace.State != "released"))
        {
            var matches = workspace.Worktrees.Where(tree => Matches(tree.Repository, configured)).ToArray();
            foreach (var tree in matches)
            {
                var label = string.IsNullOrWhiteSpace(workspace.Name) ? workspace.Owner.Label : workspace.Name;
                if (matches.Length > 1) label += " · " + tree.Branch;
                var error = sourceError ?? (tree.State != "active" ? "This worktree is not active." : null);
                string? project = null;
                try
                {
                    project = CoreDevelopmentService.Project(tree.Path, source.ProjectPath);
                    if (!File.Exists(project)) error ??= "The configured Core project is unavailable in this worktree.";
                }
                catch (Exception ex) when (ex is ArgumentException or IOException)
                { error ??= ex.Message; }
                targets.Add(new(workspace.Id, tree.Id, label, project, error));
            }
        }
        var activations = WorkspaceRuntimeFiles.List(paths.DataRoot)
            .Where(activation => activation.UserId == userId && authorized.Contains(activation.WorkspaceId) &&
                activation.CoreProject is not null && !activation.CoreReturned &&
                activation.Phase is not ("returned" or "cancelled") &&
                (activation.Phase != "preparing" || activation.CoreReserved))
            .OrderBy(activation => activation.Id, StringComparer.Ordinal)
            .Select(activation => new CoreRetainedActivation(activation.WorkspaceId,
                new(activation.Id, activation.WorkspaceId, activation.CoreWorktreeId, activation.CoreProject,
                    activation.Phase, activation.CoreReturned, activation.PreviousCore, activation.ActivatedCore,
                    activation.CoreReturnTarget is { } baseline ? new(baseline.Launch) : null,
                    activation.ReplacesCoreActivationId, activation.Error))).ToArray();
        return new(targets.OrderBy(target => target.Label, StringComparer.OrdinalIgnoreCase)
            .ThenBy(target => target.WorktreeId, StringComparer.Ordinal).ToArray(), activations);
    }

    private bool Matches(string repository, string? configured)
    {
        if (configured is null) return false;
        try { return core.NormalizeRepository(repository) == configured; }
        catch (ArgumentException) { return false; }
    }
}
