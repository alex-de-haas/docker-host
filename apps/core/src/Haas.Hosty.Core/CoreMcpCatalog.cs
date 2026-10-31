using System.Collections.Frozen;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using ModelContextProtocol.Protocol;

namespace Haas.Hosty.Core;

// This catalog belongs to Core, not to installed applications. Feature keys describe capabilities;
// they neither discover an app by identity nor authorize a caller. Domain services retain their
// current resource, actor, source, revision and replay checks.
internal static class CoreMcpCatalog
{
    internal const string MetadataKey = "io.hosty/core-tool";
    internal const int SchemaVersion = 1;

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
        new("get_host_status", Host, Read, CoreAppPermissions.ReadCore),
        new("get_core_development", Host, Read, CoreAppPermissions.ReadCore),
        new("get_core_operation", Host, Read, CoreAppPermissions.ReadCore),
        new("restart_core", Host, Restart, CoreAppPermissions.CoreLifecycle),
        new("list_apps", Apps, Read, CoreAppPermissions.ReadApps),
        new("get_app", Apps, Read, CoreAppPermissions.ReadApps),
        new("start_app", Apps, Lifecycle, CoreAppPermissions.AppLifecycle),
        new("stop_app", Apps, Lifecycle, CoreAppPermissions.AppLifecycle),
        new("restart_app", Apps, Lifecycle, CoreAppPermissions.AppLifecycle),
        new("plan_app_update", Apps, Update, CoreAppPermissions.Install),
        new("apply_app_update", Apps, Update, CoreAppPermissions.Install),
        new("tail_app_logs", Logs, Read, CoreAppPermissions.AppLogs),
        new("search_audit", Logs, Read, CoreAppPermissions.CoreLogs),
        new("get_app_development_guide", Creation, Read, CoreAppPermissions.ReadApps),
        new("prepare_workspace", Workspaces, Workspace, DirectOnly: true),
        new("list_workspaces", Workspaces, Workspace, DirectOnly: true),
        new("get_workspace", Workspaces, Workspace, DirectOnly: true),
        new("rename_workspace", Workspaces, Workspace, DirectOnly: true),
        new("delete_workspace", Workspaces, Workspace, DirectOnly: true),
        new("acquire_workspace_lease", Workspaces, Workspace, DirectOnly: true),
        new("release_workspace_lease", Workspaces, Workspace, DirectOnly: true),
        new("get_workspace_diff", Git, Workspace, DirectOnly: true),
        new("refresh_workspace", Git, Workspace, DirectOnly: true),
        new("commit_workspace", Git, Workspace, DirectOnly: true),
        new("merge_workspace_target", Git, Workspace, DirectOnly: true),
        new("abort_workspace_merge", Git, Workspace, DirectOnly: true),
        new("record_workspace_pull_requests", Git, Workspace, DirectOnly: true),
        new("get_app_dev_mode", Development, Lifecycle),
        new("plan_app_dev_mode", Development, Lifecycle, Conditions: [WorktreeCondition]),
        new("apply_app_dev_mode", Development, Lifecycle, Conditions: [WorktreeCondition]),
        new("get_app_execution_targets", Development, Workspace, DirectOnly: true),
        new("get_app_execution_selection", Development, Workspace, DirectOnly: true),
        new("get_workspace_execution_selection", Development, Workspace, DirectOnly: true),
        new("select_app_execution_target", Development, WorkspaceLifecycle, DirectOnly: true),
        new("select_workspace_execution", Development, WorkspaceLifecycle, DirectOnly: true),
        new("configure_workspace_runtime", Development, Workspace, DirectOnly: true),
        new("workspace_activation", Development, WorkspaceLifecycle, DirectOnly: true, Conditions: [CoreCondition]),
    }.ToFrozenDictionary(tool => tool.Name, StringComparer.Ordinal);

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
            return await next(request, cancellationToken);
        });
    }

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
