using System.ComponentModel;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Haas.Hosty.Core;

internal sealed record CoreWorkflowQuery(string WorkspaceId);
internal sealed record CoreWorkflowChange(string WorkspaceId, WorkspaceWorkflowCommand Input, bool Confirm = false);
internal sealed class CoreWorkflowAdapter(CoreCapabilityAuthorization authorization, DevelopmentWorkspaceService workspaces,
    WorkspaceInspectionService inspection, PublicationService publications)
{
    private async Task<(CoreCapabilityCaller Caller, WorkspaceOwner Allocation)> Context(HttpRequest request, string id, CancellationToken ct, bool complete = false)
    {
        var caller = await authorization.RequireAsync(request, complete
            ? [AccessTokenScopes.McpRead, AccessTokenScopes.McpWorkspaces, AccessTokenScopes.McpPublicationRead]
            : [AccessTokenScopes.McpRead, AccessTokenScopes.McpWorkspaces], [CoreAppPermissions.Sources], ct);
        return (caller, await inspection.WorkflowOwnerAsync(id, caller.User.Id, ct));
    }
    internal async Task<WorkspaceWorkflow> Get(HttpRequest request, CoreWorkflowQuery input, CancellationToken ct) =>
        await workspaces.WorkflowAsync((await Context(request, input.WorkspaceId, ct)).Allocation, ct);
    internal async Task<WorkspaceWorkflow> Change(HttpRequest request, string kind, CoreWorkflowChange input, CancellationToken ct)
    {
        var (caller, owner) = await Context(request, input.WorkspaceId, ct, kind == "complete");
        if (kind is not ("complete" or "resume" or "pause") || input.Confirm && kind != "pause")
            throw DevelopmentWorkspaceService.Error("workflow_invalid", "Choose complete, resume or pause; confirmation applies only to pause.");
        var heads = kind == "complete" ? await publications.MergedWorkspaceHeadsAsync(owner, ct, caller.User.Id) : new Dictionary<string, string>();
        await Context(request, input.WorkspaceId, ct, kind == "complete");
        return await workspaces.ChangeWorkflowAsync(owner, caller.User.Id, kind, input.Input, heads, ct, prepareOnly: kind == "pause" && !input.Confirm);
    }
}
internal static class CoreWorkflowApi
{
    internal static void Map(WebApplication app)
    {
        app.MapPost("/api/workflows/v1/get", async (CoreWorkflowQuery input, HttpRequest request, CoreWorkflowAdapter service, CancellationToken ct) =>
            await PublicationEndpoints.Handle(() => service.Get(request, input, ct)));
        app.MapPost("/api/workflows/v1/commands/{kind}", async (string kind, CoreWorkflowChange input, HttpRequest request, CoreWorkflowAdapter service, CancellationToken ct) =>
            await PublicationEndpoints.Handle(() => service.Change(request, kind, input, ct)));
    }
}
[McpServerToolType]
internal sealed class CoreWorkflowMcpTools(IHttpContextAccessor accessor, CoreWorkflowAdapter service)
{
    private HttpRequest Request => accessor.HttpContext?.Request ?? throw new AppIdentityException("scope_required", "A current Core caller is required.");
    [McpServerTool(Name = "workflow_status", ReadOnly = true, Destructive = false)]
    [Description("Read work lifecycle state and retained operation receipts for a registered workspace. Requires workspace authority; chats and environments have independent lifetimes.")]
    public Task<CallToolResult> Get(CoreWorkflowQuery input, CancellationToken cancellationToken) => CorePublicationResults.Run(() => service.Get(Request, input, cancellationToken));
    [McpServerTool(Name = "workflow_complete", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Complete a workspace workflow at its expectedRevision using verified publication evidence. Requires workspace and publication-read authority. Retain requestId; this does not delete chats or Finish independent test environments.")]
    public Task<CallToolResult> Complete(CoreWorkflowChange input, CancellationToken cancellationToken) => CorePublicationResults.Run(() => service.Change(Request, "complete", input, cancellationToken));
    [McpServerTool(Name = "workflow_resume", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Explicitly resume retained workspace source at its expectedRevision. Preserve the original requestId after uncertainty; this never starts an agent or runtime.")]
    public Task<CallToolResult> Resume(CoreWorkflowChange input, CancellationToken cancellationToken) => CorePublicationResults.Run(() => service.Change(Request, "resume", input, cancellationToken));
    [McpServerTool(Name = "workflow_pause", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Prepare a workspace pause and coordinate active consumers. Inspect the retained closure, then repeat the same input with confirm=true after native stops are confirmed. Unknown consumers and source leases remain protective; pause never discards source. Requires workspace authority.")]
    public Task<CallToolResult> Pause(CoreWorkflowChange input, CancellationToken cancellationToken) => CorePublicationResults.Run(() => service.Change(Request, "pause", input, cancellationToken));
}
