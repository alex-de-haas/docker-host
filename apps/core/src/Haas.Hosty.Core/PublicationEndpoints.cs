namespace Haas.Hosty.Core;

internal static class PublicationEndpoints
{
    public static void Map(WebApplication app)
    {
        const string root = "/api/internal/apps/{appId}/sessions/{sessionId}/publications";
        var routes = app.MapGroup("").AddEndpointFilter(async (context, next) =>
        {
            context.HttpContext.Response.Headers.CacheControl = "no-store";
            return await next(context);
        });
        routes.MapGet(root, async (string appId, string sessionId, HttpRequest request, WorkspaceAuthorization auth, PublicationService service, CancellationToken ct)
            => await Handle(async () => await service.ListAsync(await auth.RequireAsync(request, appId, sessionId, ct), ct)));
        routes.MapGet(root + "/connections", async (string appId, string sessionId, HttpRequest request, WorkspaceAuthorization auth, PublicationService service, CancellationToken ct)
            => await Handle(async () => await service.ConnectionsAsync(await auth.RequireAsync(request, appId, sessionId, ct), ct)));
        routes.MapGet(root + "/{id}", async (string appId, string sessionId, string id, HttpRequest request, WorkspaceAuthorization auth, PublicationService service, CancellationToken ct)
            => await Handle(async () =>
            {
                var owner = await auth.RequireAsync(request, appId, sessionId, ct);
                await service.RequireOwner(owner, ct);
                return await service.ObserveAsync(id, owner, ct);
            }));
        routes.MapPost(root + "/{id}/{kind}", async (string appId, string sessionId, string id, string kind, PublicationCommand input,
            HttpRequest request, WorkspaceAuthorization auth, PublicationService service, CancellationToken ct)
            => await Handle(async () => await service.CommandAsync(id, await auth.RequireAsync(request, appId, sessionId, ct), kind, input, ct)));
    }
    private static async Task<IResult> Handle<T>(Func<Task<T>> action)
    {
        try { return CoreJson.Json(await action()); }
        catch (AppIdentityException e) { return CoreJson.Json(new ErrorResponse(e.Code, e.Message), e.Code == "token_invalid" ? 401 : 403); }
        catch (PublicationException e) { return CoreJson.Json(new ErrorResponse(e.Code, e.Message), e.Code == "publication_forbidden" ? 403 : 409); }
        catch (UserConnectionException e) { return CoreJson.Json(new ErrorResponse(e.Code, e.Message), e.Status); }
        catch (AppLifecycleException e) { return CoreJson.Json(new ErrorResponse(e.Code, e.Message), 409); }
        catch (HttpRequestException) { return CoreJson.Json(new ErrorResponse("publication_unavailable", "Provider request failed. Recover with the same requestId."), 503); }
    }
}
