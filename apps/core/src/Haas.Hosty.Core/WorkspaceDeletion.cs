using System.Text.Json;

namespace Haas.Hosty.Core;

// Exists only between verified physical cleanup and removal of the last metadata file.
// Snapshots let recovery validate ownership/consumers after some worktree records are gone.
internal sealed record WorkspaceDeletionJournal(WorkspaceOwner Owner, DevelopmentWorkspace[] Worktrees);

internal sealed partial class DevelopmentWorkspaceService
{
    internal static string WorkspaceIdFor(WorkspaceOwner owner) => Hash("workspace\n" + OwnerIdentity(owner));
    private string Deletions => System.IO.Path.Combine(Root, "deletions");
    private string DeletionPath(string id) { Id(id); return System.IO.Path.Combine(Deletions, id + ".json"); }

    internal static void ValidateDelete(string workspaceId, WorkspaceWorkflowCommand input)
    {
        Id(workspaceId);
        RequestId(input.RequestId);
        if (input.ExpectedRevision < 0 || input.ExpectedRevision == long.MaxValue)
            throw Error("revision_invalid", "Use a valid expected workflow revision.");
    }
    internal static WorkspaceWorkflow DeletedResult(WorkspaceWorkflowCommand input)
        => new("deleted", input.ExpectedRevision + 1,
            Operations: [new(input.RequestId, "delete", input.ExpectedRevision, "succeeded")]);

    internal async Task<WorkspaceDeletionJournal?> ReadDeletionAsync(string id, CancellationToken ct)
    {
        var journal = await JsonStorage.ReadAsync<WorkspaceDeletionJournal>(DeletionPath(id), ct);
        if (journal is null) return null;
        if (journal.Owner is null || journal.Owner.UserId is null || journal.Owner.SessionId is null
            || journal.Owner.External is { PrincipalId: null } || WorkspaceIdFor(journal.Owner) != id || journal.Worktrees is not { Length: > 0 }
            || journal.Worktrees.Any(w => w is null || w.Owner is null || w.Repository is null || w.Id is null
                || w.Leases is null || w.SandboxConsumers is null || w.Operations is null || w.Operations.Any(o => o is null)
                || !w.Owner.SameIdentity(journal.Owner)
                || w.WorkspaceId != id || w.Path != WorkPath(w.Id) || w.RepositoryId != Hash(w.Repository)
                || w.Id != Hash(OwnerIdentity(journal.Owner) + "\n" + w.RepositoryId)
                || w.Branch != "hosty/session/" + w.Id || w.State != "released")
            || journal.Worktrees.Select(w => w.Id).Distinct().Count() != journal.Worktrees.Length)
            throw Error("ownership_invalid", "Workspace deletion journal is inconsistent; metadata was preserved.");
        foreach (var tree in journal.Worktrees) Id(tree.Id);
        return journal;
    }

    internal async Task RequireAbsentAsync(string id, CancellationToken ct)
    {
        if (Directory.Exists(Records)) foreach (var path in Directory.EnumerateFiles(Records, "*.json"))
        {
            var tree = await Read(System.IO.Path.GetFileNameWithoutExtension(path), null, ct);
            if (tree.WorkspaceId == id) throw Error("cleanup_pending", "Workspace metadata still exists.");
        }
    }

    internal async Task<bool> SessionWorkspaceAbsentAsync(WorkspaceOwner owner, CancellationToken ct)
    {
        // Absence authorizes conversation cleanup, so unlike a diagnostic list it must not
        // silently skip unreadable records or a previous assistant installation's source.
        if (Directory.Exists(Records)) foreach (var path in Directory.EnumerateFiles(Records, "*.json"))
        {
            var tree = await Read(System.IO.Path.GetFileNameWithoutExtension(path), null, ct);
            if (!tree.Owner.IsExternal && tree.Owner.AppId == owner.AppId && tree.Owner.UserId == owner.UserId
                && tree.Owner.SessionId == owner.SessionId) return false;
        }
        if (Directory.Exists(Deletions)) foreach (var path in Directory.EnumerateFiles(Deletions, "*.json"))
        {
            var journal = await ReadDeletionAsync(System.IO.Path.GetFileNameWithoutExtension(path), ct);
            if (journal is not null && !journal.Owner.IsExternal && journal.Owner.AppId == owner.AppId
                && journal.Owner.UserId == owner.UserId && journal.Owner.SessionId == owner.SessionId) return false;
        }
        return true;
    }

    internal async Task<bool> CanObservePublicationAsync(string id, CancellationToken ct)
    {
        DevelopmentWorkspace tree;
        try { tree = await Read(id, null, ct); }
        catch (AppLifecycleException ex) when (ex.Code == "workspace_not_found") { return false; }
        return (await WorkflowAsync(tree.Owner, ct)).State is not ("deleting" or "deleted")
            && await ReadDeletionAsync(tree.WorkspaceId, ct) is null;
    }

    // Only the final local write is serialized. A network response can arrive after Delete,
    // but cannot recreate a publication file once its worktree record has been removed.
    internal Task<bool> WritePublicationAsync(string id, Func<Task> write, CancellationToken ct)
        => Locked("publication-record-" + id, async () =>
        {
            if (!await CanObservePublicationAsync(id, ct)) return false;
            await write();
            observationState?.PublicationChanged(id);
            return true;
        }, ct);

    internal async Task<WorkspaceOwner[]> DeletedOwnersAsync(CancellationToken ct)
    {
        var owners = new Dictionary<string, WorkspaceOwner>(StringComparer.Ordinal);
        if (Directory.Exists(Deletions)) foreach (var file in Directory.EnumerateFiles(Deletions, "*.json"))
        {
            try
            {
                var journal = await ReadDeletionAsync(System.IO.Path.GetFileNameWithoutExtension(file), ct);
                if (journal is not null) owners[OwnerIdentity(journal.Owner)] = journal.Owner;
            }
            catch (Exception ex) when (ex is JsonException or AppLifecycleException or IOException)
            { logger?.LogWarning(ex, "Cannot recover workspace deletion journal {Path}", file); }
        }
        foreach (var group in (await ListAsync(null, true, ct)).Workspaces.GroupBy(w => OwnerIdentity(w.Owner)))
        {
            var owner = group.First().Owner;
            try { if ((await WorkflowAsync(owner, ct)).State == "deleted") owners[group.Key] = owner; }
            catch (Exception ex) when (ex is JsonException or AppLifecycleException or IOException)
            { logger?.LogWarning(ex, "Cannot inspect deleted workspace {WorkspaceId}", WorkspaceIdFor(owner)); }
        }
        return owners.Values.ToArray();
    }

    internal Task FinalizeDeletionAsync(WorkspaceOwner owner, CancellationToken ct)
        => Locked(Hash(OwnerIdentity(owner)), () => Locked("workspace-consumers", async () =>
        {
            var id = WorkspaceIdFor(owner);
            var journal = await ReadDeletionAsync(id, ct);
            var state = await WorkflowAsync(owner, ct);
            var current = (await ListAsync(null, true, ct)).Workspaces.Where(w => w.Owner.SameIdentity(owner)).ToArray();
            if (journal is null)
            {
                if (state.State != "deleted" || current.Length == 0)
                    throw Error("cleanup_pending", "Workspace deletion has not completed.");
                if (state.Heads is null || !state.Heads.Keys.Order(StringComparer.Ordinal)
                    .SequenceEqual(current.Select(w => w.Id).Order(StringComparer.Ordinal)))
                    throw Error("completion_unknown", "Deleted workspace has incomplete worktree evidence.");
                journal = new(owner, current);
            }
            else if (state.State != "deleted" && File.Exists(WorkflowPath(owner)))
                throw Error("cleanup_pending", "Workspace workflow changed during metadata cleanup.");
            if (current.Any(w => !journal.Worktrees.Any(prior => prior.Id == w.Id)))
                throw Error("ownership_invalid", "Workspace gained an unexpected worktree during deletion.");

            // Validate every worktree before removing any metadata. No source or branch is
            // deleted here: unfinished/ambiguous physical cleanup remains with its original owner.
            foreach (var snapshot in journal.Worktrees)
            {
                var tree = File.Exists(RecordPath(snapshot.Id)) ? await Read(snapshot.Id, null, ct) : snapshot;
                if (!tree.Owner.SameIdentity(owner) || tree.WorkspaceId != id || tree.Repository != snapshot.Repository)
                    throw Error("ownership_invalid", "Workspace ownership changed during metadata cleanup.");
                if (tree.State != "released" || tree.Leases.Length != 0 || tree.SandboxConsumers.Length != 0
                    || tree.Operations.Any(o => o.State is "pending" or "unknown") || PathEntryExists(tree.Path))
                    throw Error("cleanup_pending", "Workspace still has source or unresolved activity.");
                await CheckConsumers(tree, ct);
                var repo = RepoPath(tree.RepositoryId);
                if (Directory.Exists(repo))
                {
                    var branch = await Git(repo, ["show-ref", "--verify", "--quiet", "refs/heads/" + tree.Branch], ct, true);
                    if (branch.ExitCode != 1) throw Error("cleanup_pending", "Workspace branch is present or cannot be verified.");
                    var registrations = await Git(repo, ["worktree", "list", "--porcelain"], ct);
                    if (registrations.StandardOutput.Split('\n').Any(line => line == "worktree " + tree.Path
                        || line == "branch refs/heads/" + tree.Branch))
                        throw Error("cleanup_pending", "Workspace still has a Git registration.");
                }
            }
            await JsonStorage.WriteAsync(DeletionPath(id), journal, restrictToOwner: true, ct);
            foreach (var tree in journal.Worktrees)
                await Locked("publication-record-" + tree.Id, () =>
                {
                    DeleteMetadata(System.IO.Path.Combine(Root, "publications", tree.Id + ".json"));
                    DeleteMetadata(System.IO.Path.Combine(Root, "publications", "external", tree.Id + ".json"));
                    DeleteMetadata(System.IO.Path.Combine(Root, "publications", "review-operations", tree.Id + ".json"));
                    DeleteMetadata(RecordPath(tree.Id));
                    observationState?.Remove(tree.Id);
                    return Task.FromResult(true);
                }, ct);
            var cleanup = System.IO.Path.Combine(Root, "cleanup");
            if (Directory.Exists(cleanup)) foreach (var path in Directory.EnumerateFiles(cleanup, "*.json"))
            {
                var job = await JsonStorage.ReadAsync<WorkspaceCleanupJob>(path, ct);
                if (job?.WorkspaceId == id && job.UserId == owner.UserId) DeleteMetadata(path);
            }
            await RetireParticipationAsync(id, ct);
            DeleteMetadata(MetadataPath(owner));
            DeleteMetadata(WorkflowPath(owner));
            DeleteMetadata(DeletionPath(id)); // Last durable evidence; successful Delete retains nothing.
            return true;
        }, ct), ct);

    private void DeleteMetadata(string path)
    {
        if (CoreDataPaths.ContainsSymbolicLink(Root, path))
            throw Error("ownership_invalid", "Workspace metadata path contains a symbolic link.");
        try { File.Delete(path); }
        catch (DirectoryNotFoundException) { } // Optional publication/cleanup directories may never have existed.
    }
    internal static bool PathEntryExists(string path)
        => File.Exists(path) || Directory.Exists(path) || new FileInfo(path).LinkTarget is not null;
}

internal sealed partial class WorkspaceCleanupService
{
    private async Task RequireFinishedResourcesAsync(string workspaceId, WorkspaceOwner? owner, CancellationToken ct)
    {
        bool Matches(SandboxActor actor, SandboxContext? context) => context?.WorkspaceId == workspaceId ||
            owner is not null && Belongs(actor, context, owner, workspaceId);
        foreach (var child in (await environments.ListAsync(ct)).Where(e => Matches(e.Owner, e.Request.Context)))
            if (child.State != "finished" || DevelopmentWorkspaceService.PathEntryExists(environments.Root(child.Id)))
                throw DevelopmentWorkspaceService.Error("cleanup_pending", "Workspace child Core cleanup is not finished.");
    }
    private async Task FinalizeAsync(WorkspaceOwner owner, CancellationToken ct)
    {
        await RequireFinishedResourcesAsync(DevelopmentWorkspaceService.WorkspaceIdFor(owner), owner, ct);
        await workspaces.FinalizeDeletionAsync(owner, ct);
    }
    internal async Task RecoverDeletedAsync(ILogger logger, CancellationToken ct)
    {
        foreach (var owner in await workspaces.DeletedOwnersAsync(ct))
        {
            try
            {
                var id = DevelopmentWorkspaceService.WorkspaceIdFor(owner);
                await workspaces.WithResourceContextAsync(new(owner.UserId), new(WorkspaceId: id), async () =>
                {
                    await FinalizeAsync(owner, ct);
                    logger.LogInformation("Removed completed workspace metadata {WorkspaceId}", id);
                    return true;
                }, ct, cleanup: true);
            }
            catch (Exception ex) when (ex is AppLifecycleException or SandboxException or IOException or UnauthorizedAccessException or JsonException)
            { logger.LogWarning(ex, "Preserving incomplete workspace deletion {WorkspaceId}", DevelopmentWorkspaceService.WorkspaceIdFor(owner)); }
        }
    }
}

internal sealed class WorkspaceDeletionRecovery(WorkspaceCleanupService cleanup, ILogger<WorkspaceDeletionRecovery> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try { await cleanup.RecoverDeletedAsync(logger, stoppingToken); }
        catch (Exception ex) when (ex is not OperationCanceledException)
        { logger.LogWarning(ex, "Workspace deletion recovery did not finish; retained evidence can be retried after restart."); }
    }
}
