namespace Haas.Hosty.Core;

internal static class LifecycleEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapPost("/api/apps/install/feed/plan", async (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreLifecycleService lifecycle,
            AppFeedInstallPlanRequest input,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleLifecycleError(() => lifecycle.CreateFeedInstallPlanAsync(input, cancellationToken)),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapPost("/api/apps/install/feed", async (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreLifecycleService lifecycle,
            AppFeedInstallApplyRequest input,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleLifecycleError(() => lifecycle.ApplyFeedInstallAsync(
                    input with { StartOnInstall = input.StartOnInstall ?? true },
                    cancellationToken)),
                requireCsrf: true,
                cancellationToken: cancellationToken));

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
                // Browser installs never mint system apps from a request flag: system-ness comes from
                // the reviewed manifest role, and the flag stays for internal bootstraps and the CLI.
                async () => await HandleLifecycleError(() => lifecycle.CreateInstallPlanAsync(input with { System = false }, cancellationToken)),
                requireCsrf: true,
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
                // Interactive installs start the app immediately unless the client opts out (StartOnInstall
                // false); an absent value defaults to true so autostart apps run without a Core restart.
                // System is coerced off for the same reason as the plan endpoint above.
                async () => await HandleLifecycleError(() => lifecycle.InstallAsync(input with
                {
                    StartOnInstall = input.StartOnInstall ?? true,
                    System = false,
                    FeedsUrl = null,
                    FeedId = null,
                }, cancellationToken)),
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

        app.MapPost("/api/apps/{appId}/mounts", async (
            string appId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreLifecycleService lifecycle,
            AppMountsRequest input,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleLifecycleError(() => lifecycle.ConfigureMountsAsync(appId, input, cancellationToken)),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        // Browser twins of the control-API source routes in SourceEndpoints.cs. Let the Shell change
        // an installed app's live source folder (set/clear the local override) with the same admin
        // session + CSRF guard the other mutating app endpoints use. GET reads current source state.
        app.MapGet("/api/apps/{appId}/source", async (
            string appId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            AppSourceService sources,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleLifecycleError(() => sources.GetAsync(appId, cancellationToken)),
                cancellationToken: cancellationToken));

        app.MapPost("/api/apps/{appId}/source/override", async (
            string appId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            AppSourceService sources,
            AppSourceOverrideRequest input,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleLifecycleError(() => sources.SetLocalOverrideAsync(appId, input, cancellationToken)),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapDelete("/api/apps/{appId}/source/override", async (
            string appId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            AppSourceService sources,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleLifecycleError(() => sources.ClearLocalOverrideAsync(appId, cancellationToken)),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapPost("/api/apps/{appId}/autostart", async (
            string appId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreLifecycleService lifecycle,
            AppAutostartRequest input,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleLifecycleError(() => lifecycle.ConfigureAutostartAsync(appId, input, cancellationToken)),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapGet("/api/apps/{appId}/feeds", async (
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
                async () => await HandleLifecycleError(() => lifecycle.GetFeedsAsync(appId, cancellationToken)),
                cancellationToken: cancellationToken));

        // Selects a feed from the installed app's generic app-owned feeds document; a blank id clears
        // the selection without changing the currently resolved manifest URL.
        app.MapPost("/api/apps/{appId}/feed", async (
            string appId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreLifecycleService lifecycle,
            AppFeedRequest input,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleLifecycleError(() => lifecycle.SetFeedAsync(appId, input, cancellationToken)),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapPost("/api/apps/{appId}/development-mode", async (
            string appId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreLifecycleService lifecycle,
            AppDevelopmentModeRequest input,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleLifecycleError(() => lifecycle.ConfigureDevelopmentModeAsync(appId, input, cancellationToken)),
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
                requireCsrf: true,
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

        app.MapPost("/api/apps/{appId}/switch-runtime/plan", async (
            string appId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreLifecycleService lifecycle,
            AppRuntimeSwitchPlanRequest input,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleLifecycleError(() => lifecycle.CreateRuntimeSwitchPlanAsync(appId, input, cancellationToken)),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapPost("/api/apps/{appId}/switch-runtime", async (
            string appId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreLifecycleService lifecycle,
            AppRuntimeSwitchApplyRequest input,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleLifecycleError(() => lifecycle.ApplyRuntimeSwitchAsync(appId, input, cancellationToken)),
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
                // Browser surface: system apps stay non-removable here (the CLI control plane keeps
                // removal for operator recovery) — Shell hiding the button is not the boundary.
                async () => await HandleLifecycleError(() => lifecycle.RemoveAsync(appId, input, cancellationToken: cancellationToken)),
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

        // Phase 2 producer endpoint: host-collected `docker stats` infra metrics as Prometheus text for
        // the telemetry backend to scrape (its second metrics target). Deliberately unauthenticated —
        // it exposes only container cpu/mem on the trusted internal network, mirroring the collector's
        // own unauthenticated scrape surface. Only mapped when observability is enabled (the only mode
        // the backend scrapes it in), so a non-observability install exposes nothing here.
        // See docs/features/observability-phase-2-backend.md.
        if (app.Services.GetRequiredService<HostyCoreRuntimeConfig>().ObservabilityEnabled)
        {
            app.MapGet("/internal/telemetry/metrics", (DockerStatsExposition exposition)
                => Results.Text(exposition.CurrentPrometheusText, "text/plain; version=0.0.4"));
        }

        app.MapGet("/api/apps/{appId}/update-status", async (
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
                async () => await HandleLifecycleError(() => lifecycle.GetUpdateStatusAsync(appId, cancellationToken)),
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
                // Interactive installs start the app immediately unless the client opts out; an absent
                // value defaults to true so autostart apps run without a Core restart.
                await HandleLifecycleError(() => lifecycle.InstallAsync(input with
                {
                    StartOnInstall = input.StartOnInstall ?? true,
                    FeedsUrl = null,
                    FeedId = null,
                }, cancellationToken))));

        app.MapPost("/control/v1/apps/{appId}/configure", async (
            string appId,
            HttpRequest request,
            ControlSecret secret,
            CoreLifecycleService lifecycle,
            AppConfigureRequest input,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleLifecycleError(() => lifecycle.ConfigureAsync(appId, input, cancellationToken))));

        app.MapPost("/control/v1/apps/{appId}/mounts", async (
            string appId,
            HttpRequest request,
            ControlSecret secret,
            CoreLifecycleService lifecycle,
            AppMountsRequest input,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleLifecycleError(() => lifecycle.ConfigureMountsAsync(appId, input, cancellationToken))));

        app.MapPost("/control/v1/apps/{appId}/autostart", async (
            string appId,
            HttpRequest request,
            ControlSecret secret,
            CoreLifecycleService lifecycle,
            AppAutostartRequest input,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleLifecycleError(() => lifecycle.ConfigureAutostartAsync(appId, input, cancellationToken))));

        app.MapPost("/control/v1/apps/{appId}/feed", async (
            string appId,
            HttpRequest request,
            ControlSecret secret,
            CoreLifecycleService lifecycle,
            AppFeedRequest input,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleLifecycleError(() => lifecycle.SetFeedAsync(appId, input, cancellationToken))));

        app.MapPost("/control/v1/apps/{appId}/development-mode", async (
            string appId,
            HttpRequest request,
            ControlSecret secret,
            CoreLifecycleService lifecycle,
            AppDevelopmentModeRequest input,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleLifecycleError(() => lifecycle.ConfigureDevelopmentModeAsync(appId, input, cancellationToken))));

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

        app.MapPost("/control/v1/apps/{appId}/remove", async (
            string appId,
            HttpRequest request,
            ControlSecret secret,
            CoreLifecycleService lifecycle,
            AppRemoveRequest input,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleLifecycleError(() => lifecycle.RemoveAsync(appId, input, allowSystemRemoval: true, cancellationToken))));

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
            return CoreJson.Json(await action());
        }
        catch (AppManifestException ex)
        {
            return CoreJson.Json(
                new ManifestErrorResponse(ex.Code, ex.Message, ex.Errors),
                statusCode: StatusCodes.Status400BadRequest);
        }
        catch (AppLifecycleException ex)
        {
            var statusCode = string.Equals(ex.Code, "app_not_found", StringComparison.Ordinal)
                ? StatusCodes.Status404NotFound
                : StatusCodes.Status400BadRequest;
            return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), statusCode: statusCode);
        }
        catch (InvalidOperationException ex)
        {
            return CoreJson.Json(new ErrorResponse("lifecycle_operation_failed", ex.Message), statusCode: StatusCodes.Status400BadRequest);
        }
    }
}

internal sealed record ManifestErrorResponse(
    string Code,
    string Message,
    IReadOnlyList<AppManifestValidationError> Errors);
