using System.Text;
using System.Text.Json;
using HostySdk.App;

namespace Haas.Hosty.Core;

// Durable authorization contains identities and input digests, never task content or bearer tokens.
internal sealed record CoreTaskDispatchRef(string UserId, string PrincipalId, string RequestId);
internal sealed record CoreTaskExecutionScope(HostyTaskRef TaskRef, HostyTaskProviderRef Executor, long InputRevision,
    string InputHash, string? OptionId, string? ExecutionId, string? WorkspaceId = null, string? SessionId = null, string? LeaseId = null)
{
    internal static string Digest(HostyTaskExecutionContent content) => CoreProviderMediation.Hash(Encoding.UTF8.GetBytes(CoreJson.Text(content)));
}
internal sealed record CoreTaskDispatchAuthorization(CoreCallerAuthority Origin, CoreTaskExecutionScope Scope);
internal sealed record CoreTaskExecutorDelegation(CoreTaskDispatchRef Dispatch, HostyTaskRef TaskRef, string? ExecutionId);
internal sealed record CoreTaskDispatchRequest(CoreTaskDispatchRef Dispatch, HostyTaskProviderRef Executor, string Operation,
    string? ExecutionId = null, HostyTaskExecutionInput? Input = null, string? RequestId = null);
internal sealed record CoreTaskDispatchAuthorityRequest(CoreTaskDispatchRef Dispatch);
internal sealed record CoreTaskDispatchAuthorityView(CoreTaskDispatchRef Dispatch, CoreTaskExecutionScope Scope);
internal sealed record CoreTaskCancelInput(string RequestId);

internal sealed partial class CoreCapabilityAuthorization
{
    internal async Task<(CoreCapabilityCaller Caller, CoreProviderOperationReceipt Receipt)> TaskDispatchCallerAsync(
        CoreTaskDispatchRef reference, CancellationToken ct)
    {
        if (reference is null || string.IsNullOrWhiteSpace(reference.UserId) || reference.UserId.Length > 200
            || string.IsNullOrWhiteSpace(reference.PrincipalId) || reference.PrincipalId.Length > 500)
            throw new CoreProviderException("invalid_input", "Use a qualified task dispatch receipt.", 400);
        var receipt = await providerOperations.TaskDispatchAsync(reference, ct);
        if (receipt.TaskAuthorization is not { } grant || receipt.Provider is not { } source || receipt.Kind != "tasks"
            || receipt.Operation != "execute" || receipt.State is not ("pending" or "completed" or "unknown")
            || grant.Origin.Kind is "task-dispatch" or "task-source-read" or "history-export")
            throw new AppIdentityException("permission_denied", "This receipt does not authorize an execution dispatch.");
        var caller = await RevalidateAsync(grant.Origin, receipt.UserId, receipt.PrincipalId, "tasks", source.AppId, source.Key, "task_action", ct, retainedTask: true);
        CoreProviderPolicy.For("tasks", "execute").Require(caller);
        if (grant.Scope.WorkspaceId is not null) caller.Require(AccessTokenScopes.McpWorkspaces, CoreAppPermissions.Sources);
        var provider = await registry.GetAppAsync(source.AppId, ct);
        if (provider is null || PanelIdentity.Installation(provider) != source.InstallationId
            || !AppManagementAuthorization.HasPermission(provider, CoreAppPermissions.TaskExecutors)
            || !ProviderAccessService.Describe(provider, "tasks").Any(d => d.Key == source.Key && d.Available && d.Version == 1))
            throw new AppIdentityException("permission_denied", "The task source no longer has its reviewed executor access.");
        return (caller, receipt);
    }
}

internal sealed partial class CoreProviderMediation
{
    internal async Task<CoreTaskDispatchAuthorityView> TaskDispatchAuthorityAsync(AppRecord app, CoreTaskDispatchRef reference, CancellationToken ct)
    {
        var (_, receipt) = await authorization.TaskDispatchCallerAsync(reference, ct);
        var scope = receipt.TaskAuthorization!.Scope;
        var source = receipt.Provider!;
        if (!(source.AppId == app.Id && source.InstallationId == PanelIdentity.Installation(app))
            && !(scope.Executor.AppId == app.Id && scope.Executor.InstallationId == PanelIdentity.Installation(app)))
            throw new AppIdentityException("permission_denied", "Only the bound source or executor may observe dispatch authority.");
        await identity.RequireAccessibleUserAsync(app.Id, reference.UserId, ct);
        var executor = await apps.GetAppAsync(scope.Executor.AppId, ct);
        if (executor is null || PanelIdentity.Installation(executor) != scope.Executor.InstallationId
            || !ProviderAccessService.Describe(executor, "task-executor").Any(d => d.Key == scope.Executor.Key && d.Version == 1 && d.Available))
            throw new CoreProviderException("provider_unavailable", "The bound executor installation is unavailable.", 503, true);
        return new(reference, scope);
    }
    internal async Task<JsonElement> DispatchTaskAsync(AppRecord source, CoreTaskDispatchRequest input, CancellationToken ct)
    {
        var (caller, receipt) = await authorization.TaskDispatchCallerAsync(input.Dispatch, ct);
        if (receipt.Provider?.AppId != source.Id || receipt.Provider.InstallationId != PanelIdentity.Installation(source))
            throw new AppIdentityException("permission_denied", "Only this task provider installation may recover its execution dispatch.");
        var scope = receipt.TaskAuthorization!.Scope;
        if (input.Executor != scope.Executor || input.Operation is not ("options" or "get" or "accept" or "cancel"))
            throw new CoreProviderException("permission_denied", "Use the executor and operation bound to this task attempt.", 403);
        var executor = new HostyProviderRef(scope.Executor.AppId, scope.Executor.InstallationId, scope.Executor.Key);
        var childCaller = caller with { Authority = new("task-dispatch", TaskDispatch: input.Dispatch) };
        var policy = CoreProviderPolicy.For("task-executor", "dispatch." + input.Operation);
        if (input.Operation == "options")
            return await SendAsync<JsonElement?>(childCaller, executor, policy, "GET", "/options", null, [scope.TaskRef.Id], null, ct,
                taskDelegation: new(input.Dispatch, scope.TaskRef, null));
        if (!Guid.TryParse(input.ExecutionId, out _)) throw new CoreProviderException("invalid_input", "Select an execution UUID.", 400);
        // The source remains authoritative for its immutable attempt and cancellation intent. A
        // new attempt/reassigned executor cannot reuse an earlier action's dispatch authorization.
        var sourceCaller = caller with { Authority = new("task-source-read", TaskDispatch: input.Dispatch) };
        var taskJson = await SendAsync<JsonElement?>(sourceCaller, receipt.Provider!, CoreProviderPolicy.For("tasks", "get"), "GET",
            "/tasks/" + Uri.EscapeDataString(scope.TaskRef.Id), null, [scope.TaskRef.Id], null, ct);
        var task = taskJson.Deserialize(CoreJson.TypeInfo<HostyTaskRecord>());
        var attempt = task?.Attempts?.SingleOrDefault(a => a.ExecutionId == input.ExecutionId);
        if (task?.Ref != scope.TaskRef || attempt is null || attempt.Executor != scope.Executor
            || attempt.Request.TaskRef != scope.TaskRef || attempt.Request.TaskRevision != scope.InputRevision
            || CoreTaskExecutionScope.Digest(attempt.Request.Input) != scope.InputHash
            || scope.ExecutionId is not null && scope.ExecutionId != attempt.ExecutionId
            || scope.OptionId is not null && scope.OptionId != attempt.Request.ExecutorOptionId)
            throw new CoreProviderException("permission_denied", "The current source attempt differs from the authorized execution.", 403);
        if (input.Operation == "accept" && (input.Input is null || CoreJson.Text(input.Input) != CoreJson.Text(attempt.Request)
            || attempt.CancelRequested || task!.CancelRequested))
            throw new CoreProviderException("permission_denied", "Only the exact, uncancelled immutable attempt may be accepted.", 403);
        await operations.BindTaskExecutionAsync(input.Dispatch, input.ExecutionId!, ct);
        var route = "/executions/" + Uri.EscapeDataString(input.ExecutionId!);
        var delegation = new CoreTaskExecutorDelegation(input.Dispatch, scope.TaskRef, input.ExecutionId);
        return input.Operation switch
        {
            "get" => await SendAsync<JsonElement?>(childCaller, executor, policy, "GET", route, null, [scope.TaskRef.Id, input.ExecutionId!], null, ct, taskDelegation: delegation),
            "accept" => await SendAsync(childCaller, executor, policy, "PUT", route, input.Input!, [scope.TaskRef.Id, input.ExecutionId!], null, ct, taskDelegation: delegation),
            _ => await SendAsync(childCaller, executor, policy, "POST", route + "/cancel",
                new CoreTaskCancelInput(Guid.Parse(CoreProviderOperationStore.Normalize(input.RequestId)).ToString("D")),
                [scope.TaskRef.Id, input.ExecutionId!], null, ct, taskDelegation: delegation),
        };
    }
}
