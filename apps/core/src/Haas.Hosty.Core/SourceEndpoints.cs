namespace Haas.Hosty.Core;

internal static class SourceEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/control/v1/apps/{appId}/source", async (
            string appId,
            HttpRequest request,
            ControlSecret secret,
            AppSourceService sources,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleSourceError(() => sources.GetAsync(appId, cancellationToken))));

        app.MapPost("/control/v1/apps/{appId}/source/resolve", async (
            string appId,
            HttpRequest request,
            ControlSecret secret,
            AppSourceService sources,
            AppSourceResolveRequest input,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleSourceError(() => sources.ResolveManagedAsync(appId, input, cancellationToken))));

        app.MapPost("/control/v1/apps/{appId}/source/override", async (
            string appId,
            HttpRequest request,
            ControlSecret secret,
            AppSourceService sources,
            AppSourceOverrideRequest input,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleSourceError(() => sources.SetLocalOverrideAsync(appId, input, cancellationToken))));

        app.MapDelete("/control/v1/apps/{appId}/source/override", async (
            string appId,
            HttpRequest request,
            ControlSecret secret,
            AppSourceService sources,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleSourceError(() => sources.ClearLocalOverrideAsync(appId, cancellationToken))));

        app.MapGet("/control/v1/sources/cleanup/plan", async (
            HttpRequest request,
            ControlSecret secret,
            AppSourceService sources,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleSourceError(() => sources.CreateCleanupPlanAsync(cancellationToken))));

        app.MapPost("/control/v1/sources/cleanup", async (
            HttpRequest request,
            ControlSecret secret,
            AppSourceService sources,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleSourceError(() => sources.ApplyCleanupAsync(cancellationToken))));
    }

    private static async Task<IResult> HandleSourceError<T>(Func<Task<T>> action)
    {
        try
        {
            return Results.Json(await action());
        }
        catch (AppLifecycleException ex)
        {
            var statusCode = string.Equals(ex.Code, "app_not_found", StringComparison.Ordinal)
                ? StatusCodes.Status404NotFound
                : StatusCodes.Status400BadRequest;
            return Results.Json(new ErrorResponse(ex.Code, ex.Message), statusCode: statusCode);
        }
    }
}
