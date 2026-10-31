namespace Haas.Hosty.Core;

// Non-secret provenance signed into short-lived mediated provider credentials. Never accept it
// from an ordinary request body; only Core constructs it from an authenticated request.
internal sealed record CoreCallerAuthority(string Kind, string? CredentialHash = null, string? AppId = null,
    DateTimeOffset? Installation = null, string? PermissionRevision = null, string? IdentityHash = null,
    AssistantMcpClaims? Mcp = null, string? InvokedTool = null, string? ExportGrantId = null, CoreTaskDispatchRef? TaskDispatch = null);

internal sealed partial class CoreCapabilityAuthorization
{
    internal async Task<CoreCapabilityCaller> RevalidateAsync(CoreCallerAuthority origin, string expectedUser,
        string expectedPrincipal, string kind, string providerAppId, string key, string toolName, CancellationToken ct, bool retainedTask = false)
    {
        var state = await users.ReadAsync(ct);
        var user = state.Users.SingleOrDefault(u => u.Id == expectedUser && !u.Disabled)
            ?? throw new AppIdentityException("permission_denied", "The originating user is unavailable.");
        CoreCapabilityCaller caller;
        if (origin.Kind == "task-source-read")
        {
            if (origin.TaskDispatch is null || kind != "tasks" || toolName != "task_get")
                throw new AppIdentityException("permission_denied", "A retained task source check only authorizes its read operation.");
            var (original, receipt) = await TaskDispatchCallerAsync(origin.TaskDispatch, ct);
            if (receipt.Provider?.AppId != providerAppId || receipt.Provider.Key != key
                || original.User.Id != expectedUser || original.PrincipalId != expectedPrincipal)
                throw new AppIdentityException("permission_denied", "This task source is outside the retained dispatch.");
            caller = original with { Authority = origin };
        }
        else if (origin.Kind == "task-dispatch")
        {
            if (origin.TaskDispatch is null || kind != "task-executor" || toolName != "task_action")
                throw new AppIdentityException("permission_denied", "Task dispatch grants authorize only their executor operations.");
            var (original, receipt) = await TaskDispatchCallerAsync(origin.TaskDispatch, ct);
            var executor = receipt.TaskAuthorization!.Scope.Executor;
            if (executor.AppId != providerAppId || executor.Key != key || original.User.Id != expectedUser || original.PrincipalId != expectedPrincipal)
                throw new AppIdentityException("permission_denied", "This executor is outside the authorized task attempt.");
            caller = original with { Authority = origin };
        }
        else if (origin.Kind == "history-export")
        {
            if (kind != "conversation-history" || toolName is not ("history_export_snapshot" or "history_export_changes" or "history_capabilities") || origin.ExportGrantId is null)
                throw new AppIdentityException("permission_denied", "This consent authorizes only its history export corpus.");
            var record = await historyExports.ReadAsync(origin.ExportGrantId, ct);
            var app = origin.AppId is null ? null : await registry.GetAppAsync(origin.AppId, ct);
            if (app is null || app.InstalledAt != origin.Installation || app.PermissionRevision != origin.PermissionRevision
                || record.Grant.OwnerUserId != user.Id || record.Grant.PrincipalId != expectedPrincipal
                || record.Grant.Consumer?.Kind != "app" || record.Grant.Consumer.AppId != app.Id
                || record.Grant.Consumer.InstallationId != PanelIdentity.Installation(app))
                throw new AppIdentityException("permission_denied", "This export consumer or its consent changed.");
            var source = CoreHistoryExportStore.Providers(record).SingleOrDefault(p => p.AppId == providerAppId && p.Key == key)
                ?? throw new AppIdentityException("permission_denied", "This source is outside the approved export corpus.");
            historyExports.Scope(record, source);
            await identity.RequireAccessibleUserAsync(app.Id, user.Id, ct);
            caller = new(user, AppPrincipal(app), app, null) { Authority = origin };
            caller.Require("", CoreAppPermissions.HistoryExport);
        }
        else if (origin.Kind is "app" or "assistant")
        {
            var app = origin.AppId is null ? null : await registry.GetAppAsync(origin.AppId, ct);
            if (app is null || app.InstalledAt != origin.Installation || app.PermissionRevision != origin.PermissionRevision)
                throw new AppIdentityException("permission_denied", "The originating installation or its reviewed grants changed.");
            if (origin.Kind == "assistant")
            {
                var actor = origin.Mcp is null ? null : await assistants.ValidateClaimsAsync(origin.Mcp, AgentMcpDirectory.CoreId, ct, retainedOperation: retainedTask);
                var authorizedTool = origin.InvokedTool ?? toolName;
                if (actor is null || actor.DiscoveryOnly || actor.UserId != user.Id || actor.DeniedTools?.Contains(authorizedTool) == true
                    || actor.AllowedTools is { } allowed && !allowed.Contains(authorizedTool))
                    throw new AppIdentityException("permission_denied", "The originating assistant invocation is no longer authorized.");
            }
            else
            {
                if (origin.IdentityHash is null) throw new AppIdentityException("permission_denied", "Originating user authority is missing.");
                var actor = await identity.RequireOperationHashAsync(origin.IdentityHash, app.Id,
                    scope => scope.Kind == "provider" && scope.TargetAppId == providerAppId && scope.ProviderKind == kind && scope.Key == key, ct);
                if (actor.UserId != user.Id) throw new AppIdentityException("permission_denied", "The originating user changed.");
            }
            caller = new(user, AppPrincipal(app), app, null) { Authority = origin };
        }
        else
        {
            var record = origin.CredentialHash is null ? null : state.Sessions.SingleOrDefault(s => s.UserId == user.Id
                && AppIdentityService.HashToken(s.Id) == origin.CredentialHash
                && CoreSessionAuthorization.IsSessionLive(s, clock.UtcNow, settings.AuthLifetimes.IdleFor(s.Kind)));
            if (record is null) throw new AppIdentityException("permission_denied", "The originating credential expired or was revoked.");
            if (origin.Kind == "operator" && record.Audience is null)
                caller = new(user, OperatorPrincipal(user.Id, origin.CredentialHash!), null, null, true) { Authority = origin };
            else if (origin.Kind == "scoped" && record.Audience == AccessTokenScopes.CoreAudience)
            {
                string principal;
                if (record.Kind == AccessTokenKinds.OAuth && record.GrantId is { } grantId)
                {
                    var authority = await oauth.ReadAsync(ct);
                    var grant = authority.Grants.SingleOrDefault(g => g.Id == grantId && g.UserId == user.Id
                        && g.Audience == AccessTokenScopes.CoreAudience && OAuthStore.IsGrantLive(g, clock.UtcNow));
                    if (grant is null || !authority.Clients.Any(c => c.ClientId == grant.ClientId && c.DeletedAt is null)
                        || record.Scopes is null || record.Scopes.Except(grant.Scopes, StringComparer.Ordinal).Any())
                        throw new AppIdentityException("permission_denied", "The originating Core grant changed.");
                    principal = "oauth:" + grantId;
                }
                else if (record.Kind == AccessTokenKinds.Manual && record.GrantId is null)
                    principal = "manual:" + DevelopmentWorkspaceService.Hash(record.Id);
                else throw new AppIdentityException("permission_denied", "This credential cannot mediate provider calls.");
                caller = new(user, principal, null, record.Scopes) { Authority = origin };
                caller.Require(AccessTokenScopes.McpRead, "");
            }
            else throw new AppIdentityException("permission_denied", "The originating credential audience changed.");
        }
        if (caller.PrincipalId != expectedPrincipal)
            throw new AppIdentityException("permission_denied", "The originating principal changed.");
        await identity.RequireAccessibleUserAsync(providerAppId, user.Id, ct);
        return caller;
    }
}
