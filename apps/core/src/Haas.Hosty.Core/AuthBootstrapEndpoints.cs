namespace Haas.Hosty.Core;

internal static class AuthBootstrapEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapPost("/control/v1/auth/setup-token", async (
            HttpRequest request,
            ControlSecret secret,
            AuthBootstrapService bootstrap,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleAuthBootstrapError(() => bootstrap.CreateSetupTokenAsync(cancellationToken))));

        app.MapPost("/control/v1/auth/recovery-token", async (
            HttpRequest request,
            ControlSecret secret,
            AuthBootstrapService bootstrap,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleAuthBootstrapError(() => bootstrap.CreateRecoveryTokenAsync(cancellationToken))));

        app.MapPost("/api/auth/bootstrap", async (
            HttpRequest request,
            HttpResponse response,
            AuthBootstrapRequest input,
            AuthBootstrapService bootstrap,
            UserDirectoryStore users,
            IClock clock,
            HostyCoreRuntimeConfig config,
            CancellationToken cancellationToken) =>
            await HandleAuthBootstrapError(async () =>
            {
                var user = await bootstrap.BootstrapAsync(input, cancellationToken);
                _ = await AuthEndpoints.CreateSessionAsync(user.Id, secureCookie: request.IsHttps, response, users, clock, cancellationToken);
                return new AuthBootstrapCompleteResponse(user, config.EffectiveShellPublicOrigin);
            }));

        app.MapPost("/api/auth/recovery", async (
            HttpRequest request,
            HttpResponse response,
            AuthRecoveryRequest input,
            AuthBootstrapService bootstrap,
            UserDirectoryStore users,
            IClock clock,
            HostyCoreRuntimeConfig config,
            CancellationToken cancellationToken) =>
            await HandleAuthBootstrapError(async () =>
            {
                var user = await bootstrap.RecoverAsync(input, cancellationToken);
                _ = await AuthEndpoints.CreateSessionAsync(user.Id, secureCookie: request.IsHttps, response, users, clock, cancellationToken);
                return new AuthRecoveryCompleteResponse(user, config.EffectiveShellPublicOrigin);
            }));
    }

    private static async Task<IResult> HandleAuthBootstrapError<T>(Func<Task<T>> action)
    {
        try
        {
            return Results.Json(await action());
        }
        catch (AuthBootstrapException ex)
        {
            return Results.Json(new ErrorResponse(ex.Code, ex.Message), statusCode: ex.StatusCode);
        }
        catch (LocalPasswordAuthException ex)
        {
            return Results.Json(new ErrorResponse(ex.Code, ex.Message), statusCode: ex.StatusCode);
        }
    }
}
