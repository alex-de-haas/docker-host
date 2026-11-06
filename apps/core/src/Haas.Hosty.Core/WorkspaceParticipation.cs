namespace Haas.Hosty.Core;

internal sealed record WorkspaceMember(string UserId, string Role, string[] WorktreeIds,
    DateTimeOffset GrantedAt, string GrantedBy, DateTimeOffset? RevokedAt = null, string? SourceRevision = null);
internal sealed record WorkspaceSessionBinding(WorkspaceOwner Session, string Title, string? ViewerPath,
    DateTimeOffset AttachedAt, DateTimeOffset? DetachedAt = null, string Status = "unknown",
    DateTimeOffset? ActivityAt = null, string? LeaseId = null, DateTimeOffset? ChangedAt = null, long? ActivitySequence = null);
internal sealed record WorkspaceParticipationOperation(string Id, string Actor, string Fingerprint);
internal sealed record WorkspaceParticipation(string Id, WorkspaceOwner AllocationOwner, long Revision,
    WorkspaceMember[] Members, WorkspaceSessionBinding[] Sessions, WorkspaceParticipationOperation[] Operations, DateTimeOffset? RetiredAt = null);
internal sealed record WorkspaceMemberCommand(string RequestId, long ExpectedRevision, string UserId,
    string[]? WorktreeIds = null);
internal sealed record WorkspaceSessionCommand(string RequestId, long ExpectedRevision, string? Title = null,
    string? ViewerPath = null);

internal sealed partial class DevelopmentWorkspaceService
{
    private string ParticipationRoot => System.IO.Path.Combine(Root, "participation");
    private string ParticipationPath(string id)
    {
        Id(id);
        return System.IO.Path.Combine(ParticipationRoot, id + ".json");
    }

    // The allocation owner remains immutable compatibility evidence. Active session associations
    // and membership are separate records, never synthetic owner credentials.
    internal async Task<WorkspaceParticipation?> ReadParticipationAsync(string workspaceId, CancellationToken ct)
    {
        var value = await recordCache.ReadAsync<WorkspaceParticipation>(ParticipationPath(workspaceId), ct);
        if (value is null) return null;
        if (value.Id != workspaceId || value.AllocationOwner is null ||
            WorkspaceIdFor(value.AllocationOwner) != workspaceId || value.Revision < 1 ||
            value.Members is null || value.Sessions is null || value.Operations is null ||
            value.Members.Any(m => m is null || m.WorktreeIds is null || m.Role is not ("owner" or "contributor")) ||
            value.Sessions.Any(s => s is null || s.Session is null) ||
            value.Operations.Any(o => o is null) ||
            value.Members.Count(m => m.Role == "owner") != 1 ||
            value.Members.Count(m => m.Role == "owner" && m.RevokedAt is null && m.UserId == value.AllocationOwner.UserId) != 1 ||
            value.Members.Select(m => m.UserId).Distinct(StringComparer.Ordinal).Count() != value.Members.Length ||
            value.Sessions.Select(s => OwnerIdentity(s.Session)).Distinct(StringComparer.Ordinal).Count() != value.Sessions.Length)
            throw Error("membership_invalid", "Workspace participation metadata requires recovery.");
        return value;
    }

    private async Task SaveParticipationAsync(WorkspaceParticipation value, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        await JsonStorage.WriteAsync(ParticipationPath(value.Id), value, restrictToOwner: true);
        observationState?.CatalogChanged();
    }

    private async Task<WorkspaceParticipation[]> ParticipationRecordsAsync(CancellationToken ct)
    {
        if (!Directory.Exists(ParticipationRoot)) return [];
        var records = new List<WorkspaceParticipation>();
        foreach (var file in Directory.EnumerateFiles(ParticipationRoot, "*.json"))
        {
            var value = await ReadParticipationAsync(System.IO.Path.GetFileNameWithoutExtension(file), ct);
            if (value is not null) records.Add(value);
        }
        // A damaged record fails closed: it could contain the session's existing binding.
        return records.ToArray();
    }

    internal async Task<WorkspaceParticipation?> SessionParticipationAsync(WorkspaceOwner session, CancellationToken ct)
    {
        if (session.IsExternal) return null;
        var matches = (await ParticipationRecordsAsync(ct)).Where(p =>
            p.Sessions.Any(s => s.DetachedAt is null && s.Session.SameIdentity(session))).ToArray();
        if (matches.Length > 1) throw Error("membership_invalid", "A session has conflicting workspace associations.");
        return matches.SingleOrDefault();
    }

    private static WorkspaceMember RequireMember(WorkspaceParticipation value, string userId, bool ownerOnly = false)
    {
        var member = value.Members.FirstOrDefault(m => m.UserId == userId && m.RevokedAt is null);
        if (member is null || ownerOnly && member.Role != "owner")
            throw Error("forbidden", ownerOnly ? "Only the workspace owner can change membership." : "This workspace is not shared with the current user.");
        return member;
    }

    private async Task<WorkspaceParticipation> EnsureParticipationAsync(string workspaceId, CancellationToken ct, string? migrationActor = null)
    {
        var existing = await ReadParticipationAsync(workspaceId, ct);
        if (existing is not null) return existing;
        var trees = (await ListAsync(null, true, ct)).Workspaces.Where(w => w.WorkspaceId == workspaceId).ToArray();
        if (trees.Length == 0) throw Error("not_found", "Workspace not found.");
        var first = trees[0];
        var owner = first.Owner;
        if (trees.Any(w => !w.Owner.SameIdentity(owner))) throw Error("membership_invalid", "Workspace allocation evidence conflicts.");
        var now = clock.UtcNow;
        var value = new WorkspaceParticipation(workspaceId, owner, 1,
            [new(owner.UserId, "owner", trees.Select(t => t.Id).Order(StringComparer.Ordinal).ToArray(), now, owner.UserId)],
            [new(owner, first.Name ?? "Workspace", first.SessionPath, now, Status: trees.Any(t => t.Leases.Length > 0) ? "unknown" : "idle")], []);
        await SaveParticipationAsync(value, ct);
        return value;
    }

    private async Task ActivatePreparedParticipationAsync(DevelopmentWorkspace tree, WorkspacePrepare input, CancellationToken ct)
    {
        var value = await EnsureParticipationAsync(tree.WorkspaceId, ct);
        if (value.RetiredAt is null) return;
        // Explicit preparation after verified removal preserves legacy allocation/replay IDs.
        // Old invitations and detached sessions never regain access to this source generation.
        var now = clock.UtcNow;
        await SaveParticipationAsync(value with { Revision = checked(value.Revision + 1), RetiredAt = null,
            Members = value.Members.Select(m => m.Role == "owner" ? m with { WorktreeIds = [tree.Id] }
                : m with { RevokedAt = m.RevokedAt ?? now }).ToArray(),
            Sessions = [.. value.Sessions.Where(s => !s.Session.SameIdentity(tree.Owner)),
                new(tree.Owner, input.Name ?? tree.Name ?? "Workspace", input.SessionPath, now, Status: tree.Leases.Length > 0 ? "unknown" : "idle")] }, ct);
    }

    internal Task<WorkspaceParticipation> ParticipationAsync(string workspaceId, string actor, CancellationToken ct)
        => Locked("workspace-participation", async () =>
        {
            await RequireWorkspaceUserAsync(actor, ct);
            var value = await EnsureParticipationAsync(workspaceId, ct);
            return value;
        }, ct);

    private static bool ParticipationReplay(WorkspaceParticipation value, string requestId, string actor, string fingerprint)
    {
        RequestId(requestId);
        var previous = value.Operations.FirstOrDefault(o => o.Id == requestId);
        if (previous is null) return false;
        if (previous.Actor != actor || previous.Fingerprint != fingerprint)
            throw Error("request_conflict", "Reuse the original actor and arguments with this request ID.");
        return true;
    }

    private async Task<WorkspaceParticipation> SaveParticipationCommandAsync(WorkspaceParticipation value,
        string requestId, string actor, string fingerprint, CancellationToken ct)
    {
        value = value with { Revision = checked(value.Revision + 1),
            Operations = [.. value.Operations, new(requestId, actor, fingerprint)] };
        await SaveParticipationAsync(value, ct);
        return value;
    }

    internal Task<WorkspaceParticipation> ChangeMemberAsync(string workspaceId, string actor, string kind,
        WorkspaceMemberCommand input, CancellationToken ct)
        => Locked("workspace-participation", async () =>
        {
            RequestId(input.RequestId);
            if (kind is not ("grant" or "revoke") || string.IsNullOrWhiteSpace(input.UserId) || input.UserId.Length > 200)
                throw Error("member_invalid", "Choose a user and grant or revoke membership.");
            var value = await EnsureParticipationAsync(workspaceId, ct, actor);
            await RequireWorkspaceUserAsync(actor, ct);
            if (input.UserId == value.AllocationOwner.UserId) throw Error("owner_required", "Workspace ownership cannot be revoked or transferred here.");
            var fingerprint = Hash(kind + "\n" + CoreJson.Text(input));
            if (ParticipationReplay(value, input.RequestId, actor, fingerprint)) return value;
            if (input.ExpectedRevision != value.Revision) throw Error("revision_conflict", "Workspace membership changed. Refresh before choosing an action.");
            var trees = (await ListAsync(null, true, ct)).Workspaces.Where(t => t.WorkspaceId == workspaceId).ToArray();
            if (trees.Length == 0 || trees.Any(t => t.State != "active")) throw Error("unavailable", "The workspace is unavailable for membership changes.");
            var member = value.Members.FirstOrDefault(m => m.UserId == input.UserId);
            if (kind == "grant")
            {
                await RequireOpenWorkflow(value.AllocationOwner, ct);
                if (input.WorktreeIds is not { Length: > 0 and <= 256 } || input.WorktreeIds.Distinct(StringComparer.Ordinal).Count() != input.WorktreeIds.Length ||
                    input.WorktreeIds.Any(id => !trees.Any(t => t.Id == id)))
                    throw Error("sharing_scope_invalid", "Explicitly select the existing repository worktrees to share.");
                foreach (var tree in trees.Where(t => input.WorktreeIds.Contains(t.Id)))
                    await RequireParticipationSourceAsync(tree, actor, ct);
                member = new(input.UserId, "contributor", input.WorktreeIds.Order(StringComparer.Ordinal).ToArray(), clock.UtcNow, actor,
                    SourceRevision: await SharingSourceRevisionAsync(trees.Where(t => input.WorktreeIds.Contains(t.Id)), ct));
            }
            else
            {
                if (member is null) throw Error("member_missing", "This user has no workspace membership.");
                member = member with { RevokedAt = clock.UtcNow };
            }
            value = value with { Members = [.. value.Members.Where(m => m.UserId != input.UserId), member] };
            // Revocation fences API admission immediately. Session bindings/leases remain evidence
            // until their owning assistant verifies execution shutdown; they are never discarded here.
            return await SaveParticipationCommandAsync(value, input.RequestId, actor, fingerprint, ct);
        }, ct);

    internal Task<WorkspaceParticipation> ChangeSessionAsync(string workspaceId, WorkspaceOwner actor, string kind,
        WorkspaceSessionCommand input, CancellationToken ct)
        => Locked("workspace-participation", async () =>
        {
            RequestId(input.RequestId);
            if (actor.IsExternal || kind is not ("attach" or "detach")) throw Error("session_invalid", "Use an installed assistant session to attach or detach.");
            AssistantSessionAuthority.ValidateSessionId(actor.SessionId);
            var value = await EnsureParticipationAsync(workspaceId, ct, actor.UserId);
            var session = value.Sessions.FirstOrDefault(s => s.Session.SameIdentity(actor));
            await RequireWorkspaceUserAsync(actor.UserId, ct);
            var actorKey = OwnerIdentity(actor);
            var fingerprint = Hash(kind + "\n" + CoreJson.Text(input));
            if (ParticipationReplay(value, input.RequestId, actorKey, fingerprint)) return value;
            if (value.Revision != input.ExpectedRevision) throw Error("revision_conflict", "Workspace membership changed. Refresh before choosing an action.");
            var trees = (await ListAsync(null, true, ct)).Workspaces.Where(t => t.WorkspaceId == workspaceId).ToArray();
            if (kind == "attach")
            {
                if (input.Title is null || string.IsNullOrWhiteSpace(input.Title) || input.Title.Length > 200 || input.Title.Any(char.IsControl) ||
                    input.ViewerPath is not { Length: > 0 and <= 2048 } path || !path.StartsWith('/') || path.StartsWith("//") || path.Contains('\\') || path.Any(char.IsControl))
                    throw Error("session_invalid", "Supply a bounded session title and an app-relative viewer path.");
                if (trees.Length == 0 || trees.All(t => t.State != "active")) throw Error("unavailable", "This workspace has no retained source to attach.");
                await RequireOpenWorkflow(value.AllocationOwner, ct);
                var current = await SessionParticipationAsync(actor, ct);
                if (current is not null && current.Id != workspaceId) throw Error("session_bound", "Detach the existing workspace before attaching another one.");
                var legacy = (await ListAsync(null, true, ct)).Workspaces.Where(t => t.Owner.SameIdentity(actor) && t.State != "released");
                foreach (var tree in legacy.Where(t => t.WorkspaceId != workspaceId))
                {
                    var prior = await ReadParticipationAsync(tree.WorkspaceId, ct);
                    if (prior?.Sessions.Any(s => s.Session.SameIdentity(actor) && s.DetachedAt is not null) != true)
                        throw Error("session_bound", "This session already owns retained source. Detach it explicitly first.");
                }
                await RequireSessionIdleAsync(trees, actor, ct);
                foreach (var tree in trees.Where(t => t.State == "active"))
                    await RequireParticipationSourceAsync(tree, actor.UserId, ct);
                session = new(actor, input.Title.Trim(), path, clock.UtcNow, Status: "idle", ActivityAt: clock.UtcNow);
            }
            else
            {
                if (session is null) throw Error("session_missing", "The session has no association with this workspace.");
                await RequireSessionIdleAsync(trees, actor, ct);
                session = session with { DetachedAt = clock.UtcNow };
            }
            value = value with { Sessions = [.. value.Sessions.Where(s => !s.Session.SameIdentity(actor)), session] };
            return await SaveParticipationCommandAsync(value, input.RequestId, actorKey, fingerprint, ct);
        }, ct);

    private Task RequireSessionIdleAsync(DevelopmentWorkspace[] trees, WorkspaceOwner actor, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        // Unknown legacy leases remain conservative claims. Other attributable executions do
        // not prevent detaching this stopped session or lose their own leases when it detaches.
        if (trees.Any(t => t.Leases.Any(id => t.LeaseClaims?.FirstOrDefault(c => c.Id == id) is { } claim && claim.Session.SameIdentity(actor)) ||
            t.Operations.Any(o => o.State is "pending" or "unknown" && (o.Actor is null || o.Actor.SameIdentity(actor)))))
            throw Error("session_busy", "Stop native work and reconcile activity leases and operations before detaching.");
        return Task.CompletedTask;
    }
}
