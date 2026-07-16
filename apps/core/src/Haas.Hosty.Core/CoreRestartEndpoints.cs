namespace Haas.Hosty.Core;

// Host-admin surface for restarting/updating Core without stopping its running apps ("light restart"),
// plus a fast update-available check for the Shell sidebar. Core is an unsupervised detached process, so
// restart/update work by spawning a detached `hosty` CLI (see CoreCliLauncher); the still-running app
// containers are re-adopted by the new Core at boot. These are the primitives the Shell platform panel
// and sidebar use to keep Core current without disturbing apps.
internal static class CoreRestartEndpoints
{
    public static void Map(WebApplication app)
    {
        // Light restart on the current binary (apps kept running).
        app.MapPost("/api/core/restart", (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            HostyCoreRuntimeConfig config,
            ILoggerFactory loggerFactory,
            CancellationToken cancellationToken) =>
            SpawnCliAsync(
                request, users, clock, config, loggerFactory, cancellationToken,
                args: ["core", "restart", "--keep-apps"],
                logFileName: "core-restart.log",
                operation: "restart"));

        // Update: self-update the CLI + Core binaries, then light-restart onto the new Core.
        app.MapPost("/api/core/update", (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            HostyCoreRuntimeConfig config,
            ILoggerFactory loggerFactory,
            CancellationToken cancellationToken) =>
            SpawnCliAsync(
                request, users, clock, config, loggerFactory, cancellationToken,
                args: ["update"],
                logFileName: "core-update.log",
                operation: "update"));

        // Fast "is a newer Core available?" check (SHA256 of the installed binary vs release SHA256SUMS).
        app.MapGet("/api/core/update-status", async (
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreUpdateCheckService updateCheck,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                async () => CoreJson.Json(await updateCheck.GetStatusAsync(
                    forceRefresh: string.Equals(request.Query["refresh"], "true", StringComparison.OrdinalIgnoreCase),
                    cancellationToken)),
                cancellationToken: cancellationToken));
    }

    private static Task<IResult> SpawnCliAsync(
        HttpRequest request,
        UserDirectoryStore users,
        IClock clock,
        HostyCoreRuntimeConfig config,
        ILoggerFactory loggerFactory,
        CancellationToken cancellationToken,
        IReadOnlyList<string> args,
        string logFileName,
        string operation)
        => CoreSessionAuthorization.RequireAdminSessionAsync(
            request,
            users,
            clock,
            () =>
            {
                var logger = loggerFactory.CreateLogger("Haas.Hosty.Core.CoreRestart");
                var cliPath = CoreCliLauncher.ResolveCliPath();
                if (cliPath is null)
                {
                    logger.LogWarning("Core {Operation} requested but the hosty CLI could not be located (HOSTY_CLI_PATH unset and not on PATH).", operation);
                    return Task.FromResult(CoreJson.Json(
                        new ErrorResponse(
                            "cli_not_found",
                            "The hosty CLI could not be located to perform this operation. Set HOSTY_CLI_PATH or run the equivalent hosty command on the host."),
                        statusCode: StatusCodes.Status503ServiceUnavailable));
                }

                string logPath;
                try
                {
                    logPath = CoreCliLauncher.SpawnDetached(cliPath, args, config, logFileName);
                }
                catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or InvalidOperationException or System.ComponentModel.Win32Exception)
                {
                    logger.LogWarning(ex, "Failed to spawn the hosty CLI for Core {Operation}.", operation);
                    return Task.FromResult(CoreJson.Json(
                        new ErrorResponse("cli_spawn_failed", $"Could not launch the helper: {ex.Message}"),
                        statusCode: StatusCodes.Status500InternalServerError));
                }

                logger.LogInformation("Core {Operation} requested via API; spawned '{Cli} {Args}' (log: {LogPath}).", operation, cliPath, string.Join(' ', args), logPath);
                return Task.FromResult(CoreJson.Json(new CoreRestartResponse(operation == "update" ? "updating" : "restarting", logPath), statusCode: StatusCodes.Status202Accepted));
            },
            requireCsrf: true,
            cancellationToken: cancellationToken);
}

// LogFile is the helper's output log on the host — the first place to look when the detached operation
// never lands (the spawn itself is fire-and-forget past the immediate-failure probe).
internal sealed record CoreRestartResponse(string Status, string LogFile);
