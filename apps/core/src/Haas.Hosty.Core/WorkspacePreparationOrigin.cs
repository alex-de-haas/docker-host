namespace Haas.Hosty.Core;

// This metadata comes from the authenticated consuming backend when the run is admitted.
internal sealed record CoreAgentConversation(string SessionId, string ViewerPath, string Title)
{
    internal void Validate()
    {
        AssistantSessionAuthority.ValidateSessionId(SessionId ?? "");
        if (string.IsNullOrWhiteSpace(Title) || Title.Length > 200 || Title.Any(char.IsControl) ||
            ViewerPath is not { Length: > 0 and <= 2048 } || !ViewerPath.StartsWith('/') || ViewerPath.StartsWith("//") ||
            ViewerPath.Contains('\\') || ViewerPath.Any(char.IsControl))
            throw CoreAgentExecution.Invalid("Supply a bounded conversation title and app-relative viewer path.");
    }
}
internal sealed record WorkspaceChatOrigin(WorkspaceOwner Owner, CoreAgentConversation Conversation, string AdmissionRef, string RunId, string? Generation);
internal sealed record WorkspacePreparationEvidence(string AdmissionRef, string RunId, string? Generation, string WorktreeId, string PrepareRequestId);

internal sealed partial class DevelopmentWorkspaceService
{
    // Called under the same participation lock that protects workspace selection, prepare and attach.
    private async Task<WorkspaceParticipation?> PreparationParticipationAsync(WorkspaceOwner execution,
        WorkspaceOwner conversation, CancellationToken ct)
    {
        var native = await SessionParticipationAsync(execution, ct);
        var chat = await SessionParticipationAsync(conversation, ct);
        if (native is not null && chat is not null && native.Id != chat.Id)
            throw Error("session_bound", "The execution and its originating conversation are attached to different workspaces.");
        var target = native ?? chat;
        if (native?.Sessions.FirstOrDefault(s => s.Session.SameIdentity(execution))?.Origin is { } retained && !retained.SameIdentity(conversation))
            throw Error("origin_conflict", "This native session already has another originating conversation.");
        if (target?.Sessions.Any(s => s.DetachedAt is not null &&
                (s.Session.SameIdentity(execution) || s.Session.SameIdentity(conversation))) == true)
            throw Error("session_detached", "The originating conversation or execution was explicitly detached from this workspace.");
        return target;
    }

    private async Task<WorkspaceParticipation> MarkExecutionCoreAsync(string workspaceId, WorkspaceOwner execution, CancellationToken ct)
    {
        var participation = await EnsureParticipationAsync(workspaceId, ct);
        var binding = participation.Sessions.FirstOrDefault(s => s.DetachedAt is null && s.Session.SameIdentity(execution));
        if (binding is null || binding.Kind == "execution") return participation;
        var next = participation with { Revision = checked(participation.Revision + 1),
            Sessions = participation.Sessions.Select(s => s == binding
                ? s with { Kind = "execution", Title = "Native agent execution", ViewerPath = null } : s).ToArray() };
        await SaveParticipationAsync(next, ct);
        return next;
    }

    internal Task<WorkspaceParticipation> RepairPreparationAsync(DevelopmentWorkspace tree, WorkspaceOwner native,
        WorkspaceChatOrigin chat, string prepareId, string requestId, long revision, CancellationToken ct)
        => Locked("workspace-participation", async () =>
            await BindPreparationAsync(await Read(tree.Id, null, ct), native, chat, prepareId, requestId, revision, ct), ct);

    private async Task<WorkspaceParticipation> BindPreparationAsync(DevelopmentWorkspace tree, WorkspaceOwner native,
        WorkspaceChatOrigin chat, string prepareId, string? recoveryRequestId, long? expectedRevision, CancellationToken ct)
    {
        if (chat.Owner.UserId != native.UserId || chat.Owner.IsExternal || native.IsExternal ||
            !tree.Operations.Any(o => o.Id == prepareId && o.Kind == "prepare" && o.State == "succeeded" && (o.Actor ?? tree.Owner).SameIdentity(native)))
            throw Error("origin_unresolved", "An exact preparation receipt for the admitted execution is required.");
        await RequireWorkspaceUserAsync(chat.Owner.UserId, ct);
        var participation = await EnsureParticipationAsync(tree.WorkspaceId, ct);
        var actor = OwnerIdentity(chat.Owner);
        var requestId = recoveryRequestId ?? prepareId;
        var fingerprint = Hash(CoreJson.Text(new[] { "preparation-origin", tree.WorkspaceId, recoveryRequestId is null ? prepareId : null,
            OwnerIdentity(native), actor, chat.Conversation.ViewerPath, expectedRevision?.ToString() }));
        if (ParticipationReplay(participation, requestId, actor, fingerprint)) return participation;
        if (expectedRevision is not null && participation.Revision != expectedRevision) throw Error("revision_conflict", "Workspace participation changed. Refresh before recovering the chat.");
        if (participation.RetiredAt is not null || tree.State != "active") throw Error("unavailable", "The workspace no longer has active source.");
        var target = await PreparationParticipationAsync(native, chat.Owner, ct);
        if (target is not null && target.Id != tree.WorkspaceId) throw Error("session_bound", "The conversation or execution is attached to another workspace.");
        if (participation.Sessions.Any(s => s.DetachedAt is not null && (s.Session.SameIdentity(chat.Owner) || s.Session.SameIdentity(native))))
            throw Error("session_detached", "Explicit detachment cannot be undone by preparation recovery.");
        var trees = (await ListAsync(null, true, ct)).Workspaces.Where(t => t.WorkspaceId == tree.WorkspaceId && t.State == "active");
        foreach (var member in trees) await RequireParticipationSourceAsync(member, chat.Owner.UserId, ct);
        await RequireOpenWorkflow(participation.AllocationOwner, ct);
        var now = clock.UtcNow;
        var sessions = participation.Sessions.ToList();
        var ownerIndex = sessions.FindIndex(s => s.Session.SameIdentity(chat.Owner));
        if (ownerIndex < 0)
            sessions.Add(new(chat.Owner, chat.Conversation.Title, chat.Conversation.ViewerPath, now, Status: "idle", ActivityAt: now));
        else if (native.SameIdentity(chat.Owner) && (sessions[ownerIndex].Kind == "execution" || sessions[ownerIndex].ViewerPath is null))
            sessions[ownerIndex] = sessions[ownerIndex] with { Title = chat.Conversation.Title, ViewerPath = chat.Conversation.ViewerPath, Kind = null, Origin = null };
        if (!native.SameIdentity(chat.Owner))
        {
            var index = sessions.FindIndex(s => s.Session.SameIdentity(native));
            if (index < 0) sessions.Add(new(native, "Native agent execution", null, now, Kind: "execution", Origin: chat.Owner));
            else sessions[index] = sessions[index] with { Kind = "execution", Title = "Native agent execution", ViewerPath = null, Origin = chat.Owner };
        }
        return await SaveParticipationCommandAsync(participation with { Sessions = [.. sessions] }, requestId, actor, fingerprint, ct,
            new(chat.AdmissionRef, chat.RunId, chat.Generation, tree.Id, prepareId));
    }
}
