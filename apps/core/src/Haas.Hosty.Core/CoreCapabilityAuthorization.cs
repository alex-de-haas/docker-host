namespace Haas.Hosty.Core;

// A current caller, never a caller-supplied user ID or a synthetic application. This value is only
// request-local. Persist PrincipalId for attribution, not its grants as reusable authority.
internal sealed record CoreCapabilityCaller(HostUserRecord User, string PrincipalId, AppRecord? App,
    IReadOnlyList<string>? Scopes, bool OperatorSession = false)
{
    internal CoreCallerAuthority? Authority { get; init; }

    internal void Require(string scope, string permission)
    {
        if (App is not null)
        {
            if (!AppManagementAuthorization.HasPermission(App, permission))
                throw new AppIdentityException("app_permission_required", $"The application requires '{permission}'.");
        }
        else if (!OperatorSession && !AccessTokenScopes.Grants(Scopes, scope))
            throw new AppIdentityException("scope_required", $"The credential requires '{scope}'.");
    }
    internal SandboxActor EnvironmentActor() => new(User.Id, PrincipalId: PrincipalId,
        CreatorAppId: App?.Id, CreatorInstallation: App?.InstalledAt) { Capability = this };
}

internal sealed partial class CoreCapabilityAuthorization(UserDirectoryStore users, OAuthStore oauth,
    CoreSettingsService settings, IClock clock, AssistantMcpAccess assistants, AppRegistryStore registry, AppIdentityService identity, CoreHistoryExportStore historyExports, CoreProviderOperationStore providerOperations)
{
    internal async Task<CoreCapabilityCaller> RequireAsync(HttpRequest request, IReadOnlyList<string> scopes,
        IReadOnlyList<string> permissions, CancellationToken ct, bool administrator = true)
    {
        CoreCapabilityCaller caller;
        AuthSessionRecord? session = null;
        if (AppManagementAuthorization.Caller(request) is { } management)
        {
            var currentApp = await registry.GetAppAsync(management.App.Id, ct);
            var user = (await users.ReadAsync(ct)).Users.SingleOrDefault(u => u.Id == management.User.Id && !u.Disabled);
            if (currentApp is null || currentApp.InstalledAt != management.App.InstalledAt || user is null)
                throw new AppIdentityException("permission_denied", "The initiating installation or user is no longer available.");
            var hash = AppIdentityService.HashToken(request.Headers[AppManagementAuthorization.IdentityHeader].ToString());
            var actor = await identity.RequireOperationHashAsync(hash, currentApp.Id, scope => BackgroundGrantService.AllowsRoute(scope, request), ct);
            if (actor.UserId != user.Id) throw new AppIdentityException("permission_denied", "The initiating user changed.");
            caller = new(user, AppPrincipal(currentApp), currentApp, null)
            { Authority = new("app", AppId: currentApp.Id, Installation: currentApp.InstalledAt, PermissionRevision: currentApp.PermissionRevision, IdentityHash: hash) };
        }
        else
        {
            var bearer = CoreSessionAuthorization.ReadBearerToken(request);
            if (bearer?.StartsWith(AssistantMcpAccess.Prefix, StringComparison.Ordinal) == true)
            {
                if (request.Path != "/api/mcp") throw new AppIdentityException("mcp_access_denied", "Assistant MCP credentials are restricted to the MCP endpoint.");
                var actor = await assistants.ValidateAsync(bearer, AgentMcpDirectory.CoreId, ct);
                if (actor is null || actor.DiscoveryOnly)
                    throw new AppIdentityException("mcp_access_denied", "Current invocation authority is required.");
                var user = (await users.ReadAsync(ct)).Users.SingleOrDefault(u => u.Id == actor.UserId && !u.Disabled)
                    ?? throw new AppIdentityException("user_disabled", "The acting user is unavailable.");
                caller = new(user, AppPrincipal(actor.Caller), actor.Caller, null)
                { Authority = new("assistant", AppId: actor.Caller.Id, Installation: actor.Caller.InstalledAt, PermissionRevision: actor.Caller.PermissionRevision, Mcp: assistants.ReadVerifiedClaims(bearer), InvokedTool: CoreMcpCatalog.InvokedTool) };
            }
            else if (bearer is not null && ScopedCredentials.Resolve(await users.ReadAsync(ct), bearer,
                         clock.UtcNow, settings.AuthLifetimes, AccessTokenScopes.CoreAudience) is { } credential)
            {
                if (request.Cookies.ContainsKey(CoreSessionAuthorization.SessionCookieName))
                    throw new AppIdentityException("app_credential_mixed", "Do not combine scoped credentials with an operator cookie.");
                var record = credential.Record;
                session = record;
                string principal;
                if (record.Kind == AccessTokenKinds.OAuth && record.GrantId is { } grantId)
                {
                    var authority = await oauth.ReadAsync(ct);
                    var grant = authority.Grants.SingleOrDefault(g => g.Id == grantId && g.UserId == credential.User.Id
                        && g.Audience == AccessTokenScopes.CoreAudience && OAuthStore.IsGrantLive(g, clock.UtcNow));
                    if (grant is null || !authority.Clients.Any(c => c.ClientId == grant.ClientId && c.DeletedAt is null)
                        || record.Scopes is null || record.Scopes.Except(grant.Scopes, StringComparer.Ordinal).Any())
                        throw new AppIdentityException("scope_required", "The current Core grant is unavailable.");
                    principal = "oauth:" + grantId;
                }
                else if (record.Kind == AccessTokenKinds.Manual && record.GrantId is null)
                    principal = "manual:" + DevelopmentWorkspaceService.Hash(record.Id);
                else throw new AppIdentityException("scope_required", "Use a directly reviewed Core credential.");
                caller = new(credential.User, principal, null, record.Scopes)
                { Authority = new("scoped", CredentialHash: AppIdentityService.HashToken(record.Id)) };
                if (!AccessTokenScopes.Grants(caller.Scopes, AccessTokenScopes.McpRead))
                    throw new AppIdentityException("scope_required", "The credential requires 'mcp:read'.");
                CoreApiRequest.ExternalAuthenticated();
            }
            else
            {
                HostUserRecord? user = null;
                var result = await CoreSessionAuthorization.RequireSessionAsync(request, users, clock, actor =>
                {
                    user = actor;
                    return Task.FromResult<IResult>(Results.Empty);
                }, requireCsrf: !HttpMethods.IsGet(request.Method) &&
                    CoreSessionAuthorization.ReadSessionCredential(request).Source == SessionCredentialSource.Cookie,
                    cancellationToken: ct);
                if (user is null)
                {
                    var error = (result as Microsoft.AspNetCore.Http.IValueHttpResult)?.Value as ErrorResponse;
                    throw new SandboxException(error?.Code ?? "session_missing", error?.Message ?? "Authentication required.",
                        (result as Microsoft.AspNetCore.Http.IStatusCodeHttpResult)?.StatusCode ?? 401);
                }
                caller = new(user, OperatorPrincipal(user.Id, AppIdentityService.HashToken(CoreSessionAuthorization.ReadSessionCredential(request).Value!)), null, null, true)
                { Authority = new("operator", CredentialHash: AppIdentityService.HashToken(CoreSessionAuthorization.ReadSessionCredential(request).Value!)) };
            }
        }
        if (administrator && !AppAccessPolicy.IsAdmin(caller.User))
            throw new AppIdentityException("admin_required", "This operation requires a current administrator.");
        if (caller.App is { } app)
        {
            foreach (var permission in permissions)
                if (!AppManagementAuthorization.HasPermission(app, permission))
                    throw new AppIdentityException("app_permission_required", $"The application requires '{permission}'.");
        }
        else if (!caller.OperatorSession)
            foreach (var scope in scopes)
                if (!AccessTokenScopes.Grants(caller.Scopes, scope))
                    throw new AppIdentityException("scope_required", $"The credential requires '{scope}'.");
        if (session is not null)
            await CoreSessionAuthorization.TouchSessionAsync(users, session, clock.UtcNow, ct, oauth);
        return caller;
    }
    internal static string OperatorPrincipal(string userId, string credentialHash) => "operator:" + userId + ":" + credentialHash;
    internal static string AppPrincipal(AppRecord app) => "app:" + app.Id + ":" + PanelIdentity.Installation(app);
}
