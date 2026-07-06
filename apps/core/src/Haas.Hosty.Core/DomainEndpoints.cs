using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

internal static class DomainEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/api/apps", async (
            HttpRequest request,
            CoreLifecycleService lifecycle,
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
                    return CoreJson.Json(new AppsResponse(FilterAppsForUser(apps, state, user)));
                },
                cancellationToken: cancellationToken));

        app.MapGet("/control/v1/apps", async (HttpRequest request, ControlSecret secret, CoreLifecycleService lifecycle, CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                CoreJson.Json(new AppsResponse(await lifecycle.ListAppsAsync(cancellationToken)))));

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
        if (string.Equals(user.Role, "host.admin", StringComparison.Ordinal))
        {
            return apps;
        }

        return apps
            .Where(app => !app.System && IsUserAssignedToAppOrUnrestricted(state, user, app.Id))
            .ToArray();
    }

    private static bool IsUserAssignedToAppOrUnrestricted(UserDirectoryState state, HostUserRecord user, string appId)
    {
        var appAssignments = state.Assignments.Where(assignment => string.Equals(assignment.AppId, appId, StringComparison.Ordinal)).ToArray();
        return appAssignments.Length == 0 ||
            appAssignments.Any(assignment => string.Equals(assignment.UserId, user.Id, StringComparison.Ordinal));
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
            FingerprintSessionId(session.Id),
            session.UserId,
            session.CreatedAt,
            session.ExpiresAt,
            session.RevokedAt);

    private static string FingerprintSessionId(string id)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(id)))[..12].ToLowerInvariant();
}

internal sealed record AppsResponse(IReadOnlyList<AppSummary> Apps);

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
