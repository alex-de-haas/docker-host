namespace Haas.Hosty.Core;

internal static class LifecycleEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapPost("/api/apps/install/plan", async (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreLifecycleService lifecycle,
            AppInstallPlanRequest input,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleLifecycleError(() => lifecycle.CreateInstallPlanAsync(input, cancellationToken)),
                cancellationToken: cancellationToken));

        app.MapPost("/api/apps/install", async (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreLifecycleService lifecycle,
            AppInstallRequest input,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleLifecycleError(() => lifecycle.InstallAsync(input, cancellationToken)),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapPost("/api/apps/{appId}/start", async (
            string appId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreLifecycleService lifecycle,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleLifecycleError(() => lifecycle.StartAsync(appId, cancellationToken)),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapPost("/api/apps/{appId}/stop", async (
            string appId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreLifecycleService lifecycle,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleLifecycleError(() => lifecycle.StopAsync(appId, cancellationToken)),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapPost("/api/apps/{appId}/restart", async (
            string appId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreLifecycleService lifecycle,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleLifecycleError(() => lifecycle.RestartAsync(appId, cancellationToken)),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapPost("/api/apps/{appId}/configure", async (
            string appId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreLifecycleService lifecycle,
            AppConfigureRequest input,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleLifecycleError(() => lifecycle.ConfigureAsync(appId, input, cancellationToken)),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapPost("/api/apps/{appId}/update/plan", async (
            string appId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreLifecycleService lifecycle,
            AppUpdatePlanRequest input,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleLifecycleError(() => lifecycle.CreateUpdatePlanAsync(appId, input, cancellationToken)),
                cancellationToken: cancellationToken));

        app.MapPost("/api/apps/{appId}/update", async (
            string appId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreLifecycleService lifecycle,
            AppUpdateApplyRequest input,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleLifecycleError(() => lifecycle.ApplyUpdateAsync(appId, input, cancellationToken)),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapPost("/api/apps/{appId}/remove", async (
            string appId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreLifecycleService lifecycle,
            AppRemoveRequest input,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleLifecycleError(() => lifecycle.RemoveAsync(appId, input, cancellationToken)),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapGet("/api/apps/{appId}/logs", async (
            string appId,
            int? tail,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreLifecycleService lifecycle,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleLifecycleError(() => lifecycle.GetLogsAsync(appId, tail ?? 200, cancellationToken)),
                cancellationToken: cancellationToken));

        app.MapGet("/api/apps/{appId}/health", async (
            string appId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreLifecycleService lifecycle,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleLifecycleError(() => lifecycle.GetHealthAsync(appId, cancellationToken)),
                cancellationToken: cancellationToken));

        app.MapGet("/api/apps/{appId}/backups", async (
            string appId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreLifecycleService lifecycle,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleLifecycleError(() => lifecycle.ListBackupsAsync(appId, cancellationToken)),
                cancellationToken: cancellationToken));

        app.MapGet("/api/apps/{appId}/backups/cleanup/plan", async (
            string appId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreLifecycleService lifecycle,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleLifecycleError(() => lifecycle.CreateBackupCleanupPlanAsync(appId, cancellationToken)),
                cancellationToken: cancellationToken));

        app.MapPost("/api/apps/{appId}/backups/cleanup", async (
            string appId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreLifecycleService lifecycle,
            AppBackupCleanupApplyRequest input,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleLifecycleError(() => lifecycle.ApplyBackupCleanupAsync(appId, input, cancellationToken)),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapPost("/api/apps/{appId}/backups", async (
            string appId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreLifecycleService lifecycle,
            AppManualBackupRequest input,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleLifecycleError(() => lifecycle.CreateManualBackupAsync(appId, input, cancellationToken)),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapPost("/api/apps/{appId}/backups/{backupId}/restore", async (
            string appId,
            string backupId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreLifecycleService lifecycle,
            AppRestoreBackupRequest input,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleLifecycleError(() => lifecycle.RestoreBackupAsync(appId, backupId, input, cancellationToken)),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapDelete("/api/apps/{appId}/backups/{backupId}", async (
            string appId,
            string backupId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreLifecycleService lifecycle,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleLifecycleError(() => lifecycle.DeleteBackupAsync(appId, backupId, cancellationToken)),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapPost("/control/v1/apps/install", async (
            HttpRequest request,
            ControlSecret secret,
            CoreLifecycleService lifecycle,
            AppInstallRequest input,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleLifecycleError(() => lifecycle.InstallAsync(input, cancellationToken))));

        app.MapPost("/control/v1/apps/{appId}/configure", async (
            string appId,
            HttpRequest request,
            ControlSecret secret,
            CoreLifecycleService lifecycle,
            AppConfigureRequest input,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleLifecycleError(() => lifecycle.ConfigureAsync(appId, input, cancellationToken))));

        app.MapPost("/control/v1/apps/{appId}/start", async (
            string appId,
            HttpRequest request,
            ControlSecret secret,
            CoreLifecycleService lifecycle,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleLifecycleError(() => lifecycle.StartAsync(appId, cancellationToken))));

        app.MapPost("/control/v1/apps/{appId}/stop", async (
            string appId,
            HttpRequest request,
            ControlSecret secret,
            CoreLifecycleService lifecycle,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleLifecycleError(() => lifecycle.StopAsync(appId, cancellationToken))));

        app.MapPost("/control/v1/apps/{appId}/restart", async (
            string appId,
            HttpRequest request,
            ControlSecret secret,
            CoreLifecycleService lifecycle,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleLifecycleError(() => lifecycle.RestartAsync(appId, cancellationToken))));

        app.MapPost("/control/v1/apps/{appId}/update/plan", async (
            string appId,
            HttpRequest request,
            ControlSecret secret,
            CoreLifecycleService lifecycle,
            AppUpdatePlanRequest input,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleLifecycleError(() => lifecycle.CreateUpdatePlanAsync(appId, input, cancellationToken))));

        app.MapPost("/control/v1/apps/{appId}/update", async (
            string appId,
            HttpRequest request,
            ControlSecret secret,
            CoreLifecycleService lifecycle,
            AppUpdateApplyRequest input,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleLifecycleError(() => lifecycle.ApplyUpdateAsync(appId, input, cancellationToken))));

        app.MapPost("/control/v1/apps/{appId}/switch-runtime/plan", async (
            string appId,
            HttpRequest request,
            ControlSecret secret,
            CoreLifecycleService lifecycle,
            AppRuntimeSwitchPlanRequest input,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleLifecycleError(() => lifecycle.CreateRuntimeSwitchPlanAsync(appId, input, cancellationToken))));

        app.MapPost("/control/v1/apps/{appId}/switch-runtime", async (
            string appId,
            HttpRequest request,
            ControlSecret secret,
            CoreLifecycleService lifecycle,
            AppRuntimeSwitchApplyRequest input,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleLifecycleError(() => lifecycle.ApplyRuntimeSwitchAsync(appId, input, cancellationToken))));

        app.MapGet("/control/v1/apps/{appId}/channels", async (
            string appId,
            string? channelsPath,
            HttpRequest request,
            ControlSecret secret,
            CoreLifecycleService lifecycle,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleLifecycleError(() => lifecycle.ListChannelsAsync(appId, new AppChannelsRequest(channelsPath), cancellationToken))));

        app.MapPost("/control/v1/apps/{appId}/switch-channel/plan", async (
            string appId,
            HttpRequest request,
            ControlSecret secret,
            CoreLifecycleService lifecycle,
            AppChannelSwitchPlanRequest input,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleLifecycleError(() => lifecycle.CreateChannelSwitchPlanAsync(appId, input, cancellationToken))));

        app.MapPost("/control/v1/apps/{appId}/switch-channel", async (
            string appId,
            HttpRequest request,
            ControlSecret secret,
            CoreLifecycleService lifecycle,
            AppChannelSwitchApplyRequest input,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleLifecycleError(() => lifecycle.ApplyChannelSwitchAsync(appId, input, cancellationToken))));

        app.MapPost("/control/v1/apps/{appId}/remove", async (
            string appId,
            HttpRequest request,
            ControlSecret secret,
            CoreLifecycleService lifecycle,
            AppRemoveRequest input,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleLifecycleError(() => lifecycle.RemoveAsync(appId, input, cancellationToken))));

        app.MapGet("/control/v1/apps/{appId}/backups", async (
            string appId,
            HttpRequest request,
            ControlSecret secret,
            CoreLifecycleService lifecycle,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleLifecycleError(() => lifecycle.ListBackupsAsync(appId, cancellationToken))));

        app.MapGet("/control/v1/apps/{appId}/backups/cleanup/plan", async (
            string appId,
            HttpRequest request,
            ControlSecret secret,
            CoreLifecycleService lifecycle,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleLifecycleError(() => lifecycle.CreateBackupCleanupPlanAsync(appId, cancellationToken))));

        app.MapPost("/control/v1/apps/{appId}/backups/cleanup", async (
            string appId,
            HttpRequest request,
            ControlSecret secret,
            CoreLifecycleService lifecycle,
            AppBackupCleanupApplyRequest input,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleLifecycleError(() => lifecycle.ApplyBackupCleanupAsync(appId, input, cancellationToken))));

        app.MapPost("/control/v1/apps/{appId}/backups", async (
            string appId,
            HttpRequest request,
            ControlSecret secret,
            CoreLifecycleService lifecycle,
            AppManualBackupRequest input,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleLifecycleError(() => lifecycle.CreateManualBackupAsync(appId, input, cancellationToken))));

        app.MapPost("/control/v1/apps/{appId}/backups/{backupId}/restore", async (
            string appId,
            string backupId,
            HttpRequest request,
            ControlSecret secret,
            CoreLifecycleService lifecycle,
            AppRestoreBackupRequest input,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleLifecycleError(() => lifecycle.RestoreBackupAsync(appId, backupId, input, cancellationToken))));

        app.MapDelete("/control/v1/apps/{appId}/backups/{backupId}", async (
            string appId,
            string backupId,
            HttpRequest request,
            ControlSecret secret,
            CoreLifecycleService lifecycle,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleLifecycleError(() => lifecycle.DeleteBackupAsync(appId, backupId, cancellationToken))));

        app.MapGet("/control/v1/apps/{appId}/logs", async (
            string appId,
            int? tail,
            HttpRequest request,
            ControlSecret secret,
            CoreLifecycleService lifecycle,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleLifecycleError(() => lifecycle.GetLogsAsync(appId, tail ?? 200, cancellationToken))));

        app.MapGet("/control/v1/apps/{appId}/health", async (
            string appId,
            HttpRequest request,
            ControlSecret secret,
            CoreLifecycleService lifecycle,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleLifecycleError(() => lifecycle.GetHealthAsync(appId, cancellationToken))));
    }

    private static async Task<IResult> HandleLifecycleError<T>(Func<Task<T>> action)
    {
        try
        {
            return Results.Json(await action());
        }
        catch (AppManifestException ex)
        {
            return Results.Json(
                new ManifestErrorResponse(ex.Code, ex.Message, ex.Errors),
                statusCode: StatusCodes.Status400BadRequest);
        }
        catch (AppLifecycleException ex)
        {
            var statusCode = string.Equals(ex.Code, "app_not_found", StringComparison.Ordinal)
                ? StatusCodes.Status404NotFound
                : StatusCodes.Status400BadRequest;
            return Results.Json(new ErrorResponse(ex.Code, ex.Message), statusCode: statusCode);
        }
        catch (InvalidOperationException ex)
        {
            return Results.Json(new ErrorResponse("lifecycle_operation_failed", ex.Message), statusCode: StatusCodes.Status400BadRequest);
        }
    }
}

internal sealed record ManifestErrorResponse(
    string Code,
    string Message,
    IReadOnlyList<AppManifestValidationError> Errors);
