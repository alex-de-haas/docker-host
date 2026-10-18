namespace Haas.Hosty.Core;

internal sealed record LocalAppHandoffRequest(string RequestId, string WorkspaceId, string ExpectedHead, string ExpectedTargetHead);
internal sealed record LocalAppHandoffOperation(string Id, WorkspaceOwner Owner, string AppId, DateTimeOffset Installation,
    string Kind, LocalAppHandoffRequest Request, string State);
internal sealed record LocalAppHandoffStatus(string AppId, string WorkspaceId, string SourceHead, string TargetHead,
    bool SourceClean, bool TargetClean, bool Accepted, string RuntimeState, string? OpenUrl,
    LocalAppHandoffOperation? Operation = null);

internal sealed partial class DevelopmentWorkspaceService
{
    // Admission is shared with prepare/lease/Git mutations. Other sessions cannot acquire a new
    // managed writer between the active-writer check and the local target update.
    internal Task<T> WithLocalTargetAsync<T>(string id, WorkspaceOwner owner, Func<DevelopmentWorkspace, Task<T>> action, CancellationToken ct)
        => Locked(Hash(OwnerIdentity(owner)), async () =>
        {
            var tree = await Read(id, owner, ct);
            return await Locked("repository-admission:" + tree.RepositoryId, async () =>
            {
                await ValidateTree(tree, ct);
                return await action(tree);
            }, ct);
        }, ct);

    internal async Task RequireLocalTargetIdleAsync(DevelopmentWorkspace tree, CancellationToken ct)
    {
        await RequireOpenWorkflow(tree.Owner, ct);
        if (tree.State != "active") throw Error("not_active", "The workspace is not active.");
        // Advisory listings omit unreadable records. Acceptance must instead prove that no
        // same-repository writer or uncertain Git outcome remains before advancing main.
        if (Directory.Exists(Records)) foreach (var file in Directory.EnumerateFiles(Records, "*.json"))
        {
            DevelopmentWorkspace other;
            try { other = await Read(System.IO.Path.GetFileNameWithoutExtension(file), null, ct); }
            catch (Exception ex) when (ex is System.Text.Json.JsonException or IOException or AppLifecycleException)
            { throw Error("state_unavailable", "Workspace activity cannot be verified. Restore the unreadable workspace record before accepting locally."); }
            if (other.RepositoryId == tree.RepositoryId && other.State != "released" &&
                (other.Leases.Length > 0 || other.Operations.Any(o => o.State is "pending" or "unknown")))
                throw Error("in_use", "Stop active work and recover pending or unknown Git operations before accepting locally.");
        }
        // Preview consumers read the separate worktree, not the canonical target. They remain usable.
    }

    internal async Task RefreshLocalTargetAsync(DevelopmentWorkspace tree, CancellationToken ct)
    {
        await Fetch(RepoPath(tree.RepositoryId), tree.Repository, tree.TargetBranch, ct);
        await Observe(tree, ct);
    }
}

internal sealed partial class CoreLifecycleService
{
    private string LocalHandoffRecord(string id) => Path.Combine(paths.CoreRoot, "authoring", "local", id + ".json");

    private async Task<AppRecord> RequireLocalAppAsync(string appId, DevelopmentWorkspace tree, CancellationToken ct)
    {
        var app = await RequireAppAsync(appId, ct);
        var source = Path.GetFullPath(paths.ResolveManagedCheckoutPath(appId));
        if (app.SourceState is not { Type: "local-git" } binding || binding.LocalOverridePath != source ||
            binding.ManagedCheckoutPath != source || binding.Repository != source || tree.TargetBranch != "main" ||
            !tree.Apps.Any(a => a.AppId == appId && a.Installation == app.InstalledAt) ||
            CoreDataPaths.ContainsSymbolicLink(paths.AppsRoot, source) ||
            !Directory.Exists(Path.Combine(source, ".git")) || CoreDataPaths.ContainsSymbolicLink(source, Path.Combine(source, ".git")))
            throw new AppLifecycleException("local_source_required", "This action requires the app's registered local Git source and current workspace binding.");
        var common = (await DevelopmentWorkspaceService.Git(source, ["rev-parse", "--path-format=absolute", "--git-common-dir"], ct)).StandardOutput.Trim();
        var branch = (await DevelopmentWorkspaceService.Git(source, ["symbolic-ref", "HEAD"], ct)).StandardOutput.Trim();
        if (common != tree.Repository || branch != "refs/heads/main")
            throw new AppLifecycleException("local_source_changed", "The local repository or checked-out main changed. Preserve it and review the source binding.");
        return app;
    }

    private static async Task<(string Head, bool Clean)> LocalGitStateAsync(string path, CancellationToken ct)
    {
        var head = (await DevelopmentWorkspaceService.Git(path, ["rev-parse", "HEAD"], ct)).StandardOutput.Trim();
        var status = await DevelopmentWorkspaceService.Git(path, ["status", "--porcelain", "--untracked-files=all"], ct);
        var merge = await DevelopmentWorkspaceService.Git(path, ["rev-parse", "--verify", "MERGE_HEAD"], ct, true);
        return (head, status.StandardOutput.Length == 0 && merge.ExitCode != 0);
    }

    private async Task<LocalAppHandoffStatus> LocalStatusAsync(AppRecord app, DevelopmentWorkspace tree,
        LocalAppHandoffOperation? operation, CancellationToken ct)
    {
        var source = await LocalGitStateAsync(tree.Path, ct);
        var target = await LocalGitStateAsync(app.SourceState!.LocalOverridePath!, ct);
        var summary = await BuildAppSummaryAsync(app, ct);
        var open = coreOrigins is null ? null : CoreEnvironmentAccess.ProjectApp(System.Text.Json.JsonSerializer.SerializeToElement(summary, CoreJsonSerializerContext.Default.AppSummary), coreOrigins.Effective).PreviewUrl;
        return new(app.Id, tree.Id, source.Head, target.Head, source.Clean, target.Clean,
            source.Clean && target.Clean && source.Head == target.Head && app.SourceState.Commit == target.Head,
            app.RuntimeState, open, operation);
    }

    internal Task<LocalAppHandoffStatus> ReadLocalAppAsync(WorkspaceOwner owner, string appId, string workspaceId,
        DevelopmentWorkspaceService workspaces, CancellationToken ct)
        => WithAppLockAsync(appId, () => workspaces.WithLocalTargetAsync(workspaceId, owner, async tree =>
            await LocalStatusAsync(await RequireLocalAppAsync(appId, tree, ct), tree, null, ct), ct), ct);

    internal Task<LocalAppHandoffStatus> HandoffLocalAppAsync(WorkspaceOwner owner, string appId, string kind,
        LocalAppHandoffRequest input, DevelopmentWorkspaceService workspaces, CancellationToken ct)
        => WithAppLockAsync(appId, () => workspaces.WithLocalTargetAsync(input.WorkspaceId, owner, async tree =>
        {
            if (kind is not ("accept" or "use") || !Guid.TryParseExact(input.RequestId, "D", out var requestId) ||
                !System.Text.RegularExpressions.Regex.IsMatch(input.ExpectedHead ?? "", "^[0-9a-f]{40,64}$") ||
                !System.Text.RegularExpressions.Regex.IsMatch(input.ExpectedTargetHead ?? "", "^[0-9a-f]{40,64}$"))
                throw new AppLifecycleException("local_request_invalid", "Supply an action, UUID requestId and reviewed source/target commit hashes.");
            var app = await RequireLocalAppAsync(appId, tree, ct);
            var journal = LocalHandoffRecord(requestId.ToString("D"));
            var op = await JsonStorage.ReadAsync<LocalAppHandoffOperation>(journal, ct);
            if (op is not null && (!op.Owner.SameIdentity(owner) || op.AppId != appId || op.Installation != app.InstalledAt || op.Kind != kind || op.Request != input))
                throw new AppLifecycleException("local_request_conflict", "This request belongs to another operation. Retry the original arguments.");
            if (op?.State == "succeeded") return await LocalStatusAsync(app, tree, op, ct);
            if (kind == "accept") await workspaces.RequireLocalTargetIdleAsync(tree, ct);
            else if (tree.Leases.Length > 0) throw DevelopmentWorkspaceService.Error("in_use", "Stop active work before starting the ordinary app.");
            var state = await LocalStatusAsync(app, tree, op, ct);
            if (!state.SourceClean || !state.TargetClean)
                throw new AppLifecycleException("local_source_dirty", "Commit or resolve the worktree and canonical main first. No files were overwritten.");
            if (state.SourceHead != input.ExpectedHead || (state.TargetHead != input.ExpectedTargetHead && !(op is not null && state.TargetHead == input.ExpectedHead)))
                throw new AppLifecycleException("local_head_changed", "Source or target changed. Review the current heads before a new request.");
            if (kind == "accept" && AppRuntimeStates.IsUp(app.RuntimeState) && state.TargetHead != input.ExpectedHead)
                throw new AppLifecycleException("local_app_running", "Stop the ordinary app before advancing main; its source watcher may otherwise change live behavior.");
            if (kind == "use" && !state.Accepted)
                throw new AppLifecycleException("local_not_accepted", "Accept this clean worktree into local main before ordinary use.");
            if (op is null)
            {
                op = new(input.RequestId, owner, appId, app.InstalledAt, kind, input, "pending");
                await JsonStorage.WriteAsync(journal, op, restrictToOwner: true);
            }
            if (kind == "accept")
            {
                var canonical = app.SourceState!.LocalOverridePath!;
                await DevelopmentWorkspaceService.Git(canonical,
                    ["fetch", "--no-tags", "--no-write-fetch-head", workspaces.RepositoryPath(tree.Repository), input.ExpectedHead!], ct);
                if ((await DevelopmentWorkspaceService.Git(canonical,
                    ["merge-base", "--is-ancestor", state.TargetHead, input.ExpectedHead!], ct, true)).ExitCode != 0)
                    throw new AppLifecycleException("local_diverged", "Local main diverged. Reconcile history explicitly in the worktree; no reset or force update was performed.");
                var before = await LocalGitStateAsync(canonical, ct);
                if (!before.Clean || before.Head != state.TargetHead)
                    throw new AppLifecycleException("local_head_changed", "Local main changed during preparation. No integration was performed.");
                if (state.TargetHead != input.ExpectedHead)
                    await DevelopmentWorkspaceService.Git(canonical, ["merge", "--ff-only", input.ExpectedHead!], ct);
                var actual = await LocalGitStateAsync(canonical, ct);
                if (!actual.Clean || actual.Head != input.ExpectedHead)
                    throw new AppLifecycleException("local_outcome_unknown", "Integration needs inspection; retry with the original request after verifying Git state.");
                app = (await apps.UpdateAppAsync(appId, current => current with
                { SourceState = current.SourceState! with { Commit = actual.Head } }, ct)).App;
                await workspaces.RefreshLocalTargetAsync(tree, ct);
            }
            else
            {
                // Normal startup performs existing manifest, permission, setting and mount checks.
                // It uses this installation's data/cache roots. No sandbox data or identity is copied.
                if (!AppRuntimeStates.IsUp(app.RuntimeState)) await StartCoreAsync(appId, false, ct);
                app = await RequireAppAsync(appId, ct);
            }
            op = op with { State = "succeeded" };
            await JsonStorage.WriteAsync(journal, op, restrictToOwner: true);
            return await LocalStatusAsync(app, tree, op, ct);
        }, ct), ct);
}
