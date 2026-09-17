namespace Haas.Hosty.Core;

internal static class SourceWorktreeEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/api/apps/{appId}/source/status", async (
            string appId,
            HttpRequest request,
            HttpResponse response,
            UserDirectoryStore users, IClock clock,
            AppSourceService sources,
            CancellationToken cancellationToken) =>
        {
            response.Headers.CacheControl = "no-store";
            return await CoreSessionAuthorization.RequireAdminSessionAsync(request, users, clock,
                async () => await Handle(() => sources.GetWorktreeStatusAsync(appId, cancellationToken)),
                requireCsrf: false, cancellationToken: cancellationToken);
        });

        app.MapGet("/control/v1/apps/{appId}/source/status", async (
            string appId,
            HttpRequest request,
            HttpResponse response,
            ControlSecret secret,
            AppSourceService sources,
            CancellationToken cancellationToken) =>
        {
            response.Headers.CacheControl = "no-store";
            return await HostyCoreApplication.RequireControlSecret(request, secret,
                async () => await Handle(() => sources.GetWorktreeStatusAsync(appId, cancellationToken)));
        });

        app.MapPost("/api/apps/{appId}/source/diff", async (
            string appId,
            HttpRequest request,
            HttpResponse response,
            UserDirectoryStore users, IClock clock,
            AppSourceService sources,
            AppSourceDiffRequest input,
            CancellationToken cancellationToken) =>
        {
            response.Headers.CacheControl = "no-store";
            return await CoreSessionAuthorization.RequireAdminSessionAsync(request, users, clock,
                async () => await Handle(() => sources.GetWorktreeDiffAsync(appId, input, cancellationToken)),
                requireCsrf: true, cancellationToken: cancellationToken);
        });

        app.MapPost("/control/v1/apps/{appId}/source/diff", async (
            string appId,
            HttpRequest request,
            HttpResponse response,
            ControlSecret secret,
            AppSourceService sources,
            AppSourceDiffRequest input,
            CancellationToken cancellationToken) =>
        {
            response.Headers.CacheControl = "no-store";
            return await HostyCoreApplication.RequireControlSecret(request, secret,
                async () => await Handle(() => sources.GetWorktreeDiffAsync(appId, input, cancellationToken)));
        });

        app.MapPost("/api/apps/{appId}/source/discard/plan", async (
            string appId,
            HttpRequest request,
            HttpResponse response,
            UserDirectoryStore users, IClock clock,
            AppSourceService sources,
            AppSourceDiscardRequest input,
            CancellationToken cancellationToken) =>
        {
            response.Headers.CacheControl = "no-store";
            return await CoreSessionAuthorization.RequireAdminSessionAsync(request, users, clock,
                async () => await Handle(() => sources.PlanDiscardAsync(appId, input, cancellationToken)),
                requireCsrf: true, cancellationToken: cancellationToken);
        });

        app.MapPost("/control/v1/apps/{appId}/source/discard/plan", async (
            string appId,
            HttpRequest request,
            HttpResponse response,
            ControlSecret secret,
            AppSourceService sources,
            AppSourceDiscardRequest input,
            CancellationToken cancellationToken) =>
        {
            response.Headers.CacheControl = "no-store";
            return await HostyCoreApplication.RequireControlSecret(request, secret,
                async () => await Handle(() => sources.PlanDiscardAsync(appId, input, cancellationToken)));
        });

        app.MapPost("/api/apps/{appId}/source/discard", async (
            string appId,
            HttpRequest request,
            HttpResponse response,
            UserDirectoryStore users, IClock clock,
            CoreLifecycleService lifecycle,
            AppSourceDiscardApplyRequest input,
            CancellationToken cancellationToken) =>
        {
            response.Headers.CacheControl = "no-store";
            return await CoreSessionAuthorization.RequireAdminSessionAsync(request, users, clock,
                async () => await Handle(() => lifecycle.ApplySourceDiscardAsync(appId, input, cancellationToken)),
                requireCsrf: true, cancellationToken: cancellationToken);
        });

        app.MapPost("/control/v1/apps/{appId}/source/discard", async (
            string appId,
            HttpRequest request,
            HttpResponse response,
            ControlSecret secret,
            CoreLifecycleService lifecycle,
            AppSourceDiscardApplyRequest input,
            CancellationToken cancellationToken) =>
        {
            response.Headers.CacheControl = "no-store";
            return await HostyCoreApplication.RequireControlSecret(request, secret,
                async () => await Handle(() => lifecycle.ApplySourceDiscardAsync(appId, input, cancellationToken)));
        });

    }

    private static async Task<IResult> Handle<T>(Func<Task<T>> action)
    {
        try { return CoreJson.Json(await action()); }
        catch (AppLifecycleException ex)
        {
            var status = ex.Code == "app_not_found" ? 404 : ex.Code is "source_review_stale" or "source_review_expired" ? 409 : 400;
            return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), statusCode: status);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return CoreJson.Json(new ErrorResponse("source_io_failed", "Source access failed. Refresh status to inspect the result before retrying."), statusCode: 400);
        }
    }
}
