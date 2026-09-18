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
        app.MapGet("/api/core/development", (HttpRequest request, UserDirectoryStore users, IClock clock,
            CoreDevelopmentService development, CancellationToken cancellationToken) =>
            CoreSessionAuthorization.RequireAdminSessionAsync(request, users, clock,
                async () => CoreJson.Json(await development.GetAsync(cancellationToken)), cancellationToken: cancellationToken));

        app.MapPut("/api/core/source", (HttpRequest request, CoreSourceRequest input, UserDirectoryStore users,
            IClock clock, CoreDevelopmentService development, CancellationToken cancellationToken) =>
            CoreSessionAuthorization.RequireAdminSessionAsync(request, users, clock,
                () => HandleAsync(async () => CoreJson.Json(await development.SaveAsync(input, cancellationToken))),
                requireCsrf: true, cancellationToken: cancellationToken));

        app.MapPost("/api/core/restart", (HttpRequest request, CoreRestartRequest input, UserDirectoryStore users,
            IClock clock, CoreDevelopmentService development, AuditStore audit, CancellationToken cancellationToken) =>
            CoreSessionAuthorization.RequireAdminSessionAsync(request, users, clock,
                () => HandleAsync(async () =>
                {
                    var actor = await CoreSessionAuthorization.TryResolveSessionAsync(request, users, clock, cancellationToken);
                    var outcome = "failed";
                    try
                    {
                        var operation = await development.RestartAsync(input, cancellationToken);
                        outcome = operation.Status;
                        return CoreJson.Json(operation, statusCode: 202);
                    }
                    finally
                    {
                        try
                        {
                            await audit.AppendAsync(new AuditRecord($"audit_{Guid.NewGuid():N}", "core.lifecycle.restart", "core",
                                "hosty-core", outcome, actor?.Id, clock.UtcNow,
                                new Dictionary<string, string> { ["via"] = "http", ["operation"] = input.RequestId }), CancellationToken.None);
                        }
                        catch (Exception ex) { Console.Error.WriteLine($"[audit] Core restart audit failed: {ex.Message}"); }
                    }
                }),
                requireCsrf: true, cancellationToken: cancellationToken));

        app.MapGet("/api/core/operations/{id}", (string id, HttpRequest request, UserDirectoryStore users,
            IClock clock, CoreDevelopmentService development, CancellationToken cancellationToken) =>
            CoreSessionAuthorization.RequireAdminSessionAsync(request, users, clock,
                () => HandleAsync(() => Task.FromResult(development.GetOperation(id) is { } operation
                    ? CoreJson.Json(operation) : CoreJson.Json(new ErrorResponse("operation_not_found", "Core operation was not found."), statusCode: 404))),
                cancellationToken: cancellationToken));

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

    private static async Task<IResult> HandleAsync(Func<Task<IResult>> action)
    {
        try { return await action(); }
        catch (ArgumentException ex)
        { return CoreJson.Json(new ErrorResponse("invalid_request", ex.Message), statusCode: 400); }
        catch (Exception ex) when (ex is IOException or InvalidOperationException or System.ComponentModel.Win32Exception)
        { return CoreJson.Json(new ErrorResponse("core_operation_failed", ex.Message), statusCode: 409); }
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
