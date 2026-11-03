using HostySdk.App;
using System.ComponentModel;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Haas.Hosty.Core;

[McpServerToolType]
internal sealed class CoreDecisionMcpTools(IHttpContextAccessor context, CoreCapabilityAuthorization auth, CoreDecisionService service)
{
    private Task<CoreCapabilityCaller> Caller(string permission, CancellationToken ct) => CoreDecisionEndpoints.Operator(
        (context.HttpContext ?? throw new AppIdentityException("permission_denied", "A current caller is required.")).Request, auth, permission, ct);

    [McpServerTool(Name = "decision_create", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Create an addressed question for the acting user. Requires mcp:decisions or decisions.request. Reuse the request UUID and exact input after uncertainty. Answers never grant tool or installation permission.")]
    public Task<CallToolResult> Create(HostyDecisionCreate input, CancellationToken cancellationToken) => CoreProviderResults.Run(async () =>
        await service.CreateAsync(await Caller(CoreAppPermissions.DecisionsRequest, cancellationToken), input, cancellationToken));
    [McpServerTool(Name = "decision_list", ReadOnly = true, Destructive = false)]
    [Description("List only the current user's accessible decisions and pending count. The cursor is bound to the user and filters; page size is 1–100. Administrator status grants no other user's decisions.")]
    public Task<CallToolResult> List(HostyDecisionQuery input, CancellationToken cancellationToken) => CoreProviderResults.Run(async () =>
        await service.QueryAsync(await Caller(CoreAppPermissions.DecisionsRead, cancellationToken), input, ct: cancellationToken));
    [McpServerTool(Name = "decision_get", ReadOnly = true, Destructive = false)]
    [Description("Read one authorized decision, immutable answer, and separate continuation receipt.")]
    public Task<CallToolResult> Get(string id, CancellationToken cancellationToken) => CoreProviderResults.Run(async () =>
        await service.GetAsync(await Caller(CoreAppPermissions.DecisionsRead, cancellationToken), id, cancellationToken));
    [McpServerTool(Name = "decision_resolve", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Submit an explicit answer as the addressed user using stable question and option IDs, the displayed revision, and a request UUID. One response wins; saving an answer does not prove execution resumed.")]
    public Task<CallToolResult> Resolve(string id, HostyDecisionResolve input, CancellationToken cancellationToken) => CoreProviderResults.Run(async () =>
        await service.ResolveAsync(await Caller(CoreAppPermissions.DecisionsRespond, cancellationToken), id, input, cancellationToken));
    [McpServerTool(Name = "decision_withdraw", ReadOnly = false, Destructive = true, Idempotent = true)]
    [Description("Withdraw an originating source's decision and fence continuation. Keeps any already accepted answer. Cannot withdraw another application's decision.")]
    public Task<CallToolResult> Withdraw(string id, HostyDecisionWithdraw input, CancellationToken cancellationToken) => CoreProviderResults.Run(async () =>
        await service.WithdrawAsync(await Caller(CoreAppPermissions.DecisionsRequest, cancellationToken), id, input, ct: cancellationToken));
    [McpServerTool(Name = "decision_invalidate", ReadOnly = false, Destructive = true, Idempotent = true)]
    [Description("Mark the originating source's reviewed decision stale after its inputs change. Does not edit the frozen question or transfer authority to new inputs.")]
    public Task<CallToolResult> Invalidate(string id, HostyDecisionWithdraw input, CancellationToken cancellationToken) => CoreProviderResults.Run(async () =>
        await service.WithdrawAsync(await Caller(CoreAppPermissions.DecisionsRequest, cancellationToken), id, input, stale: true, ct: cancellationToken));
    [McpServerTool(Name = "decision_responses", ReadOnly = true, Destructive = false)]
    [Description("Reconcile outstanding responses addressed only to this originating installation/user. Persist the response and continuation command before acknowledging; notifications are not delivery.")]
    public Task<CallToolResult> Responses(HostyDecisionQuery input, CancellationToken cancellationToken) => CoreProviderResults.Run(async () =>
        await service.QueryAsync(await Caller(CoreAppPermissions.DecisionsRequest, cancellationToken), input, responses: true, ct: cancellationToken));
    [McpServerTool(Name = "decision_acknowledge", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Acknowledge durable source receipt of this resolution revision. This means saved, not native acceptance or successful completion.")]
    public Task<CallToolResult> Acknowledge(string id, HostyDecisionAck input, CancellationToken cancellationToken) => CoreProviderResults.Run(async () =>
        await service.AckAsync(await Caller(CoreAppPermissions.DecisionsRequest, cancellationToken), id, input, cancellationToken));
    [McpServerTool(Name = "decision_continuation", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Record the originating source's monotonic continuation outcome using its stable command UUID and receipt revision. Unknown native acceptance must stay blocked; this tool itself starts no execution.")]
    public Task<CallToolResult> Continue(string id, HostyDecisionContinue input, CancellationToken cancellationToken) => CoreProviderResults.Run(async () =>
        await service.ContinueAsync(await Caller(CoreAppPermissions.DecisionsRequest, cancellationToken), id, input, cancellationToken));
}
