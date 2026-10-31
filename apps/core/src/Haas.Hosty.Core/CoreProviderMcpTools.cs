using System.ComponentModel;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Haas.Hosty.Core;

internal static class CoreProviderResults
{
    internal static async Task<CallToolResult> Run<T>(Func<Task<T>> action)
    {
        try { return CoreCapabilityResults.Success(await action()); }
        catch (Exception ex) when (ex is CoreProviderException or AppIdentityException or SandboxException or System.Text.Json.JsonException)
        {
            var error = ex switch
            {
                CoreProviderException provider => provider.Error,
                AppIdentityException identity => new CoreProviderError(identity.Code, identity.Message, false),
                SandboxException sandbox => new CoreProviderError(sandbox.Code, sandbox.Message, false),
                _ => new CoreProviderError("provider_response_invalid", "The provider returned an invalid response.", false),
            };
            var result = CoreCapabilityResults.Success(new CoreProviderFailure(error)); result.IsError = true; return result;
        }
    }
}
[McpServerToolType]
internal sealed class CoreProviderMcpTools(IHttpContextAccessor accessor, CoreCapabilityAuthorization auth,
    CoreTaskAdapter tasks, CoreAgentSessionAdapter sessions)
{
    private Task<CoreCapabilityCaller> Caller(string kind, string operation, CancellationToken ct)
        => CoreProviderApi.Caller((accessor.HttpContext ?? throw new AppIdentityException("permission_denied", "A current Core caller is required.")).Request, auth, kind, operation, ct);

    [McpServerTool(Name = "task_providers", ReadOnly = true, Destructive = false)]
    [Description("Discover reviewed task providers accessible to the current user, including installation IDs and availability. Core does not select a default provider or store task records.")]
    public Task<CallToolResult> TaskProviders(CancellationToken cancellationToken)
        => CoreProviderResults.Run(async () => await tasks.ProvidersAsync(await Caller("tasks", "list", cancellationToken), cancellationToken));

    [McpServerTool(Name = "task_options", ReadOnly = true, Destructive = false)]
    [Description("Read the explicitly selected task provider's capabilities and accessible executor directory. Supply an executor reference for that executor's opaque options. Profiles and runtime settings remain private to their provider.")]
    public Task<CallToolResult> TaskOptions([Description("Explicit task provider and optional executor, each qualified by installation and interface key.")] CoreTaskOptions input, CancellationToken cancellationToken)
        => CoreProviderResults.Run(async () => await tasks.OptionsAsync(await Caller("tasks", "options", cancellationToken), input, cancellationToken));

    [McpServerTool(Name = "task_list", ReadOnly = true, Destructive = false)]
    [Description("List visible tasks from one explicitly selected provider. Results preserve provider-owned IDs and revisions; unavailable providers are errors, not empty task collections. No Harness conversation is needed.")]
    public Task<CallToolResult> TaskList([Description("Provider reference, optional status/cursor and page size 1–100.")] CoreTaskQuery input, CancellationToken cancellationToken)
        => CoreProviderResults.Run(async () => await tasks.ListAsync(await Caller("tasks", "list", cancellationToken), input, cancellationToken));

    [McpServerTool(Name = "task_get", ReadOnly = true, Destructive = false)]
    [Description("Read a task through its qualified provider/installation/key/ID reference. The provider enforces current user access and returns its authoritative revision.")]
    public Task<CallToolResult> TaskGet([Description("Qualified task reference.")] CoreTaskGet input, CancellationToken cancellationToken)
        => CoreProviderResults.Run(async () => await tasks.GetAsync(await Caller("tasks", "get", cancellationToken), input, cancellationToken));

    [McpServerTool(Name = "task_create", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Create a provider-owned Draft task with a stable request UUID. Requires explicit task write authority. Retain the provider selection and unchanged input when recovering an uncertain reply; references do not grant resource access.")]
    public Task<CallToolResult> TaskCreate([Description("Provider and replayable creation input, including title, markdown, assignee and resources.")] CoreTaskCreate input, CancellationToken cancellationToken)
        => CoreProviderResults.Run(async () => await tasks.CreateAsync(await Caller("tasks", "create", cancellationToken), input, cancellationToken));

    [McpServerTool(Name = "task_edit", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Replace editable Draft task inputs using the provider's current expectedRevision and original request UUID. Active or uncertain execution must stop according to provider policy before editing.")]
    public Task<CallToolResult> TaskEdit([Description("Qualified task reference and revision-checked full replacement.")] CoreTaskEdit input, CancellationToken cancellationToken)
        => CoreProviderResults.Run(async () => await tasks.EditAsync(await Caller("tasks", "edit", cancellationToken), input, cancellationToken));

    [McpServerTool(Name = "task_action", ReadOnly = false, Destructive = true, Idempotent = true)]
    [Description("Apply a common task lifecycle/review action. Ready/start that dispatches executor work and cancellation of an active attempt require separate execute authority and current executor access. Execution results remain bound to their original executor; acceptance never proves native termination.")]
    public Task<CallToolResult> TaskAction([Description("Qualified task reference, action, request UUID and expectedRevision; review includes the original result input revision.")] CoreTaskAction input, CancellationToken cancellationToken)
        => CoreProviderResults.Run(async () => await tasks.ActionAsync(await Caller("tasks", "action", cancellationToken), input, cancellationToken));

    [McpServerTool(Name = "agent_session_providers", ReadOnly = true, Destructive = false)]
    [Description("Discover accessible reviewed agent-session providers independently of conversation-history providers. Native state stays at its owning provider; no Harness installation is required.")]
    public Task<CallToolResult> SessionProviders(CancellationToken cancellationToken)
        => CoreProviderResults.Run(async () => await sessions.ProvidersAsync(await Caller("agent-sessions", "sessions.get", cancellationToken), cancellationToken));

    [McpServerTool(Name = "agent_session_list", ReadOnly = true, Destructive = false)]
    [Description("Query bounded native-session metadata from one qualified provider, optionally for a conversation. Availability and coverage must remain explicit; no transcript or hidden native state is included.")]
    public Task<CallToolResult> SessionList([Description("Explicit provider, optional conversation/cursor and page size 1–200.")] CoreAgentSessionQuery input, CancellationToken cancellationToken)
        => CoreProviderResults.Run(async () => await sessions.ListAsync(await Caller("agent-sessions", "sessions.query", cancellationToken), input, cancellationToken));

    [McpServerTool(Name = "agent_session_get", ReadOnly = true, Destructive = false)]
    [Description("Observe one provider-native session, its revision, conversation reference and active runs. Conversation sharing grants no execution access.")]
    public Task<CallToolResult> SessionGet([Description("Native session reference with explicit provider and opaque native ID.")] CoreAgentSessionGet input, CancellationToken cancellationToken)
        => CoreProviderResults.Run(async () => await sessions.GetAsync(await Caller("agent-sessions", "sessions.get", cancellationToken), input, cancellationToken));

    [McpServerTool(Name = "agent_run_get", ReadOnly = true, Destructive = false)]
    [Description("Read current execution state, freshness and provider-confirmed native termination. Terminal text/state, a missing heartbeat or an unavailable provider never implies stopConfirmed.")]
    public Task<CallToolResult> RunGet([Description("Qualified execution run reference.")] CoreAgentRunGet input, CancellationToken cancellationToken)
        => CoreProviderResults.Run(async () => await sessions.ReadRunAsync(await Caller("agent-sessions", "runs.get", cancellationToken), input.Run, cancellationToken));

    [McpServerTool(Name = "agent_run_cancel", ReadOnly = false, Destructive = true, Idempotent = true)]
    [Description("Request cancellation of an authorized run using a stable UUID and expected revision. Requires separate execution control authority. Inspect the retained run until the provider confirms its native consumers exited before releasing resource claims.")]
    public Task<CallToolResult> RunCancel([Description("Run reference, stable request UUID and decimal-string expected revision.")] CoreAgentRunCancel input, CancellationToken cancellationToken)
        => CoreProviderResults.Run(async () => await sessions.CancelAsync(await Caller("agent-sessions", "runs.cancel", cancellationToken), input, cancellationToken));
}
