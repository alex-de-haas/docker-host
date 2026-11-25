using Haas.Hosty.Launch;

namespace Haas.Hosty.Core;

internal sealed class WorkspaceActivationAccess(UserDirectoryStore users, OAuthStore oauth, AppRegistryStore apps,
    CoreSettingsService settings, IClock clock, AppIdentityService identity, AssistantMcpAccess? assistants = null, DevelopmentWorkspaceService? workspaces = null)
{
    internal async Task ValidateAsync(WorkspaceActivationActor actor, bool core, CancellationToken ct, bool sourceRequired = true)
    {
        if (actor.Deletion is not null) throw Denied();
        var state = await users.ReadAsync(ct);
        if (!state.Users.Any(u => u.Id == actor.UserId && !u.Disabled && AppAccessPolicy.IsAdmin(u))) throw Denied();
        if (actor.AppId is { } appId)
        {
            IReadOnlyList<string>? effective = null;
            if (actor.Mcp is { } origin)
            {
                if (assistants is null || actor.Installation is null) throw Denied();
                var current = await assistants.ValidateClaimsAsync(new(appId, AgentMcpDirectory.CoreId, actor.UserId,
                    origin.GrantHash, actor.Installation.Value, null, origin.GrantRevision, origin.Expires,
                    origin.SessionId, origin.LeaseRevision, AgentAdmissionRef: origin.AgentAdmissionRef,
                    AgentTargetKey: origin.AgentTargetKey, AgentAllowedTools: origin.AgentAllowedTools), AgentMcpDirectory.CoreId, ct, retainedOperation: true);
                if (current is null || current.DiscoveryOnly || current.DeniedTools?.Contains(origin.Tool) == true ||
                    current.AllowedTools is { } allowed && !allowed.Contains(origin.Tool) ||
                    (current.EffectivePermissions is { } selected
                        ? CoreMcpCatalog.AppPermission(origin.Tool) is not { } permission || !selected.Contains(permission)
                        : !McpEndpoints.HasAppToolPermission(current.Caller, origin.Tool))) throw Denied();
                effective = current.EffectivePermissions;
            }
            else if (actor.AppIdentityHash is null || (await identity.RequireActivityHashAsync(actor.AppIdentityHash, appId, ct)).UserId != actor.UserId) throw Denied();
            var app = await apps.GetAppAsync(appId, ct);
            bool Has(string permission) => effective is not null ? effective.Contains(permission)
                : app is not null && AppManagementAuthorization.HasPermission(app, permission);
            if (app is null || app.InstalledAt != actor.Installation ||
                sourceRequired && !Has(CoreAppPermissions.Sources) || !Has(CoreAppPermissions.AppLifecycle) ||
                core && !Has(CoreAppPermissions.WorkspaceCore)) throw Denied();
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
    // A browser may close after it authorizes an exact replacement. Only the recorded Return
    // can use this receipt. Ordinary runtime selection and all workspace entry paths reject it.
    internal async Task ValidateReturnAsync(WorkspaceActivationActor actor, string kind, string target, string requestId,
        CancellationToken ct, string? operation = null, string? replacement = null)
    {
        if (actor.Deletion is not { } reference)
        {
            await ValidateAsync(actor, kind == "core", ct, sourceRequired: kind == "core");
            return;
        }
        var journal = workspaces is null ? null : await workspaces.ReadDiscardAsync(reference.WorkspaceId, reference.RequestId, actor.UserId, ct);
        if (journal is not { State: "pending", DeleteOwner.Authority: { } original } ||
            original != (actor with { Deletion = null }) || original.Mcp is not null ||
            original.AppId is null && original.Principal?.StartsWith("browser:", StringComparison.Ordinal) != true ||
            WorkspaceRuntimeFiles.ChildId(reference.RequestId, reference.TargetKey) != requestId ||
            journal.DeleteOwner.Returns?.SingleOrDefault(t => t.Key == reference.TargetKey) is not { } selected ||
            selected.Kind != kind || (kind == "core" ? selected.Operation : selected.Name) != target ||
            kind == "app" && (selected.Operation != operation || selected.Replacement != replacement))
            throw Denied();
        if (!(await users.ReadAsync(ct)).Users.Any(u => u.Id == actor.UserId && !u.Disabled && AppAccessPolicy.IsAdmin(u))) throw Denied();
        if (actor.AppId is { } id)
        {
            var app = await apps.GetAppAsync(id, ct);
            if (app is null || app.InstalledAt != actor.Installation || !AppManagementAuthorization.HasPermission(app, CoreAppPermissions.Sources) ||
                !AppManagementAuthorization.HasPermission(app, CoreAppPermissions.AppLifecycle) ||
                kind == "core" && !AppManagementAuthorization.HasPermission(app, CoreAppPermissions.WorkspaceCore)) throw Denied();
        }
    }

    internal static AppIdentityException Denied() => new("activation_authority_required",
        "Workspace activation requires current source and app lifecycle authority. Core additionally requires reviewed core.workspace.activate or direct mcp:core-restart authority.");
}
