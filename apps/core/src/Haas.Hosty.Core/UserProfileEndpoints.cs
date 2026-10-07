namespace Haas.Hosty.Core;

internal static class UserProfileEndpoints
{
    public static void Map(WebApplication app)
    {
        var group = app.MapGroup("/api/profile").AddEndpointFilter(async (context, next) =>
        {
            context.HttpContext.Response.Headers.CacheControl = "no-store";
            return await next(context);
        });
        group.MapGet("", (HttpRequest request, UserDirectoryStore users, IClock clock, UserConnectionService service, CancellationToken ct)
            => CoreSessionAuthorization.RequireSessionAsync(request, users, clock, u => Handle(async () => BasicProfile(await service.ProfileAsync(u.Id, ct))), cancellationToken: ct));
        group.MapPut("", (HttpRequest request, UserProfileUpdate input, UserDirectoryStore users, IClock clock, UserConnectionService service, CancellationToken ct)
            => RequireProfileMutationAsync(request, users, clock, u => Handle(async () => BasicProfile(await service.UpdateProfileAsync(u.Id, input.DisplayName, ct))), ct));
        var sources = app.MapGroup("/api/source-connections").AddEndpointFilter(async (context, next) =>
        {
            context.HttpContext.Response.Headers.CacheControl = "no-store";
            return await next(context);
        });
        sources.MapGet("", (HttpRequest request, UserDirectoryStore users, IClock clock, UserConnectionService service, CancellationToken ct)
            => RequireSourceAsync(request, users, clock, u => Handle(async () => SourceProfile(await service.ProfileAsync(u.Id, ct))), ct));
        sources.MapPut("/identity", (HttpRequest request, SourceIdentityUpdate input, UserDirectoryStore users, IClock clock, UserConnectionService service, CancellationToken ct)
            => RequireSourceAsync(request, users, clock, u => Handle(async () => SourceProfile(await service.UpdateGitIdentityAsync(u.Id, input.GitIdentity, ct))), ct));
        sources.MapPost("/pat", (HttpRequest request, UserConnectionInput input, UserDirectoryStore users, IClock clock, UserConnectionService service, CancellationToken ct)
            => RequireSourceAsync(request, users, clock, u => Handle(() => service.AddPatAsync(u.Id, input, ct)), ct));
        sources.MapPost("/device", (HttpRequest request, UserConnectionInput input, UserDirectoryStore users, IClock clock, UserConnectionService service, AppIdentityService identities, CancellationToken ct)
            => RequireSourceAsync(request, users, clock, u => Handle(async () =>
            {
                var sessionId = AppManagementAuthorization.Caller(request) is { } caller
                    ? await identities.AuthorizingBrowserSessionAsync(request.Headers[AppManagementAuthorization.IdentityHeader].ToString(), caller.App.Id, ct)
                    : CoreSessionAuthorization.ReadSessionId(request);
                if (sessionId is null) throw new UserConnectionException("browser_session_required", "Sign in through Core before connecting a provider.", 403);
                return await service.StartDeviceAsync(u.Id, sessionId, input, ct);
            }), ct));
        sources.MapPost("/device/{id}/poll", (string id, HttpRequest request, UserDirectoryStore users, IClock clock, UserConnectionService service, CancellationToken ct)
            => RequireSourceAsync(request, users, clock, u => Handle(() => service.PollAsync(u.Id, id, ct)), ct));
        sources.MapDelete("/device/{id}", (string id, HttpRequest request, UserDirectoryStore users, IClock clock, UserConnectionService service, CancellationToken ct)
            => RequireSourceAsync(request, users, clock, u => Handle(() => service.CancelAsync(u.Id, id, ct)), ct));
        sources.MapPut("/{id}", (string id, HttpRequest request, UserConnectionRename input, UserDirectoryStore users, IClock clock, UserConnectionService service, CancellationToken ct)
            => RequireSourceAsync(request, users, clock, u => Handle(() => service.RenameAsync(u.Id, id, input.Label, ct)), ct));
        sources.MapPost("/{id}/check", (string id, HttpRequest request, UserDirectoryStore users, IClock clock, UserConnectionService service, CancellationToken ct)
            => RequireSourceAsync(request, users, clock, u => Handle(() => service.CheckAsync(u.Id, id, ct)), ct));
        sources.MapDelete("/{id}", (string id, HttpRequest request, UserDirectoryStore users, IClock clock, UserConnectionService service, CancellationToken ct)
            => RequireSourceAsync(request, users, clock, u => Handle(() => service.DisconnectAsync(u.Id, id, ct)), ct));
    }
    private static BasicUserProfile BasicProfile(UserProfileResponse profile) => new(profile.Id, profile.Email, profile.DisplayName);
    private static SourceConnectionsResponse SourceProfile(UserProfileResponse profile) => new(profile.Connections, profile.Providers, profile.GitIdentity);

    private static Task<IResult> RequireSourceAsync(HttpRequest request, UserDirectoryStore users,
        IClock clock, Func<HostUserRecord, Task<IResult>> action, CancellationToken ct)
    {
        Task<IResult> Admin(HostUserRecord user) => AppAccessPolicy.IsAdmin(user)
            ? action(user)
            : Task.FromResult<IResult>(CoreJson.Json(new ErrorResponse("admin_required", "Source connections require an administrator."), 403));
        // App callers have passed the source-selection or connection-management gate. Direct callers must be
        // operator sessions for reads and browser sessions with CSRF for writes. Neither path
        // accepts a user ID from the body.
        return AppManagementAuthorization.Caller(request) is { } caller
            ? Admin(caller.User)
            : HttpMethods.IsGet(request.Method)
                ? CoreSessionAuthorization.RequireSessionAsync(request, users, clock, Admin, cancellationToken: ct)
                : CoreSessionAuthorization.RequireBrowserSessionAsync(request, users, clock, Admin, ct);
    }

    private static Task<IResult> RequireProfileMutationAsync(HttpRequest request, UserDirectoryStore users,
        IClock clock, Func<HostUserRecord, Task<IResult>> action, CancellationToken ct)
        => AppManagementAuthorization.Caller(request) is { } caller
            ? action(caller.User)
            : CoreSessionAuthorization.RequireBrowserSessionAsync(request, users, clock, action, ct);

    private static async Task<IResult> Handle<T>(Func<Task<T>> action)
    {
        try { return CoreJson.Json(await action()); }
        catch (UserConnectionException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), ex.Status); }
        catch (AppIdentityException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), AuthEndpoints.MapIdentityErrorStatus(ex.Code)); }
    }
}
