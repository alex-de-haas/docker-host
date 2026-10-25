using Microsoft.AspNetCore.WebUtilities;

namespace Haas.Hosty.Core;

internal sealed record UiPanelRef(string AppId, string InstallationId, string PanelId);
internal sealed record UiPanelTarget(UiPanelRef Panel, string? Route = null);
internal sealed record UiFramePolicy(bool Microphone, bool PopupEscape)
{
    public static UiFramePolicy From(AppRecord app) => new(
        AppManagementAuthorization.HasPermission(app, CoreAppPermissions.SpeechProviders),
        AppManagementAuthorization.HasPermission(app, CoreAppPermissions.Install));
}
internal sealed record UiPeer(string AppId, string InstallationId, IReadOnlyList<string> Origins);
internal sealed record UiBootstrap(int Version, string CoreOrigin, string UserId, UiPeer App,
    bool CanHost, bool PinnedOpen, UiPeer? Peer = null);
internal sealed record UiPanel(UiPanelRef Panel, string Label, string AppName, string? Icon,
    string Endpoint, string Route, string? Origin, bool Available, string State, bool CanStart, UiFramePolicy FramePolicy);
internal sealed record UiPanelCatalog(IReadOnlyList<UiPanel> Panels);
internal sealed record UiFrameSurface(string AppId, string InstallationId, string Endpoint, string Route,
    string Origin, UiFramePolicy FramePolicy);
internal sealed record UiResolvedPanel(UiPanelTarget Target, UiFrameSurface? Surface, bool Available,
    string State, string? StandaloneHref);

/// <summary>Stateless, actor-scoped UI discovery. A browser handshake never becomes API authority.</summary>
internal sealed partial class UiPanelService(AppRegistryStore apps, AppIdentityService identity,
    UserDirectoryStore users, CorePublicOriginResolver coreOrigins, ToolActivityService activity)
{
    internal static bool CanHost(AppRecord app) => AppManagementAuthorization.HasPermission(app, CoreAppPermissions.ReadPanels)
        || AppManagementAuthorization.HasPermission(app, CoreAppPermissions.ReadApps);

    private static void RequireHost(AppRecord app)
    {
        if (!CanHost(app)) throw new AppIdentityException("app_permission_required", "Allow this app to discover and open panels.");
    }

    internal static UiPeer Peer(AppRecord app) => new(app.Id, PanelIdentity.Installation(app), app.Endpoints
        .Where(e => e.Public && e.Protocol is "http" or "https")
        .SelectMany(e => AppIdentityService.GetAllowedEndpointOrigins(app, e))
        .Select(Origin).OfType<string>().Distinct(StringComparer.Ordinal).ToArray());

    internal static string? Origin(string? value)
        => Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https"
           && string.IsNullOrEmpty(uri.UserInfo) ? uri.GetLeftPart(UriPartial.Authority) : null;

    public async Task<UiBootstrap> BootstrapAsync(AppRecord caller, string userId, string? parentOrigin, CancellationToken ct)
    {
        UiPeer? peer = null;
        if (parentOrigin is not null)
        {
            if (Origin(parentOrigin) != parentOrigin) throw new AppIdentityException("origin_denied", "Invalid parent origin.");
            var matches = (await apps.ListAppRecordsAsync(ct)).Where(a => Peer(a).Origins.Contains(parentOrigin, StringComparer.Ordinal)).ToArray();
            if (matches.Length != 1) throw new AppIdentityException("origin_denied", "The parent origin does not identify one installed app.");
            var parent = matches[0];
            await identity.RequireAccessibleUserAsync(parent.Id, userId, ct);
            RequireHost(parent);
            peer = Peer(parent);
        }
        return new(1, Origin(coreOrigins.Effective)!, userId, Peer(caller), CanHost(caller), true, peer);
    }

    public async Task<UiPanelCatalog> ListAsync(AppRecord caller, string userId, CancellationToken ct)
    {
        RequireHost(caller);
        var state = await users.ReadAsync(ct);
        var user = state.Users.SingleOrDefault(u => u.Id == userId && !u.Disabled)
            ?? throw new AppIdentityException("user_disabled", "The current user is unavailable.");
        var canStart = AppAccessPolicy.IsAdmin(user) && AppManagementAuthorization.HasPermission(caller, CoreAppPermissions.AppLifecycle);
        var result = new List<UiPanel>();
        foreach (var app in await apps.ListAppRecordsAsync(ct))
        {
            if (!AppAccessPolicy.CanAccessApp(state, user, app.Id, app.System)) continue;
            var summary = AppSummary.From(app);
            foreach (var panel in summary.PanelSurfaces)
            {
                if (panel.Endpoint is null || panel.PanelId is null) continue;
                var available = Available(app, panel);
                result.Add(new(new(app.Id, PanelIdentity.Installation(app), panel.PanelId), panel.Label ?? app.DisplayName,
                    app.DisplayName, panel.Icon, panel.Endpoint, panel.Path, Origin(panel.EmbeddedUrl), available,
                    SurfaceState(app, panel),
                    canStart, UiFramePolicy.From(app)));
            }
        }
        return new(result);
    }

    public async Task<ToolActivityList> ActivityAsync(AppRecord caller, string userId, CancellationToken ct)
    {
        var catalog = await ListAsync(caller, userId, ct);
        var installed = (await apps.ListAppRecordsAsync(ct)).ToDictionary(a => a.Id);
        var result = new List<ToolActivity>();
        foreach (var panel in catalog.Panels)
        {
            if (!installed.TryGetValue(panel.Panel.AppId, out var app)
                || PanelIdentity.Installation(app) != panel.Panel.InstallationId) continue;
            var surface = AppSummary.From(app).PanelSurfaces.FirstOrDefault(p => p.PanelId == panel.Panel.PanelId);
            if (surface is null) continue;
            var health = app.Health?.Services.FirstOrDefault(s => s.Service == surface.Service)?.Health;
            // Panels may still be opened with an advisory failed probe, but their activity must not
            // promise a live provider. Another service's failed probe cannot hide this tool's state.
            result.Add(activity.Read(userId, panel with { Available = panel.Available && health != "unhealthy" }));
        }
        return new(result);
    }

    public async Task<UiResolvedPanel> ResolveAsync(AppRecord caller, string userId, UiPanelTarget target, CancellationToken ct)
    {
        RequireHost(caller);
        if (target.Panel is not { AppId.Length: > 0, InstallationId.Length: > 0, PanelId.Length: > 0 })
            throw new AppIdentityException("destination_invalid", "Select a declared panel.");
        var (_, app) = await identity.RequireAccessibleUserAsync(target.Panel.AppId, userId, ct);
        if (PanelIdentity.Installation(app) != target.Panel.InstallationId)
            throw new AppIdentityException("installation_changed", "The selected app installation changed.");
        var panel = AppSummary.From(app).PanelSurfaces.SingleOrDefault(p => p.PanelId == target.Panel.PanelId)
            ?? throw new AppIdentityException("destination_changed", "The selected panel is no longer declared.");
        var route = target.Route ?? panel.Path;
        if (panel.Endpoint is null || !UiSurfaceRoutes.Within(route, panel.Path))
            throw new AppIdentityException("destination_invalid", "The route is outside the selected panel.");
        var origin = Origin(panel.EmbeddedUrl);
        var available = Available(app, panel);
        return new(new(target.Panel, route), origin is null ? null : new(app.Id, PanelIdentity.Installation(app),
            panel.Endpoint, route, origin, UiFramePolicy.From(app)), available,
            SurfaceState(app, panel),
            BuildOpenUrl(coreOrigins.Effective, app.Id, target.Panel.InstallationId, panel.Endpoint, route));
    }

    private static bool Available(AppRecord app, AppSurfaceSummary panel)
        => Available(app, panel.Service, panel.EmbeddedUrl);

    internal static bool Available(AppRecord app, string? service, string? url)
        => SurfaceState(app, service, url) is "running" or "degraded";

    private static string SurfaceState(AppRecord app, AppSurfaceSummary panel)
        => SurfaceState(app, panel.Service, panel.EmbeddedUrl);

    internal static string SurfaceState(AppRecord app, string? serviceName, string? url)
    {
        if (app.RuntimeState is "starting" or "stopping") return app.RuntimeState;
        var service = app.Health?.Services.FirstOrDefault(s => s.Service == serviceName);
        if (url is null || (service is not null ? service.Status != "running" : app.RuntimeState != "running"))
            return app.RuntimeState == "running" ? "unavailable" : app.RuntimeState;
        // A failed sidecar does not make a working UI unavailable. A failed probe is advisory.
        var health = service?.Health ?? app.Health?.Status;
        return health == "starting" ? "unavailable" : health is "unhealthy" or "degraded" ? "degraded" : "running";
    }

    internal static string BuildOpenUrl(string core, string appId, string installation, string endpoint, string route)
        => QueryHelpers.AddQueryString($"{core.TrimEnd('/')}/api/apps/{Uri.EscapeDataString(appId)}/open",
            new Dictionary<string, string?> { ["installationId"] = installation, ["endpoint"] = endpoint, ["route"] = route });
}

internal static class UiSurfaceRoutes
{
    public static bool Valid(string? route)
    {
        if (route is not { Length: > 0 and <= 8192 } || !route.StartsWith('/') || route.StartsWith("//", StringComparison.Ordinal)
            || route.Contains('\\') || route.Any(char.IsControl)) return false;
        var path = route.Split('?', '#')[0];
        for (var i = 0; i < path.Length; i++)
        {
            if (path[i] != '%') continue;
            if (i + 2 >= path.Length || !Uri.IsHexDigit(path[i + 1]) || !Uri.IsHexDigit(path[i + 2])) return false;
            var escaped = path.Substring(i + 1, 2);
            if (escaped.Equals("2f", StringComparison.OrdinalIgnoreCase) || escaped.Equals("5c", StringComparison.OrdinalIgnoreCase) || escaped == "25") return false;
            i += 2;
        }
        return !Uri.UnescapeDataString(path).Split('/').Any(p => p is "." or "..");
    }

    public static bool Within(string? route, string declared)
    {
        if (!Valid(route) || !Valid(declared)) return false;
        var root = new Uri("https://surface.invalid" + declared).AbsolutePath.TrimEnd('/');
        var path = new Uri("https://surface.invalid" + route).AbsolutePath;
        return root.Length == 0 || path == root || path.StartsWith(root + "/", StringComparison.Ordinal);
    }
}

internal static class UiPanelEndpoints
{
    public static void Map(WebApplication app)
    {
        const string root = "/api/internal/apps/{appId}/ui";
        app.MapPost(root + "/activity", async (string appId, ToolActivityReport input, HttpContext context,
            ProviderAccessService access, ToolActivityService activity) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            try
            {
                var caller = await access.AuthenticateAsync(appId, context.Request, context.RequestAborted);
                return CoreJson.Json(await activity.ReportAsync(caller, input, context.RequestAborted));
            }
            catch (AppIdentityException ex)
            {
                var status = ex.Code == "installation_changed" ? 409 : ex.Code == "activity_capacity" ? 429
                    : ex.Code is "activity_invalid" or "destination_invalid" ? 400 : AuthEndpoints.MapIdentityErrorStatus(ex.Code);
                return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), status);
            }
        });
        app.MapGet(root + "/activity", async (string appId, HttpContext context,
            ProviderAccessService access, AppIdentityService identity, UiPanelService ui) =>
            await Handle(context, appId, access, identity, async (caller, userId) =>
                CoreJson.Json(await ui.ActivityAsync(caller, userId, context.RequestAborted))));
        app.MapGet(root + "/bootstrap", async (string appId, string? parentOrigin, HttpContext context,
            ProviderAccessService access, AppIdentityService identity, UiPanelService ui) =>
            await Handle(context, appId, access, identity, async (caller, userId) =>
                CoreJson.Json(await ui.BootstrapAsync(caller, userId, parentOrigin, context.RequestAborted))));
        app.MapGet(root + "/panels", async (string appId, HttpContext context,
            ProviderAccessService access, AppIdentityService identity, UiPanelService ui) =>
            await Handle(context, appId, access, identity, async (caller, userId) =>
                CoreJson.Json(await ui.ListAsync(caller, userId, context.RequestAborted))));
        app.MapGet(root + "/navigation", async (string appId, HttpContext context,
            ProviderAccessService access, AppIdentityService identity, UiPanelService ui) =>
            await Handle(context, appId, access, identity, async (caller, userId) =>
                CoreJson.Json(await ui.NavigationAsync(caller, userId, context.RequestAborted))));
        app.MapPost(root + "/navigation/resolve", async (string appId, UiNavigationTarget target, HttpContext context,
            ProviderAccessService access, AppIdentityService identity, UiPanelService ui) =>
            await Handle(context, appId, access, identity, async (caller, userId) =>
                CoreJson.Json(await ui.ResolveNavigationAsync(caller, userId, target, context.RequestAborted))));
        app.MapPost(root + "/panels/resolve", async (string appId, UiPanelTarget target, HttpContext context,
            ProviderAccessService access, AppIdentityService identity, UiPanelService ui) =>
            await Handle(context, appId, access, identity, async (caller, userId) =>
                CoreJson.Json(await ui.ResolveAsync(caller, userId, target, context.RequestAborted))));
    }

    private static async Task<IResult> Handle(HttpContext context, string appId, ProviderAccessService access,
        AppIdentityService identity, Func<AppRecord, string, Task<IResult>> action)
    {
        context.Response.Headers.CacheControl = "no-store";
        try
        {
            var caller = await access.AuthenticateAsync(appId, context.Request, context.RequestAborted);
            var actor = await identity.RevalidateAsync(context.Request.Headers["X-Hosty-User-Token"].ToString(), appId, context.RequestAborted);
            return await action(caller, actor.UserId);
        }
        catch (AppIdentityException ex)
        {
            var status = ex.Code is "destination_changed" or "installation_changed" ? 409
                : ex.Code == "destination_invalid" ? 400 : AuthEndpoints.MapIdentityErrorStatus(ex.Code);
            return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), status);
        }
    }
}
