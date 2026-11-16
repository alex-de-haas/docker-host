using System.Text.Json;

namespace Haas.Hosty.Core;

internal sealed record CoreAgentWorkspaceInput(string WorkspaceId, long? ExpectedRevision = null,
    string? LeaseId = null, string? RequestId = null, string? Status = null, long? Sequence = null,
    string? Title = null, string? ViewerPath = null);
internal sealed record CoreAgentWorkspaceRequest(string AdmissionRef, string Operation, CoreAgentWorkspaceInput Input);
internal sealed record CoreAgentWorkspaceResult(string Id, long Revision, string Path, string? LeaseId = null,
    bool StopRequested = false, string? State = null);

internal sealed partial class CoreAgentExecution
{
    internal async Task<CoreAgentWorkspaceResult> Workspace(AppRecord provider, CoreAgentWorkspaceRequest input, CancellationToken ct)
    {
        if (input.Operation is not ("resolve" or "lease" or "activity" or "release" or "release_all") || input.Input is null)
            throw Invalid("Select a supported workspace operation.");
        return await store.WithWorkspaceLease(input.AdmissionRef, record => WorkspaceCore(provider, input, record, ct), ct);
    }
    private async Task<CoreAgentWorkspaceResult> WorkspaceCore(AppRecord provider, CoreAgentWorkspaceRequest input,
        CoreAgentAuthorization record, CancellationToken ct)
    {
        var value = input.Input;
        if (record.Request.Provider.AppId != provider.Id || record.Request.Provider.InstallationId != PanelIdentity.Installation(provider))
            throw new AppIdentityException("permission_denied", "The provider installation changed.");
        var release = input.Operation is "release" or "release_all";
        if (input.Operation == "release_all") return await ReleaseAll(provider, record, value.RequestId, ct);
        if (!release)
        {
            var (_, origin) = await ValidateRecord(provider, record, ct);
            origin.Require(AccessTokenScopes.McpWorkspaces, CoreAppPermissions.Sources);
            var consumer = await apps.GetAppAsync(record.CallerAppId, ct);
            if (consumer is null || !AppManagementAuthorization.HasPermission(consumer, CoreAppPermissions.Sources))
                throw new AppIdentityException("app_permission_required", "The consumer requires reviewed workspace access.");
        }
        if (record.Request.SessionId is not { Length: > 0 } sessionId) throw Invalid("A provider session is required.");
        var actor = new WorkspaceOwner(provider.Id, provider.InstalledAt, record.UserId, sessionId);
        if (release || input.Operation == "activity")
        {
            var lease = record.Leases?.SingleOrDefault(l => l.WorktreeId == value.WorkspaceId && l.LeaseId == value.LeaseId);
            if (lease is null || lease.SessionId != sessionId || !Guid.TryParse(value.RequestId, out _))
                throw new AppIdentityException("permission_denied", "Use the exact workspace, session and lease of this execution.");
            if (lease.Released) return new(lease.WorktreeId, 0, "", value.LeaseId, State: "released");
            var associated = await workspaces.SessionParticipationAsync(actor, ct);
            var status = value.Status switch { "queued" => "running", "waiting_for_input" => "awaiting_question", "succeeded" or "cancelled" => "unknown", _ => value.Status ?? "running" };
            var receipt = release ? await workspaces.ReleaseAgentLeaseAsync(lease.WorktreeId, actor, lease.LeaseId, ct)
                : await workspaces.AgentLeaseActivityAsync(lease.WorktreeId, actor, new(status, value.LeaseId, Sequence: value.Sequence), ct);
            if (release) await store.Change(record.Id, current => current with { Leases = current.Leases?.Select(l => l.LeaseId == lease.LeaseId ? l with { Released = true } : l).ToArray() }, ct);
            var selected = (await workspaces.ListAsync(null, true, ct)).Workspaces.SingleOrDefault(t => t.Id == lease.WorktreeId);
            return new(lease.WorktreeId, receipt.Revision ?? associated?.Revision ?? 0, selected?.Path ?? "", value.LeaseId,
                receipt.StopRequested, receipt.State);
        }
        var contexts = record.Request.Resources ?? (record.Request.Ceiling is { } ceiling && ceiling.TryGetProperty("resources", out var selectedResources) ? selectedResources : default);
        var context = contexts.ValueKind == JsonValueKind.Array ? contexts.EnumerateArray().FirstOrDefault(r => r.GetProperty("kind").GetString() == "worktree" && r.GetProperty("id").GetString() == value.WorkspaceId) : default;
        if (context.ValueKind == JsonValueKind.Undefined) throw new AppIdentityException("permission_denied", "The initial execution directory is outside its declared worktree context.");
        if (!long.TryParse(context.GetProperty("revision").GetString(), out var contextRevision)
            || value.ExpectedRevision is { } reviewed && reviewed != contextRevision) throw Invalid("Resolve the exact declared worktree revision.");
        var matches = (await workspaces.ListAsync(null, true, ct)).Workspaces
            .Where(t => (t.Id == value.WorkspaceId || t.WorkspaceId == value.WorkspaceId) && t.State == "active").ToArray();
        if (matches.Length != 1) throw new CoreProviderException("workspace_unavailable", "Select one active repository worktree.", 409);
        var tree = matches[0];
        var participation = await workspaces.ParticipationAsync(tree.WorkspaceId, record.UserId, ct);
        if (participation.Revision != contextRevision && record.Leases?.Any(l => l.WorkspaceId == tree.WorkspaceId && l.Revision == participation.Revision && !l.Released) != true)
            throw new CoreProviderException("revision_conflict", "Workspace participation changed.", 409);
        await workspaces.RequireSessionAccessAsync(tree, actor, ct);
        if (input.Operation == "resolve") return new(tree.Id, participation.Revision, tree.Path, record.Leases?.SingleOrDefault(l => l.WorktreeId == tree.Id)?.LeaseId);
        if (!Guid.TryParse(value.RequestId, out _) || !Guid.TryParse(value.LeaseId, out _)) throw Invalid("Use stable UUID request and lease IDs.");
        var binding = new CoreAgentLease(tree.WorkspaceId, tree.Id, sessionId, value.LeaseId!, value.RequestId);
        record = await store.RecordLease(record.Id, binding, ct);
        var association = await workspaces.SessionParticipationAsync(actor, ct);
        if (association is null)
        {
            if (participation.Sessions.Any(s => s.Session.SameIdentity(actor) && s.DetachedAt is not null))
                throw new CoreProviderException("session_detached", "Explicit detachment cannot be undone by execution recovery.", 409);
            await workspaces.ChangeSessionAsync(tree.WorkspaceId, actor, "attach",
                new(value.RequestId!, participation.Revision, value.Title ?? "Agent session", value.ViewerPath ?? "/"), ct);
        }
        // One primary conversation association is retained; additional reviewed repository
        // contexts still have exact execution-owned leases without changing that association.
        await workspaces.CommandAsync(tree.Id, actor, "lease", new(value.RequestId!, LeaseId: value.LeaseId), ct);
        participation = await workspaces.ParticipationAsync(tree.WorkspaceId, record.UserId, ct);
        await store.Change(record.Id, current => current with { Leases = current.Leases?.Select(l => l.LeaseId == value.LeaseId ? l with { Revision = participation.Revision } : l).ToArray() }, ct);
        return new(tree.Id, participation.Revision, tree.Path, value.LeaseId);
    }
}
