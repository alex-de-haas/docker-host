using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

// Captures only non-secret references to the authority already checked by lifecycle endpoints.
// Background admission revalidates that authority for the actual provider, not just the consumer.
internal sealed class DependencyStartAuthorization(IHttpContextAccessor http, UserDirectoryStore users,
    AppRegistryStore apps, AppIdentityService identity, AssistantMcpAccess assistants,
    CoreSettingsService settings, IClock clock)
{
    internal async Task<DependencyStartAuthority> CaptureAsync(CancellationToken ct)
    {
        var request = http.HttpContext?.Request;
        if (request is null || request.Path.StartsWithSegments("/control")) return new("operator");
        if (AppManagementAuthorization.Caller(request) is { } caller)
            return new("app", caller.User.Id, AppIdentityService.HashToken(request.Headers[AppManagementAuthorization.IdentityHeader].ToString()), caller.App.Id);
        var credential = CoreSessionAuthorization.ReadSessionId(request);
        if (credential?.StartsWith(AssistantMcpAccess.Prefix, StringComparison.Ordinal) == true &&
            assistants.ReadVerifiedClaims(credential) is { } claims)
            return new("assistant", claims.UserId, Assistant: claims);
        var record = (await users.ReadAsync(ct)).Sessions.FirstOrDefault(s => s.Id == credential);
        return record is null ? new("unavailable") : new("session", record.UserId, Hash(record.Id));
    }

    internal async Task ValidateAsync(DependencyStartAuthority authority, string target, bool provider, CancellationToken ct)
    {
        if (authority.Kind == "operator") return;
        try
        {
            if (authority.Kind == "session")
            {
                var state = await users.ReadAsync(ct);
                var record = state.Sessions.FirstOrDefault(s => Hash(s.Id) == authority.CredentialHash && s.UserId == authority.UserId);
                var user = state.Users.FirstOrDefault(u => u.Id == authority.UserId);
                if (record is null || user is null || user.Disabled || !AppAccessPolicy.IsAdmin(user) ||
                    !CoreSessionAuthorization.IsSessionLive(record, clock.UtcNow, settings.AuthLifetimes.IdleFor(record.Kind))) throw Denied(target);
                if (record.Audience is not null && (record.Audience != AccessTokenScopes.CoreAudience ||
                    !AccessTokenScopes.Grants(record.Scopes, AccessTokenScopes.McpRead) ||
                    !AccessTokenScopes.Grants(record.Scopes, AccessTokenScopes.McpLifecycle))) throw Denied(target);
                return;
            }
            if (authority.Kind == "app" && authority.CallerAppId is { } callerId && authority.CredentialHash is { } hash)
            {
                var validated = await identity.RevalidateAuthorityAsync(hash, callerId, ct, allowBackground: true);
                var caller = await apps.GetAppAsync(callerId, ct);
                if (validated.Actor.UserId != authority.UserId || validated.Actor.HostRole != "host.admin" || caller is null ||
                    !AppManagementAuthorization.HasPermission(caller, CoreAppPermissions.AppLifecycle)) throw Denied(target);
                if (validated.Background is { } background && (background.Scope.Kind != "core" ||
                    background.Scope.TargetAppId != target || !background.Scope.Actions.Contains(provider ? "start" : "restart") &&
                    !background.Scope.Actions.Contains("start"))) throw Denied(target);
                return;
            }
            if (authority.Kind == "assistant" && authority.Assistant is { } claims)
            {
                var actor = await assistants.ValidateClaimsAsync(claims, AccessTokenScopes.CoreAudience, ct);
                if (actor is null || actor.DiscoveryOnly || actor.UserId != authority.UserId ||
                    !AppManagementAuthorization.HasPermission(actor.Caller, CoreAppPermissions.AppLifecycle) ||
                    provider && (actor.DeniedTools?.Contains("start_app") == true ||
                        actor.AllowedTools is { } allowed && !allowed.Contains("start_app"))) throw Denied(target);
                return;
            }
        }
        catch (AppIdentityException) { throw Denied(target); }
        throw Denied(target);
    }

    private static string Hash(string credential) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(credential)));
    private static AppLifecycleException Denied(string target) => new("dependency_start_forbidden",
        $"Start of '{target}' is not authorized by the original request. Start it with current lifecycle authority, then retry the consumer.");
}
