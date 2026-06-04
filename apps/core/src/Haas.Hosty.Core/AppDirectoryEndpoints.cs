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
            var token = ReadBearerToken(request);
            if (string.IsNullOrWhiteSpace(token) || !serviceTokens.ValidateToken(appId, token))
            {
                return Results.Json(
                    new ErrorResponse("app_directory_unauthorized", "App service token is missing or invalid."),
                    statusCode: StatusCodes.Status401Unauthorized);
            }

            if (await apps.GetAppAsync(appId, cancellationToken) is null)
            {
                return Results.Json(
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

            return Results.Json(new AppDirectoryUsersResponse(
                Users: directoryUsers,
                Pagination: new AppDirectoryPagination(100, 0, directoryUsers.Length),
                UpdatedAt: DateTimeOffset.UtcNow));
        });
    }

    private static string? ReadBearerToken(HttpRequest request)
    {
        if (!request.Headers.TryGetValue("Authorization", out var header))
        {
            return null;
        }

        var value = header.ToString();
        return value.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)
            ? value["Bearer ".Length..].Trim()
            : null;
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
