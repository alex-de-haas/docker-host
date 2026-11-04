using System.Text.Json;
using HostySdk.App;

namespace Haas.Hosty.Core;

internal sealed record CoreTaskOptions(HostyTaskProviderRef Provider, HostyTaskProviderRef? Executor = null);
internal sealed record CoreTaskQuery(HostyTaskProviderRef Provider, string? Cursor = null, int Limit = 50, string? Status = null, HostyTaskRef? ParentTaskRef = null, HostyTaskRef? RootTaskRef = null, bool RootsOnly = false);
internal sealed record CoreTaskGet(HostyTaskRef TaskRef);
internal sealed record CoreTaskCreate(HostyTaskProviderRef Provider, HostyTaskCreate Input);
internal sealed record CoreTaskEdit(HostyTaskRef TaskRef, HostyTaskEdit Input);
internal sealed record CoreTaskAction(HostyTaskRef TaskRef, HostyTaskAction Input);
internal sealed record CoreTaskOptionsView(HostyTaskProviderRef Provider, JsonElement Capabilities, ProviderDirectory Executors, CoreTaskUserChoice[] Users);
internal sealed record CoreTaskUserChoice(string Id, string DisplayName);

internal sealed class CoreTaskAdapter(CoreProviderMediation providers, CoreProviderOperationStore operations, UserDirectoryStore users, AppIdentityService identity)
{
    internal Task<ProviderDirectory> ProvidersAsync(CoreCapabilityCaller caller, CancellationToken ct) => providers.ListAsync(caller, "tasks", ct);
    internal async Task<JsonElement> OptionsAsync(CoreCapabilityCaller caller, CoreTaskOptions input, CancellationToken ct)
    {
        var provider = Ref(input.Provider);
        if (input.Executor is { } executor)
            return await providers.SendAsync<JsonElement?>(caller, Ref(executor), CoreProviderPolicy.For("task-executor", "options"), "GET", "/options", null, [], null, ct);
        var capabilities = await providers.SendAsync<JsonElement?>(caller, provider, CoreProviderPolicy.For("tasks", "options"), "GET", "/capabilities", null, [], null, ct);
        var executors = await providers.ListAsync(caller, "task-executor", ct);
        var choices = new List<CoreTaskUserChoice>();
        foreach (var user in (await users.ReadAsync(ct)).Users.Where(u => !u.Disabled))
        {
            try { await identity.RequireAccessibleUserAsync(provider.AppId, user.Id, ct); }
            catch (AppIdentityException) { continue; }
            choices.Add(new(user.Id, user.DisplayName ?? user.Id));
            if (choices.Count == 200) break;
        }
        return JsonSerializer.SerializeToElement(new CoreTaskOptionsView(input.Provider, capabilities, executors, choices.ToArray()), CoreJson.TypeInfo<CoreTaskOptionsView>());
    }
    internal async Task<JsonElement> ListAsync(CoreCapabilityCaller caller, CoreTaskQuery input, CancellationToken ct)
    {
        if (input.Limit is < 1 or > 100 || input.Cursor?.Length > 4096 || input.Status is not (null or "Draft" or "Ready" or "InProgress" or "Blocked" or "Done" or "Cancelled"))
            throw new CoreProviderException("invalid_input", "Use a common task status, a bounded cursor and page size 1–100.", 400);
        var route = "/tasks?limit=" + input.Limit + (input.Cursor is null ? "" : "&cursor=" + Uri.EscapeDataString(input.Cursor))
            + (input.Status is null ? "" : "&status=" + Uri.EscapeDataString(input.Status))
            + (input.ParentTaskRef is null ? "" : "&parentTaskRef=" + Uri.EscapeDataString(ReferenceKey(input.ParentTaskRef)))
            + (input.RootTaskRef is null ? "" : "&rootTaskRef=" + Uri.EscapeDataString(ReferenceKey(input.RootTaskRef)))
            + (input.RootsOnly ? "&rootsOnly=true" : "");
        var result = await providers.SendAsync<JsonElement?>(caller, Ref(input.Provider), CoreProviderPolicy.For("tasks", "list"), "GET", route, null, [], null, ct);
        var page = result.Deserialize(CoreJson.TypeInfo<HostyTaskPage>()) ?? throw Invalid();
        if (page.Tasks is null || page.Tasks.Length > input.Limit) throw Invalid();
        foreach (var task in page.Tasks) CheckTask(task, input.Provider);
        return result;
    }
    internal async Task<JsonElement> GetAsync(CoreCapabilityCaller caller, CoreTaskGet input, CancellationToken ct)
    {
        var provider = Ref(input.TaskRef);
        var result = await providers.SendAsync<JsonElement?>(caller, Ref(provider), CoreProviderPolicy.For("tasks", "get"), "GET", Route(input.TaskRef), null, [input.TaskRef.Id], null, ct);
        CheckTask(Task(result), provider, input.TaskRef.Id); return result;
    }
    internal async Task<JsonElement> CreateAsync(CoreCapabilityCaller caller, CoreTaskCreate input, CancellationToken ct)
    {
        if (input.Input?.Input is null) throw new CoreProviderException("invalid_input", "Provide task creation inputs.", 400);
        caller = await BoundCallerAsync(caller, ct);
        if (caller.Authority?.TaskWorkflow is { } bound && (input.Input.Input.ParentTaskRef != bound.ParentTaskRef
            || Ref(input.Provider) != Ref(Ref(bound.RootTaskRef)))) throw new CoreProviderException("root_task_required", "Create children beneath this session's current task in its existing tree.", 409);
        await CheckCapabilities(caller, input.Provider, input.Input.Input, ct);
        var result = await providers.SendAsync(caller, Ref(input.Provider), CoreProviderPolicy.For("tasks", "create"), "POST", "/tasks", input.Input, [], input.Input.RequestId, ct);
        CheckTask(Task(result), input.Provider); return result;
    }
    internal async Task<JsonElement> EditAsync(CoreCapabilityCaller caller, CoreTaskEdit input, CancellationToken ct)
    {
        if (input.Input?.Input is null) throw new CoreProviderException("invalid_input", "Provide task replacement inputs.", 400);
        var provider = Ref(input.TaskRef);
        caller = await BoundCallerAsync(caller, ct);
        await CheckBoundTarget(caller, input.TaskRef, ct);
        await CheckCapabilities(caller, provider, input.Input.Input, ct);
        var result = await providers.SendAsync(caller, Ref(provider), CoreProviderPolicy.For("tasks", "edit"), "PATCH", Route(input.TaskRef), input.Input, [input.TaskRef.Id], input.Input.RequestId, ct);
        CheckTask(Task(result), provider, input.TaskRef.Id); return result;
    }
    internal async Task<JsonElement> ActionAsync(CoreCapabilityCaller caller, CoreTaskAction input, CancellationToken ct)
    {
        if (input.Input is null || input.Input.Action is not ("ready" or "draft" or "start" or "complete" or "cancel" or "accept" or "request_changes" or "retry" or "disposition"))
            throw new CoreProviderException("invalid_input", "Use a common task action. Execution results belong to the bound executor.", 400);
        var provider = Ref(input.TaskRef);
        caller = await BoundCallerAsync(caller, ct);
        await CheckBoundTarget(caller, input.TaskRef, ct);
        var receipt = await operations.PrepareTaskActionAsync(caller, input, async () =>
        {
            var task = Task(await GetAsync(caller, new(input.TaskRef), ct));
            var active = task.Attempts?.LastOrDefault(a => a.Receipt?.StopConfirmed != true);
            var execution = input.Input.Action is "ready" or "retry" or "request_changes" or "start" or "cancel" && (task.Assignee?.Kind == "app" || active is not null);
            var selected = CoreProviderPolicy.For("tasks", execution ? "execute" : "action");
            selected.Require(caller);
            CoreTaskExecutionScope? scope = null;
            if (execution)
            {
                var executor = active?.Executor ?? task.Assignee?.Executor ?? throw Invalid();
                var descriptor = await providers.ResolveAsync(caller, Ref(executor), "task-executor", ct);
                var selection = active?.Request.Selection ?? input.Input.Selection ?? task.Assignee?.Selection;
                if (selection is null && descriptor.Capabilities.Contains("options"))
                {
                    var directory = (await OptionsAsync(caller, new(provider, executor), ct)).Deserialize(CoreJson.TypeInfo<HostyTaskExecutorOptions>()) ?? throw Invalid();
                    var option = directory.Options.SingleOrDefault(o => o.Id == directory.DefaultId)
                        ?? throw new CoreProviderException("selection_required", "Select a current executor option.", 409);
                    selection = new("option", option.Id, option.Revision);
                }
                if (selection?.Kind == "configuration" && !descriptor.Capabilities.Contains("configuration-ref"))
                    throw new CoreProviderException("unsupported_capability", "The executor does not accept configuration references.", 422);
                var selectedRevision = task.InputRevision;
                var content = new HostyTaskExecutionContent(task.Title, task.Markdown, task.Resources, task.Review);
                if (input.Input.Action == "request_changes")
                {
                    content = content with { Markdown = content.Markdown + "\n\n## Requested changes\n" + input.Input.Feedback };
                    selectedRevision++;
                }
                else if (input.Input.Action == "retry" && selection is not null) selectedRevision++;
                var snapshot = active?.Request ?? new HostyTaskExecutionInput(1, task.Ref, selectedRevision, content,
                    new(task.RootTaskRef, task.ParentTaskRef, task.RelationRevision), [], selection);
                scope = new(input.TaskRef, executor, snapshot.InputRevision, CoreTaskExecutionScope.TemplateDigest(snapshot),
                    snapshot.Selection, active?.ExecutionId, ExecutionHash: active is null ? null : CoreTaskExecutionScope.Digest(snapshot), PrerequisiteRefs: task.DependsOn);
            }
            return (selected, scope);
        }, ct);
        var policy = CoreProviderPolicy.For("tasks", receipt.Operation); policy.Require(caller);
        var forwarded = input.Input.Action is "ready" or "retry" or "request_changes" && receipt.TaskAuthorization?.Scope.Selection is { } chosen
            ? input.Input with { Selection = chosen } : input.Input;
        var result = await providers.SendAsync(caller, Ref(provider), policy, "POST", Route(input.TaskRef) + "/actions", forwarded, [input.TaskRef.Id], input.Input.RequestId, ct, taskDispatch: receipt.TaskAuthorization is null ? null : new(caller.User.Id, caller.PrincipalId, receipt.RequestId));
        CheckTask(Task(result), provider, input.TaskRef.Id); return result;
    }
    private async Task CheckCapabilities(CoreCapabilityCaller caller, HostyTaskProviderRef provider, HostyTaskInput input, CancellationToken ct)
    {
        var descriptor = await providers.ResolveAsync(caller, Ref(provider), "tasks", ct);
        if (descriptor.Version != 1) throw new CoreProviderException("version_unsupported", "The task provider must implement v1.", 422);
        foreach (var feature in new[] { input.ParentTaskRef is not null ? "parent-child" : null,
            input.DependsOn is { Length: > 0 } ? "prerequisites" : null, input.Review?.Mode == "delegator" ? "delegated-review" : null })
            if (feature is not null && !descriptor.Capabilities.Contains(feature)) throw new CoreProviderException("unsupported_capability", "The task provider does not declare " + feature + ".", 422);
    }
    private async Task<CoreCapabilityCaller> BoundCallerAsync(CoreCapabilityCaller caller, CancellationToken ct)
    {
        var binding = caller.Authority?.TaskWorkflow ?? await operations.TaskSessionAsync(caller, ct);
        if (binding is null) return caller;
        var parent = Task(await GetAsync(caller, new(binding.ParentTaskRef), ct));
        var root = parent.Ref == binding.RootTaskRef ? parent : Task(await GetAsync(caller, new(binding.RootTaskRef), ct));
        CoreTaskWorkflow.CheckCurrent(binding, root, parent, caller.User.Id);
        var retained = await operations.TaskDispatchAsync(binding.RootDispatch, ct);
        var original = retained.TaskAuthorization?.Origin ?? throw new CoreProviderException("permission_denied", "The original root authority is unavailable.", 403);
        return caller with { Authority = original with { TaskWorkflow = binding } };
    }
    private async Task CheckBoundTarget(CoreCapabilityCaller caller, HostyTaskRef reference, CancellationToken ct)
    {
        if (caller.Authority?.TaskWorkflow is not { } binding) return;
        var task = Task(await GetAsync(caller, new(reference), ct));
        if (task.RootTaskRef != binding.RootTaskRef || task.Ref != binding.ParentTaskRef && task.ParentTaskRef != binding.ParentTaskRef)
            throw new CoreProviderException("permission_denied", "An execution may change only its own task or direct children.", 403);
    }
    private static string ReferenceKey(HostyTaskRef reference) => CoreJson.Text(new[] { reference.AppId, reference.InstallationId, reference.Key, reference.Id });
    private static HostyTaskRecord Task(JsonElement result) => result.Deserialize(CoreJson.TypeInfo<HostyTaskRecord>()) ?? throw Invalid();
    private static void CheckTask(HostyTaskRecord task, HostyTaskProviderRef provider, string? id = null)
    {
        if (task.Ref is null || task.Ref.AppId != provider.AppId || task.Ref.InstallationId != provider.InstallationId || task.Ref.Key != provider.Key
            || id is not null && task.Ref.Id != id || task.Revision < 1 || !Guid.TryParse(task.Ref.Id, out _)) throw Invalid();
    }
    private static CoreProviderException Invalid() => new("provider_response_invalid", "The provider returned an invalid or differently qualified task.", 502);
    private static HostyProviderRef Ref(HostyTaskProviderRef? provider)
    {
        var result = provider is null ? null : new HostyProviderRef(provider.AppId, provider.InstallationId, provider.Key);
        CoreProviderMediation.ValidateReference(result); return result!;
    }
    private static HostyTaskProviderRef Ref(HostyTaskRef? task)
    {
        if (task is null || !Guid.TryParse(task.Id, out _)) throw new CoreProviderException("invalid_reference", "Select a qualified task UUID.", 400);
        return new(task.AppId, task.InstallationId, task.Key);
    }
    private static string Route(HostyTaskRef task) { _ = Ref(task); return "/tasks/" + Uri.EscapeDataString(task.Id); }
}
