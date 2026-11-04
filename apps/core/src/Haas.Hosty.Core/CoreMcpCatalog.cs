using System.Collections.Frozen;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Haas.Hosty.Core;

// This catalog belongs to Core, not to installed applications. Feature keys describe capabilities;
// they neither discover an app by identity nor authorize a caller. Domain services retain their
// current resource, actor, source, revision and replay checks.
internal static class CoreMcpCatalog
{
    private static readonly AsyncLocal<string?> Invocation = new();
    internal static string? InvokedTool => Invocation.Value;

    internal const string MetadataKey = "io.hosty/core-tool";
    internal const int SchemaVersion = 1;

    private static readonly CoreMcpFeature Workflow = new("workflow", "Work lifecycle");
    private static readonly CoreMcpFeature History = new("history", "Conversation history");
    private static readonly CoreMcpFeature Decisions = new("decisions", "Decisions");
    private static readonly string[] DecisionScopes = [AccessTokenScopes.McpRead, AccessTokenScopes.McpDecisions];
    private static readonly CoreMcpFeature Tasks = new("tasks", "Tasks");
    private static readonly CoreMcpFeature Sessions = new("agent-sessions", "Agent sessions & runs");
    private static readonly CoreMcpFeature Environments = new("environments", "Test environments");
    private static readonly string[] EnvironmentRead = [AccessTokenScopes.McpRead, AccessTokenScopes.McpEnvironmentsRead];
    private static readonly string[] EnvironmentManage = [AccessTokenScopes.McpRead, AccessTokenScopes.McpEnvironmentsRead, AccessTokenScopes.McpEnvironmentsManage];
    private static readonly string[] EnvironmentApi = [AccessTokenScopes.McpRead, AccessTokenScopes.McpEnvironmentsRead, AccessTokenScopes.McpEnvironmentsManage, AccessTokenScopes.McpEnvironmentApi];

    private static readonly CoreMcpFeature Host = new("host", "Host & Core");
    private static readonly CoreMcpFeature Apps = new("apps", "App management");
    private static readonly CoreMcpFeature Logs = new("logs", "Logs & audit");
    private static readonly CoreMcpFeature Workspaces = new("workspaces", "Workspaces");
    private static readonly CoreMcpFeature Git = new("git", "Git & pull requests");
    private static readonly CoreMcpFeature Creation = new("app-creation", "App creation");
    private static readonly CoreMcpFeature Development = new("development", "Runtime development");

    private static readonly string[] Read = [AccessTokenScopes.McpRead];
    private static readonly string[] Lifecycle = [AccessTokenScopes.McpRead, AccessTokenScopes.McpLifecycle];
    private static readonly string[] Update = [AccessTokenScopes.McpRead, AccessTokenScopes.McpUpdate];
    private static readonly string[] Restart = [AccessTokenScopes.McpRead, AccessTokenScopes.McpCoreRestart];
    private static readonly string[] Workspace = [AccessTokenScopes.McpRead, AccessTokenScopes.McpWorkspaces];
    private static readonly string[] WorkspaceLifecycle = [AccessTokenScopes.McpRead, AccessTokenScopes.McpWorkspaces, AccessTokenScopes.McpLifecycle];
    private static readonly CoreMcpScopeCondition WorktreeCondition = new("worktree", [AccessTokenScopes.McpWorkspaces]);
    private static readonly CoreMcpScopeCondition CoreCondition = new("core-participant", [AccessTokenScopes.McpCoreRestart]);

    // Explicit assignments: a tool prefix or readOnlyHint never selects its feature or authority.
    // Only implemented tools belong here. Keep existing public names and app admission unchanged.
    internal static readonly FrozenDictionary<string, CoreMcpToolDefinition> Tools = new CoreMcpToolDefinition[]
    {
        new("decision_create", Decisions, DecisionScopes, CoreAppPermissions.DecisionsRequest),
        new("decision_list", Decisions, DecisionScopes, CoreAppPermissions.DecisionsRead),
        new("decision_get", Decisions, DecisionScopes, CoreAppPermissions.DecisionsRead),
        new("decision_resolve", Decisions, DecisionScopes, CoreAppPermissions.DecisionsRespond),
        new("decision_withdraw", Decisions, DecisionScopes, CoreAppPermissions.DecisionsRequest),
        new("decision_invalidate", Decisions, DecisionScopes, CoreAppPermissions.DecisionsRequest),
        new("decision_responses", Decisions, DecisionScopes, CoreAppPermissions.DecisionsRequest),
        new("decision_acknowledge", Decisions, DecisionScopes, CoreAppPermissions.DecisionsRequest),
        new("decision_continuation", Decisions, DecisionScopes, CoreAppPermissions.DecisionsRequest),
        ProviderTool("history_export_create", History, "conversation-history", "exports.create"),
        ProviderTool("history_export_get", History, "conversation-history", "exports.get"),
        ProviderTool("history_export_acknowledge", History, "conversation-history", "exports.acknowledge"),
        ProviderTool("history_export_revoke", History, "conversation-history", "exports.revoke"),
        ProviderTool("history_export_snapshot", History, "conversation-history", "exports.snapshot"),
        ProviderTool("history_export_changes", History, "conversation-history", "exports.changes"),
        ProviderTool("history_providers", History, "conversation-history", "capabilities"),
        ProviderTool("history_capabilities", History, "conversation-history", "capabilities"),
        ProviderTool("conversation_list", History, "conversation-history", "conversations.query"),
        ProviderTool("conversation_get", History, "conversation-history", "conversations.get"),
        ProviderTool("history_read", History, "conversation-history", "entries.query"),
        ProviderTool("history_entry_get", History, "conversation-history", "entries.get"),
        ProviderTool("history_attachment_get", History, "conversation-history", "attachments.resolve"),
        ProviderTool("history_search", History, "conversation-history", "search"),
        ProviderTool("history_share_list", History, "conversation-history", "shares.query"),
        ProviderTool("history_share_create", History, "conversation-history", "shares.create"),
        ProviderTool("history_share_revoke", History, "conversation-history", "shares.revoke"),
        ProviderTool("history_operation_get", History, "conversation-history", "capabilities"),
        ProviderTool("task_providers", Tasks, "tasks", "list"),
        ProviderTool("task_options", Tasks, "tasks", "options"),
        ProviderTool("task_list", Tasks, "tasks", "list"),
        ProviderTool("task_get", Tasks, "tasks", "get"),
        ProviderTool("task_create", Tasks, "tasks", "create"),
        ProviderTool("task_edit", Tasks, "tasks", "edit"),
        ProviderTool("task_action", Tasks, "tasks", "action"),
        ProviderTool("agent_session_providers", Sessions, "agent-sessions", "sessions.get"),
        ProviderTool("agent_session_list", Sessions, "agent-sessions", "sessions.query"),
        ProviderTool("agent_session_get", Sessions, "agent-sessions", "sessions.get"),
        ProviderTool("agent_run_get", Sessions, "agent-sessions", "runs.get"),
        ProviderTool("agent_run_cancel", Sessions, "agent-sessions", "runs.cancel"),
        new("environment_consent", Environments, EnvironmentManage, CoreAppPermissions.CoreEnvironmentsOperate),
        new("environment_list", Environments, EnvironmentRead, CoreAppPermissions.CoreEnvironmentsInspect),
        new("environment_status", Environments, EnvironmentRead, CoreAppPermissions.CoreEnvironmentsInspect),
        new("environment_consumer_register", Environments, EnvironmentManage, CoreAppPermissions.CoreEnvironmentsOperate),
        new("environment_consumer_release", Environments, EnvironmentManage, CoreAppPermissions.CoreEnvironmentsOperate),
        new("environment_consumer_reconcile", Environments, EnvironmentManage, CoreAppPermissions.CoreEnvironmentsOperate),
        new("environment_create", Environments, EnvironmentManage, CoreAppPermissions.CoreEnvironmentsOperate),
        new("environment_start", Environments, EnvironmentManage, CoreAppPermissions.CoreEnvironmentsOperate),
        new("environment_stop", Environments, EnvironmentManage, CoreAppPermissions.CoreEnvironmentsOperate),
        new("environment_restart", Environments, EnvironmentManage, CoreAppPermissions.CoreEnvironmentsOperate),
        new("environment_finish", Environments, EnvironmentManage, CoreAppPermissions.CoreEnvironmentsOperate),
        new("environment_setup", Environments, EnvironmentApi, CoreAppPermissions.CoreEnvironmentsApi),
        new("environment_api", Environments, EnvironmentApi, CoreAppPermissions.CoreEnvironmentsApi),
        new("get_host_status", Host, Read, CoreAppPermissions.ReadCore),
        new("get_core_development", Host, Read, CoreAppPermissions.ReadCore),
        new("get_core_operation", Host, Read, CoreAppPermissions.ReadCore),
        new("restart_core", Host, Restart, CoreAppPermissions.CoreLifecycle),
        new("list_apps", Apps, Read, CoreAppPermissions.ReadApps),
        new("get_app", Apps, Read, CoreAppPermissions.ReadApps),
        new("start_app", Apps, Lifecycle, CoreAppPermissions.AppLifecycle),
        new("stop_app", Apps, Lifecycle, CoreAppPermissions.AppLifecycle),
        new("restart_app", Apps, Lifecycle, CoreAppPermissions.AppLifecycle),
        new("list_app_source_migrations", Apps, [AccessTokenScopes.McpRead, AccessTokenScopes.McpWorkspaces, AccessTokenScopes.McpUpdate], CoreAppPermissions.Sources),
        new("plan_app_update_source", Apps, [AccessTokenScopes.McpRead, AccessTokenScopes.McpWorkspaces, AccessTokenScopes.McpUpdate], CoreAppPermissions.Sources),
        new("apply_app_update_source", Apps, [AccessTokenScopes.McpRead, AccessTokenScopes.McpWorkspaces, AccessTokenScopes.McpUpdate], CoreAppPermissions.Sources),
        new("get_app_update_source_operation", Apps, [AccessTokenScopes.McpRead, AccessTokenScopes.McpWorkspaces, AccessTokenScopes.McpUpdate], CoreAppPermissions.Sources),
        new("apply_app_update_sources", Apps, [AccessTokenScopes.McpRead, AccessTokenScopes.McpWorkspaces, AccessTokenScopes.McpUpdate], CoreAppPermissions.Sources),
        new("plan_app_update", Apps, Update, CoreAppPermissions.Install),
        new("apply_app_update", Apps, Update, CoreAppPermissions.Install),
        new("tail_app_logs", Logs, Read, CoreAppPermissions.AppLogs),
        new("search_audit", Logs, Read, CoreAppPermissions.CoreLogs),
        new("get_app_development_guide", Creation, Read, CoreAppPermissions.ReadApps),
        new("prepare_workspace", Workspaces, Workspace, CoreAppPermissions.Sources),
        new("list_workspaces", Workspaces, Workspace, CoreAppPermissions.Sources),
        new("workflow_status", Workflow, Workspace, CoreAppPermissions.Sources),
        new("workflow_resume", Workflow, Workspace, CoreAppPermissions.Sources),
        new("workflow_pause", Workflow, Workspace, CoreAppPermissions.Sources),
        new("workflow_complete", Workflow, [.. Workspace, AccessTokenScopes.McpPublicationRead], CoreAppPermissions.Sources),
        new("app_creation_capabilities", Creation, Workspace, CoreAppPermissions.Sources),
        new("app_creation_guide", Creation, Workspace, CoreAppPermissions.Sources),
        new("app_creation_status", Creation, Workspace, CoreAppPermissions.Sources),
        new("app_local_status", Creation, Workspace, CoreAppPermissions.Sources),
        new("app_create", Creation, [.. Workspace, AccessTokenScopes.McpAppCreate], CoreAppPermissions.Install),
        new("pr_connections", Git, [.. Workspace, AccessTokenScopes.McpPublicationRead], CoreAppPermissions.Sources),
        new("pr_list", Git, [.. Workspace, AccessTokenScopes.McpPublicationRead], CoreAppPermissions.Sources),
        new("pr_status", Git, [.. Workspace, AccessTokenScopes.McpPublicationRead], CoreAppPermissions.Sources),
        new("pr_resolve_review", Git, [.. Workspace, AccessTokenScopes.McpPublicationRead, AccessTokenScopes.McpPublicationWrite], CoreAppPermissions.PublicationWrite),
        new("pr_commit", Git, Workspace, CoreAppPermissions.Sources),
        new("pr_configure", Git, [.. Workspace, AccessTokenScopes.McpPublicationRead, AccessTokenScopes.McpPublicationWrite], CoreAppPermissions.PublicationWrite),
        new("pr_push", Git, [.. Workspace, AccessTokenScopes.McpPublicationRead, AccessTokenScopes.McpPublicationWrite], CoreAppPermissions.PublicationWrite),
        new("pr_publish", Git, [.. Workspace, AccessTokenScopes.McpPublicationRead, AccessTokenScopes.McpPublicationWrite], CoreAppPermissions.PublicationWrite),
        new("pr_link", Git, [.. Workspace, AccessTokenScopes.McpPublicationRead, AccessTokenScopes.McpPublicationWrite], CoreAppPermissions.PublicationWrite),
        new("pr_ready", Git, [.. Workspace, AccessTokenScopes.McpPublicationRead, AccessTokenScopes.McpPublicationWrite], CoreAppPermissions.PublicationWrite),
        new("pr_merge", Git, [.. Workspace, AccessTokenScopes.McpPublicationRead, AccessTokenScopes.McpPublicationWrite], CoreAppPermissions.PublicationWrite),
        new("pr_complete", Git, [.. Workspace, AccessTokenScopes.McpPublicationRead], CoreAppPermissions.Sources),
        new("pr_corrective", Git, [.. Workspace, AccessTokenScopes.McpPublicationRead, AccessTokenScopes.McpPublicationWrite], CoreAppPermissions.PublicationWrite),
        new("remote_status", Git, [.. Workspace, AccessTokenScopes.McpPublicationRead], CoreAppPermissions.Sources),
        new("remote_connect", Git, [.. Workspace, AccessTokenScopes.McpPublicationRead], CoreAppPermissions.Sources),
        new("remote_fetch", Git, [.. Workspace, AccessTokenScopes.McpPublicationRead], CoreAppPermissions.Sources),
        new("remote_push_base", Git, [.. Workspace, AccessTokenScopes.McpPublicationRead, AccessTokenScopes.McpPublicationWrite], CoreAppPermissions.PublicationWrite),
        new("get_workspace_participants", Workspaces, Workspace, CoreAppPermissions.Sources),
        new("get_workspace_commit_review", Git, Workspace, CoreAppPermissions.Sources),
        new("merge_workspace_upstream", Git, Workspace, CoreAppPermissions.Sources),
        new("get_workspace", Workspaces, Workspace, CoreAppPermissions.Sources),
        new("rename_workspace", Workspaces, Workspace, CoreAppPermissions.Sources),
        new("delete_workspace", Workspaces, Workspace, CoreAppPermissions.Sources),
        new("acquire_workspace_lease", Workspaces, Workspace, CoreAppPermissions.Sources),
        new("release_workspace_lease", Workspaces, Workspace, CoreAppPermissions.Sources),
        new("get_workspace_diff", Git, Workspace, CoreAppPermissions.Sources),
        new("refresh_workspace", Git, Workspace, CoreAppPermissions.Sources),
        new("commit_workspace", Git, Workspace, CoreAppPermissions.Sources),
        new("merge_workspace_target", Git, Workspace, CoreAppPermissions.Sources),
        new("abort_workspace_merge", Git, Workspace, CoreAppPermissions.Sources),
        new("record_workspace_pull_requests", Git, Workspace, CoreAppPermissions.Sources),
        new("get_app_dev_mode", Development, Lifecycle, CoreAppPermissions.AppLifecycle),
        new("plan_app_dev_mode", Development, Lifecycle, CoreAppPermissions.AppLifecycle, Conditions: [WorktreeCondition]),
        new("apply_app_dev_mode", Development, Lifecycle, CoreAppPermissions.AppLifecycle, Conditions: [WorktreeCondition]),
        new("get_app_execution_targets", Development, Workspace, CoreAppPermissions.Sources),
        new("get_app_execution_selection", Development, Workspace, CoreAppPermissions.Sources),
        new("get_workspace_execution_selection", Development, Workspace, CoreAppPermissions.Sources),
        new("select_app_execution_target", Development, WorkspaceLifecycle, CoreAppPermissions.Sources),
        new("select_workspace_execution", Development, WorkspaceLifecycle, CoreAppPermissions.Sources),
        new("configure_workspace_runtime", Development, Workspace, CoreAppPermissions.Sources),
        new("workspace_activation", Development, WorkspaceLifecycle, CoreAppPermissions.Sources, Conditions: [CoreCondition]),
    }.ToFrozenDictionary(tool => tool.Name, StringComparer.Ordinal);

    private static CoreMcpToolDefinition ProviderTool(string name, CoreMcpFeature feature, string kind, string operation)
    {
        var policy = CoreProviderPolicy.For(kind, operation);
        return new(name, feature, [AccessTokenScopes.McpRead, .. policy.Scopes], policy.Permissions.Last(),
            Conditions: name == "task_action" ? [new("executor-dispatch-or-cancel", [AccessTokenScopes.McpTasksExecute])] : null);
    }

    internal static string? AppPermission(string name) => Tools.GetValueOrDefault(name)?.AppPermission;

    internal static void ConfigureFilters(IMcpRequestFilterBuilder filters)
    {
        filters.AddListToolsFilter(next => async (request, cancellationToken) =>
        {
            var result = await next(request, cancellationToken);
            // The SDK may reuse primitive descriptors across requests. Decorate independent copies
            // and retain schemas, annotations, pagination and unrelated protocol metadata.
            result.Tools = result.Tools.Select(Describe).ToList();
            return result;
        });
        filters.AddCallToolFilter(next => async (request, cancellationToken) =>
        {
            if (request.Params?.Name is not { } name || !Tools.ContainsKey(name))
                return new CallToolResult
                {
                    IsError = true,
                    Content = [new TextContentBlock { Text = CoreJson.Text(new ErrorResponse(
                        "mcp_tool_unmapped", "This tool has no reviewed Core capability mapping.")) }],
                };
            // Validate only public schema facts before SDK argument binding. Binding exceptions are
            // otherwise intentionally sanitized, as are unexpected exceptions from the tool body.
            if (request.MatchedPrimitive is McpServerTool tool &&
                ArgumentError(tool.ProtocolTool.InputSchema, request.Params.Arguments) is { } error)
                return new CallToolResult
                {
                    IsError = true,
                    Content = [new TextContentBlock { Text = CoreJson.Text(error) }],
                };
            var previous = Invocation.Value;
            Invocation.Value = name;
            try { return await next(request, cancellationToken); }
            finally { Invocation.Value = previous; }
        });
    }

    private static ErrorResponse? ArgumentError(JsonElement schema, IDictionary<string, JsonElement>? arguments)
    {
        if (schema.TryGetProperty("required", out var required))
            foreach (var entry in required.EnumerateArray())
            {
                var name = entry.GetString()!;
                if (arguments is null || !arguments.ContainsKey(name))
                    return new("mcp_argument_required", $"Required argument '{name}' is missing.");
            }

        if (arguments is not null && schema.TryGetProperty("properties", out var properties))
            foreach (var property in properties.EnumerateObject())
            {
                if (!arguments.TryGetValue(property.Name, out var value) ||
                    !property.Value.TryGetProperty("type", out var type)) continue;
                var types = type.ValueKind == JsonValueKind.Array
                    ? type.EnumerateArray().Select(entry => entry.GetString()!).ToArray()
                    : [type.GetString()!];
                if (!types.Any(expected => MatchesType(value, expected)))
                    return new("mcp_argument_invalid",
                        $"Argument '{property.Name}' must have JSON type {string.Join(" or ", types)}.");
            }
        return null;
    }

    // This is a binding-shape check, not a replacement for each tool's domain validation.
    // Unknown schema constraints remain with the SDK and the owning service.
    private static bool MatchesType(JsonElement value, string expected) => expected switch
    {
        "string" => value.ValueKind == JsonValueKind.String,
        "integer" => value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out _),
        "number" => value.ValueKind == JsonValueKind.Number,
        "boolean" => value.ValueKind is JsonValueKind.True or JsonValueKind.False,
        "object" => value.ValueKind == JsonValueKind.Object,
        "array" => value.ValueKind == JsonValueKind.Array,
        "null" => value.ValueKind == JsonValueKind.Null,
        _ => true,
    };

    internal static Tool Describe(Tool tool)
    {
        if (!Tools.TryGetValue(tool.Name, out var definition))
            throw new InvalidOperationException("A registered MCP tool has no reviewed Core capability mapping.");

        var copy = JsonSerializer.Deserialize(JsonSerializer.SerializeToElement(tool, CoreJson.TypeInfo<Tool>()),
            CoreJson.TypeInfo<Tool>())!;
        copy.Meta ??= new JsonObject();
        copy.Meta[MetadataKey] = new JsonObject
        {
            ["schemaVersion"] = SchemaVersion,
            ["owner"] = AgentMcpDirectory.CoreId,
            ["operationId"] = definition.Name,
            ["feature"] = new JsonObject { ["id"] = definition.Feature.Id, ["title"] = definition.Feature.Title },
            ["authority"] = new JsonObject
            {
                ["directScopes"] = Strings(definition.DirectScopes),
                ["directOnly"] = definition.DirectOnly,
                ["appPermission"] = definition.AppPermission,
                ["conditions"] = new JsonArray((definition.Conditions ?? []).Select(condition => (JsonNode)new JsonObject
                {
                    ["when"] = condition.When, ["directScopes"] = Strings(condition.DirectScopes),
                }).ToArray()),
            },
        };
        return copy;
    }

    private static JsonArray Strings(IEnumerable<string> values)
        => new(values.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray());
}

internal sealed record CoreMcpFeature(string Id, string Title);
internal sealed record CoreMcpScopeCondition(string When, string[] DirectScopes);
internal sealed record CoreMcpToolDefinition(string Name, CoreMcpFeature Feature, string[] DirectScopes,
    string? AppPermission = null, bool DirectOnly = false, CoreMcpScopeCondition[]? Conditions = null);
