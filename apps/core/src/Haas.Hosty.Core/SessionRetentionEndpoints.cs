namespace Haas.Hosty.Core;

internal sealed record SessionRetentionRequest(string UserId, WorkspaceWorkflowCommand? Cleanup = null);
internal sealed record SessionRetentionSnapshot(string Kind, WorkspaceWorkflow? Workflow, bool ResourcesFinished, bool WorkspaceAbsent = false);

internal static class SessionRetentionEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapPost("/api/internal/apps/{appId}/sessions/{sessionId}/retention", async (string appId, string sessionId,
            SessionRetentionRequest input, HttpRequest request, AppServiceTokenService tokens, AppRegistryStore apps,
            UserDirectoryStore users, DevelopmentWorkspaceService workspaces, CoreEnvironmentStore environments,
            SandboxStore sandboxes, WorkspaceCleanupService cleanup, CancellationToken ct) =>
        {
            request.HttpContext.Response.Headers.CacheControl = "no-store";
            try
            {
                AssistantSessionAuthority.ValidateSessionId(sessionId);
                if (!tokens.ValidateToken(appId, CoreSessionAuthorization.ReadBearerToken(request) ?? ""))
                    throw new AppIdentityException("token_invalid", "An app service token is required.");
                var caller = await apps.GetAppAsync(appId, ct);
                if (caller is null || !AgentMcpDirectory.IsAssistant(caller))
                    throw new AppIdentityException("mcp_assistant_required", "A confirmed assistant is required.");
                if (!(await users.ReadAsync(ct)).Users.Any(u => u.Id == input.UserId && !u.Disabled && AppAccessPolicy.IsAdmin(u)))
                    throw new AppIdentityException("admin_required", "The session owner must still be an enabled administrator.");
                var owner = new WorkspaceOwner(appId, caller.InstalledAt, input.UserId, sessionId);
                var trees = (await workspaces.ListAsync(owner, true, ct)).Workspaces;
                if (trees.Length == 0 && (await workspaces.ListAsync(null, true, ct)).Workspaces.Any(t =>
                    !t.Owner.IsExternal && t.Owner.AppId == appId && t.Owner.UserId == input.UserId &&
                    t.Owner.SessionId == sessionId && t.Owner.Installation != caller.InstalledAt))
                    throw DevelopmentWorkspaceService.Error("retention_unclassified", "A previous assistant installation owns this session's source. Reconcile it before deletion.");
                var workflow = trees.Length > 0 ? await workspaces.WorkflowAsync(owner, ct) : null;
                bool Owns(SandboxActor actor, SandboxContext? context) => actor.AppId == owner.AppId &&
                    actor.Installation == owner.Installation && actor.UserId == owner.UserId &&
                    (context?.SessionId == sessionId || context?.WorkspaceId == DevelopmentWorkspaceService.WorkspaceIdFor(owner));
                var children = (await environments.ListAsync(ct)).Where(e => Owns(e.Owner, e.Request.Context)).ToArray();
                var instances = (await sandboxes.ListAsync(ct)).Where(s => Owns(s.Owner, s.Request.Context)).ToArray();
                if (input.Cleanup is not null)
                {
                    if (!AppManagementAuthorization.HasPermission(caller, CoreAppPermissions.WorkspacesCleanup) ||
                        !AppManagementAuthorization.HasPermission(caller, CoreAppPermissions.Sources))
                        throw new AppIdentityException("app_permission_required", "Review apps.workspaces.cleanup and apps.sources.full before background cleanup.");
                    // The existing coordinator rechecks every head, merge, lease and consumer, journals
                    // Finish and release, and rejects unfinished work. No arbitrary workspace ID input.
                    workflow = await cleanup.DeleteAsync(DevelopmentWorkspaceService.WorkspaceIdFor(owner), owner.UserId, appId, input.Cleanup, ct);
                    children = (await environments.ListAsync(ct)).Where(e => Owns(e.Owner, e.Request.Context)).ToArray();
                    instances = (await sandboxes.ListAsync(ct)).Where(s => Owns(s.Owner, s.Request.Context)).ToArray();
                }
                return CoreJson.Json(new SessionRetentionSnapshot(trees.Length > 0 || workflow?.State == "deleted" ? "workspace" :
                    children.Length + instances.Length > 0 ? "sandbox" : "chat", workflow,
                    children.All(e => e.State == "finished") && instances.All(s => s.State == "disposed"),
                    await workspaces.SessionWorkspaceAbsentAsync(owner, ct)));
            }
            catch (AppIdentityException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), AuthEndpoints.MapIdentityErrorStatus(ex.Code)); }
            catch (AppLifecycleException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), 409); }
            catch (SandboxException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), ex.Status); }
        });
    }
}
