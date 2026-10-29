using System.ComponentModel;
using Haas.Hosty.Launch;
using ModelContextProtocol.Server;

namespace Haas.Hosty.Core;

[McpServerToolType]
internal sealed class WorkspaceActivationMcpTools(IHttpContextAccessor accessor,
    ExternalWorkspaceMcpAuthorization authorization, WorkspaceInspectionService inspection, WorkspaceActivationActions actions)
{
    [McpServerTool(Name = "workspace_activation", ReadOnly = false, Destructive = true, Idempotent = true)]
    [Description("Plan, apply, inspect, cancel, resume or Return a registered workspace on this Core's ordinary data. Direct mcp:workspaces and mcp:lifecycle are required; selecting Core additionally requires mcp:core-restart. First call kind plan with selection; review its planDigest and consequences. Apply the identical selection with planDigest and a UUID requestId. Preserve original IDs after disconnection. Return supplies an explicit apps/core selection and compatibility acknowledgement; it never restores data or source. Delegated credentials cannot use this tool.")]
    // Keep services out of the reflected signature: strict AOT schema generation must not depend
    // on schema-time DI inference to distinguish trusted dependencies from caller arguments.
    public async Task<string> Run(string workspaceId, string kind, WorkspaceActivationCommand input, CancellationToken cancellationToken)
    {
        var http = accessor.HttpContext ?? throw WorkspaceActivationAccess.Denied();
        var result = await CoreWorkspaceEndpoints.HandleResult(async () =>
        {
            var actor = await authorization.RequireAsync(http, cancellationToken);
            var owner = await inspection.WorkflowOwnerAsync(workspaceId, actor.UserId, cancellationToken);
            return await actions.RunAsync(workspaceId, kind, input, new(actor.UserId, "direct-mcp", Principal: actor.PrincipalId), cancellationToken);
        });
        // Serialize the typed endpoint result without writing through the MCP HTTP response.
        if (result is Microsoft.AspNetCore.Http.IValueHttpResult value && value.Value is { } body) return System.Text.Json.JsonSerializer.Serialize(body, CoreJsonSerializerContext.Default.Options.GetTypeInfo(body.GetType()));
        return CoreJson.Text(new ErrorResponse("activation_response_invalid", "The activation response is unavailable."));
    }
}
