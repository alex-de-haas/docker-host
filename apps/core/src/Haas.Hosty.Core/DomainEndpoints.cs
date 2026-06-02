namespace Haas.Hosty.Core;

internal static class DomainEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/api/apps", async (AppRegistryStore store, CancellationToken cancellationToken) =>
            Results.Json(new AppsResponse(await store.ListAppsAsync(cancellationToken))));

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
}

internal sealed record AppsResponse(IReadOnlyList<AppSummary> Apps);

internal sealed record UsersResponse(
    IReadOnlyList<HostUserRecord> Users,
    IReadOnlyList<HostInvitationRecord> Invitations,
    IReadOnlyList<AppAssignmentRecord> Assignments,
    IReadOnlyList<AuthSessionRecord> Sessions);

internal sealed record AuditResponse(IReadOnlyList<AuditRecord> Events);
