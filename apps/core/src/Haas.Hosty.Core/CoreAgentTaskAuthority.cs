using System.Text.Json;
using HostySdk.App;

namespace Haas.Hosty.Core;

internal sealed record CoreAgentTaskAuthority(string Kind, CoreTaskDispatchRef Dispatch, string ExecutionId);

internal sealed partial class CoreAgentExecution
{
    // Cancellation revokes new execution effects while retaining the exact current attempt's
    // observation and Stop authority. A pre-admission cancellation fence must not need admission.
    private static bool TaskObservationOrStop(string operation) => operation is "runs.cancel" or "runs.closure" or "runs.read" or "runs.events" or "runs.controls.read";

    private async Task<(CoreCapabilityCaller Caller, CoreCallerAuthority Origin, DateTimeOffset Expires)> TaskAuthority(
        AppRecord consumer, CoreAgentTaskAuthority authority, string operation, CancellationToken ct)
    {
        if (authority.Kind != "task" || !Guid.TryParse(authority.ExecutionId, out _)) throw Invalid("Use the exact current task execution UUID.");
        var (caller, receipt) = await authorization.TaskDispatchCallerAsync(authority.Dispatch, ct);
        var scope = receipt.TaskAuthorization!.Scope;
        if (scope.Executor.AppId != consumer.Id || scope.Executor.InstallationId != PanelIdentity.Installation(consumer)
            || scope.ExecutionId != authority.ExecutionId) throw new AppIdentityException("permission_denied", "Only the retained task executor may use this dispatch.");
        await identity.RequireAccessibleUserAsync(consumer.Id, caller.User.Id, ct);
        var task = (await tasks.GetAsync(caller, new(scope.TaskRef), ct)).Deserialize(CoreJson.TypeInfo<HostyTaskRecord>())!;
        var attempt = task.Attempts.LastOrDefault();
        var observationOrStop = TaskObservationOrStop(operation);
        if (task.Owner.UserId != caller.User.Id || attempt?.ExecutionId != authority.ExecutionId || attempt.Executor != scope.Executor
            || attempt.Invalidated == true || CoreTaskExecutionScope.Digest(attempt.Request) != scope.ExecutionHash
            || !observationOrStop && (task.CancelRequested || attempt.CancelRequested || attempt.Receipt?.StopConfirmed == true || task.Status is "Done" or "Cancelled"))
            throw new AppIdentityException("permission_denied", "This task execution is no longer current or has requested cancellation.");
        var rootReference = receipt.TaskAuthorization.Origin.TaskWorkflow?.RootDispatch ?? authority.Dispatch;
        var rootReceipt = await operations.TaskDispatchAsync(rootReference, ct);
        var root = task.ParentTaskRef is null ? task : (await tasks.GetAsync(caller, new(task.RootTaskRef), ct)).Deserialize(CoreJson.TypeInfo<HostyTaskRecord>())!;
        if (root.Owner.UserId != caller.User.Id || !observationOrStop && (root.CancelRequested || root.Status is "Done" or "Cancelled")
            || root.Coordination?.RootGeneration != task.Coordination?.RootGeneration
            || rootReceipt.TaskAuthorization?.Scope.RootGeneration != root.Coordination?.RootGeneration)
            throw new AppIdentityException("permission_denied", "The task root generation changed or requested cancellation.");
        var origin = rootReceipt.TaskAuthorization!.Origin;
        DateTimeOffset expires;
        if ((origin.IdentityHash ?? origin.Mcp?.GrantHash) is { } hash)
            expires = (await grants.TryResolveAsync(hash, ct) ?? throw new AppIdentityException("permission_denied", "The task's original application grant expired.")).AbsoluteExpiresAt;
        else if (origin.CredentialHash is { } credential)
            expires = (await users.ReadAsync(ct)).Sessions.SingleOrDefault(s => AppIdentityService.HashToken(s.Id) == credential)?.ExpiresAt
                ?? throw new AppIdentityException("permission_denied", "The task's original credential expired.");
        else throw new AppIdentityException("permission_denied", "The retained task has no renewable original actor.");
        return (caller, origin, expires);
    }
}
