using System.ComponentModel;
using ModelContextProtocol.Protocol;
using ModelContextProtocol.Server;

namespace Haas.Hosty.Core;

internal static class CorePublicationResults
{
    internal static async Task<CallToolResult> Run<T>(Func<Task<T>> action)
    {
        try { return await CoreCapabilityResults.Run(action); }
        catch (Exception ex) when (ex is PublicationException or UserConnectionException or HttpRequestException)
        {
            var failure = ex switch { PublicationException e => new ErrorResponse(e.Code, e.Message),
                UserConnectionException e => new ErrorResponse(e.Code, e.Message),
                _ => new ErrorResponse("publication_unavailable", "Provider request failed. Recover using the original requestId.") };
            var result = CoreCapabilityResults.Success(failure); result.IsError = true; return result;
        }
    }
}

[McpServerToolType]
internal sealed class CorePublicationMcpTools(IHttpContextAccessor accessor, CorePublicationAdapter service)
{
    private HttpRequest Request => accessor.HttpContext?.Request ?? throw new AppIdentityException("scope_required", "A current Core caller is required.");
    [McpServerTool(Name = "pr_connections", ReadOnly = true, Destructive = false)]
    [Description("List the acting user's available publication connections. Requires workspace and publication-read authority. A listed connection is not a grant to push or create a repository.")]
    public Task<CallToolResult> Connections(CancellationToken cancellationToken) => CorePublicationResults.Run(() => service.Connections(Request, cancellationToken));
    [McpServerTool(Name = "pr_list", ReadOnly = true, Destructive = false)]
    [Description("List this user's workspace publications across creating clients, optionally limited to a workspace. Another user's private connection and receipts remain inaccessible.")]
    public Task<CallToolResult> List(CorePublicationQuery input, CancellationToken cancellationToken) => CorePublicationResults.Run(() => service.List(Request, input, cancellationToken));
    [McpServerTool(Name = "pr_status", ReadOnly = true, Destructive = false)]
    [Description("Refresh a registered worktree's publication status, checks and reviews using its selected user connection. Missing provider evidence is unavailable, never successful completion.")]
    public Task<CallToolResult> Status(CorePublicationGet input, CancellationToken cancellationToken) => CorePublicationResults.Run(() => service.Get(Request, input.WorktreeId, cancellationToken));
    [McpServerTool(Name = "pr_resolve_review", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Resolve one PR review thread at the reviewed expectedHead. Requires publication-write and current repository access. Preserve the original requestId and exact input after uncertainty.")]
    public Task<CallToolResult> Command0(CorePublicationMutation input, CancellationToken cancellationToken) => CorePublicationResults.Run(() => service.Command(Request, "resolve-review", input, cancellationToken));
    [McpServerTool(Name = "pr_commit", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Commit reviewed worktree paths with explicit contributors and expectedHead. Requires workspace authority and repository commit authorization; never pushes. Preserve the original requestId and exact input after uncertainty.")]
    public Task<CallToolResult> Command1(CorePublicationMutation input, CancellationToken cancellationToken) => CorePublicationResults.Run(() => service.Command(Request, "commit", input, cancellationToken));
    [McpServerTool(Name = "pr_configure", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Configure an explicit publication connection and completion policy. May create or select a fork, so publication-write authority is required. Preserve the original requestId and exact input after uncertainty.")]
    public Task<CallToolResult> Command2(CorePublicationMutation input, CancellationToken cancellationToken) => CorePublicationResults.Run(() => service.Command(Request, "configure", input, cancellationToken));
    [McpServerTool(Name = "pr_push", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Push the reviewed worktree HEAD to the selected publication branch. Requires publication-write and current provider permission. Preserve the original requestId and exact input after uncertainty.")]
    public Task<CallToolResult> Command3(CorePublicationMutation input, CancellationToken cancellationToken) => CorePublicationResults.Run(() => service.Command(Request, "push", input, cancellationToken));
    [McpServerTool(Name = "pr_publish", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Create or recover the pull request for the reviewed worktree HEAD. Requires publication-write; respects dependencies and exact-head checks. Preserve the original requestId and exact input after uncertainty.")]
    public Task<CallToolResult> Command4(CorePublicationMutation input, CancellationToken cancellationToken) => CorePublicationResults.Run(() => service.Command(Request, "publish", input, cancellationToken));
    [McpServerTool(Name = "pr_link", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Verify and link an existing PR to the registered worktree. Requires publication-write and exact repository, branch and head evidence. Preserve the original requestId and exact input after uncertainty.")]
    public Task<CallToolResult> Command5(CorePublicationMutation input, CancellationToken cancellationToken) => CorePublicationResults.Run(() => service.Command(Request, "link", input, cancellationToken));
    [McpServerTool(Name = "pr_ready", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Mark the selected pull request ready at the expectedHead. Requires publication-write and current provider permission. Preserve the original requestId and exact input after uncertainty.")]
    public Task<CallToolResult> Command6(CorePublicationMutation input, CancellationToken cancellationToken) => CorePublicationResults.Run(() => service.Command(Request, "ready", input, cancellationToken));
    [McpServerTool(Name = "pr_merge", ReadOnly = false, Destructive = true, Idempotent = true)]
    [Description("Merge the exact reviewed PR head using the explicit merge method. Requires publication-write; CI, reviews and repository protections remain mandatory. Preserve the original requestId and exact input after uncertainty.")]
    public Task<CallToolResult> Command7(CorePublicationMutation input, CancellationToken cancellationToken) => CorePublicationResults.Run(() => service.Command(Request, "merge", input, cancellationToken));
    [McpServerTool(Name = "pr_complete", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Record an explicit publication outcome after verifying current evidence. Cleanup is opt-in and retains its dirty, unmerged and consumer guards. Preserve the original requestId and exact input after uncertainty.")]
    public Task<CallToolResult> Command8(CorePublicationMutation input, CancellationToken cancellationToken) => CorePublicationResults.Run(() => service.Command(Request, "complete", input, cancellationToken));
    [McpServerTool(Name = "pr_corrective", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Prepare a corrective publication after explicitly resuming retained workspace source. Requires publication-write and preserved prior publication history. Preserve the original requestId and exact input after uncertainty.")]
    public Task<CallToolResult> Command9(CorePublicationMutation input, CancellationToken cancellationToken) => CorePublicationResults.Run(() => service.Command(Request, "corrective", input, cancellationToken));
    [McpServerTool(Name = "remote_status", ReadOnly = true, Destructive = false)]
    [Description("Read the reviewed remote of a local-source application in a registered worktree. Requires workspace and publication-read authority.")]
    public Task<CallToolResult> RemoteStatus(CoreRemoteQuery input, CancellationToken cancellationToken) => CorePublicationResults.Run(() => service.RemoteStatus(Request, input, cancellationToken));
    [McpServerTool(Name = "remote_connect", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Perform the explicit connect operation for the selected local-source app and worktree. Retain requestId, expectedHead and the reviewed connection. Push additionally requires publication-write; connecting or fetching never grants push authority.")]
    public Task<CallToolResult> Remote0(CoreRemoteMutation input, CancellationToken cancellationToken) => CorePublicationResults.Run(() => service.RemoteCommand(Request, "connect", input, cancellationToken));
    [McpServerTool(Name = "remote_fetch", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Perform the explicit fetch operation for the selected local-source app and worktree. Retain requestId, expectedHead and the reviewed connection. Push additionally requires publication-write; connecting or fetching never grants push authority.")]
    public Task<CallToolResult> Remote1(CoreRemoteMutation input, CancellationToken cancellationToken) => CorePublicationResults.Run(() => service.RemoteCommand(Request, "fetch", input, cancellationToken));
    [McpServerTool(Name = "remote_push_base", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Perform the explicit push-base operation for the selected local-source app and worktree. Retain requestId, expectedHead and the reviewed connection. Push additionally requires publication-write; connecting or fetching never grants push authority.")]
    public Task<CallToolResult> Remote2(CoreRemoteMutation input, CancellationToken cancellationToken) => CorePublicationResults.Run(() => service.RemoteCommand(Request, "push-base", input, cancellationToken));
}
