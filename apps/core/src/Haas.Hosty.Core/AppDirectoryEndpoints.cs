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
            var assignedUserIds = state.Assignments
                .Where(assignment => string.Equals(assignment.AppId, appId, StringComparison.Ordinal))
                .Select(assignment => assignment.UserId)
                .ToHashSet(StringComparer.Ordinal);
            var directoryUsers = state.Users
                .Where(user => !user.Disabled && assignedUserIds.Contains(user.Id))
                .OrderBy(user => user.Email ?? user.Id, StringComparer.OrdinalIgnoreCase)
                .Select(user => new AppDirectoryUser(
                    Id: user.Id,
                    DisplayName: user.DisplayName,
                    Email: user.Email,
                    HostRole: user.Role))
                .ToArray();

            return CoreJson.Json(new AppDirectoryUsersResponse(
                Users: directoryUsers,
                Pagination: new AppDirectoryPagination(100, 0, directoryUsers.Length),
                UpdatedAt: DateTimeOffset.UtcNow));
        });
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
