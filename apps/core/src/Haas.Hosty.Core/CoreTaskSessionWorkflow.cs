using System.ComponentModel;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using HostySdk.App;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Haas.Hosty.Core;

internal sealed record CoreTaskSessionWorkflowBinding(HostyProviderRef Executor, string SessionId, string[]? Tools = null, JsonElement? Policy = null);
internal sealed record CoreAgentWorkflowRequest(string AdmissionRef, string Action, JsonElement Input, HostyTaskProviderRef? Source = null);
internal sealed record CoreAgentWorkflowInvocation(HostyProviderRef Provider, string SessionId, string RunId);
internal sealed record CoreAgentWorkflowGrant(string AdmissionRef, CoreTaskSessionWorkflowBinding Binding, CoreAgentWorkflowInvocation Agent);
internal sealed record CoreTaskSessionWorkflowCommand(string Action, JsonElement Input, CoreAgentWorkflowInvocation Agent, [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] HostyTaskProviderRef? Source = null);

internal sealed partial class CoreAgentExecution
{
    internal static CoreTaskSessionWorkflowBinding? Workflow(CoreAgentAuthorizeRequest input) =>
        input.Ceiling is { } ceiling && ceiling.TryGetProperty("workflow", out var value) && value.ValueKind != JsonValueKind.Null
            ? value.Deserialize(CoreJson.TypeInfo<CoreTaskSessionWorkflowBinding>()) : null;

    private static void ValidateWorkflowOwner(AppRecord consumer, CoreAgentAuthorizeRequest input)
    {
        if (Workflow(input) is not { } binding) return;
        if (binding.Executor.AppId != consumer.Id || binding.Executor.InstallationId != PanelIdentity.Installation(consumer))
            throw new AppIdentityException("permission_denied", "A session workflow belongs to the consuming executor installation.");
        if (!AppManagementAuthorization.HasPermission(consumer, CoreAppPermissions.TaskExecutors))
            throw new AppIdentityException("app_permission_required", "Session workflows require providers.task-executor.");
        if (ProviderAccessService.Find(consumer, "task-executor", binding.Executor.Key, binding.Executor.ImplementationId) is not { Version: 1 } target
            || binding.Executor.ImplementationId is not null && !target.Available || !target.Capabilities.Contains("session-workflow"))
            throw new CoreProviderException("unsupported_capability", "The consumer must declare the reviewed session-workflow executor capability.", 422);
    }

    internal async Task<bool> HasWorkflow(AppRecord provider, string admission, CancellationToken ct)
    {
        var (record, _) = await ValidateRecord(provider, await store.Get(admission, ct), ct);
        return Workflow(record.Request) is not null;
    }

    internal async Task<(CoreAgentAuthorization Record, CoreCapabilityCaller Origin, CoreTaskSessionWorkflowBinding Binding)> WorkflowScope(
        AppRecord provider, string admission, CancellationToken ct)
    {
        var (record, origin) = await ValidateRecord(provider, await store.Get(admission, ct), ct);
        var binding = Workflow(record.Request) ?? throw new CoreProviderException("unsupported_capability", "This run has no consumer-owned task workflow.", 422);
        var consumer = await apps.GetAppAsync(record.CallerAppId, ct) ?? throw new AppIdentityException("permission_denied", "The workflow consumer is unavailable.");
        ValidateWorkflowOwner(consumer, record.Request);
        if (record.Request.Operation != "runs.start" || record.Request.SessionId is null || record.Request.RunId is null)
            throw new AppIdentityException("permission_denied", "Task workflow calls require an admitted native run.");
        await identity.RequireAccessibleUserAsync(consumer.Id, record.UserId, ct);
        return (record, origin, binding);
    }
}

internal sealed partial class CoreProviderMediation
{
    internal static readonly string[] SessionWorkflowActions = ["task-executor-options", "task-options", "task-list", "task-get", "task-create", "task-edit", "task-action",
        "task-result", "task-fail", "task-request-input", "task-adopt", "task-prepare-executor", "task-delegate", "task-wait", "task-plan", "task-bind-workspace", "task-execution-get"];

    internal async Task<JsonElement?> SessionWorkflowAsync(CoreCapabilityCaller caller, string action, JsonElement input, CancellationToken ct,
        HostyTaskProviderRef? source = null)
    {
        if (caller.AgentExecution is null || caller.App is null) return null;
        var agents = services.GetRequiredService<CoreAgentExecution>();
        // An ordinary agent consumer needs no workflow endpoint at all.
        if (!await agents.HasWorkflow(caller.App, caller.AgentExecution, ct)) return null;
        var scope = await agents.WorkflowScope(caller.App, caller.AgentExecution, ct);
        if (caller.User.Id != scope.Record.UserId || caller.PrincipalId != CoreCapabilityAuthorization.AppPrincipal(caller.App))
            throw new AppIdentityException("permission_denied", "The current provider execution changed.");
        return await DispatchSessionWorkflow(scope.Record, scope.Origin, scope.Binding, action, input, source, ct);
    }

    internal async Task<JsonElement> AgentWorkflowAsync(AppRecord provider, CoreAgentWorkflowRequest input, CancellationToken ct)
    {
        var (record, origin, binding) = await services.GetRequiredService<CoreAgentExecution>().WorkflowScope(provider, input.AdmissionRef, ct);
        return await DispatchSessionWorkflow(record, origin, binding, input.Action, input.Input, input.Source, ct);
    }

    private async Task<JsonElement> DispatchSessionWorkflow(CoreAgentAuthorization record, CoreCapabilityCaller origin,
        CoreTaskSessionWorkflowBinding binding, string action, JsonElement input, HostyTaskProviderRef? source, CancellationToken ct)
    {
        if (!SessionWorkflowActions.Contains(action, StringComparer.Ordinal) || input.ValueKind != JsonValueKind.Object)
            throw new CoreProviderException("invalid_input", "Use a documented session workflow action and object input.", 400);
        var name = action.Replace('-', '_');
        if (binding.Tools is not null && !binding.Tools.Contains(name, StringComparer.Ordinal)
            || binding.Policy is { ValueKind: JsonValueKind.Object } policy && policy.TryGetProperty("tools", out var toolRules)
                && toolRules.ValueKind == JsonValueKind.Object && toolRules.TryGetProperty(name, out var rule)
                && rule.GetProperty("mode").GetString() == "disabled")
            throw new AppIdentityException("permission_denied", "This task workflow tool is disabled by its admitted selection or policy.");
        if (source is not null)
        {
            var selectedConsumer = (await apps.GetAppAsync(binding.Executor.AppId, ct))!;
            var expectedSource = record.Authority is { } authority
                ? (await operations.TaskDispatchAsync(authority.Dispatch, ct)).TaskAuthorization!.Scope.TaskRef : null;
            var matches = expectedSource is not null
                ? source.AppId == expectedSource.AppId && source.InstallationId == expectedSource.InstallationId && source.Key == expectedSource.Key && source.ImplementationId == expectedSource.ImplementationId
                : source.AppId == binding.Executor.AppId && source.InstallationId == binding.Executor.InstallationId
                    && ProviderAccessService.Find(selectedConsumer, "tasks", source.Key, source.ImplementationId) is { Version: 1 } sourceDescriptor && (source.ImplementationId is null || sourceDescriptor.Available);
            if (!matches) throw new AppIdentityException("permission_denied", "Session task tools use their current selected task provider.");
        }
        var agent = new CoreAgentWorkflowInvocation(record.Request.Provider, record.Request.SessionId!, record.Request.RunId!);
        var command = new CoreTaskSessionWorkflowCommand(action, input, agent, source);
        var body = JsonSerializer.SerializeToUtf8Bytes(command, CoreJson.TypeInfo<CoreTaskSessionWorkflowCommand>());
        if (body.Length > MaxBytes) throw new CoreProviderException("budget_exceeded", "The workflow request exceeds 1 MiB.", 413);
        var path = "/sessions/" + Uri.EscapeDataString(binding.SessionId) + "/workflow";
        var consumer = (await apps.GetAppAsync(binding.Executor.AppId, ct))!;
        var descriptor = ProviderAccessService.Find(consumer, "task-executor", binding.Executor.Key, binding.Executor.ImplementationId);
        if (descriptor is not { Available: true, Version: 1, Url: not null }) throw new CoreProviderException("provider_unavailable", "The workflow executor is unavailable.", 503, true);
        var grant = new CoreAgentWorkflowGrant(record.Id, binding, agent);
        var expires = clock.UtcNow.AddSeconds(120); if (record.ExpiresAt < expires) expires = record.ExpiresAt;
        var claims = new CoreProviderClaims(2, record.UserId, record.PrincipalId, record.Origin, binding.Executor,
            consumer.PermissionRevision, "task-executor", "session.workflow", "POST", path, Hash(body), [], expires.ToUnixTimeSeconds(), AgentWorkflow: grant, ImplementationIncarnation: descriptor.Incarnation);
        var data = Prefix + Encode(JsonSerializer.SerializeToUtf8Bytes(claims, CoreJson.TypeInfo<CoreProviderClaims>()));
        using var request = new HttpRequestMessage(HttpMethod.Post, descriptor.Url.TrimEnd('/') + path);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", data + "." + Encode(signing.Sign(Encoding.UTF8.GetBytes(data))));
        request.Content = new ByteArrayContent(body); request.Content.Headers.ContentType = new("application/json");
        try
        {
            using var response = await clients.CreateClient(ClientName).SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
            using var document = JsonDocument.Parse(await ReadBoundedAsync(response.Content, ct));
            if (!response.IsSuccessStatusCode)
            {
                var error = document.RootElement.TryGetProperty("error", out var nested) && nested.ValueKind == JsonValueKind.Object ? nested : document.RootElement;
                throw new CoreProviderException(error.TryGetProperty("code", out var code) ? code.GetString() ?? "provider_failed" : "provider_failed",
                    error.TryGetProperty("message", out var message) ? message.GetString() ?? "Workflow failed." : "Workflow failed.", (int)response.StatusCode, (int)response.StatusCode >= 500);
            }
            // The consumer may settle the task as part of this response. Do not re-admit or retry it.
            return document.RootElement.Clone();
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        { throw new CoreProviderException("provider_unavailable", "Workflow outcome is uncertain. Recover the same action with its unchanged request UUID and input.", 503, true); }
    }

    private async Task<CoreProviderInvocation> IntrospectSessionWorkflow(AppRecord consumer, CoreProviderClaims claims, CoreProviderIntrospectionRequest input, CancellationToken ct)
    {
        if (claims.Kind != "task-executor" || claims.Operation != "session.workflow" || claims.AgentWorkflow is not { } grant
            || claims.Method != "POST" || claims.Path != "/sessions/" + Uri.EscapeDataString(grant.Binding.SessionId) + "/workflow"
            || claims.Provider != grant.Binding.Executor)
            throw new AppIdentityException("token_invalid", "Use the exact admitted session workflow operation.");
        var provider = await apps.GetAppAsync(grant.Agent.Provider.AppId, ct) ?? throw new AppIdentityException("permission_denied", "The native provider is unavailable.");
        var (record, origin, binding) = await services.GetRequiredService<CoreAgentExecution>().WorkflowScope(provider, grant.AdmissionRef, ct);
        if (CoreJson.Text(binding) != CoreJson.Text(grant.Binding) || binding.Executor.AppId != consumer.Id || record.UserId != claims.UserId || record.PrincipalId != claims.PrincipalId
            || CoreJson.Text(record.Origin) != CoreJson.Text(claims.Origin)
            || grant.Agent != new CoreAgentWorkflowInvocation(record.Request.Provider, record.Request.SessionId!, record.Request.RunId!))
            throw new AppIdentityException("permission_denied", "The workflow no longer belongs to this exact actor and native run.");
        var descriptor = ProviderAccessService.Find(consumer, "task-executor", binding.Executor.Key, binding.Executor.ImplementationId);
        if (descriptor is not { Available: true, Version: 1 } || descriptor.Incarnation != claims.ImplementationIncarnation || !descriptor.Capabilities.Contains("session-workflow"))
            throw new AppIdentityException("provider_unavailable", "The reviewed session workflow is unavailable.");
        return new(2, record.UserId, origin.User.Role, record.PrincipalId, record.CallerAppId, PanelIdentity.Installation(consumer),
            "task-executor", binding.Executor.Key, "session.workflow", [], AgentExecution: grant.Agent, ImplementationId: binding.Executor.ImplementationId);
    }
}

[McpServerToolType]
internal sealed class CoreTaskSessionMcpTools(IHttpContextAccessor accessor, CoreCapabilityAuthorization auth, CoreProviderMediation providers)
{
    private Task<CallToolResult> Invoke(string action, JsonElement input, CancellationToken ct) => CoreProviderResults.Run(async () =>
    {
        var request = (accessor.HttpContext ?? throw new AppIdentityException("permission_denied", "A current Core MCP caller is required.")).Request;
        var caller = await auth.RequireAsync(request, [AccessTokenScopes.McpTasksRead], [CoreAppPermissions.TaskExecutors], ct);
        return await providers.SessionWorkflowAsync(caller, action, input, ct)
            ?? throw new CoreProviderException("unsupported_capability", "This tool requires an admitted consumer-owned session workflow.", 422);
    });

    [McpServerTool(Name = "task_executor_options", ReadOnly = true, Destructive = false)]
    [Description("Read the current session-owned executor profile directory. Input is an empty object.")]
    public Task<CallToolResult> TaskExecutorOptions([Description("Session workflow input object as described by this tool.")] JsonElement input, CancellationToken cancellationToken) => Invoke("task-executor-options", input, cancellationToken);

    [McpServerTool(Name = "task_execution_get", ReadOnly = true, Destructive = false)]
    [Description("Read this session task binding, current revisions, root plan and bounded results. Input: optional cursor and limit (1-100).")]
    public Task<CallToolResult> TaskExecutionGet([Description("Session workflow input object as described by this tool.")] JsonElement input, CancellationToken cancellationToken) => Invoke("task-execution-get", input, cancellationToken);

    [McpServerTool(Name = "task_result", ReadOnly = false, Destructive = false)]
    [Description("Report completed work and yield. Input: requestId UUID, completed true, result {markdown,resources}. Unfinished work is not success.")]
    public Task<CallToolResult> TaskResult([Description("Session workflow input object as described by this tool.")] JsonElement input, CancellationToken cancellationToken) => Invoke("task-result", input, cancellationToken);

    [McpServerTool(Name = "task_fail", ReadOnly = false, Destructive = false)]
    [Description("Report an unsuccessful attempt and yield. Input: requestId UUID, result {markdown,resources}.")]
    public Task<CallToolResult> TaskFail([Description("Session workflow input object as described by this tool.")] JsonElement input, CancellationToken cancellationToken) => Invoke("task-fail", input, cancellationToken);

    [McpServerTool(Name = "task_request_input", ReadOnly = false, Destructive = false)]
    [Description("Request mandatory human input using durable Decisions, then yield. Input: requestId UUID, reason, questions [{id,header,question,options:[{label,description}]}]. Never request secrets.")]
    public Task<CallToolResult> TaskRequestInput([Description("Session workflow input object as described by this tool.")] JsonElement input, CancellationToken cancellationToken) => Invoke("task-request-input", input, cancellationToken);

    [McpServerTool(Name = "task_adopt", ReadOnly = false, Destructive = false)]
    [Description("Start explicitly requested task orchestration in this same conversation. Input: requestId UUID, title, markdown, resources, selectionRevision, contextRevision, autonomyRevision from task_execution_get. Normal mode requires owner approval.")]
    public Task<CallToolResult> TaskAdopt([Description("Session workflow input object as described by this tool.")] JsonElement input, CancellationToken cancellationToken) => Invoke("task-adopt", input, cancellationToken);

    [McpServerTool(Name = "task_prepare_executor", ReadOnly = false, Destructive = false)]
    [Description("Choose a saved profile or prepare one-off child configuration. Input: requestId UUID, directoryRevision; option {id,revision} or name, rationale, instructions, skillIds. Read task_executor_options first.")]
    public Task<CallToolResult> TaskPrepareExecutor([Description("Session workflow input object as described by this tool.")] JsonElement input, CancellationToken cancellationToken) => Invoke("task-prepare-executor", input, cancellationToken);

    [McpServerTool(Name = "task_delegate", ReadOnly = false, Destructive = false)]
    [Description("Create and arm a direct child with its own session. Input: requestId UUID, expectedGraphRevision, title, markdown, resources, selection {kind,id,revision}, rationale; optional dependsOn and writeScope {mode,paths}.")]
    public Task<CallToolResult> TaskDelegate([Description("Session workflow input object as described by this tool.")] JsonElement input, CancellationToken cancellationToken) => Invoke("task-delegate", input, cancellationToken);

    [McpServerTool(Name = "task_wait", ReadOnly = false, Destructive = false)]
    [Description("Register a durable wait for direct children, then yield without polling. Input: requestId UUID, children [qualified task refs], mode any/all; optional observed [{taskRef,taskRevision}].")]
    public Task<CallToolResult> TaskWait([Description("Session workflow input object as described by this tool.")] JsonElement input, CancellationToken cancellationToken) => Invoke("task-wait", input, cancellationToken);

    [McpServerTool(Name = "task_plan", ReadOnly = false, Destructive = false)]
    [Description("Save a versioned plan. Input: requestId UUID, expectedRevision (0 for first), markdown.")]
    public Task<CallToolResult> TaskPlan([Description("Session workflow input object as described by this tool.")] JsonElement input, CancellationToken cancellationToken) => Invoke("task-plan", input, cancellationToken);

    [McpServerTool(Name = "task_bind_workspace", ReadOnly = false, Destructive = false)]
    [Description("Bind or prepare the authorized root source workspace. Input: requestId UUID, expectedRevision, workspaceId or prepare {appId,name,targetBranch?}. Grants no lifecycle/publication authority.")]
    public Task<CallToolResult> TaskBindWorkspace([Description("Session workflow input object as described by this tool.")] JsonElement input, CancellationToken cancellationToken) => Invoke("task-bind-workspace", input, cancellationToken);
}
