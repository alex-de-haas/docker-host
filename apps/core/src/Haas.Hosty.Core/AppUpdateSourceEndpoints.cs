namespace Haas.Hosty.Core;

internal static class AppUpdateSourceEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/api/apps/update-source/suggestions", (HttpRequest request, UserDirectoryStore users, IClock clock,
            CoreLifecycleService lifecycle, CancellationToken ct) => CoreSessionAuthorization.RequireAdminSessionAsync(request, users, clock,
                () => Run(() => lifecycle.GetUpdateSourceSuggestionsAsync(ct)), cancellationToken: ct));
        app.MapPost("/api/apps/{appId}/update-source/plan", (string appId, AppUpdateSourcePlanRequest input, HttpRequest request,
            UserDirectoryStore users, IClock clock, CoreLifecycleService lifecycle, CancellationToken ct) =>
            CoreSessionAuthorization.RequireAdminSessionAsync(request, users, clock, () => Run(() => lifecycle.PlanUpdateSourceAsync(appId, input, ct)), requireCsrf: true, cancellationToken: ct));
        app.MapPost("/api/apps/{appId}/update-source/apply", (string appId, AppUpdateSourceApplyRequest input, HttpRequest request,
            UserDirectoryStore users, IClock clock, CoreLifecycleService lifecycle, CancellationToken ct) =>
            CoreSessionAuthorization.RequireAdminSessionAsync(request, users, clock, () => Run( () => lifecycle.ApplyUpdateSourceAsync(appId, input, ct)), requireCsrf: true, cancellationToken: ct));
        app.MapGet("/api/apps/{appId}/update-source/operations/{requestId}", (string appId, string requestId, HttpRequest request,
            UserDirectoryStore users, IClock clock, CoreLifecycleService lifecycle, CancellationToken ct) =>
            CoreSessionAuthorization.RequireAdminSessionAsync(request, users, clock, () => Run(() => Task.FromResult(lifecycle.GetUpdateSourceOperation(appId, requestId))), cancellationToken: ct));
        app.MapPost("/api/apps/update-source/apply", (AppUpdateSourceBatchRequest input, HttpRequest request,
            UserDirectoryStore users, IClock clock, CoreLifecycleService lifecycle, CancellationToken ct) =>
            CoreSessionAuthorization.RequireAdminSessionAsync(request, users, clock, () => Run( () => lifecycle.ApplyUpdateSourceBatchAsync(input, ct)), requireCsrf: true, cancellationToken: ct));

        app.MapGet("/control/v1/apps/update-source/suggestions", (HttpRequest request, ControlSecret secret, CoreLifecycleService lifecycle, CancellationToken ct) =>
            HostyCoreApplication.RequireControlSecret(request, secret, () => Run(() => lifecycle.GetUpdateSourceSuggestionsAsync(ct))));
        app.MapPost("/control/v1/apps/{appId}/update-source/plan", (string appId, AppUpdateSourcePlanRequest input, HttpRequest request, ControlSecret secret, CoreLifecycleService lifecycle, CancellationToken ct) =>
            HostyCoreApplication.RequireControlSecret(request, secret, () => Run(() => lifecycle.PlanUpdateSourceAsync(appId, input, ct))));
        app.MapPost("/control/v1/apps/{appId}/update-source/apply", (string appId, AppUpdateSourceApplyRequest input, HttpRequest request, ControlSecret secret, CoreLifecycleService lifecycle, CancellationToken ct) =>
            HostyCoreApplication.RequireControlSecret(request, secret, () => Run(() => lifecycle.ApplyUpdateSourceAsync(appId, input, ct))));
        app.MapGet("/control/v1/apps/{appId}/update-source/operations/{requestId}", (string appId, string requestId, HttpRequest request, ControlSecret secret, CoreLifecycleService lifecycle) =>
            HostyCoreApplication.RequireControlSecret(request, secret, () => Run(() => Task.FromResult(lifecycle.GetUpdateSourceOperation(appId, requestId)))));
        app.MapPost("/control/v1/apps/update-source/apply", (AppUpdateSourceBatchRequest input, HttpRequest request, ControlSecret secret, CoreLifecycleService lifecycle, CancellationToken ct) =>
            HostyCoreApplication.RequireControlSecret(request, secret, () => Run(() => lifecycle.ApplyUpdateSourceBatchAsync(input, ct))));
    }

    private static async Task<IResult> Run<T>(Func<Task<T>> action)
    {
        try { return CoreJson.Json(await action()); }
        catch (AppLifecycleException error) { return CoreJson.Json(new ErrorResponse(error.Code, error.Message), 409); }
        catch (Haas.Hosty.Releases.PlatformReleaseException error) { return CoreJson.Json(new ErrorResponse(error.Code, error.Message), 400); }
        catch (AppManifestException error) { return CoreJson.Json(new ErrorResponse(error.Code, error.Message), 400); }
    }
}
