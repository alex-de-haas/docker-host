namespace Haas.Hosty.Core;

internal static class DomainEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/api/apps", async (
            HttpRequest request,
            AppRegistryStore store,
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
                    var apps = await store.ListAppsAsync(cancellationToken);
                    return Results.Json(new AppsResponse(FilterAppsForUser(apps, state, user)));
                },
                cancellationToken));

        app.MapGet("/control/v1/apps", async (HttpRequest request, ControlSecret secret, AppRegistryStore store, CancellationToken cancellationToken) =>
            HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                Results.Json(new AppsResponse(await store.ListAppsAsync(cancellationToken)))));

        app.MapGet("/api/users", async (UserDirectoryStore store, CancellationToken cancellationToken) =>
        {
            var state = await store.ReadAsync(cancellationToken);
            return Results.Json(new UsersResponse(state.Users, state.Invitations, state.Assignments, state.Sessions));
        });

        app.MapGet("/control/v1/users", async (HttpRequest request, ControlSecret secret, UserDirectoryStore store, CancellationToken cancellationToken) =>
            HostyCoreApplication.RequireControlSecret(request, secret, async () =>
            {
                var state = await store.ReadAsync(cancellationToken);
                return Results.Json(new UsersResponse(state.Users, state.Invitations, state.Assignments, state.Sessions));
            }));

        app.MapGet("/control/v1/audit/recent", async (HttpRequest request, ControlSecret secret, AuditStore store, CancellationToken cancellationToken) =>
            HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                Results.Json(new AuditResponse(await store.ReadRecentAsync(cancellationToken: cancellationToken)))));
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
}

internal sealed record AppsResponse(IReadOnlyList<AppSummary> Apps);

internal sealed record UsersResponse(
    IReadOnlyList<HostUserRecord> Users,
    IReadOnlyList<HostInvitationRecord> Invitations,
    IReadOnlyList<AppAssignmentRecord> Assignments,
    IReadOnlyList<AuthSessionRecord> Sessions);

internal sealed record AuditResponse(IReadOnlyList<AuditRecord> Events);
