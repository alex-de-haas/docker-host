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
                async () => await HandleLifecycleError(() =>
                {
                    RequireInstallPlanId(input);
                    return lifecycle.InstallAsync(input with
                    {
                        StartOnInstall = input.StartOnInstall ?? true,
                        System = false,
                        FeedsUrl = null,
                        FeedId = null,
                    }, cancellationToken);
                }),
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

        app.MapPost("/api/apps/{appId}/ports/reassign/plan", async (
            string appId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreLifecycleService lifecycle,
            ReassignPortPlanRequest input,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleLifecycleError(() => lifecycle.ReassignPortPlanAsync(appId, input.Service, input.PortKey, cancellationToken)),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        app.MapPost("/api/apps/{appId}/ports/reassign", async (
            string appId,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreLifecycleService lifecycle,
            ReassignPortRequest input,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleLifecycleError(() => lifecycle.ReassignPortAsync(appId, input, cancellationToken)),
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
        app.MapGet("/api/apps/{appId}/settings/{settingKey}/value", async (
            string appId,
            string settingKey,
            HttpRequest request,
            HttpResponse response,
            UserDirectoryStore users,
            IClock clock,
            CoreLifecycleService lifecycle,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () =>
                {
                    // Served on explicit demand only (the Shell's reveal click), never in the app
                    // summaries, and never cached: a secret in a shared cache outlives the click.
                    response.Headers.CacheControl = "no-store";
                    return await HandleLifecycleError(() => lifecycle.GetSettingValueAsync(appId, settingKey, cancellationToken));
                },
                cancellationToken: cancellationToken));

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

        // Fleet update check: starts a sweep (or joins the one already running) and returns
        // immediately — the sweep runs on the application lifetime token, so closing the tab never
        // aborts it. Progress is read from the `updateCheck` block on GET /api/apps.
        app.MapPost("/api/apps/update-check", async (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            AppUpdateSweepService updateSweep,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                () => Task.FromResult(CoreJson.Json(updateSweep.Trigger())),
                requireCsrf: true,
                cancellationToken: cancellationToken));

        // Read-only pending-plan view: what an earlier update check (or dialog open) cached for this
        // app, if still fresh. Lets clients apply or review without rebuilding the plan. No CSRF —
        // nothing is mutated.
        app.MapGet("/api/apps/{appId}/update/plan", async (
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
                async () => await HandleLifecycleError(() => lifecycle.GetPendingUpdatePlanAsync(appId, cancellationToken)),
                cancellationToken: cancellationToken));

        // Enqueue-and-return: validation errors (digest mismatch, stale base, already updating) come
        // back immediately; the apply itself runs detached on the application lifetime token so a
        // page reload never aborts it. Progress is the record's operationStatus ("updating"), the
        // outcome is the record flip plus a notification. The CLI control-plane twin below stays
        // synchronous. See docs/planning/plan-first-app-updates.md (phase 3).
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
                async () => await HandleLifecycleError(() => lifecycle.EnqueueUpdateAsync(appId, input, cancellationToken)),
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
        // the telemetry backend to scrape (its second metrics target). Always mapped: the exposition
        // itself idles (empty text) unless the telemetry app is installed, so a non-observability
        // install exposes nothing here and a live enable needs no Core restart.
        //
        // Requires an app service token like every other app->Core endpoint. It used to be
        // unauthenticated on the theory that scrape traffic stays on a trusted internal network — but
        // managed ingress publishes Core's whole origin (its rules are hostname->service, with no path
        // support), so "internal" was never a boundary and this leaked the installed-app inventory
        // plus per-service load to anyone who found the path. Any valid app token is accepted: the
        // exposition is host-wide, so there is no per-app scoping to enforce, and the token proves only
        // that the caller is an installed app. Living under /api/internal/ also puts it inside the
        // endpoint-authorization harness, which enumerates /api routes — the old /internal path sat in
        // its blind spot. See docs/features/observability-phase-2-backend.md.
        app.MapGet("/api/internal/telemetry/metrics", async (
            HttpRequest request,
            AppServiceTokenService serviceTokens,
            AppRegistryStore apps,
            DockerStatsExposition exposition,
            CancellationToken cancellationToken) =>
        {
            var token = CoreSessionAuthorization.ReadBearerToken(request);
            var callerAppId = string.IsNullOrWhiteSpace(token) ? null : serviceTokens.ResolveAppId(token);
            // The signature alone is not enough: it is HMAC over the app id with a durable key, so a
            // token copied before the app was removed verifies forever. Requiring the app to still be
            // installed matches every other app-token route and bounds a leaked token to the lifetime
            // of its installation.
            if (callerAppId is null || await apps.GetAppAsync(callerAppId, cancellationToken) is null)
            {
                return CoreJson.Json(
                    new ErrorResponse("telemetry_metrics_unauthorized", "App service token is missing or invalid."),
                    statusCode: StatusCodes.Status401Unauthorized);
            }

            return Results.Text(exposition.CurrentPrometheusText, "text/plain; version=0.0.4");
        });

        // `refresh=true` forces a plan rebuild; otherwise a fresh cached plan is projected without
        // network work (plan-first updates, docs/planning/plan-first-app-updates.md).
        app.MapGet("/api/apps/{appId}/update-status", async (
            string appId,
            bool? refresh,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreLifecycleService lifecycle,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => await HandleLifecycleError(() => lifecycle.GetUpdateStatusAsync(appId, refresh ?? false, cancellationToken)),
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

        // The control plane gets the same plan-then-apply contract as the browser: the CLI requests a
        // plan (no System coercion here — installing system apps from trusted local manifests is a CLI
        // capability) and echoes its plan id back on install.
        app.MapPost("/control/v1/apps/install/plan", async (
            HttpRequest request,
            ControlSecret secret,
            CoreLifecycleService lifecycle,
            AppInstallPlanRequest input,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                await HandleLifecycleError(() => lifecycle.CreateInstallPlanAsync(input, cancellationToken))));

        app.MapPost("/control/v1/apps/install", async (
            HttpRequest request,
            ControlSecret secret,
            CoreLifecycleService lifecycle,
            AppInstallRequest input,
            CancellationToken cancellationToken) =>
            await HostyCoreApplication.RequireControlSecret(request, secret, async () =>
                // Interactive installs start the app immediately unless the client opts out; an absent
                // value defaults to true so autostart apps run without a Core restart.
                await HandleLifecycleError(() =>
                {
                    RequireInstallPlanId(input);
                    return lifecycle.InstallAsync(input with
                    {
                        StartOnInstall = input.StartOnInstall ?? true,
                        FeedsUrl = null,
                        FeedId = null,
                    }, cancellationToken);
                })));

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

    // Every network install must be the apply of a reviewed plan — an install without a plan id
    // would fetch the manifest at apply time, and whatever the source serves in that moment is what
    // runs (C-CR1). The check lives at the endpoints so Core's own in-process bootstrap, which
    // installs from trusted local distribution manifests, keeps its direct path.
    private static void RequireInstallPlanId(AppInstallRequest input)
    {
        if (string.IsNullOrWhiteSpace(input.PlanId))
        {
            throw new AppLifecycleException(
                "install_plan_required",
                "Install requires a reviewed plan. Request POST /api/apps/install/plan (or /control/v1/apps/install/plan) first and echo its planId.");
        }
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
            var statusCode = ex.Code switch
            {
                "app_not_found" => StatusCodes.Status404NotFound,
                // Conflict with current state, not a malformed request: the same install succeeds
                // once the app is removed, and an update is the way to change it in place.
                "already_installed" => StatusCodes.Status409Conflict,
                _ => StatusCodes.Status400BadRequest,
            };
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
