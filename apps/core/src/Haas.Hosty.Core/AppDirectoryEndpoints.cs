namespace Haas.Hosty.Core;

internal static class AppDirectoryEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/api/internal/apps/{appId}/directory/users", async (
            string appId,
            HttpRequest request,
            AppServiceTokenService serviceTokens,
            AppRegistryStore apps,
            UserDirectoryStore users,
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

            var state = await users.ReadAsync(cancellationToken);
            var directoryUsers = BuildDirectoryUsers(state, appId);

            return CoreJson.Json(new AppDirectoryUsersResponse(
                Users: directoryUsers,
                Pagination: new AppDirectoryPagination(100, 0, directoryUsers.Length),
                UpdatedAt: DateTimeOffset.UtcNow));
        });
    }

    /// <summary>
    /// The enabled Host users an app may see: those explicitly assigned to the app plus every Host
    /// admin. Admins have implicit access to every app and are never stored as explicit assignments
    /// (UserManagementService forces an empty list for host.admin), so they must be added here too —
    /// otherwise this directory contradicts <see cref="AppIdentityService"/>'s access check, and apps
    /// that reconcile against the list (e.g. media-server's Jellyfin credentials) wrongly revoke
    /// admin access.
    /// </summary>
    internal static AppDirectoryUser[] BuildDirectoryUsers(UserDirectoryState state, string appId)
    {
        // Collections are non-null by contract, but this helper takes arbitrary state, and the
        // persisted document could be hand-edited or predate a field — guard against null.
        var assignedUserIds = (state.Assignments ?? [])
            .Where(assignment => string.Equals(assignment.AppId, appId, StringComparison.Ordinal))
            .Select(assignment => assignment.UserId)
            .ToHashSet(StringComparer.Ordinal);

        return (state.Users ?? [])
            .Where(user => !user.Disabled &&
                (string.Equals(user.Role, "host.admin", StringComparison.Ordinal) || assignedUserIds.Contains(user.Id)))
            .OrderBy(user => user.Email ?? user.Id, StringComparer.OrdinalIgnoreCase)
            .Select(user => new AppDirectoryUser(
                Id: user.Id,
                DisplayName: user.DisplayName,
                Email: user.Email,
                HostRole: user.Role))
            .ToArray();
    }
}

internal sealed record AppDirectoryUsersResponse(
    IReadOnlyList<AppDirectoryUser> Users,
    AppDirectoryPagination Pagination,
    DateTimeOffset UpdatedAt);

internal sealed record AppDirectoryPagination(int Limit, int Offset, int Total);

internal sealed record AppDirectoryUser(
    string Id,
    string? DisplayName,
    string? Email,
    string HostRole);
