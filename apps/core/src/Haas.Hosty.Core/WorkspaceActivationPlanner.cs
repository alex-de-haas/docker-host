using Haas.Hosty.Launch;

namespace Haas.Hosty.Core;

internal sealed record WorkspaceAppChoice(string AppId, bool Selected = true, string? WorktreeId = null, string? Runtime = null);
internal sealed record WorkspaceActivationSelection(bool CoreSelected = true, string? CoreWorktreeId = null,
    WorkspaceAppChoice[]? Apps = null);
internal sealed record WorkspaceActivationParticipant(string Id, string Kind, string Name, string? WorktreeId,
    string? Repository, string? SourcePath, string? Branch, string? Commit, int? ChangedFiles,
    string? CurrentRuntime, string? TargetRuntime, string[] AvailableRuntimes,
    bool DefaultSelected, bool Selected, string Reason, string? Unavailable);
internal sealed record WorkspaceActivationPlan(string WorkspaceId, string CoreInstance, string CoreSourceRevision,
    WorkspaceActivationParticipant[] Participants)
{
    public string Stage => "selection-only";
}

// This is a read-only candidate projection, not a lifecycle approval or an executable apply plan.
internal sealed class WorkspaceActivationPlanner(DevelopmentWorkspaceService workspaces,
    WorkspaceInspectionService inspection, AppRegistryStore apps, CoreDevelopmentService core)
{
    public async Task<WorkspaceActivationPlan> PlanAsync(string workspaceId, string userId,
        WorkspaceActivationSelection input, CancellationToken ct)
    {
        var owner = await inspection.WorkflowOwnerAsync(workspaceId, userId, ct);
        var trees = (await workspaces.ListAsync(owner, false, ct)).Workspaces;
        var state = await core.GetAsync(ct);
        var choices = input.Apps ?? [];
        if (choices.Any(c => c is null) || choices.Select(c => c.AppId).Distinct().Count() != choices.Length)
            throw new ArgumentException("Application choices must have distinct app IDs.");
        var known = trees.SelectMany(t => t.Apps).Select(a => a.AppId).ToHashSet(StringComparer.Ordinal);
        if (choices.Any(c => !known.Contains(c.AppId))) throw new ArgumentException("Only explicitly bound applications can be selected.");
        var result = new List<WorkspaceActivationParticipant>();
        foreach (var appId in known.Order(StringComparer.Ordinal))
        {
            var choice = choices.SingleOrDefault(c => c.AppId == appId);
            var candidates = trees.Where(t => t.Apps.Any(a => a.AppId == appId)).ToArray();
            var selected = choice?.WorktreeId is { } id ? candidates.SingleOrDefault(t => t.Id == id)
                : candidates.Length == 1 ? candidates[0] : null;
            if (choice?.WorktreeId is not null && selected is null)
                throw new ArgumentException("The selected worktree does not bind that application.");
            var app = await apps.GetAppAsync(appId, ct);
            string? error = app is null ? "Application is no longer installed."
                : selected is null ? "Choose a worktree for this application."
                : selected.Apps.Single(a => a.AppId == appId).Installation != app.InstalledAt
                    ? "Application was reinstalled; refresh its workspace binding." : null;
            string? path = null;
            if (error is null && selected is not null && app is not null)
            {
                try
                {
                    if (app.SourceState is null || workspaces.LogicalRepositoryIdentity(await workspaces.CanonicalRepositoryAsync(
                            app.SourceState.Repository, app.SourceState.LocalOverridePath, ct)) != workspaces.LogicalRepositoryIdentity(selected.Repository)
                        || app.SourceState.ManifestSubpath != selected.Apps.Single(a => a.AppId == appId).Subpath)
                        error = "Application source changed; refresh its workspace binding.";
                    else
                    {
                        path = Path.GetFullPath(Path.Combine(selected.Path, app.SourceState.ManifestSubpath ?? ""));
                        if (!DevelopmentWorkspaceService.IsUnder(selected.Path, path))
                            error = "Application source subpath escapes its worktree.";
                        else if (!Directory.Exists(path)) error = "Application source directory is unavailable.";
                    }
                }
                catch (Exception ex) when (ex is AppLifecycleException or ArgumentException or IOException)
                { error = "Application source is unavailable; refresh its workspace binding."; }
            }
            var profiles = (app?.RuntimeProfiles ?? []).Where(p => p.Development && p.Type is "docker" or "localCommand" or "mixed")
                .Select(p => p.Key).Distinct().Order(StringComparer.Ordinal).ToArray();
            var runtime = choice?.Runtime ?? (profiles.Length == 1 ? profiles[0] : null);
            if (choice?.Runtime is not null && !profiles.Contains(choice.Runtime))
                throw new ArgumentException("The selected runtime is not an installed development profile.");
            error ??= profiles.Length == 0 ? "No supported development profile is installed."
                : runtime is null ? "Choose a development profile." : null;
            var observation = await ObserveAsync(selected, error, ct);
            error ??= observation.Error;
            result.Add(new(appId, "app", app?.DisplayName ?? appId, selected?.Id, selected?.Repository, path,
                selected?.Branch, observation.Value?.Head, observation.Value?.Local?.FileCount,
                app?.SelectedRuntime, runtime, profiles, error is null, (choice?.Selected ?? true) && error is null,
                "explicit-app-binding", error));
        }

        DevelopmentWorkspace[] matches = [];
        string? coreError = state.Source.RepositoryUrl is null ? "Core development repository is not configured." : null;
        if (state.Source.RepositoryUrl is { } repository)
            matches = trees.Where(t => MatchesCore(t.Repository, repository)).ToArray();
        var coreTree = input.CoreWorktreeId is { } coreId ? matches.SingleOrDefault(t => t.Id == coreId)
            : matches.Length == 1 ? matches[0] : null;
        if (input.CoreWorktreeId is not null && coreTree is null)
            throw new ArgumentException("The selected worktree does not match the configured Core repository.");
        coreError ??= matches.Length == 0 ? "The configured Core repository is not in this workspace."
            : coreTree is null ? "Choose a matching Core worktree." : null;
        string? coreProject = null;
        if (coreError is null && coreTree is not null)
        {
            try
            {
                _ = await core.SourceGrantAsync(state.Source, userId, ct);
                coreProject = CoreDevelopmentService.Project(coreTree.Path, state.Source.ProjectPath);
                if (!File.Exists(coreProject)) coreError = "The configured Core project is unavailable in this worktree.";
            }
            catch (Exception ex) when (ex is AppLifecycleException or ArgumentException) { coreError = ex.Message; }
        }
        var coreObservation = await ObserveAsync(coreTree, coreError, ct);
        coreError ??= coreObservation.Error;
        result.Add(new("hosty:core", "core", "Core", coreTree?.Id, state.Source.RepositoryUrl, coreProject,
            coreTree?.Branch, coreObservation.Value?.Head, coreObservation.Value?.Local?.FileCount,
            state.Launch.Mode, "dev", ["dev"], coreError is null, input.CoreSelected && coreError is null,
            "configured-repository-match", coreError));
        return new(workspaceId, state.Instance, state.Source.Revision, result.ToArray());
    }

    private bool MatchesCore(string repository, string configured)
    {
        try { return core.NormalizeRepository(repository) == core.NormalizeRepository(configured); }
        catch (ArgumentException) { return false; }
    }

    private async Task<(WorkspaceObservation? Value, string? Error)> ObserveAsync(DevelopmentWorkspace? tree,
        string? error, CancellationToken ct)
    {
        if (tree is null || error is not null) return (null, error);
        try
        {
            var observed = await workspaces.ObserveAsync(tree.Id, tree.Owner, ct);
            return observed.Observation?.State == "ok" ? (observed.Observation, null)
                : (null, "Worktree source is unavailable; inspect it before activation.");
        }
        catch (Exception ex) when (ex is AppLifecycleException or IOException)
        { return (null, "Worktree source is unavailable; inspect it before activation."); }
    }
}
