using Microsoft.AspNetCore.Routing;

namespace Haas.Hosty.Core;

// App management uses the existing app-bound user grant plus the server's service credential.
// This allowlist is deliberately independent of host roles: the endpoint still checks the user.
// New routes are unavailable to app callers until their authority is explicitly mapped here.
internal static class AppManagementAuthorization
{
    public const string IdentityHeader = "X-Hosty-App-Identity";
    private static readonly object CallerKey = new();
    private static readonly IReadOnlyDictionary<string, string[]> Policies = BuildPolicies();

    public static AppManagementCaller? Caller(HttpRequest request)
        => request.HttpContext.Items.TryGetValue(CallerKey, out var value) ? value as AppManagementCaller : null;

    public static async Task InvokeAsync(HttpContext context, RequestDelegate next)
    {
        var request = context.Request;
        // Internal service APIs already authenticate the same pair and enforce their own contracts.
        if (!request.Headers.ContainsKey(IdentityHeader) || request.Path.StartsWithSegments("/api/internal"))
        {
            await next(context);
            return;
        }

        var result = await ResolveAsync(request, context.RequestAborted);
        if (result.Error is not null)
        {
            await result.Error.ExecuteAsync(context);
            return;
        }

        context.Items[CallerKey] = result.Caller;
        context.Response.Headers.CacheControl = "no-store";
        await next(context);
    }

    public static async Task<(AppManagementCaller? Caller, IResult? Error)> ResolveAsync(
        HttpRequest request, CancellationToken ct)
    {
        var route = (request.HttpContext.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText;
        if (route is null || !Policies.TryGetValue($"{request.Method} {route}", out var permissions))
            return Denied("app_operation_forbidden", "This operation requires the direct Core operator interface.");
        // Never accept a simultaneous cookie as an alternative authority for this app request.
        if (request.Cookies.ContainsKey(CoreSessionAuthorization.SessionCookieName))
            return Denied("app_credential_mixed", "Do not send a Core session cookie with app credentials.");
        var services = request.HttpContext.RequestServices;
        var bearer = CoreSessionAuthorization.ReadBearerToken(request);
        var appId = bearer is null ? null : services.GetRequiredService<AppServiceTokenService>().ResolveAppId(bearer);
        if (appId is null)
            return Denied("app_service_token_invalid", "An app service token is required.", 401);
        try
        {
            var actor = await services.GetRequiredService<AppIdentityService>()
                .RevalidateAsync(request.Headers[IdentityHeader].ToString(), appId, ct);
            var app = await services.GetRequiredService<AppRegistryStore>().GetAppAsync(appId, ct);
            if (app is null) return Denied("app_access_denied", "The calling app is no longer installed.");
            var connectionSelection = request.Method == "GET" && route is "/api/source-connections" or "/api/source-connections/" or "/api/apps/{appId}/source-access";
            var missing = permissions.Where(p => !HasPermission(app, p) &&
                !(p == CoreAppPermissions.Sources && connectionSelection && HasPermission(app, CoreAppPermissions.SourceConnections))).ToArray();
            if (missing.Length > 0)
                return Denied("app_permission_required", $"The calling app requires: {string.Join(", ", missing.Select(p => p == CoreAppPermissions.Sources && connectionSelection ? "sources.connections or apps.sources.full" : p))}.");
            if (permissions.Length > 0)
                await services.GetRequiredService<AppIdentityService>().RequireActivityAsync(request.Headers[IdentityHeader].ToString(), appId, ct);
            var state = await services.GetRequiredService<UserDirectoryStore>().ReadAsync(ct);
            var user = state.Users.FirstOrDefault(u => u.Id == actor.UserId && !u.Disabled);
            if (user is null) return Denied("user_disabled", "The acting user is unavailable.");
            return (new AppManagementCaller(app, user), null);
        }
        catch (AppIdentityException ex)
        {
            return Denied(ex.Code, ex.Message, AuthEndpoints.MapIdentityErrorStatus(ex.Code));
        }
    }

    public static bool HasPermission(AppRecord app, string permission)
        => app.GrantedCorePermissions?.Contains(permission, StringComparer.Ordinal) == true;

    public static IResult? RequireAdditional(HttpRequest request, string permission)
        => Caller(request) is { } caller && !HasPermission(caller.App, permission)
            ? CoreJson.Json(new ErrorResponse("app_permission_required", $"The calling app requires '{permission}'."), 403)
            : null;

    internal static IResult? RequirePrivateSourceAccess(HttpRequest request, PrivateSourceAccess? access)
    {
        if (Caller(request) is not { } caller || (access?.Manifest is null && access?.Git is null)) return null;
        if (!HasPermission(caller.App, CoreAppPermissions.Sources) && !HasPermission(caller.App, CoreAppPermissions.SourceConnections))
            return CoreJson.Json(new ErrorResponse("app_permission_required", "Source selection requires apps.sources.full or sources.connections."), 403);
        return new[] { access?.Manifest, access?.Git }.OfType<SourceReadGrant>().Any(g => g.OwnerId != caller.User.Id)
            ? CoreJson.Json(new ErrorResponse("source_access_denied", "Only the source owner can review these private connections."), 403)
            : null;
    }

    private static (AppManagementCaller?, IResult?) Denied(string code, string message, int status = 403)
        => (null, CoreJson.Json(new ErrorResponse(code, message), status));

    private static IReadOnlyDictionary<string, string[]> BuildPolicies()
    {
        var result = new Dictionary<string, string[]>(StringComparer.Ordinal);
        void Add(string permission, params string[] routes)
        {
            foreach (var route in routes) result.Add(route, [permission]);
        }
        Add(CoreAppPermissions.ReadApps,
            "GET /api/apps", "GET /api/apps/{appId}/health", "GET /api/apps/{appId}/update-status",
            "GET /api/apps/{appId}/assets/{**assetPath}", "GET /api/apps/{id}/permissions");
        Add(CoreAppPermissions.AppLogs, "GET /api/apps/{appId}/logs");
        Add(CoreAppPermissions.Notifications, "GET /api/notifications", "POST /api/notifications/read");
        Add(CoreAppPermissions.AppLifecycle,
            "POST /api/apps/{appId}/start", "POST /api/apps/{appId}/stop", "POST /api/apps/{appId}/restart",
            "POST /api/apps/{appId}/autostart", "POST /api/apps/{appId}/switch-runtime/plan",
            "POST /api/apps/{appId}/switch-runtime", "GET /api/apps/{appId}/source",
            "POST /api/apps/{appId}/source/override", "DELETE /api/apps/{appId}/source/override",
            "GET /api/apps/{appId}/source/summary");
        Add(CoreAppPermissions.ConfigureApps,
            "POST /api/apps/{appId}/configure", "POST /api/apps/{appId}/ports/reassign/plan",
            "POST /api/apps/{appId}/ports/reassign", "POST /api/apps/{appId}/mounts",
            "PUT /api/apps/{appId}/mounts/shared/{name}", "GET /api/apps/{appId}/settings/{settingKey}/value",
            "GET /api/apps/{appId}/public-origins", "POST /api/apps/{appId}/public-origins/publish",
            "POST /api/apps/{appId}/public-origins/unpublish", "GET /api/apps/{appId}/backups",
            "POST /api/apps/{appId}/backups", "GET /api/apps/{appId}/backups/cleanup/plan",
            "POST /api/apps/{appId}/backups/cleanup", "POST /api/apps/{appId}/backups/{backupId}/restore",
            "DELETE /api/apps/{appId}/backups/{backupId}");
        Add(CoreAppPermissions.Install,
            "GET /api/apps/{appId}/feeds", "POST /api/apps/{appId}/feed",
            "POST /api/apps/update-check", "GET /api/apps/{appId}/update/plan",
            "POST /api/apps/{appId}/update/plan", "POST /api/apps/{appId}/update",
            "GET /api/apps/{appId}/remove-impact");
        Add(CoreAppPermissions.ReadCore,
            "GET /api/core/status", "GET /api/core/development", "GET /api/core/operations/{id}",
            "GET /api/core/update-status", "GET /api/core/bootstrap");
        Add(CoreAppPermissions.CoreLifecycle, "POST /api/core/restart");
        Add(CoreAppPermissions.UpdateCore, "POST /api/core/update");
        Add(CoreAppPermissions.CoreLogs, "GET /api/core/logs");
        Add(CoreAppPermissions.ConfigureCore,
            "GET /api/core/settings", "PUT /api/core/settings", "PUT /api/core/source",
            "GET /api/core/agents", "PUT /api/core/agents/{targetId}",
            "GET /api/global-mounts", "POST /api/global-mounts", "DELETE /api/global-mounts/{name}",
            "GET /api/core/public-origin", "POST /api/core/public-origin/publish", "POST /api/core/public-origin/unpublish",
            "GET /api/core/cloudflare/token-template", "GET /api/core/cloudflare/status", "GET /api/core/cloudflare/diagnostics",
            "POST /api/core/cloudflare/connect", "POST /api/core/cloudflare/disconnect");
        Add(CoreAppPermissions.ReadUsers, "GET /api/users", "GET /api/auth/users", "GET /api/auth/invitations");
        Add(CoreAppPermissions.ManageUsers,
            "POST /api/auth/invitations", "DELETE /api/auth/invitations/{invitationId}",
            "PATCH /api/auth/users/{userId}", "DELETE /api/auth/users/{userId}",
            "DELETE /api/auth/users/{userId}/record", "PUT /api/auth/users/{userId}/assignments");
        Add(CoreAppPermissions.SourceConnections,
            "PUT /api/source-connections/identity",
            "POST /api/source-connections/pat", "POST /api/source-connections/device",
            "POST /api/source-connections/device/{id}/poll", "DELETE /api/source-connections/device/{id}",
            "PUT /api/source-connections/{id}", "POST /api/source-connections/{id}/check", "DELETE /api/source-connections/{id}");
        Add(CoreAppPermissions.Sources,
            "GET /api/apps/{appId}/source-access", "GET /api/source-connections", "GET /api/source-connections/",
            "GET /api/core/source/status", "POST /api/core/source/diff", "GET /api/apps/{appId}/source/status",
            "POST /api/apps/{appId}/source/diff", "POST /api/apps/{appId}/source/discard/plan",
            "POST /api/apps/{appId}/source/discard");
        result.Add("GET /api/core/resources", [CoreAppPermissions.ReadCore, CoreAppPermissions.ReadApps]);
        result.Add("GET /api/events", [CoreAppPermissions.ReadApps, CoreAppPermissions.ReadCore, CoreAppPermissions.Notifications]);
        // Self-session probes and reviewed requests need identity, not a blanket management grant.
        // InstallationApprovalService checks the operation's permission and request ownership itself.
        foreach (var route in new[] { "GET /api/profile", "GET /api/profile/", "PUT /api/profile", "PUT /api/profile/", "GET /api/auth/session", "POST /api/installations",
                     "POST /api/installations/{id}/submit", "GET /api/installations/{id}" })
            result.Add(route, []);
        return result;
    }
}

internal sealed record AppManagementCaller(AppRecord App, HostUserRecord User);
