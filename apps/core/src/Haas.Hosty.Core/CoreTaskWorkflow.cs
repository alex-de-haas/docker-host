using System.Text.Json;
using HostySdk.App;

namespace Haas.Hosty.Core;

// Non-secret exact tree/attempt provenance. Core owns authority; the provider owns its graph,
// revisions, runtime budgets and private executor configuration.
internal sealed record CoreTaskWorkflowBinding(CoreTaskDispatchRef RootDispatch, HostyTaskRef RootTaskRef,
    HostyTaskRef ParentTaskRef, string ParentExecutionId, long CoordinatorEpoch, long RootGeneration);
internal sealed record CoreTaskWorkflowRequest(CoreTaskDispatchRef RootDispatch, HostyTaskRef ParentTaskRef,
    string ParentExecutionId, long CoordinatorEpoch, long RootGeneration, string Operation, string RequestId, JsonElement Payload);
internal sealed record CoreTaskWorkflowObserve(CoreTaskWorkflowBinding Binding, HostyTaskRecord Root, HostyTaskRecord Parent);

internal sealed class CoreTaskWorkflow(CoreCapabilityAuthorization authorization, CoreProviderOperationStore operations,
    CoreProviderMediation providers, CoreTaskAdapter tasks, CoreTaskSources sources)
{
    internal static void CheckCurrent(CoreTaskWorkflowBinding binding, HostyTaskRecord root, HostyTaskRecord parent, string userId)
    {
        var current = parent.Attempts.LastOrDefault();
        if (root.Ref != binding.RootTaskRef || root.ParentTaskRef is not null || root.RootTaskRef != root.Ref
            || root.Owner.UserId != userId || parent.Owner.UserId != userId || parent.RootTaskRef != root.Ref
            || parent.Ref != binding.ParentTaskRef || root.Coordination?.RootGeneration != binding.RootGeneration
            || parent.Coordination is not { } coordinator || coordinator.RootGeneration != binding.RootGeneration
            || coordinator.CoordinatorEpoch != binding.CoordinatorEpoch || coordinator.ExecutionId != binding.ParentExecutionId
            || current?.ExecutionId != binding.ParentExecutionId || current.CancelRequested || current.Invalidated == true
            || parent.CancelRequested || root.CancelRequested || root.Status is "Done" or "Cancelled"
            || parent.Status is "Done" or "Cancelled" || current.Receipt?.StopConfirmed == true)
            throw new CoreProviderException("stale_input", "The root generation or current coordinating attempt changed.", 409);
    }
    internal async Task<JsonElement> Run(AppRecord app, CoreTaskWorkflowRequest input, CancellationToken ct)
    {
        _ = CoreProviderOperationStore.Normalize(input.RequestId);
        if (!Guid.TryParse(input.ParentExecutionId, out _) || input.CoordinatorEpoch < 1 || input.RootGeneration < 1
            || input.Payload.ValueKind != JsonValueKind.Object)
            throw new CoreProviderException("invalid_input", "Use the current root, coordinator and operation payload.", 400);
        var (caller, receipt) = await authorization.TaskDispatchCallerAsync(input.RootDispatch, ct);
        var scope = receipt.TaskAuthorization!.Scope;
        if (scope.RootGeneration != input.RootGeneration) throw new CoreProviderException("stale_input", "The retained dispatch belongs to another root generation.", 409);
        if (scope.Executor.AppId != app.Id || scope.Executor.InstallationId != PanelIdentity.Installation(app))
            throw new AppIdentityException("permission_denied", "Only the retained executor installation may coordinate this root.");
        var source = new HostyTaskProviderRef(scope.TaskRef.AppId, scope.TaskRef.InstallationId, scope.TaskRef.Key);
        if (input.ParentTaskRef.AppId != source.AppId || input.ParentTaskRef.InstallationId != source.InstallationId || input.ParentTaskRef.Key != source.Key)
            throw new CoreProviderException("unsupported_capability", "Coordinated children use the root's task provider installation.", 422);
        var descriptor = await providers.ResolveAsync(caller, new(source.AppId, source.InstallationId, source.Key), "tasks", ct);
        if (descriptor.Version != 1 || !descriptor.Capabilities.Contains("parent-child") || !descriptor.Available)
            throw new CoreProviderException("unsupported_capability", "The current source must declare v1 parent-child tasks.", 422);
        var root = Read(await tasks.GetAsync(caller, new(scope.TaskRef), ct));
        var parent = root.Ref == input.ParentTaskRef ? root : Read(await tasks.GetAsync(caller, new(input.ParentTaskRef), ct));
        var binding = new CoreTaskWorkflowBinding(input.RootDispatch, root.Ref, parent.Ref, input.ParentExecutionId, input.CoordinatorEpoch, input.RootGeneration);
        CheckCurrent(binding, root, parent, caller.User.Id);
        if (parent.Attempts.Last().Executor != scope.Executor)
            throw new CoreProviderException("unsupported_capability", "The coordinating attempt must use the root executor installation.", 422);
        if (input.Operation == "observe_source")
            return JsonSerializer.SerializeToElement(await sources.Observe(app, caller, binding, ct), CoreJson.TypeInfo<CoreTaskSourceReference?>());
        if (input.Operation is "prepare_source" or "bind_source")
            return JsonSerializer.SerializeToElement(await sources.Select(app, caller, binding, parent, input, ct), CoreJson.TypeInfo<CoreTaskSourceReference>());
        var tool = input.Operation switch { "create_child" => "task_create", "edit" => "task_edit", "action" => "task_action", "read" or "observe" or "bind_session" => "task_get", _ => null };
        if (tool is null) throw new CoreProviderException("unsupported_capability", "This workflow operation is not available.", 422);
        // Check the requested tool itself against current MCP policy, not only the original launch.
        var origin = receipt.TaskAuthorization.Origin with { InvokedTool = tool, TaskWorkflow = binding };
        caller = await authorization.RevalidateAsync(origin, caller.User.Id, caller.PrincipalId, "tasks", source.AppId, source.Key, tool, ct, retainedTask: true);
        if (input.Operation == "observe") return JsonSerializer.SerializeToElement(new CoreTaskWorkflowObserve(binding, root, parent), CoreJson.TypeInfo<CoreTaskWorkflowObserve>());
        if (input.Operation == "bind_session")
        {
            var sessionId = input.Payload.TryGetProperty("sessionId", out var session) && session.ValueKind == JsonValueKind.String ? session.GetString() : null;
            if (string.IsNullOrWhiteSpace(sessionId) || sessionId.Length > 200 || parent.Attempts.Last().Receipt?.SessionRef?.Id != sessionId)
                throw new CoreProviderException("permission_denied", "Bind only the session retained by this exact accepted attempt.", 403);
            await operations.BindTaskSessionAsync(app, caller.User.Id, sessionId, binding, ct);
            return JsonSerializer.SerializeToElement(binding, CoreJson.TypeInfo<CoreTaskWorkflowBinding>());
        }
        if (input.Operation == "create_child")
        {
            var create = input.Payload.Deserialize(CoreJson.TypeInfo<HostyTaskCreate>()) ?? throw Invalid();
            if (CoreProviderOperationStore.Normalize(create.RequestId) != CoreProviderOperationStore.Normalize(input.RequestId) || create.Input.ParentTaskRef != parent.Ref
                || create.Input.Assignee?.Kind != "app" || create.Input.Assignee.Executor != scope.Executor)
                throw new CoreProviderException("permission_denied", "Create a direct child for the retained executor with the same request identity.", 403);
            return await tasks.CreateAsync(caller, new(source, create), ct);
        }
        if (input.Operation == "read")
        {
            var query = input.Payload.Deserialize(CoreJson.TypeInfo<CoreTaskGet>()) ?? throw Invalid();
            var result = await tasks.GetAsync(caller, query, ct);
            if (Read(result).RootTaskRef != root.Ref) throw new CoreProviderException("permission_denied", "Read only this retained task tree.", 403);
            return result;
        }
        if (input.Operation == "edit")
        {
            var edit = input.Payload.Deserialize(CoreJson.TypeInfo<CoreTaskEdit>()) ?? throw Invalid();
            if (CoreProviderOperationStore.Normalize(edit.Input.RequestId) != CoreProviderOperationStore.Normalize(input.RequestId)) throw Invalid();
            return await tasks.EditAsync(caller, edit, ct);
        }
        var action = input.Payload.Deserialize(CoreJson.TypeInfo<CoreTaskAction>()) ?? throw Invalid();
        if (CoreProviderOperationStore.Normalize(action.Input.RequestId) != CoreProviderOperationStore.Normalize(input.RequestId)) throw Invalid();
        return await tasks.ActionAsync(caller, action, ct);
    }
    private static HostyTaskRecord Read(JsonElement value) => value.Deserialize(CoreJson.TypeInfo<HostyTaskRecord>()) ?? throw Invalid();
    private static CoreProviderException Invalid() => new("invalid_input", "Supply the typed workflow operation payload.", 400);
}
