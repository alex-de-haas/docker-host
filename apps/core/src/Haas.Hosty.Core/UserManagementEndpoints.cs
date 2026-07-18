namespace Haas.Hosty.Core;

internal static class UserManagementEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/api/auth/users", async (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            UserManagementService management,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleUserManagementError(() => management.ListAsync(cancellationToken)),
                cancellationToken: cancellationToken));

        app.MapGet("/api/auth/invitations", async (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            UserManagementService management,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () =>
                {
                    var state = await management.ListAsync(cancellationToken);
                    return CoreJson.Json(new UserInvitationsResponse(state.Invitations));
                },
                cancellationToken: cancellationToken));

        app.MapPost("/api/auth/invitations", async (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            UserManagementService management,
            UserInvitationCreateRequest input,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await CoreSessionAuthorization.RequireSessionAsync(
                    request,
                    users,
                    clock,
                    async actor => await HandleUserManagementError(() => management.CreateInvitationAsync(input, actor, cancellationToken)),
                    cancellationToken: cancellationToken),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapDelete("/api/auth/invitations/{invitationId}", async (
            string invitationId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            UserManagementService management,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await CoreSessionAuthorization.RequireSessionAsync(
                    request,
                    users,
                    clock,
                    async actor => await HandleUserManagementError(() => management.RevokeInvitationAsync(invitationId, actor, cancellationToken)),
                    cancellationToken: cancellationToken),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapGet("/api/auth/invitations/accept", async (
            string setupToken,
            UserManagementService management,
            CancellationToken cancellationToken) =>
            await HandleUserManagementError(() => management.PreviewInvitationAsync(setupToken, cancellationToken)));

        app.MapPost("/api/auth/invitations/accept", async (
            HttpRequest request,
            HttpResponse response,
            UserManagementService management,
            UserDirectoryStore users,
            IClock clock,
            AuthLifetimes lifetimes,
            UserInvitationAcceptRequest input,
            CancellationToken cancellationToken) =>
            await HandleUserManagementError(async () =>
            {
                var user = await management.AcceptInvitationAsync(input, cancellationToken);
                _ = await AuthEndpoints.CreateSessionAsync(user.Id, secureCookie: request.IsHttps, response, users, clock, lifetimes, cancellationToken);
                return new UserInvitationAcceptResponse(user, user.Role == "host.admin" ? "/" : "/apps");
            }));

        app.MapPatch("/api/auth/users/{userId}", async (
            string userId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            UserManagementService management,
            HostUserUpdateRequest input,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await CoreSessionAuthorization.RequireSessionAsync(
                    request,
                    users,
                    clock,
                    async actor => await HandleUserManagementError(() => management.UpdateUserAsync(userId, input, actor, cancellationToken)),
                    cancellationToken: cancellationToken),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapDelete("/api/auth/users/{userId}", async (
            string userId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            UserManagementService management,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await CoreSessionAuthorization.RequireSessionAsync(
                    request,
                    users,
                    clock,
                    async actor => await HandleUserManagementError(() => management.DisableUserAsync(userId, actor, cancellationToken)),
                    cancellationToken: cancellationToken),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        // Hard delete of the stored record, distinct from the soft-disable DELETE above. The user must
        // already be disabled (the service enforces it), so deletion is always a deliberate second step.
        app.MapDelete("/api/auth/users/{userId}/record", async (
            string userId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            UserManagementService management,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await CoreSessionAuthorization.RequireSessionAsync(
                    request,
                    users,
                    clock,
                    async actor => await HandleUserManagementError(() => management.PurgeUserAsync(userId, actor, cancellationToken)),
                    cancellationToken: cancellationToken),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapPut("/api/auth/users/{userId}/assignments", async (
            string userId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            UserManagementService management,
            HostUserAssignmentsRequest input,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await CoreSessionAuthorization.RequireSessionAsync(
                    request,
                    users,
                    clock,
                    async actor => await HandleUserManagementError(() => management.ReplaceAssignmentsAsync(userId, input, actor, cancellationToken)),
                    cancellationToken: cancellationToken),
                requireCsrf: true,
                cancellationToken: cancellationToken));
    }

    private static async Task<IResult> HandleUserManagementError<T>(Func<Task<T>> action)
    {
        try
        {
            return CoreJson.Json(await action());
        }
        catch (UserManagementException ex)
        {
            return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), statusCode: ex.StatusCode);
        }
        catch (LocalPasswordAuthException ex)
        {
            return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), statusCode: ex.StatusCode);
        }
    }
}

internal sealed record UserInvitationsResponse(IReadOnlyList<UserInvitationSummary> Invitations);
