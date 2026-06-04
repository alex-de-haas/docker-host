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
                _ = await AuthEndpoints.CreateSessionAsync(user.Id, secureCookie: false, response, users, clock, cancellationToken);
                return new AuthBootstrapCompleteResponse(user, config.ShellPublicOrigin ?? "/");
            }));

        app.MapPost("/api/auth/recovery", async (
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
                _ = await AuthEndpoints.CreateSessionAsync(user.Id, secureCookie: false, response, users, clock, cancellationToken);
                return new AuthRecoveryCompleteResponse(user, config.ShellPublicOrigin ?? "/");
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
    }
}
