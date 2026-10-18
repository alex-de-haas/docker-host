namespace Haas.Hosty.Core;

internal sealed record LocalBuildingWork(string WorkspaceId, string WorktreeId, string SessionId, string? AssistantId,
    bool Owned, string State, string? Head, bool? Accepted, string? Unavailable);
internal sealed record LocalBuildingApp(string AppId, string Name, string? AcceptedHead, string? Unavailable, LocalBuildingWork[] Work);

internal static class LocalBuildingSource
{
    internal static async Task<LocalBuildingApp> ReadAsync(CoreDataPaths paths, AppRecord app, CancellationToken ct)
    {
        var source = Path.GetFullPath(paths.ResolveManagedCheckoutPath(app.Id));
        LocalBuildingApp Result(string? head, string? error) => new(app.Id, app.DisplayName, head, error, []);
        if (app.SourceState is not { Type: "local-git" } binding || binding.Repository != source ||
            binding.ManagedCheckoutPath != source || CoreDataPaths.ContainsSymbolicLink(paths.AppsRoot, source) ||
            !Directory.Exists(Path.Combine(source, ".git")) || CoreDataPaths.ContainsSymbolicLink(source, Path.Combine(source, ".git")))
            return Result(null, "The registered local repository is unavailable. Preserve its source and review the binding.");
        try
        {
            var head = (await DevelopmentWorkspaceService.Git(source, ["rev-parse", "refs/heads/main"], ct)).StandardOutput.Trim();
            var branch = (await DevelopmentWorkspaceService.Git(source, ["symbolic-ref", "HEAD"], ct)).StandardOutput.Trim();
            var dirty = (await DevelopmentWorkspaceService.Git(source, ["status", "--porcelain", "--untracked-files=all"], ct)).StandardOutput.Length > 0;
            var merge = await DevelopmentWorkspaceService.Git(source, ["rev-parse", "--verify", "MERGE_HEAD"], ct, true);
            var error = binding.LocalOverridePath != source ? "Another source folder is selected. Clear the override to resume from local main."
                : branch != "refs/heads/main" || dirty || merge.ExitCode == 0 ? "Local main has unfinished changes. Preserve and resolve them before starting a new session."
                : binding.Commit != head ? "Local main changed outside Accept locally. Review the source before starting a new session." : null;
            return Result(head, error);
        }
        catch (AppLifecycleException ex) { return Result(null, ex.Message); }
    }
}

internal sealed partial class CoreLifecycleService
{
    internal async Task<LocalBuildingApp[]> ReadLocalBuildingAppsAsync(string userId, DevelopmentWorkspaceService workspaces, CancellationToken ct)
    {
        var trees = (await workspaces.ListAsync(null, false, ct)).Workspaces;
        var result = new List<LocalBuildingApp>();
        foreach (var app in (await apps.ListAppRecordsAsync(ct)).Where(a => a.SourceState?.Type == "local-git" && a.PrivateSources?.Git is null))
        {
            var local = await LocalBuildingSource.ReadAsync(paths, app, ct);
            var work = new List<LocalBuildingWork>();
            // Same-owner work only: another administrator's session details are not needed here.
            foreach (var tree in trees.Where(t => t.Owner.UserId == userId && t.Apps.Any(a => a.AppId == app.Id && a.Installation == app.InstalledAt)))
            {
                string? head = null, error = null;
                bool? accepted = null;
                try
                {
                    await workspaces.ValidateTree(tree, ct);
                    var observed = await workspaces.ObserveAsync(tree.Id, tree.Owner, ct);
                    head = observed.Observation?.Head;
                    if (head is null || observed.Observation?.State != "ok") throw DevelopmentWorkspaceService.Error("unavailable", "Worktree state is unavailable.");
                    var ancestry = await DevelopmentWorkspaceService.Git(paths.ResolveManagedCheckoutPath(app.Id),
                        ["merge-base", "--is-ancestor", head, local.AcceptedHead ?? "refs/heads/main"], ct, true);
                    // Missing objects in canonical Git also mean the work has not been accepted there.
                    accepted = ancestry.ExitCode == 0 && observed.Observation.Local?.Files.Count == 0 && !observed.Observation.Conflict;
                }
                catch (AppLifecycleException ex) { error = ex.Message; }
                var workflow = await workspaces.WorkflowAsync(tree.Owner, ct);
                work.Add(new(tree.WorkspaceId, tree.Id, tree.Owner.SessionId, tree.Owner.IsExternal ? null : tree.Owner.AppId,
                    true, workflow.State, head, accepted, error));
            }
            result.Add(local with { Work = work.ToArray() });
        }
        return result.OrderBy(a => a.Name, StringComparer.Ordinal).ToArray();
    }
}
