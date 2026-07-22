namespace Haas.Hosty.Core;

// App-callable keychain for runtime-acquired secrets (see AppSecretsStore and
// docs/planning/app-secrets-store.md). Service-token authenticated only — no session surface, no
// Shell/admin read path. The list route returns key names only; values are never enumerable, never
// logged, and only readable by the owning app's token.
internal static class AppSecretsEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/api/internal/apps/{appId}/secrets", async (
            string appId,
            HttpRequest request,
            AppServiceTokenService serviceTokens,
            AppSecretsStore secrets,
            CancellationToken cancellationToken) =>
        {
            if (Authorize(appId, request, serviceTokens) is { } unauthorized)
            {
                return unauthorized;
            }

            var result = await secrets.ListKeysAsync(appId, cancellationToken);
            return result.Status == AppSecretsStatus.AppNotFound
                ? AppNotFound()
                : CoreJson.Json(new AppSecretKeysResponse(result.Keys));
        });

        app.MapGet("/api/internal/apps/{appId}/secrets/{key}", async (
            string appId,
            string key,
            HttpRequest request,
            AppServiceTokenService serviceTokens,
            AppSecretsStore secrets,
            CancellationToken cancellationToken) =>
        {
            if (Authorize(appId, request, serviceTokens) is { } unauthorized)
            {
                return unauthorized;
            }

            if (ValidateKey(key) is { } invalid)
            {
                return CoreJson.Json(invalid, statusCode: StatusCodes.Status400BadRequest);
            }

            var result = await secrets.GetAsync(appId, key, cancellationToken);
            return result.Status switch
            {
                AppSecretsStatus.AppNotFound => AppNotFound(),
                // An absent key is an expected state (e.g. reconnect-required), not an error path.
                AppSecretsStatus.KeyNotFound => CoreJson.Json(
                    new ErrorResponse("app_secret_not_found", "No secret is stored under this key."),
                    statusCode: StatusCodes.Status404NotFound),
                _ => CoreJson.Json(new AppSecretValueResponse(result.Value!)),
            };
        });

        app.MapPut("/api/internal/apps/{appId}/secrets/{key}", async (
            string appId,
            string key,
            HttpRequest request,
            AppSecretWriteRequest? input,
            AppServiceTokenService serviceTokens,
            AppSecretsStore secrets,
            CancellationToken cancellationToken) =>
        {
            if (Authorize(appId, request, serviceTokens) is { } unauthorized)
            {
                return unauthorized;
            }

            if (ValidateWrite(key, input?.Value) is { } invalid)
            {
                return CoreJson.Json(invalid, statusCode: StatusCodes.Status400BadRequest);
            }

            return await secrets.SetAsync(appId, key, input!.Value!, cancellationToken) switch
            {
                AppSecretsStatus.AppNotFound => AppNotFound(),
                AppSecretsStatus.TooManyKeys => CoreJson.Json(
                    new ErrorResponse(
                        "app_secret_limit_exceeded",
                        $"An app can store at most {AppSecretsStore.MaxKeysPerApp} secrets."),
                    statusCode: StatusCodes.Status400BadRequest),
                // Unreachable via this route (ValidateWrite ran above); mapped so the store's own
                // bounds can never surface as a misleading success.
                AppSecretsStatus.KeyInvalid => CoreJson.Json(
                    ValidateKey(key)!, statusCode: StatusCodes.Status400BadRequest),
                AppSecretsStatus.ValueInvalid => CoreJson.Json(
                    ValidateWrite(key, input.Value)!, statusCode: StatusCodes.Status400BadRequest),
                _ => Results.NoContent(),
            };
        });

        app.MapDelete("/api/internal/apps/{appId}/secrets/{key}", async (
            string appId,
            string key,
            HttpRequest request,
            AppServiceTokenService serviceTokens,
            AppSecretsStore secrets,
            CancellationToken cancellationToken) =>
        {
            if (Authorize(appId, request, serviceTokens) is { } unauthorized)
            {
                return unauthorized;
            }

            if (ValidateKey(key) is { } invalid)
            {
                return CoreJson.Json(invalid, statusCode: StatusCodes.Status400BadRequest);
            }

            return await secrets.DeleteAsync(appId, key, cancellationToken) == AppSecretsStatus.AppNotFound
                ? AppNotFound()
                : Results.NoContent();
        });
    }

    // The store re-checks app existence under the shared per-app lock (the removal fence), so the
    // usual GetAppAsync prologue would only duplicate that read — the 404 comes from the store.
    private static IResult? Authorize(string appId, HttpRequest request, AppServiceTokenService serviceTokens)
    {
        var token = CoreSessionAuthorization.ReadBearerToken(request);
        if (string.IsNullOrWhiteSpace(token) || !serviceTokens.ValidateToken(appId, token))
        {
            return CoreJson.Json(
                new ErrorResponse("app_secrets_unauthorized", "App service token is missing or invalid."),
                statusCode: StatusCodes.Status401Unauthorized);
        }

        return null;
    }

    internal static ErrorResponse? ValidateKey(string? key)
        => AppSecretsStore.IsValidKey(key)
            ? null
            : new ErrorResponse(
                "app_secret_key_invalid",
                "Secret keys must match ^[a-z0-9][a-z0-9._-]{0,127}$.");

    internal static ErrorResponse? ValidateWrite(string? key, string? value)
    {
        if (ValidateKey(key) is { } invalidKey)
        {
            return invalidKey;
        }

        return AppSecretsStore.IsValidValue(value)
            ? null
            : new ErrorResponse(
                "app_secret_value_invalid",
                $"Secret values must be non-empty UTF-8 strings of at most {AppSecretsStore.MaxValueBytes} bytes.");
    }

    private static IResult AppNotFound()
        => CoreJson.Json(
            new ErrorResponse("app_not_found", "Runtime app was not found."),
            statusCode: StatusCodes.Status404NotFound);
}

internal sealed record AppSecretKeysResponse(IReadOnlyList<string> Keys);

internal sealed record AppSecretValueResponse(string Value);

internal sealed record AppSecretWriteRequest(string? Value);
