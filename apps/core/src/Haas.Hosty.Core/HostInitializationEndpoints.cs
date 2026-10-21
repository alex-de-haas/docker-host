using Haas.Hosty.Initialization;
namespace Haas.Hosty.Core;

internal static class HostInitializationEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/control/v1/core/initialization", async (HttpRequest request, ControlSecret secret,
            HostInitializationService initialization, CancellationToken ct) =>
            await HostyCoreApplication.RequireControlSecret(request, secret,
                () => Handle(() => initialization.GetAsync(ct))));
        app.MapPost("/control/v1/core/initialization", async (HttpRequest request, ControlSecret secret,
            InitializationRequest input, HostInitializationService initialization, CancellationToken ct) =>
            await HostyCoreApplication.RequireControlSecret(request, secret,
                () => Handle(() => initialization.SubmitAsync(input, ct))));
        app.MapPost("/control/v1/core/initialization/setup-link", async (HttpRequest request, HttpResponse response,
            ControlSecret secret, HostInitializationService initialization, CancellationToken ct) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, () =>
            {
                response.Headers.CacheControl = "no-store";
                return Handle(() => initialization.SetupLinkAsync(ct));
            }));
    }
    private static async Task<IResult> Handle<T>(Func<Task<T>> action)
    {
        try { return CoreJson.Json(await action()); }
        catch (AppLifecycleException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), statusCode: 409); }
        catch (AuthBootstrapException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), statusCode: ex.StatusCode); }
    }
}
