using System.Text.Json;
using HostySdk.App;

namespace Haas.Hosty.Core;

internal sealed record CoreTaskMcpBinding(CoreTaskDispatchRef Dispatch, string ExecutionId, string SessionId);
internal sealed record CoreTaskMcpRequest(CoreTaskMcpBinding Binding, string TargetAppId);

// Issues MCP-only, short-lived tokens for an exact admitted execution. No user credential is
// recovered, persisted or broadened; each receiving MCP endpoint revalidates this binding.
internal sealed class CoreTaskMcp(CoreCapabilityAuthorization authorization, CoreTaskAdapter tasks,
    AssistantMcpAccess access, CoreProviderOperationStore operations)
{
    internal async Task<string> Validate(AppRecord executor, CoreTaskMcpBinding binding, CancellationToken ct)
    {
        AssistantSessionAuthority.ValidateSessionId(binding.SessionId);
        var (caller, receipt) = await authorization.TaskDispatchCallerAsync(binding.Dispatch, ct);
        var scope = receipt.TaskAuthorization!.Scope;
        if (scope.Executor.AppId != executor.Id || scope.Executor.InstallationId != PanelIdentity.Installation(executor)
            || scope.ExecutionId != binding.ExecutionId) throw Denied();
        var task = (await tasks.GetAsync(caller, new(scope.TaskRef), ct)).Deserialize(CoreJson.TypeInfo<HostyTaskRecord>())!;
        var attempt = task.Attempts.LastOrDefault();
        if (task.Owner.UserId != caller.User.Id || attempt?.ExecutionId != binding.ExecutionId || attempt.Receipt?.SessionRef?.Id != binding.SessionId
            || task.CancelRequested || attempt.CancelRequested || attempt.Invalidated == true || attempt.Receipt?.StopConfirmed == true
            || task.Status is "Done" or "Cancelled") throw Denied();
        var origin = receipt.TaskAuthorization.Origin;
        var rootReference = origin.TaskWorkflow?.RootDispatch ?? binding.Dispatch;
        var rootReceipt = await operations.TaskDispatchAsync(rootReference, ct);
        var root = task.ParentTaskRef is null ? task : (await tasks.GetAsync(caller, new(task.RootTaskRef), ct)).Deserialize(CoreJson.TypeInfo<HostyTaskRecord>())!;
        if (root.Owner.UserId != caller.User.Id || root.CancelRequested || root.Status is "Done" or "Cancelled" || root.Coordination?.RootGeneration != task.Coordination?.RootGeneration
            || rootReceipt.TaskAuthorization?.Scope.RootGeneration != root.Coordination?.RootGeneration) throw Denied();
        origin = rootReceipt.TaskAuthorization!.Origin;
        if (origin.AppId != executor.Id || origin.Installation != executor.InstalledAt || origin.Kind is not ("app" or "assistant"))
            throw new CoreProviderException("mcp_origin_unsupported", "This task needs an originating assistant user grant for its configured MCP connections.", 422);
        return origin.IdentityHash ?? origin.Mcp?.GrantHash ?? throw Denied();
    }
    internal async Task<DelegatedTokenResponse> Issue(AppRecord executor, CoreTaskMcpRequest input, CancellationToken ct)
    {
        var hash = await Validate(executor, input.Binding, ct);
        return await access.IssueTaskAsync(executor.Id, input.TargetAppId, hash, input.Binding, ct);
    }
    private static CoreProviderException Denied() => new("permission_denied", "The task MCP binding is not the current owned execution.", 403);
}
