using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

namespace Haas.Hosty.Core;

internal static class DomainEndpoints
{
    // Shape-only check for app-reported audit action names ("ai_session_created"); the "app."
    // prefix added at write time is what guarantees no collision with Core's own action vocabulary.
    private static readonly Regex AppAuditActionPattern = new("^[a-z][a-z0-9_]{0,62}$", RegexOptions.Compiled);

    public static void Map(WebApplication app)
    {
        app.MapGet("/api/apps", async (
            HttpRequest request,
            CoreLifecycleService lifecycle,
            AppUpdateSweepService updateSweep,
            UserDirectoryStore users,
            IClock clock,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireSessionAsync(
                request,
                users,
                clock,
                async user =>
                {
                    var state = await users.ReadAsync(cancellationToken);
                    var apps = await lifecycle.ListAppsAsync(cancellationToken);
                    // The sweep status block drives the "Check updates" spinner from server state,
                    // so a page opened mid-sweep (or after a reload) shows the check in progress.
                    return CoreJson.Json(new AppsResponse(FilterAppsForUser(apps, state, user), updateSweep.Status));
                },
                cancellationToken: cancellationToken));

        app.MapGet("/control/v1/apps", async (HttpRequest request, ControlSecret secret, CoreLifecycleService lifecycle, CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                CoreJson.Json(new AppsResponse(await lifecycle.ListAppsAsync(cancellationToken)))));

        // App-authenticated read of installed app ids. An app (e.g. Marketplace) calls this with its
        // own service token to learn which apps are already installed — enough to flag catalog entries
        // as installed — without holding a Core session. Returns ids only; the richer per-app state
        // stays session-gated on GET /api/apps. Any valid app service token is accepted.
        app.MapGet("/api/internal/apps/{appId}/installed-apps", async (
            string appId,
            HttpRequest request,
            AppServiceTokenService serviceTokens,
            AppRegistryStore apps,
            CoreLifecycleService lifecycle,
            CancellationToken cancellationToken) =>
        {
            var token = CoreSessionAuthorization.ReadBearerToken(request);
            if (string.IsNullOrWhiteSpace(token) || !serviceTokens.ValidateToken(appId, token))
            {
                return CoreJson.Json(
                    new ErrorResponse("installed_apps_unauthorized", "App service token is missing or invalid."),
                    statusCode: StatusCodes.Status401Unauthorized);
            }

            if (await apps.GetAppAsync(appId, cancellationToken) is null)
            {
                return CoreJson.Json(
                    new ErrorResponse("app_not_found", "Runtime app was not found."),
                    statusCode: StatusCodes.Status404NotFound);
            }

            var installed = await lifecycle.ListAppsAsync(cancellationToken);
            return CoreJson.Json(new InstalledAppsResponse(installed.Select(summary => summary.Id).ToArray()));
        });

        // App-authenticated read of the installed app roster (id → display name). A system app (e.g. the
        // Telemetry UI) calls this with its own service token to label its appId-keyed data (metrics /
        // logs / traces) with human-readable names — the display-name enrichment the removed telemetry
        // read proxy used to do. Any valid app service token is accepted; returns id + display name only,
        // so the richer per-app state on GET /api/apps stays session-gated.
        app.MapGet("/api/internal/apps/{appId}/app-directory", async (
            string appId,
            HttpRequest request,
            AppServiceTokenService serviceTokens,
            AppRegistryStore apps,
            CoreLifecycleService lifecycle,
            CancellationToken cancellationToken) =>
        {
            var token = CoreSessionAuthorization.ReadBearerToken(request);
            if (string.IsNullOrWhiteSpace(token) || !serviceTokens.ValidateToken(appId, token))
            {
                return CoreJson.Json(
                    new ErrorResponse("app_directory_unauthorized", "App service token is missing or invalid."),
                    statusCode: StatusCodes.Status401Unauthorized);
            }

            if (await apps.GetAppAsync(appId, cancellationToken) is null)
            {
                return CoreJson.Json(
                    new ErrorResponse("app_not_found", "Runtime app was not found."),
                    statusCode: StatusCodes.Status404NotFound);
            }

            var installed = await lifecycle.ListAppsAsync(cancellationToken);
            return CoreJson.Json(new AppDirectoryResponse(
                installed
                    .Select(summary => new AppDirectoryEntry(
                        summary.Id,
                        summary.DisplayName,
                        summary.RuntimeState,
                        (summary.Interfaces ?? new Dictionary<string, IReadOnlyList<AppInterfaceSummary>>())
                            .SelectMany(pair => pair.Value.Select(declaration =>
                                new AppDirectoryInterface(pair.Key, declaration.Key, declaration.Url)))
                            .ToArray()))
                    .ToArray()));
        });

        // App-reported audit events (docs/features/ai-gateway/plan.md): the AI gateway reports
        // assistant session lifecycle and approved actions here so they land in the same durable
        // audit log as Core's own records — lifecycle and approvals only, never transcript content.
        // Service-token auth scopes the report to the calling app, and the stored action is
        // namespaced with "app." plus the reported name so an app can never impersonate a Core
        // action. Details are capped so a misbehaving app cannot flood the log.
        app.MapPost("/api/internal/apps/{appId}/audit", async (
            string appId,
            HttpRequest request,
            AppServiceTokenService serviceTokens,
            AppRegistryStore apps,
            AuditStore audit,
            IClock clock,
            AppAuditReportRequest input,
            CancellationToken cancellationToken) =>
        {
            var token = CoreSessionAuthorization.ReadBearerToken(request);
            if (string.IsNullOrWhiteSpace(token) || !serviceTokens.ValidateToken(appId, token))
            {
                return CoreJson.Json(
                    new ErrorResponse("app_audit_unauthorized", "App service token is missing or invalid."),
                    statusCode: StatusCodes.Status401Unauthorized);
            }

            if (await apps.GetAppAsync(appId, cancellationToken) is null)
            {
                return CoreJson.Json(
                    new ErrorResponse("app_not_found", "Runtime app was not found."),
                    statusCode: StatusCodes.Status404NotFound);
            }

            if (string.IsNullOrWhiteSpace(input.Action) || !AppAuditActionPattern.IsMatch(input.Action))
            {
                return CoreJson.Json(
                    new ErrorResponse("app_audit_action_invalid", "action must match ^[a-z][a-z0-9_]{0,62}$."),
                    statusCode: StatusCodes.Status400BadRequest);
            }

            var details = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (var pair in (input.Details ?? new Dictionary<string, string>()).Take(16))
            {
                if (string.IsNullOrWhiteSpace(pair.Key))
                {
                    continue;
                }

                var key = pair.Key.Length <= 64 ? pair.Key : pair.Key[..64];
                var value = pair.Value ?? "";
                details[key] = value.Length <= 500 ? value : value[..500];
            }

            await audit.AppendAsync(
                new AuditRecord(
                    Id: Guid.NewGuid().ToString("N"),
                    Action: $"app.{input.Action}",
                    ResourceType: "app",
                    ResourceId: appId,
                    Outcome: "reported",
                    ActorUserId: null,
                    CreatedAt: clock.UtcNow,
                    Details: details),
                cancellationToken);
            return CoreJson.Json(new AppAuditReportResponse("recorded"));
        });

        // App-authenticated per-app update check. Marketplace calls this (with its own service token)
        // to show an "Update" affordance for an already-installed catalog app. Returns only whether an
        // update is available; the richer per-service status stays admin-session-gated on
        // GET /api/apps/{appId}/update-status. Any valid app service token is accepted.
        app.MapGet("/api/internal/apps/{appId}/installed-apps/{targetAppId}/update-status", async (
            string appId,
            string targetAppId,
            HttpRequest request,
            AppServiceTokenService serviceTokens,
            AppRegistryStore apps,
            CoreLifecycleService lifecycle,
            CancellationToken cancellationToken) =>
        {
            var token = CoreSessionAuthorization.ReadBearerToken(request);
            if (string.IsNullOrWhiteSpace(token) || !serviceTokens.ValidateToken(appId, token))
            {
                return CoreJson.Json(
                    new ErrorResponse("update_status_unauthorized", "App service token is missing or invalid."),
                    statusCode: StatusCodes.Status401Unauthorized);
            }

            if (await apps.GetAppAsync(appId, cancellationToken) is null)
            {
                return CoreJson.Json(
                    new ErrorResponse("app_not_found", "Runtime app was not found."),
                    statusCode: StatusCodes.Status404NotFound);
            }

            // The target isn't installed → nothing to update.
            if (await apps.GetAppAsync(targetAppId, cancellationToken) is null)
            {
                return CoreJson.Json(new AppUpdateAvailabilityResponse(targetAppId, Installed: false, UpdateAvailable: false));
            }

            try
            {
                var status = await lifecycle.GetUpdateStatusAsync(targetAppId, refresh: false, cancellationToken);
                return CoreJson.Json(new AppUpdateAvailabilityResponse(targetAppId, Installed: true, status.UpdateAvailable));
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // Availability can't be determined (no followed feed/source, unreadable manifest, etc.)
                // — report no update rather than failing; the reviewed update flow stays the source of
                // truth. Client cancellation still propagates.
                return CoreJson.Json(new AppUpdateAvailabilityResponse(targetAppId, Installed: true, UpdateAvailable: false));
            }
        });

        app.MapGet("/api/users", async (
            HttpRequest request,
            UserDirectoryStore store,
            IClock clock,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                store,
                clock,
                async () =>
                {
                    var state = await store.ReadAsync(cancellationToken);
                    return CoreJson.Json(BuildUsersResponse(state));
                },
                cancellationToken: cancellationToken));

        app.MapGet("/control/v1/users", async (HttpRequest request, ControlSecret secret, UserDirectoryStore store, CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
            {
                var state = await store.ReadAsync(cancellationToken);
                return CoreJson.Json(BuildUsersResponse(state));
            }));

        app.MapGet("/control/v1/audit/recent", async (HttpRequest request, ControlSecret secret, AuditStore store, CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                CoreJson.Json(new AuditResponse(await store.ReadRecentAsync(cancellationToken: cancellationToken)))));
    }

    private static IReadOnlyList<AppSummary> FilterAppsForUser(
        IReadOnlyList<AppSummary> apps,
        UserDirectoryState state,
        HostUserRecord user)
    {
        if (AppAccessPolicy.IsAdmin(user))
        {
            return apps;
        }

        return apps
            .Where(app => AppAccessPolicy.CanAccessApp(state, user, app.Id, app.System))
            .ToArray();
    }

    // Session ids ARE the bearer credential (they are compared directly to the hosty_session cookie), so
    // they must never leave Core. Expose only a non-reversible fingerprint plus lifecycle timestamps so
    // admin tooling can still count/age sessions without holding a token it could replay.
    private static UsersResponse BuildUsersResponse(UserDirectoryState state)
        => new(
            state.Users,
            state.Invitations,
            state.Assignments,
            state.Sessions.Select(ToSummary).ToArray());

    private static AuthSessionSummary ToSummary(AuthSessionRecord session)
        => new(
            CoreSessionAuthorization.FingerprintSessionId(session.Id),
            session.UserId,
            session.CreatedAt,
            session.ExpiresAt,
            session.RevokedAt);
}

internal sealed record AppsResponse(
    IReadOnlyList<AppSummary> Apps,
    // Fleet update-check status (plan-first updates). Null on surfaces that do not attach it (the
    // control-plane list); additive so older clients ignore it.
    AppUpdateCheckStatus? UpdateCheck = null);

internal sealed record InstalledAppsResponse(IReadOnlyList<string> AppIds);

// App-token roster: id → display name for every installed app. Consumed by system apps (e.g. the
// Telemetry UI) to label their appId-keyed data. A generic capability, not telemetry-specific.
internal sealed record AppDirectoryResponse(IReadOnlyList<AppDirectoryEntry> Apps);

internal sealed record AppDirectoryEntry(
    string Id,
    string DisplayName,
    string RuntimeState,
    IReadOnlyList<AppDirectoryInterface> Interfaces);

/// One declared platform interface, resolved to a ready-to-call URL from the app's endpoints.
internal sealed record AppDirectoryInterface(string Name, string Key, string? Url);

internal sealed record AppUpdateAvailabilityResponse(string AppId, bool Installed, bool UpdateAvailable);

internal sealed record UsersResponse(
    IReadOnlyList<HostUserRecord> Users,
    IReadOnlyList<HostInvitationRecord> Invitations,
    IReadOnlyList<AppAssignmentRecord> Assignments,
    IReadOnlyList<AuthSessionSummary> Sessions);

// A leak-safe projection of AuthSessionRecord: the id is a SHA-256 fingerprint, never the replayable token.
internal sealed record AuthSessionSummary(
    string Id,
    string UserId,
    DateTimeOffset CreatedAt,
    DateTimeOffset ExpiresAt,
    DateTimeOffset? RevokedAt);

internal sealed record AuditResponse(IReadOnlyList<AuditRecord> Events);

internal sealed record AppAuditReportRequest(string? Action, IReadOnlyDictionary<string, string>? Details);

internal sealed record AppAuditReportResponse(string Status);
