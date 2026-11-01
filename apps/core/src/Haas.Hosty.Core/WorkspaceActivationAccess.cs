using Haas.Hosty.Launch;

namespace Haas.Hosty.Core;

internal sealed class WorkspaceActivationAccess(UserDirectoryStore users, OAuthStore oauth, AppRegistryStore apps,
    CoreSettingsService settings, IClock clock, AppIdentityService identity, AssistantMcpAccess? assistants = null)
{
    internal async Task ValidateAsync(WorkspaceActivationActor actor, bool core, CancellationToken ct, bool sourceRequired = true)
    {
        var state = await users.ReadAsync(ct);
        if (!state.Users.Any(u => u.Id == actor.UserId && !u.Disabled && AppAccessPolicy.IsAdmin(u))) throw Denied();
        if (actor.AppId is { } appId)
        {
            if (actor.Mcp is { } origin)
            {
                if (assistants is null || actor.Installation is null) throw Denied();
                var current = await assistants.ValidateClaimsAsync(new(appId, AgentMcpDirectory.CoreId, actor.UserId,
                    origin.GrantHash, actor.Installation.Value, null, origin.GrantRevision, origin.Expires,
                    origin.SessionId, origin.LeaseRevision), AgentMcpDirectory.CoreId, ct, retainedOperation: true);
                if (current is null || current.DiscoveryOnly || current.DeniedTools?.Contains(origin.Tool) == true ||
                    current.AllowedTools is { } allowed && !allowed.Contains(origin.Tool) ||
                    !McpEndpoints.HasAppToolPermission(current.Caller, origin.Tool)) throw Denied();
            }
            else if (actor.AppIdentityHash is null || (await identity.RequireActivityHashAsync(actor.AppIdentityHash, appId, ct)).UserId != actor.UserId) throw Denied();
            var app = await apps.GetAppAsync(appId, ct);
            if (app is null || app.InstalledAt != actor.Installation ||
                sourceRequired && !AppManagementAuthorization.HasPermission(app, CoreAppPermissions.Sources) ||
                !AppManagementAuthorization.HasPermission(app, CoreAppPermissions.AppLifecycle) ||
                core && !AppManagementAuthorization.HasPermission(app, CoreAppPermissions.WorkspaceCore)) throw Denied();
        }
        else if (actor.Principal is { } principal)
        {
            IReadOnlyList<string>? scopes = null;
            if (principal.StartsWith("oauth:", StringComparison.Ordinal))
            {
                var authority = await oauth.ReadAsync(ct);
                var grant = authority.Grants.FirstOrDefault(g => "oauth:" + g.Id == principal && g.UserId == actor.UserId &&
                    g.Audience == AccessTokenScopes.CoreAudience && OAuthStore.IsGrantLive(g, clock.UtcNow));
                if (grant is not null && authority.Clients.Any(c => c.ClientId == grant.ClientId && c.DeletedAt is null)) scopes = grant.Scopes;
            }
            else if (principal.StartsWith("browser:", StringComparison.Ordinal))
            {
                if (state.Sessions.Any(s => s.UserId == actor.UserId && s.BrowserOrigin is not null &&
                    "browser:" + DevelopmentWorkspaceService.Hash(s.Id) == principal &&
                    CoreSessionAuthorization.IsSessionLive(s, clock.UtcNow, settings.AuthLifetimes.IdleFor(s.Kind)))) return;
                throw Denied();
            }
            else if (principal.StartsWith("manual:", StringComparison.Ordinal))
                scopes = state.Sessions.FirstOrDefault(s => s.UserId == actor.UserId && s.Kind == AccessTokenKinds.Manual &&
                    s.Audience == AccessTokenScopes.CoreAudience && "manual:" + DevelopmentWorkspaceService.Hash(s.Id) == principal &&
                    CoreSessionAuthorization.IsSessionLive(s, clock.UtcNow, settings.AuthLifetimes.IdleFor(s.Kind)))?.Scopes;
            if (scopes is null || !AccessTokenScopes.Grants(scopes, AccessTokenScopes.McpRead) ||
                sourceRequired && !AccessTokenScopes.Grants(scopes, AccessTokenScopes.McpWorkspaces) ||
                !AccessTokenScopes.Grants(scopes, AccessTokenScopes.McpLifecycle) ||
                core && !AccessTokenScopes.Grants(scopes, AccessTokenScopes.McpCoreRestart)) throw Denied();
        }
        else throw Denied();
    }
    internal static AppIdentityException Denied() => new("activation_authority_required",
        "Workspace activation requires current source and app lifecycle authority. Core additionally requires reviewed core.workspace.activate or direct mcp:core-restart authority.");
}
