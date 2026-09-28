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
            => CoreSessionAuthorization.RequireSessionAsync(request, users, clock, u => Handle(() => service.ProfileAsync(u.Id, ct)), cancellationToken: ct));
        group.MapPut("", (HttpRequest request, UserProfileUpdate input, UserDirectoryStore users, IClock clock, UserConnectionService service, CancellationToken ct)
            => CoreSessionAuthorization.RequireBrowserSessionAsync(request, users, clock, u => Handle(() => service.UpdateProfileAsync(u.Id, input.DisplayName, ct)), ct));
        group.MapPost("/connections/pat", (HttpRequest request, UserConnectionInput input, UserDirectoryStore users, IClock clock, UserConnectionService service, CancellationToken ct)
            => CoreSessionAuthorization.RequireBrowserSessionAsync(request, users, clock, u => Handle(() => service.AddPatAsync(u.Id, input, ct)), ct));
        group.MapPost("/connections/device", (HttpRequest request, UserConnectionInput input, UserDirectoryStore users, IClock clock, UserConnectionService service, CancellationToken ct)
            => CoreSessionAuthorization.RequireBrowserSessionAsync(request, users, clock, u => Handle(() => service.StartDeviceAsync(u.Id, CoreSessionAuthorization.ReadSessionId(request)!, input, ct)), ct));
        group.MapPost("/connections/device/{id}/poll", (string id, HttpRequest request, UserDirectoryStore users, IClock clock, UserConnectionService service, CancellationToken ct)
            => CoreSessionAuthorization.RequireBrowserSessionAsync(request, users, clock, u => Handle(() => service.PollAsync(u.Id, id, ct)), ct));
        group.MapDelete("/connections/device/{id}", (string id, HttpRequest request, UserDirectoryStore users, IClock clock, UserConnectionService service, CancellationToken ct)
            => CoreSessionAuthorization.RequireBrowserSessionAsync(request, users, clock, u => Handle(() => service.CancelAsync(u.Id, id, ct)), ct));
        group.MapPut("/connections/{id}", (string id, HttpRequest request, UserConnectionRename input, UserDirectoryStore users, IClock clock, UserConnectionService service, CancellationToken ct)
            => CoreSessionAuthorization.RequireBrowserSessionAsync(request, users, clock, u => Handle(() => service.RenameAsync(u.Id, id, input.Label, ct)), ct));
        group.MapPost("/connections/{id}/check", (string id, HttpRequest request, UserDirectoryStore users, IClock clock, UserConnectionService service, CancellationToken ct)
            => CoreSessionAuthorization.RequireBrowserSessionAsync(request, users, clock, u => Handle(() => service.CheckAsync(u.Id, id, ct)), ct));
        group.MapDelete("/connections/{id}", (string id, HttpRequest request, UserDirectoryStore users, IClock clock, UserConnectionService service, CancellationToken ct)
            => CoreSessionAuthorization.RequireBrowserSessionAsync(request, users, clock, u => Handle(() => service.DisconnectAsync(u.Id, id, ct)), ct));
    }
    private static async Task<IResult> Handle<T>(Func<Task<T>> action)
    {
        try { return CoreJson.Json(await action()); }
        catch (UserConnectionException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), ex.Status); }
    }
}
