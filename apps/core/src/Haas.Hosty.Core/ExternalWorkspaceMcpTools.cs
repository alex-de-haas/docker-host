using System.ComponentModel;
using ModelContextProtocol.Server;

namespace Haas.Hosty.Core;

// No caller-selected user, credential, installation or owner ID enters this surface. Native edits
// happen in the returned worktree; managed Git operations keep their durable UUID/head guards.
[McpServerToolType]
internal sealed class ExternalWorkspaceMcpTools
{
    [McpServerTool(Name = "prepare_workspace", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Prepare a Core-owned worktree for an installed source app on this local host. Requires direct Core mcp:read and mcp:workspaces authority. Use one stable opaque taskId per work context and a UUID requestId; reuse the same request and arguments after an uncertain response. Supply a UUID activity lease before editing or starting native processes. Read repository instructions and approved plans in the returned absolute directory. Keep verified plan progress current without waiting for commits. No app runtime, publication or conversation is created.")]
    public static Task<string> PrepareAsync(string requestId, string taskId, string appId, string leaseId,
        ExternalWorkspaceMcpAuthorization authorization, DevelopmentWorkspaceService workspaces,
        IHttpContextAccessor accessor, AuditStore audit, IClock clock, CancellationToken cancellationToken,
        string? targetBranch = null, string? label = null)
        => ExecuteAsync(async caller =>
        {
            var owner = caller.Owner(taskId, label);
            var result = await workspaces.PrepareAsync(owner,
                new WorkspacePrepare(requestId, taskId, appId, null, targetBranch, leaseId, label), cancellationToken);
            await AuditAsync(audit, clock, caller, result, requestId, "prepare");
            return CoreJson.Text(result);
        }, authorization, accessor, cancellationToken);

    [McpServerTool(Name = "list_workspaces", ReadOnly = true)]
    [Description("List only external workspaces owned by this directly reviewed Core principal. Requires mcp:read and mcp:workspaces. Optional taskId filters logical work contexts; tasks within one grant are not authorization boundaries. Another grant never inherits these bindings. Released records are included by default for operation recovery.")]
    public static Task<string> ListAsync(ExternalWorkspaceMcpAuthorization authorization,
        DevelopmentWorkspaceService workspaces, IHttpContextAccessor accessor, CancellationToken cancellationToken,
        string? taskId = null, bool includeReleased = true)
        => ExecuteAsync(async caller =>
        {
            var owned = (await workspaces.ListAsync(null, includeReleased, cancellationToken)).Workspaces
                .Where(w => caller.Owns(w.Owner) && (taskId is null || w.Owner.SessionId == taskId)).ToArray();
            // Observation is service-owned and revalidates source grants before exposing byte-level
            // change metadata. A revoked private source must not leak through a catalog shortcut.
            var observed = new List<DevelopmentWorkspace>();
            foreach (var workspace in owned)
            {
                try { observed.Add(await workspaces.ObserveAsync(workspace.Id, workspace.Owner, cancellationToken)); }
                catch (Exception ex) when (ex is AppLifecycleException or IOException or UnauthorizedAccessException)
                {
                    // Revoked source access and unavailable records must not hide unrelated owned
                    // workspaces. Omit this record rather than exposing its cached private metadata.
                    // Credential authorization stays outside the loop; cancellation propagates.
                }
            }
            return CoreJson.Text(new WorkspaceList(observed.ToArray()));
        }, authorization, accessor, cancellationToken);

    [McpServerTool(Name = "get_workspace", ReadOnly = true)]
    [Description("Observe one workspace owned by the current external Core principal, including uncommitted changes, branch/base and durable operations. Requires mcp:read and mcp:workspaces. After an uncertain mutation, inspect its operation using the original UUID; do not retry with a new request ID.")]
    public static Task<string> GetAsync(string workspaceId, ExternalWorkspaceMcpAuthorization authorization,
        DevelopmentWorkspaceService workspaces, IHttpContextAccessor accessor, CancellationToken cancellationToken)
        => ExecuteAsync(async caller => CoreJson.Text(await workspaces.ObserveAsync(workspaceId,
            await OwnerAsync(workspaceId, caller, workspaces, cancellationToken), cancellationToken)),
            authorization, accessor, cancellationToken);

    [McpServerTool(Name = "get_workspace_diff", ReadOnly = true)]
    [Description("Read a bounded changed-file diff from an owned external workspace. Requires mcp:read and mcp:workspaces even though this tool reads only. path is repository-relative; view=session compares the original preparation base to current files, view=local shows local Git changes. Regular contained files only.")]
    public static Task<string> DiffAsync(string workspaceId, string path, ExternalWorkspaceMcpAuthorization authorization,
        DevelopmentWorkspaceService workspaces, IHttpContextAccessor accessor, CancellationToken cancellationToken,
        string view = "session")
        => ExecuteAsync(async caller => CoreJson.Text(await workspaces.DiffAsync(workspaceId,
            await OwnerAsync(workspaceId, caller, workspaces, cancellationToken), new(path, view), cancellationToken)),
            authorization, accessor, cancellationToken);

    [McpServerTool(Name = "refresh_workspace", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Fetch the installed source's tracked target into an owned workspace's managed repository; never change worktree files or integrate implicitly. Requires mcp:workspaces. UUID requestId must be reused after uncertain responses.")]
    public static Task<string> RefreshAsync(string workspaceId, string requestId, ExternalWorkspaceMcpAuthorization authorization,
        DevelopmentWorkspaceService workspaces, IHttpContextAccessor accessor, AuditStore audit, IClock clock, CancellationToken cancellationToken)
        => CommandAsync(workspaceId, "refresh", new(requestId), authorization, workspaces, accessor, audit, clock, cancellationToken);

    [McpServerTool(Name = "commit_workspace", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Commit explicitly selected repository-relative paths at the reviewed expectedHead with explicit message and author. Requires mcp:workspaces plus user/repository permission to commit. Preserve unrelated changes; follow repository commit and attribution rules. Use a UUID requestId and repeat its exact arguments after uncertainty. This never pushes or publishes.")]
    public static Task<string> CommitAsync(string workspaceId, string requestId, string expectedHead, string message,
        string[] paths, string authorName, string authorEmail, ExternalWorkspaceMcpAuthorization authorization,
        DevelopmentWorkspaceService workspaces, IHttpContextAccessor accessor, AuditStore audit, IClock clock, CancellationToken cancellationToken)
        => CommandAsync(workspaceId, "commit", new(requestId, expectedHead, message, paths, authorName, authorEmail),
            authorization, workspaces, accessor, audit, clock, cancellationToken);

    [McpServerTool(Name = "merge_workspace_target", ReadOnly = false, Destructive = true, Idempotent = true)]
    [Description("Explicitly merge fresh target-branch changes into a clean owned workspace at expectedHead using a regular merge commit, message and author. Requires mcp:workspaces and user/repository authorization. Conflicts remain for explicit resolution. Use the original UUID requestId to recover; no push, app restart or publication occurs.")]
    public static Task<string> MergeAsync(string workspaceId, string requestId, string expectedHead, string message,
        string authorName, string authorEmail, ExternalWorkspaceMcpAuthorization authorization,
        DevelopmentWorkspaceService workspaces, IHttpContextAccessor accessor, AuditStore audit, IClock clock, CancellationToken cancellationToken)
        => CommandAsync(workspaceId, "merge", new(requestId, expectedHead, message, AuthorName: authorName, AuthorEmail: authorEmail),
            authorization, workspaces, accessor, audit, clock, cancellationToken);

    [McpServerTool(Name = "abort_workspace_merge", ReadOnly = false, Destructive = true, Idempotent = true)]
    [Description("Abort a pending managed merge in an owned workspace at expectedHead. Requires mcp:workspaces and explicit authorization to discard merge resolution. Preserve the original UUID requestId for replay/recovery.")]
    public static Task<string> AbortMergeAsync(string workspaceId, string requestId, string expectedHead,
        ExternalWorkspaceMcpAuthorization authorization, DevelopmentWorkspaceService workspaces,
        IHttpContextAccessor accessor, AuditStore audit, IClock clock, CancellationToken cancellationToken)
        => CommandAsync(workspaceId, "abort-merge", new(requestId, expectedHead),
            authorization, workspaces, accessor, audit, clock, cancellationToken);

    [McpServerTool(Name = "acquire_workspace_lease", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Add a UUID activity lease to an owned workspace before native editing or processes. Requires mcp:workspaces and a UUID requestId. Leases do not expire on disconnect, token expiry or revocation; only release after all native consumers stop.")]
    public static Task<string> AcquireLeaseAsync(string workspaceId, string requestId, string leaseId,
        ExternalWorkspaceMcpAuthorization authorization, DevelopmentWorkspaceService workspaces,
        IHttpContextAccessor accessor, AuditStore audit, IClock clock, CancellationToken cancellationToken)
        => CommandAsync(workspaceId, "lease", new(requestId, LeaseId: leaseId),
            authorization, workspaces, accessor, audit, clock, cancellationToken);

    [McpServerTool(Name = "release_workspace_lease", ReadOnly = false, Destructive = true, Idempotent = true)]
    [Description("Release an activity lease only after native editing/processes using the owned directory have stopped. Requires mcp:workspaces and UUID requestId/leaseId. Disconnect, revoked MCP access and client closure do not establish that processes stopped. Release never deletes the worktree.")]
    public static Task<string> ReleaseLeaseAsync(string workspaceId, string requestId, string leaseId,
        ExternalWorkspaceMcpAuthorization authorization, DevelopmentWorkspaceService workspaces,
        IHttpContextAccessor accessor, AuditStore audit, IClock clock, CancellationToken cancellationToken)
        => CommandAsync(workspaceId, "release-lease", new(requestId, LeaseId: leaseId),
            authorization, workspaces, accessor, audit, clock, cancellationToken);

    [McpServerTool(Name = "record_workspace_pull_requests", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Record existing HTTPS pull-request URLs as references on an owned workspace. Requires mcp:workspaces and UUID requestId. This records metadata only; it never creates a PR, pushes commits or grants publication authority.")]
    public static Task<string> RecordPullRequestsAsync(string workspaceId, string requestId, string[] pullRequests,
        ExternalWorkspaceMcpAuthorization authorization, DevelopmentWorkspaceService workspaces,
        IHttpContextAccessor accessor, AuditStore audit, IClock clock, CancellationToken cancellationToken)
        => CommandAsync(workspaceId, "references", new(requestId, PullRequests: pullRequests),
            authorization, workspaces, accessor, audit, clock, cancellationToken);

    [McpServerTool(Name = "cleanup_workspace", ReadOnly = false, Destructive = true, Idempotent = true)]
    [Description("Release and remove an owned worktree at expectedHead only after explicit user/repository cleanup authorization. Requires mcp:workspaces and UUID requestId. Refuses dirty/conflicted/unmerged work, activity leases and runtime/source consumers. Never infer cleanup from client disconnect. The original request ID recovers uncertain cleanup.")]
    public static Task<string> CleanupAsync(string workspaceId, string requestId, string expectedHead,
        ExternalWorkspaceMcpAuthorization authorization, DevelopmentWorkspaceService workspaces,
        IHttpContextAccessor accessor, AuditStore audit, IClock clock, CancellationToken cancellationToken)
        => CommandAsync(workspaceId, "cleanup", new(requestId, expectedHead),
            authorization, workspaces, accessor, audit, clock, cancellationToken);

    private static Task<string> CommandAsync(string id, string kind, WorkspaceCommand command,
        ExternalWorkspaceMcpAuthorization authorization, DevelopmentWorkspaceService workspaces,
        IHttpContextAccessor accessor, AuditStore audit, IClock clock, CancellationToken ct)
        => ExecuteAsync(async caller =>
        {
            var result = await workspaces.CommandAsync(id, await OwnerAsync(id, caller, workspaces, ct), kind, command, ct);
            await AuditAsync(audit, clock, caller, result, command.RequestId, kind);
            return CoreJson.Text(result);
        }, authorization, accessor, ct);

    private static async Task<WorkspaceOwner> OwnerAsync(string id, ExternalWorkspaceMcpCaller caller,
        DevelopmentWorkspaceService workspaces, CancellationToken ct)
    {
        var workspace = (await workspaces.ListAsync(null, true, ct)).Workspaces.FirstOrDefault(w => w.Id == id && caller.Owns(w.Owner));
        return workspace?.Owner ?? throw new AppLifecycleException("workspace_not_found", "No owned workspace has that ID.");
    }

    private static async Task<string> ExecuteAsync(Func<ExternalWorkspaceMcpCaller, Task<string>> action,
        ExternalWorkspaceMcpAuthorization authorization, IHttpContextAccessor accessor, CancellationToken ct)
    {
        try { return await action(await authorization.RequireAsync(accessor.HttpContext, ct)); }
        catch (Exception ex) when (ex is AppIdentityException or AppLifecycleException or IOException or UnauthorizedAccessException)
        { return CoreJson.Text(new McpError(ex.Message)); }
    }

    private static async Task AuditAsync(AuditStore audit, IClock clock, ExternalWorkspaceMcpCaller caller,
        DevelopmentWorkspace workspace, string requestId, string kind)
    {
        try
        {
            await audit.AppendAsync(new("audit_" + Guid.NewGuid().ToString("N"), "development.workspace." + kind,
                "workspace", workspace.Id, workspace.Operations.FirstOrDefault(o => o.Id == requestId)?.State ?? workspace.State,
                caller.UserId, clock.UtcNow, new Dictionary<string, string> { ["via"] = "mcp", ["requestId"] = requestId,
                    ["principal"] = caller.PrincipalId }), CancellationToken.None);
        }
        catch (Exception ex) { Console.Error.WriteLine("[audit] Cannot record external workspace operation: " + ex.Message); }
    }
}
