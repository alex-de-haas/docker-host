namespace Haas.Hosty.Core;

internal sealed partial class DevelopmentWorkspaceService
{
    private async Task<SourceReadGrant?> ActingSourceGrantAsync(DevelopmentWorkspace tree, WorkspaceOwner? actor, string? connectionId, CancellationToken ct)
    {
        if (actor is not null && connectionId is not null)
            return await RemoteGit.BindAsync(actor.UserId, connectionId, tree.Repository, false, ct);
        if (actor is null || actor.UserId == tree.Owner.UserId) return await WorkspaceGrantAsync(tree, ct);
        if (tree.SourceGrant is not null || (await apps.ListAppRecordsAsync(ct)).Any(a =>
            a.PrivateSources?.Git is not null && tree.Apps.Any(b => b.AppId == a.Id && b.Installation == a.InstalledAt)))
            throw Error("connection_required", "Select your own Git connection before fetching this private repository.");
        return null;
    }

    internal async Task<bool> SessionCanReadAsync(DevelopmentWorkspace tree, WorkspaceOwner actor, CancellationToken ct)
    {
        try { await RequireSessionAccessAsync(tree, actor, ct); return true; }
        catch (AppLifecycleException ex) when (ex.Code is "workspace_forbidden" or "workspace_membership_revoked") { return false; }
    }

    // API adapters establish application authority. Retained source is a Core-wide collection;
    // allocation, chat association and credentials identify activity, never a second access grant.
    internal Task RequireSessionAccessAsync(DevelopmentWorkspace tree, WorkspaceOwner actor, CancellationToken ct)
        => RequireWorkspaceUserAsync(actor.UserId, ct);

    internal async Task RequireWorkspaceUserAsync(string userId, CancellationToken ct)
    {
        if (participantUsers is not null && !(await participantUsers.ReadAsync(ct)).Users.Any(u =>
            u.Id == userId && !u.Disabled && AppAccessPolicy.IsAdmin(u)))
            throw Error("forbidden", "The initiating user no longer has workspace authority.");
    }

    internal async Task<bool> RequireParticipationSourceAsync(DevelopmentWorkspace tree, string userId, CancellationToken ct)
    {
        await RequireWorkspaceUserAsync(userId, ct);
        return true;
    }

    // Context selection is independent of collection access. Never expand a session's working
    // set merely because its caller can read every workspace.
    private async Task<bool> IsSessionWorkspaceAsync(DevelopmentWorkspace tree, WorkspaceOwner actor, CancellationToken ct)
    {
        var participation = await SessionParticipationAsync(actor, ct);
        if (participation is not null) return participation.Id == tree.WorkspaceId;
        return tree.Owner.SameIdentity(actor) &&
            (await ReadParticipationAsync(tree.WorkspaceId, ct))?.Sessions.Any(s => s.Session.SameIdentity(actor) && s.DetachedAt is not null) != true;
    }

    private async Task<string> SharingSourceRevisionAsync(IEnumerable<DevelopmentWorkspace> trees, CancellationToken ct)
    {
        var installed = await apps.ListAppRecordsAsync(ct);
        var revisions = new List<string>();
        foreach (var tree in trees.OrderBy(t => t.Id, StringComparer.Ordinal))
        {
            var repository = LogicalRepositoryIdentity(tree.Repository);
            revisions.Add(tree.Id + "\n" + repository + "\n" + CoreJson.Text(tree.SourceGrant) + "\n" + CoreJson.Text(tree.Core));
            foreach (var app in installed.Where(a => tree.Apps.Any(b => b.AppId == a.Id && b.Installation == a.InstalledAt) ||
                a.PrivateSources?.Git?.Repository == repository).OrderBy(a => a.Id, StringComparer.Ordinal))
                revisions.Add(app.Id + "\n" + app.InstalledAt.ToString("O") + "\n" + CoreJson.Text(app.PrivateSources?.Git));
        }
        return Hash(string.Join("\n", revisions));
    }

    internal async Task<DevelopmentWorkspace> SessionProjectionAsync(DevelopmentWorkspace tree, WorkspaceOwner actor, CancellationToken ct)
    {
        await RequireSessionAccessAsync(tree, actor, ct);
        return tree with { SourceGrant = null, RemoteObservation = actor.UserId == tree.Owner.UserId ? tree.RemoteObservation : null,
            SessionPath = null, LeaseClaims = null,
            Operations = tree.Operations.Select(o => o.Actor?.SameIdentity(actor) == true || o.Actor is null && tree.Owner.SameIdentity(actor)
                ? o : o with { Command = null, RemoteCommand = null, Fingerprint = "", Actor = null, Error = null }).ToArray() };
    }

    internal static DevelopmentWorkspace UserProjection(DevelopmentWorkspace tree, string actor)
        => tree with { SourceGrant = null, SessionPath = null, LeaseClaims = null,
            RemoteObservation = actor == tree.Owner.UserId ? tree.RemoteObservation : null,
            Operations = tree.Operations.Select(o => (o.Actor?.UserId ?? tree.Owner.UserId) == actor
                ? o : o with { Command = null, RemoteCommand = null, Fingerprint = "", Actor = null, Error = null }).ToArray() };

    internal async Task<WorkspaceList> SessionListAsync(WorkspaceOwner actor, CancellationToken ct)
    {
        var source = await ListAsync(actor, true, ct);
        var projected = new List<DevelopmentWorkspace>();
        foreach (var tree in source.Workspaces) projected.Add(await SessionProjectionAsync(tree, actor, ct));
        return new(projected.ToArray());
    }

    internal async Task<WorkspaceOwner> SessionResourceOwnerAsync(WorkspaceOwner actor, CancellationToken ct, bool ownerOnly = false)
    {
        var participation = await SessionParticipationAsync(actor, ct);
        if (participation is null)
        {
            if (!actor.IsExternal && (await ParticipationRecordsAsync(ct)).Any(p => p.AllocationOwner.SameIdentity(actor)))
                throw Error("session_detached", "This session is detached from its former workspace.");
            return actor;
        }
        await RequireWorkspaceUserAsync(actor.UserId, ct);
        return participation.AllocationOwner;
    }

    internal async Task RequireWorkspaceOwnerAsync(DevelopmentWorkspace tree, WorkspaceOwner? actor, CancellationToken ct)
    {
        if (actor is null) return; // Explicit administrator recovery retains its separate authorization.
        await RequireSessionAccessAsync(tree, actor, ct);
    }

    private async Task<DevelopmentWorkspace?> PrepareAssociatedAsync(WorkspaceOwner actor, WorkspacePrepare input, CancellationToken ct)
    {
        var participation = await SessionParticipationAsync(actor, ct);
        if (participation is null)
        {
            // A detached creator must not silently recover source through legacy allocation lookup.
            var history = (await ParticipationRecordsAsync(ct)).FirstOrDefault(p => p.AllocationOwner.SameIdentity(actor));
            if (history is { RetiredAt: null }) throw Error("session_detached", "Attach a workspace explicitly before preparing source again.");
            return null;
        }
        await RequireWorkspaceUserAsync(actor.UserId, ct);
        if (participation.AllocationOwner.SameIdentity(actor)) return null;
        RequestId(input.RequestId);
        if (input.SessionId != actor.SessionId) throw Error("session_invalid", "Preparation must use the authenticated session.");
        var app = await apps.GetAppAsync(input.AppId, ct) ?? throw Error("app_missing", "An installed source app is required.");
        var source = app.SourceState ?? throw Error("source_missing", "The app has no source repository.");
        var repository = await CanonicalRepository(source.Repository, source.LocalOverridePath, ct);
        var all = (await ListAsync(null, true, ct)).Workspaces;
        var tree = all.FirstOrDefault(t => t.WorkspaceId == participation.Id && t.Repository == repository);
        if (tree is null) return await PrepareCoreAsync(participation.AllocationOwner, input, ct, actor: actor);
        return await Locked(Hash(OwnerIdentity(tree.Owner)), async () =>
        {
            tree = await Read(tree.Id, actor, ct);
            await RequireOpenWorkflow(tree.Owner, ct);
            if (tree.State != "active") throw Error("not_active", "This workspace no longer has active source.");
            if (input.TargetBranch is not null && input.TargetBranch != tree.TargetBranch) throw Error("base_conflict", "The shared worktree has a different target branch.");
            if (!tree.Apps.Any(a => a.AppId == app.Id && a.Installation == app.InstalledAt))
                tree = Attach(tree, app, null);
            var fingerprint = Hash(OwnerIdentity(actor) + "\n" + CoreJson.Text(input));
            var previous = tree.Operations.FirstOrDefault(o => o.Id == input.RequestId);
            if (previous is not null)
            {
                if (previous.Kind != "prepare" || previous.Fingerprint != fingerprint) throw Error("request_conflict", "Reuse the original session and preparation arguments.");
                return tree;
            }
            if (input.LeaseId is not null)
            {
                if (!Guid.TryParse(input.LeaseId, out _)) throw Error("lease_invalid", "Lease ID must be a UUID.");
                tree = ClaimLease(tree, actor, input.LeaseId);
            }
            tree = tree with { Operations = [.. tree.Operations, new(input.RequestId, "prepare", fingerprint, "succeeded", ResultHead: tree.OriginalBase, Actor: actor)] };
            return await Save(tree);
        }, ct);
    }
}
