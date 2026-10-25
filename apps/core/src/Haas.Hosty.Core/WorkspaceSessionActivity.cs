namespace Haas.Hosty.Core;

internal sealed record WorkspaceActivityRequest(string Status, string? LeaseId = null, bool Stopped = false, string? Title = null, long? Sequence = null);
internal sealed record WorkspaceActivityReceipt(string? WorkspaceId, long? Revision, bool StopRequested, string State);

internal sealed partial class DevelopmentWorkspaceService
{
    internal Task<WorkspaceActivityReceipt> SessionActivityAsync(WorkspaceOwner actor, WorkspaceActivityRequest input, CancellationToken ct)
        => Locked("workspace-participation", async () =>
        {
            if (input.Status is not ("idle" or "failed" or "running" or "awaiting_approval" or "awaiting_question" or "stopping" or "unknown") ||
                input.Sequence is < 0 || input.LeaseId is not null && !Guid.TryParse(input.LeaseId, out _) ||
                input.Title is { } title && (title.Length > 200 || title.Any(char.IsControl)))
                throw Error("activity_invalid", "Supply a bounded execution state and lease identity.");
            var value = await SessionParticipationAsync(actor, ct);
            if (value is null)
            {
                var legacy = (await ListAsync(null, true, ct)).Workspaces.FirstOrDefault(t => t.Owner.SameIdentity(actor));
                if (legacy is not null && await ReadParticipationAsync(legacy.WorkspaceId, ct) is null)
                    value = await EnsureParticipationAsync(legacy.WorkspaceId, ct, actor.UserId);
            }
            if (value is null) return new WorkspaceActivityReceipt(null, null, false, "unbound");
            return await Locked(Hash(OwnerIdentity(value.AllocationOwner)), async () =>
            {
                var trees = (await ListAsync(null, true, ct)).Workspaces.Where(t => t.WorkspaceId == value.Id).ToArray();
                var binding = value.Sessions.Single(s => s.Session.SameIdentity(actor));
                var stop = false;
                try
                {
                    RequireMember(value, actor.UserId);
                    await RequireOpenWorkflow(value.AllocationOwner, ct);
                    foreach (var tree in trees.Where(t => t.LeaseClaims?.Any(c => c.Session.SameIdentity(actor)) == true))
                        await RequireSessionAccessAsync(tree, actor, ct);
                }
                catch (AppLifecycleException) { stop = true; }
                if (binding.ActivitySequence is { } sequence && (input.Sequence is null || input.Sequence <= sequence))
                    return new WorkspaceActivityReceipt(value.Id, value.Revision, stop, binding.Status);
                if (input.Stopped)
                {
                    // The authenticated user and owning assistant acknowledge shutdown of their
                    // exact execution. An old acknowledgement cannot release a later run's lease.
                    if (input.LeaseId is not null)
                        foreach (var tree in trees.Where(t => t.Leases.Contains(input.LeaseId)))
                        {
                            RequireLeaseOwner(tree, actor, input.LeaseId);
                            await Save(tree with { Leases = tree.Leases.Where(id => id != input.LeaseId).ToArray(),
                                LeaseClaims = tree.LeaseClaims?.Where(c => c.Id != input.LeaseId).ToArray() });
                        }
                    if (binding.LeaseId is not null && binding.LeaseId != input.LeaseId)
                        return new WorkspaceActivityReceipt(value.Id, value.Revision, stop, binding.Status);
                }
                else if (input.Status != "idle" && input.LeaseId is not null &&
                    !trees.Any(t => t.Leases.Contains(input.LeaseId) && t.LeaseClaims?.Any(c => c.Id == input.LeaseId && c.Session.SameIdentity(actor)) == true))
                    throw Error("activity_lease_missing", "Acquire this execution's source lease before reporting active work.");
                var leaseId = input.Stopped ? null : input.LeaseId ?? binding.LeaseId;
                var status = input.Stopped ? input.Status == "failed" ? "failed" : "idle"
                    : stop ? "stopping" : leaseId is not null && input.Status is ("idle" or "failed") ? "unknown" : input.Status;
                var name = input.Title is { Length: > 0 } ? input.Title : binding.Title;
                binding = binding with { Status = status, ActivityAt = clock.UtcNow, LeaseId = leaseId,
                    ChangedAt = binding.Status != status || binding.Title != name ? clock.UtcNow : binding.ChangedAt,
                    ActivitySequence = input.Sequence ?? binding.ActivitySequence, Title = name };
                await SaveParticipationAsync(value with { Sessions = value.Sessions.Select(s => s.Session.SameIdentity(actor) ? binding : s).ToArray() }, ct);
                return new WorkspaceActivityReceipt(value.Id, value.Revision, stop, binding.Status);
            }, ct);
        }, ct);

    internal async Task<bool> CanRecoverSessionCleanupAsync(WorkspaceOwner owner, WorkspaceWorkflowCommand command, CancellationToken ct)
    {
        RequestId(command.RequestId);
        var job = await JsonStorage.ReadAsync<WorkspaceCleanupJob>(System.IO.Path.Combine(Root, "cleanup", command.RequestId + ".json"), ct);
        return job is not null && job.WorkspaceId == WorkspaceIdFor(owner) && job.UserId == owner.UserId && job.Input == command;
    }

    private async Task RetireParticipationAsync(string workspaceId, CancellationToken ct)
    {
        var record = await ReadParticipationAsync(workspaceId, ct);
        if (record is null) return;
        await SaveParticipationAsync(record with { Revision = record.Revision + 1, RetiredAt = clock.UtcNow,
            Sessions = record.Sessions.Select(s => s with { DetachedAt = s.DetachedAt ?? clock.UtcNow, Status = "idle", LeaseId = null }).ToArray() }, ct);
    }

    internal async Task<bool> SessionDetachedAsync(WorkspaceOwner actor, CancellationToken ct)
    {
        var records = await ParticipationRecordsAsync(ct);
        if (records.Any(p => p.Sessions.Any(s => s.Session.SameIdentity(actor) && s.DetachedAt is null))) return false;
        var detached = records.Where(p => p.Sessions.Any(s => s.Session.SameIdentity(actor) && s.DetachedAt is not null)).ToArray();
        if (detached.Length == 0) return false;
        foreach (var value in detached)
            await RequireSessionIdleAsync((await ListAsync(null, true, ct)).Workspaces.Where(t => t.WorkspaceId == value.Id).ToArray(), actor, ct);
        return true;
    }
}

internal static class WorkspaceSessionActivityEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapPost("/api/internal/apps/{appId}/sessions/{sessionId}/workspace-activity", async (string appId, string sessionId,
            WorkspaceActivityRequest input, HttpRequest request, WorkspaceAuthorization auth,
            DevelopmentWorkspaceService workspaces, CancellationToken ct) =>
        {
            request.HttpContext.Response.Headers.CacheControl = "no-store";
            try
            {
                // Identity comes from the existing user activity grant plus app service token.
                // The request cannot name another user or another assistant installation.
                var actor = await auth.RequireAsync(request, appId, sessionId, ct);
                return CoreJson.Json(await workspaces.SessionActivityAsync(actor, input, ct));
            }
            catch (AppIdentityException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), AuthEndpoints.MapIdentityErrorStatus(ex.Code)); }
            catch (AppLifecycleException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), 409); }
        });
    }
}
