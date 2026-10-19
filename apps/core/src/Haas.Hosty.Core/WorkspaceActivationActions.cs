using Haas.Hosty.Launch;

namespace Haas.Hosty.Core;

internal sealed record WorkspaceActivationCommand(string? RequestId = null, WorkspaceActivationSelection? Selection = null,
    string? PlanDigest = null, string? ActivationId = null, WorkspaceReturnRequest? Return = null);

internal sealed class WorkspaceActivationActions(WorkspaceActivationService service, WorkspaceActivationAccess access,
    WorkspaceActivationRecovery recovery, WorkspaceInspectionService inspection, CoreDataPaths paths, AuditStore audit, IClock clock)
{
    internal async Task<IResult> RunAsync(string workspaceId, string kind, WorkspaceActivationCommand input,
        WorkspaceActivationActor actor, CancellationToken ct)
    {
        var outcome = "refused";
        try
        {
            _ = await inspection.WorkflowOwnerAsync(workspaceId, actor.UserId, ct);
            if (kind == "plan")
            {
                var review = await service.ReviewAsync(workspaceId, actor.UserId, input.Selection ?? new(), ct);
                await access.ValidateAsync(actor, review.Plan.Participants.Any(p => p.Kind == "core" && p.Selected), ct);
                return CoreJson.Json(review);
            }
            if (kind == "list")
            {
                await access.ValidateAsync(actor, false, ct);
                return CoreJson.Json(WorkspaceRuntimeFiles.List(paths.DataRoot).Where(a => a.WorkspaceId == workspaceId && a.UserId == actor.UserId).ToArray());
            }
            if (kind == "apply")
            {
                if (input.RequestId is null || input.PlanDigest is null || input.Selection is null)
                    throw new ArgumentException("Supply the reviewed selection, digest and stable UUID requestId.");
                var a = await service.PrepareAsync(workspaceId, new(input.RequestId, actor.UserId, input.Selection, input.PlanDigest,
                    actor with { Review = input.PlanDigest }), ct);
                outcome = "accepted";
                return a.Returns?.Length > 0 ? CoreJson.Json(await service.StatusAsync(a.Id, ct)) : CoreJson.Json(recovery.Dispatch(a.Id));
            }
            if (input.ActivationId is null) throw new ArgumentException("Supply the original activationId.");
            var activation = WorkspaceRuntimeFiles.Read(paths.DataRoot, input.ActivationId);
            if (activation.UserId != actor.UserId || activation.WorkspaceId != workspaceId) throw WorkspaceActivationAccess.Denied();
            var includesCore = kind == "return" ? input.Return?.Core == true : activation.CoreProject is not null && !activation.CoreReturned;
            await access.ValidateAsync(actor, includesCore, ct);
            if (kind == "status") return CoreJson.Json(await service.StatusAsync(activation.Id, ct));
            if (kind == "cancel") return CoreJson.Json(WorkspaceActivationSupervisor.Cancel(paths.DataRoot, activation.Id));
            if (kind == "return")
            {
                if (input.Return is null) throw new ArgumentException("Supply the explicit Return selection and compatibility acceptance.");
                var returning = await service.PrepareReturnAsync(activation.Id, input.Return, ct, actor);
                if (returning.Returns?.LastOrDefault() is not { State: "pending" } current || current.Request.RequestId != input.Return.RequestId)
                    return CoreJson.Json(await service.StatusAsync(activation.Id, ct));
                outcome = "accepted";
                return CoreJson.Json(recovery.Dispatch(activation.Id));
            }
            if (kind == "resume")
            {
                outcome = "accepted";
                return CoreJson.Json(recovery.Dispatch(activation.Id, resume: true));
            }
            throw new ArgumentException("Choose plan, apply, list, status, cancel, resume or return.");
        }
        finally
        {
            if (kind is not ("plan" or "status" or "list"))
                await audit.AppendAsync(new AuditRecord("audit_" + Guid.NewGuid().ToString("N"), "workspace.activation." + kind,
                    "workspace", workspaceId, outcome, actor.UserId, clock.UtcNow,
                    new Dictionary<string, string> { ["requestId"] = input.RequestId ?? input.Return?.RequestId ?? "",
                        ["activationId"] = input.ActivationId ?? "", ["review"] = input.PlanDigest ?? "", ["via"] = actor.Via }), CancellationToken.None);
        }
    }
}
