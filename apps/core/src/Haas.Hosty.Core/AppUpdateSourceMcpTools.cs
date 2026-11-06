using System.ComponentModel;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Haas.Hosty.Core;

[McpServerToolType]
internal sealed class AppUpdateSourceMcpTools(CoreLifecycleService lifecycle, CoreCapabilityAuthorization authorization, IHttpContextAccessor accessor)
{
    private async Task Authorize(CancellationToken ct, bool apply = false)
    {
        var request = accessor.HttpContext?.Request ?? throw new AppIdentityException("permission_denied", "A current Core caller is required.");
        var caller = await authorization.RequireAsync(request, [AccessTokenScopes.McpRead, AccessTokenScopes.McpWorkspaces, AccessTokenScopes.McpUpdate], [CoreAppPermissions.Sources], ct);
        if (apply && caller.App is not null) throw new AppIdentityException("approval_required", "An operator must approve this exact publisher/source switch. Ordinary app update authority does not authorize it.");
    }
    [McpServerTool(Name = "list_app_source_migrations", ReadOnly = true)]
    [Description("List exact distribution source-migration suggestions. These are proposals, not approval. Requires mcp:read, mcp:workspaces and mcp:update.")]
    public Task<CallToolResult> List(CancellationToken cancellationToken) => CoreCapabilityResults.Run(async () =>
    { await Authorize(cancellationToken); return await lifecycle.GetUpdateSourceSuggestionsAsync(cancellationToken); });

    [McpServerTool(Name = "plan_app_update_source", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Review a future update-source switch to an explicit feed URL and ID. Validates the ready release and returns old/new bindings, revision and planDigest. No runtime, binaries or data change. Requires source-management and update authority.")]
    public Task<CallToolResult> Plan(string appId, AppUpdateSourcePlanRequest input, CancellationToken cancellationToken) => CoreCapabilityResults.Run(async () =>
    { await Authorize(cancellationToken); return await lifecycle.PlanUpdateSourceAsync(appId, input, cancellationToken); });

    [McpServerTool(Name = "apply_app_update_source", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Apply an explicitly approved source-switch plan with its original UUID requestId. Changes future update binding only. Requires direct reviewed Core source-management/update authority or an administrator session; an ordinary app grant cannot approve a publisher switch.")]
    public Task<CallToolResult> Apply(string appId, AppUpdateSourceApplyRequest input, CancellationToken cancellationToken) => CoreCapabilityResults.Run(async () =>
    { await Authorize(cancellationToken, apply: true); return await lifecycle.ApplyUpdateSourceAsync(appId, input, cancellationToken); });

    [McpServerTool(Name = "get_app_update_source_operation", ReadOnly = true)]
    [Description("Recover the retained result of a source switch using the same app ID and UUID requestId.")]
    public Task<CallToolResult> Get(string appId, string requestId, CancellationToken cancellationToken) => CoreCapabilityResults.Run(async () =>
    { await Authorize(cancellationToken); return lifecycle.GetUpdateSourceOperation(appId, requestId); });

    [McpServerTool(Name = "apply_app_update_sources", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Apply one approved batch of exact app/source plan digests with a stable UUID. Results are independent per app; completed switches are replay-safe. No app update or restart occurs.")]
    public Task<CallToolResult> Batch(AppUpdateSourceBatchRequest input, CancellationToken cancellationToken) => CoreCapabilityResults.Run(async () =>
    { await Authorize(cancellationToken, apply: true); return await lifecycle.ApplyUpdateSourceBatchAsync(input, cancellationToken); });
}
