namespace Haas.Hosty.Core;

internal static class StorageUsageEndpoints
{
    public static void Map(WebApplication app)
    {
        var routes = app.MapGroup("").AddEndpointFilter(async (context, next) =>
        {
            context.HttpContext.Response.Headers.CacheControl = "no-store";
            return await next(context);
        });
        routes.MapGet("/api/storage", async (HttpRequest request, UserDirectoryStore users, IClock clock,
            StorageUsageService storage, CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(request, users, clock,
                () => Task.FromResult(CoreJson.Json(storage.GetState())), cancellationToken: cancellationToken));

        routes.MapPost("/api/storage/refresh", async (HttpRequest request, UserDirectoryStore users, IClock clock,
            StorageUsageService storage, StorageRefreshRequest input, CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(request, users, clock, () =>
            {
                if (!Guid.TryParse(input.RequestId, out var requestId))
                    return Task.FromResult(CoreJson.Json(new ErrorResponse("storage_request_invalid",
                        "A UUID requestId is required. Reuse it after an uncertain response."), StatusCodes.Status400BadRequest));
                return Task.FromResult(CoreJson.Json(storage.Refresh(requestId), StatusCodes.Status202Accepted));
            }, requireCsrf: true, cancellationToken: cancellationToken));
    }
}
