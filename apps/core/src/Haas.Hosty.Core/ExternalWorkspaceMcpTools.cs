using System.ComponentModel;
using ModelContextProtocol.Server;

namespace Haas.Hosty.Core;

// No caller-selected user, credential, installation or owner ID enters this surface. Native edits
// happen in the returned worktree; managed Git operations keep their durable UUID/head guards.
[McpServerToolType]
internal sealed class ExternalWorkspaceMcpTools
{
    [McpServerTool(Name = "prepare_workspace", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Prepare a Core-owned worktree for an installed source app on this local host. Requires direct mcp:read and mcp:workspaces, or reviewed application source authority. Use one stable opaque taskId per work context and a UUID requestId; reuse the same request and arguments after an uncertain response. Supply name as a short, purpose-based description of the work (for example Simplify runtime switching), not an agent name or generated branch/ID. Use rename_workspace when the task scope changes materially. Supply a UUID activity lease before editing or starting native processes. Read repository instructions and approved plans in the returned absolute directory. Keep verified plan progress current without waiting for commits. No app runtime, publication or conversation is created.")]
    public static Task<string> PrepareAsync(string requestId, string taskId, string appId, string leaseId, string name,
        ExternalWorkspaceMcpAuthorization authorization, DevelopmentWorkspaceService workspaces,
        IHttpContextAccessor accessor, AuditStore audit, IClock clock, CancellationToken cancellationToken,
        string? targetBranch = null, string? label = null, string? navigationPath = null)
        => ExecuteAsync(async caller =>
        {
            DevelopmentWorkspaceService.ValidateWorkspaceName(name!);
            var owner = caller.Owner(taskId, label);
            var result = await workspaces.PrepareAsync(owner,
                new WorkspacePrepare(requestId, taskId, appId, navigationPath, targetBranch, leaseId, label, Name: name), cancellationToken);
            await AuditAsync(audit, clock, caller, result, requestId, "prepare");
            return CoreJson.Text(await workspaces.SessionProjectionAsync(result, owner, cancellationToken));
        }, authorization, accessor, cancellationToken);

    [McpServerTool(Name = "list_workspaces", ReadOnly = true)]
    [Description("List all registered Core workspaces accessible with the current application and initiating-user workspace authority. Requires mcp:read and mcp:workspaces. Optional taskId filters allocation context; creators, sessions and credentials do not restrict collection access. Released records are included by default for operation recovery.")]
    public static Task<string> ListAsync(ExternalWorkspaceMcpAuthorization authorization,
        DevelopmentWorkspaceService workspaces, IHttpContextAccessor accessor, CancellationToken cancellationToken,
        string? taskId = null, bool includeReleased = true)
        => ExecuteAsync(async caller =>
        {
            var owned = (await workspaces.ListAsync(null, includeReleased, cancellationToken)).Workspaces
                .Where(w => taskId is null || w.Owner.SessionId == taskId).ToArray();
            // Observation is service-owned and revalidates source grants before exposing byte-level
            // change metadata. A revoked private source must not leak through a catalog shortcut.
            var observed = new List<DevelopmentWorkspace>();
            foreach (var workspace in owned)
            {
                try { observed.Add(await workspaces.SessionProjectionAsync(await workspaces.ObserveAsync(workspace.Id, caller.Owner(workspace.Owner.SessionId), cancellationToken), caller.Owner(workspace.Owner.SessionId), cancellationToken)); }
                catch (Exception ex) when (ex is AppLifecycleException or IOException or UnauthorizedAccessException)
                {
                    // Revoked source access and unavailable records must not hide unrelated owned
                    // workspaces. Omit this record rather than exposing its cached private metadata.
                    // Credential authorization stays outside the loop; cancellation propagates.
                }
            }
            return CoreJson.Text(new WorkspaceList(observed.ToArray(), new(true, true, caller.UserId, caller.PrincipalId)));
        }, authorization, accessor, cancellationToken);

    [McpServerTool(Name = "get_workspace", ReadOnly = true)]
    [Description("Observe one registered workspace with current workspace authority, including uncommitted changes, branch/base and durable operations. Requires mcp:read and mcp:workspaces. After an uncertain mutation, inspect its operation using the original UUID; do not retry with a new request ID.")]
    public static Task<string> GetAsync(string workspaceId, ExternalWorkspaceMcpAuthorization authorization,
        DevelopmentWorkspaceService workspaces, IHttpContextAccessor accessor, CancellationToken cancellationToken)
        => ExecuteAsync(async caller =>
        {
            var actor = await OwnerAsync(workspaceId, caller, workspaces, cancellationToken);
            return CoreJson.Text(await workspaces.SessionProjectionAsync(await workspaces.ObserveAsync(workspaceId, actor, cancellationToken), actor, cancellationToken));
        },
            authorization, accessor, cancellationToken);

    [McpServerTool(Name = "rename_workspace", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Rename an logical workspace with a short purpose-based name of at most 120 plain-text characters. Requires direct mcp:read and mcp:workspaces, or reviewed application source authority. workspaceId may be an worktree id or aggregate workspaceId. Use a UUID requestId; repeat the same name and requestId after an uncertain response. Only display metadata changes: source, branch, grants, active runtime and execution approvals remain intact. Update the name when the scope materially changes; do not ask the user to invent it.")]
    public static Task<string> RenameAsync(string workspaceId, string requestId, string name,
        ExternalWorkspaceMcpAuthorization authorization, DevelopmentWorkspaceService workspaces,
        IHttpContextAccessor accessor, CancellationToken cancellationToken)
        => ExecuteAsync(async caller =>
        {
            var owner = await OwnerAsync(workspaceId, caller, workspaces, cancellationToken, aggregate: true);
            return CoreJson.Text(await workspaces.RenameAsync(owner, new(requestId, name), cancellationToken, caller.UserId));
        }, authorization, accessor, cancellationToken);

    [McpServerTool(Name = "get_workspace_diff", ReadOnly = true)]
    [Description("Read a bounded changed-file diff from an registered workspace. Requires mcp:read and mcp:workspaces even though this tool reads only. path is repository-relative; view=session compares the original preparation base to current files, view=local shows local Git changes. Regular contained files only.")]
    public static Task<string> DiffAsync(string workspaceId, string path, ExternalWorkspaceMcpAuthorization authorization,
        DevelopmentWorkspaceService workspaces, IHttpContextAccessor accessor, CancellationToken cancellationToken,
        string view = "session")
        => ExecuteAsync(async caller => CoreJson.Text(await workspaces.DiffAsync(workspaceId,
            await OwnerAsync(workspaceId, caller, workspaces, cancellationToken), new(path, view), cancellationToken)),
            authorization, accessor, cancellationToken);

    [McpServerTool(Name = "refresh_workspace", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Fetch the installed source's tracked target into a registered workspace's managed repository; never change worktree files or integrate implicitly. Requires mcp:workspaces. UUID requestId must be reused after uncertain responses.")]
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
    [Description("Explicitly merge fresh target-branch changes into a clea registered workspace at expectedHead using a regular merge commit, message and author. Requires mcp:workspaces and user/repository authorization. Conflicts remain for explicit resolution. Use the original UUID requestId to recover; no push, app restart or publication occurs.")]
    public static Task<string> MergeAsync(string workspaceId, string requestId, string expectedHead, string message,
        string authorName, string authorEmail, ExternalWorkspaceMcpAuthorization authorization,
        DevelopmentWorkspaceService workspaces, IHttpContextAccessor accessor, AuditStore audit, IClock clock, CancellationToken cancellationToken)
        => CommandAsync(workspaceId, "merge", new(requestId, expectedHead, message, AuthorName: authorName, AuthorEmail: authorEmail),
            authorization, workspaces, accessor, audit, clock, cancellationToken);

    [McpServerTool(Name = "abort_workspace_merge", ReadOnly = false, Destructive = true, Idempotent = true)]
    [Description("Abort a pending managed merge in a registered workspace at expectedHead. Requires mcp:workspaces and explicit authorization to discard merge resolution. Preserve the original UUID requestId for replay/recovery.")]
    public static Task<string> AbortMergeAsync(string workspaceId, string requestId, string expectedHead,
        ExternalWorkspaceMcpAuthorization authorization, DevelopmentWorkspaceService workspaces,
        IHttpContextAccessor accessor, AuditStore audit, IClock clock, CancellationToken cancellationToken)
        => CommandAsync(workspaceId, "abort-merge", new(requestId, expectedHead),
            authorization, workspaces, accessor, audit, clock, cancellationToken);

    [McpServerTool(Name = "acquire_workspace_lease", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Add a UUID activity lease to a registered workspace before native editing or processes. Requires mcp:workspaces and a UUID requestId. Leases do not expire on disconnect, token expiry or revocation; only release after all native consumers stop.")]
    public static Task<string> AcquireLeaseAsync(string workspaceId, string requestId, string leaseId,
        ExternalWorkspaceMcpAuthorization authorization, DevelopmentWorkspaceService workspaces,
        IHttpContextAccessor accessor, AuditStore audit, IClock clock, CancellationToken cancellationToken)
        => CommandAsync(workspaceId, "lease", new(requestId, LeaseId: leaseId),
            authorization, workspaces, accessor, audit, clock, cancellationToken);

    [McpServerTool(Name = "release_workspace_lease", ReadOnly = false, Destructive = true, Idempotent = true)]
    [Description("Release an activity lease only after native editing/processes using the registered directory have stopped. Requires mcp:workspaces and UUID requestId/leaseId. Disconnect, revoked MCP access and client closure do not establish that processes stopped. Release never deletes the worktree.")]
    public static Task<string> ReleaseLeaseAsync(string workspaceId, string requestId, string leaseId,
        ExternalWorkspaceMcpAuthorization authorization, DevelopmentWorkspaceService workspaces,
        IHttpContextAccessor accessor, AuditStore audit, IClock clock, CancellationToken cancellationToken)
        => CommandAsync(workspaceId, "release-lease", new(requestId, LeaseId: leaseId),
            authorization, workspaces, accessor, audit, clock, cancellationToken);

    [McpServerTool(Name = "record_workspace_pull_requests", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Record existing HTTPS pull-request URLs as references on a registered workspace. Requires mcp:workspaces and UUID requestId. This records metadata only; it never creates a PR, pushes commits or grants publication authority.")]
    public static Task<string> RecordPullRequestsAsync(string workspaceId, string requestId, string[] pullRequests,
        ExternalWorkspaceMcpAuthorization authorization, DevelopmentWorkspaceService workspaces,
        IHttpContextAccessor accessor, AuditStore audit, IClock clock, CancellationToken cancellationToken)
        => CommandAsync(workspaceId, "references", new(requestId, PullRequests: pullRequests),
            authorization, workspaces, accessor, audit, clock, cancellationToken);

    [McpServerTool(Name = "delete_workspace", ReadOnly = false, Destructive = true, Idempotent = true)]
    [Description("Delete registered logical workspaces, including unfinished source, unmerged commits and activity leases. Requires current mcp:read and mcp:workspaces authority. Supply a UUID requestId and either workspaceId, workspaceIds, or all=true. No review or confirmation token is required. MCP Ask/Run unprompted/Disabled is the approval policy. Bulk targets are fixed on acceptance; retry the same request after uncertainty. Remote published source and ordinary app data are retained. Reports removal and consumer-stop outcomes separately.")]
    public static Task<string> DeleteAsync(string requestId, ExternalWorkspaceMcpAuthorization authorization,
        DevelopmentWorkspaceService workspaces, WorkspaceCleanupService cleanup, IHttpContextAccessor accessor,
        AuditStore audit, IClock clock, CancellationToken cancellationToken, string? workspaceId = null,
        string[]? workspaceIds = null, bool all = false)
        => ExecuteAsync(async caller =>
        {
            if (workspaceId is not null)
            {
                if (all || workspaceIds is not null) throw DevelopmentWorkspaceService.Error("request_invalid", "Choose workspaceId, workspaceIds or all.");
                return CoreJson.Text(await cleanup.ApplyDeleteAsync(workspaceId, caller.UserId, caller.App?.Id, new(requestId), cancellationToken));
            }
            return CoreJson.Text(await cleanup.DeleteBatchAsync(caller.UserId, caller.App?.Id, new(requestId, workspaceIds, all), cancellationToken));
        }, authorization, accessor, cancellationToken);

    [McpServerTool(Name = "get_workspace_participants", ReadOnly = true)]
    [Description("Read a registered workspace's current participants and activity. Requires direct workspace or reviewed application source authority; does not attach a conversation or grant membership.")]
    public static Task<string> ParticipantsAsync(string workspaceId, ExternalWorkspaceMcpAuthorization authorization,
        DevelopmentWorkspaceService workspaces, UserDirectoryStore users, AppRegistryStore apps,
        IHttpContextAccessor accessor, CancellationToken cancellationToken)
        => ExecuteAsync(async caller => CoreJson.Text(await WorkspaceParticipationEndpoints.Project(
            await workspaces.ParticipationAsync(workspaceId, caller.UserId, cancellationToken), caller.UserId,
            caller.App?.Id ?? "", users, apps, cancellationToken)), authorization, accessor, cancellationToken);

    [McpServerTool(Name = "get_workspace_commit_review", ReadOnly = false, Destructive = false, Idempotent = true)]
    [Description("Prepare a bounded exact-file commit review at the expected HEAD. Retain requestId, selected paths and review ID; this creates no commit or publication. Requires workspace authority.")]
    public static Task<string> CommitReviewAsync(string workspaceId, WorkspaceCommitReviewRequest input,
        ExternalWorkspaceMcpAuthorization authorization, DevelopmentWorkspaceService workspaces,
        IHttpContextAccessor accessor, CancellationToken cancellationToken)
        => ExecuteAsync(async caller => CoreJson.Text(await workspaces.PrepareCommitReviewAsync(workspaceId,
            await OwnerAsync(workspaceId, caller, workspaces, cancellationToken), input, cancellationToken)), authorization, accessor, cancellationToken);

    [McpServerTool(Name = "merge_workspace_upstream", ReadOnly = false, Destructive = true, Idempotent = true)]
    [Description("Merge the explicitly reviewed upstream into a registered worktree at expectedHead. Uses the selected source connection; allowUnrelatedHistories is an explicit opt-in. Retain the same requestId after uncertainty. This never pushes or merges a remote pull request.")]
    public static Task<string> MergeUpstreamAsync(string workspaceId, WorkspaceCommand input,
        ExternalWorkspaceMcpAuthorization authorization, DevelopmentWorkspaceService workspaces,
        IHttpContextAccessor accessor, AuditStore audit, IClock clock, CancellationToken cancellationToken)
        => CommandAsync(workspaceId, "merge-upstream", input, authorization, workspaces, accessor, audit, clock, cancellationToken);

    private static Task<string> CommandAsync(string id, string kind, WorkspaceCommand command,
        ExternalWorkspaceMcpAuthorization authorization, DevelopmentWorkspaceService workspaces,
        IHttpContextAccessor accessor, AuditStore audit, IClock clock, CancellationToken ct)
        => ExecuteAsync(async caller =>
        {
            var result = await workspaces.CommandAsync(id, await OwnerAsync(id, caller, workspaces, ct), kind, command, ct);
            await AuditAsync(audit, clock, caller, result, command.RequestId, kind);
            return CoreJson.Text(await workspaces.SessionProjectionAsync(result, caller.Owner(result.Owner.SessionId), ct));
        }, authorization, accessor, ct);

    private static async Task<WorkspaceOwner> OwnerAsync(string id, ExternalWorkspaceMcpCaller caller,
        DevelopmentWorkspaceService workspaces, CancellationToken ct, bool aggregate = false)
    {
        var workspace = (await workspaces.ListAsync(null, true, ct)).Workspaces.FirstOrDefault(w => (w.Id == id || aggregate && w.WorkspaceId == id));
        if (workspace is null) throw new AppLifecycleException("workspace_not_found", "No registered workspace has that ID.");
        return aggregate ? workspace.Owner : caller.Owner(workspace.Owner.SessionId);
    }

    private static async Task<string> ExecuteAsync(Func<ExternalWorkspaceMcpCaller, Task<string>> action,
        ExternalWorkspaceMcpAuthorization authorization, IHttpContextAccessor accessor, CancellationToken ct)
    {
        try { return await action(await authorization.RequireAsync(accessor.HttpContext, ct)); }
        catch (Exception ex) when (ex is AppIdentityException or AppLifecycleException or IOException or UnauthorizedAccessException)
        { return CoreJson.Text(new McpError(ex.Message)); }
    }

    internal static async Task AuditAsync(AuditStore audit, IClock clock, ExternalWorkspaceMcpCaller caller,
        DevelopmentWorkspace workspace, string requestId, string kind, string via = "mcp")
    {
        try
        {
            await audit.AppendAsync(new("audit_" + Guid.NewGuid().ToString("N"), "development.workspace." + kind,
                "workspace", workspace.Id, workspace.Operations.FirstOrDefault(o => o.Id == requestId)?.State ?? workspace.State,
                caller.UserId, clock.UtcNow, new Dictionary<string, string> { ["via"] = via, ["requestId"] = requestId,
                    ["principal"] = caller.PrincipalId }), CancellationToken.None);
        }
        catch (Exception ex) { Console.Error.WriteLine("[audit] Cannot record external workspace operation: " + ex.Message); }
    }
}
