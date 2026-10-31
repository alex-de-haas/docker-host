using System.Text.Json;
using HostySdk.App;

namespace Haas.Hosty.Core;

internal sealed record CoreTaskOptions(HostyTaskProviderRef Provider, HostyTaskProviderRef? Executor = null);
internal sealed record CoreTaskQuery(HostyTaskProviderRef Provider, string? Cursor = null, int Limit = 50, string? Status = null);
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
            + (input.Status is null ? "" : "&status=" + Uri.EscapeDataString(input.Status));
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
        var result = await providers.SendAsync(caller, Ref(input.Provider), CoreProviderPolicy.For("tasks", "create"), "POST", "/tasks", input.Input, [], input.Input.RequestId, ct);
        CheckTask(Task(result), input.Provider); return result;
    }
    internal async Task<JsonElement> EditAsync(CoreCapabilityCaller caller, CoreTaskEdit input, CancellationToken ct)
    {
        if (input.Input?.Input is null) throw new CoreProviderException("invalid_input", "Provide task replacement inputs.", 400);
        var provider = Ref(input.TaskRef);
        var result = await providers.SendAsync(caller, Ref(provider), CoreProviderPolicy.For("tasks", "edit"), "PATCH", Route(input.TaskRef), input.Input, [input.TaskRef.Id], input.Input.RequestId, ct);
        CheckTask(Task(result), provider, input.TaskRef.Id); return result;
    }
    internal async Task<JsonElement> ActionAsync(CoreCapabilityCaller caller, CoreTaskAction input, CancellationToken ct)
    {
        if (input.Input is null || input.Input.Action is not ("ready" or "draft" or "start" or "complete" or "cancel" or "accept" or "request_changes"))
            throw new CoreProviderException("invalid_input", "Use a common task action. Execution results belong to the bound executor.", 400);
        var provider = Ref(input.TaskRef);
        var receipt = await operations.PrepareTaskActionAsync(caller, input, async () =>
        {
            var task = Task(await GetAsync(caller, new(input.TaskRef), ct));
            var active = task.Attempts?.LastOrDefault(a => a.Receipt?.StopConfirmed != true);
            var execution = input.Input.Action is "ready" or "start" or "cancel" && (task.Assignee?.Kind == "app" || active is not null);
            var selected = CoreProviderPolicy.For("tasks", execution ? "execute" : "action");
            selected.Require(caller);
            CoreTaskExecutionScope? scope = null;
            if (execution)
            {
                var executor = active?.Executor ?? task.Assignee?.Executor ?? throw Invalid();
                _ = await providers.ResolveAsync(caller, Ref(executor), "task-executor", ct);
                var content = active?.Request.Input ?? new(task.Title, task.Markdown, task.Resources, task.RequiresReview, task.WorkspaceId);
                if (content.WorkspaceId is not null) caller.Require(AccessTokenScopes.McpWorkspaces, CoreAppPermissions.Sources);
                scope = new(input.TaskRef, executor, active?.Request.TaskRevision ?? task.InputRevision,
                    CoreTaskExecutionScope.Digest(content), active?.Request.ExecutorOptionId ?? task.Assignee?.OptionId, active?.ExecutionId, content.WorkspaceId);
            }
            return (selected, scope);
        }, ct);
        var policy = CoreProviderPolicy.For("tasks", receipt.Operation); policy.Require(caller);
        var result = await providers.SendAsync(caller, Ref(provider), policy, "POST", Route(input.TaskRef) + "/actions", input.Input, [input.TaskRef.Id], input.Input.RequestId, ct, taskDispatch: receipt.TaskAuthorization is null ? null : new(caller.User.Id, caller.PrincipalId, receipt.RequestId));
        CheckTask(Task(result), provider, input.TaskRef.Id); return result;
    }
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
