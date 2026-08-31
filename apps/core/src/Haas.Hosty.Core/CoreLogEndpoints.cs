namespace Haas.Hosty.Core;

// Core's own recent log records, for the Dashboard's Core logs dialog. Host-admin only, for the same
// reason the per-app console tail is: request paths run through here, and in Development so do secret
// *key names* (see docs/features/app-secrets-store.md).
//
// Reads the in-memory rings rather than `core.log`, so it answers on a host where that file does not
// exist at all — a foreground Core, or `npm run dev`.
internal static class CoreLogEndpoints
{
    private const int DefaultTail = 200;
    private const int MaxTail = 1000;
    private const int DefaultPullLimit = 500;
    private const int MaxPullLimit = 1000;

    public static void Map(WebApplication app)
    {
        app.MapGet("/api/core/logs", async (
            string? ring,
            int? tail,
            string? level,
            HttpRequest request,
            UserDirectoryStore users,
            IClock clock,
            CoreLogBuffer buffer,
            CancellationToken cancellationToken) =>
            await CoreSessionAuthorization.RequireAdminSessionAsync(
                request,
                users,
                clock,
                () =>
                {
                    if (!TryParseRing(ring, out var kind))
                    {
                        return Task.FromResult(CoreJson.Json(
                            new ErrorResponse("core_logs_invalid_ring", "ring must be 'hosty' or 'framework'."),
                            statusCode: StatusCodes.Status400BadRequest));
                    }

                    if (!TryParseLevel(level, out var minLevel))
                    {
                        return Task.FromResult(CoreJson.Json(
                            new ErrorResponse(
                                "core_logs_invalid_level",
                                "level must be one of trace, debug, information, warning, error, critical."),
                            statusCode: StatusCodes.Status400BadRequest));
                    }

                    var records = buffer.Ring(kind).Read(Math.Clamp(tail ?? DefaultTail, 1, MaxTail), minLevel);
                    return Task.FromResult(CoreJson.Json(new CoreLogsResponse(
                        buffer.RunId,
                        kind == CoreLogRingKind.Framework ? "framework" : "hosty",
                        records)));
                },
                cancellationToken: cancellationToken));

        // The telemetry backend's pull. Core gains no OpenTelemetry SDK for this: it is an AOT binary
        // with one package reference, it starts *before* the collector it would have exported to, an
        // exporter queue would put a managed app inside the kernel's failure path, and OTLP ingest is
        // still unauthenticated so pushed records would be forgeable. Pulling inverts all four and
        // reuses auth that already exists — the same app service token that guards the docker-stats
        // exposition, on a route inside the endpoint-authorization harness.
        //
        // Only Core's own ring is exported. The request trail stays in memory for the dialog: at the
        // measured ~96 % share it would drown the fleet's logs in a 3-day store with a ~1 GiB ceiling,
        // a failure this store has already had once.
        app.MapGet("/api/internal/telemetry/logs", async (
            long? after,
            int? limit,
            HttpRequest request,
            AppServiceTokenService serviceTokens,
            AppRegistryStore apps,
            CoreLogBuffer buffer,
            CancellationToken cancellationToken) =>
        {
            var token = CoreSessionAuthorization.ReadBearerToken(request);
            var callerAppId = string.IsNullOrWhiteSpace(token) ? null : serviceTokens.ResolveAppId(token);
            // The signature alone is not enough: it is HMAC over the app id with a durable key, so a
            // token copied before the app was removed verifies forever. Requiring the app to still be
            // installed matches every other app-token route.
            if (callerAppId is null || await apps.GetAppAsync(callerAppId, cancellationToken) is null)
            {
                return CoreJson.Json(
                    new ErrorResponse("telemetry_logs_unauthorized", "App service token is missing or invalid."),
                    statusCode: StatusCodes.Status401Unauthorized);
            }

            var cursor = Math.Max(after ?? 0, 0);
            var records = buffer.Ring(CoreLogRingKind.Hosty)
                .ReadAfter(cursor, Math.Clamp(limit ?? DefaultPullLimit, 1, MaxPullLimit), LogLevel.Trace);

            // Holding the caller's cursor when nothing is new keeps a quiet host idempotent; a restart
            // is signalled by runId rather than by the cursor going backwards.
            return CoreJson.Json(new CoreLogPullResponse(
                buffer.RunId,
                records.Count > 0 ? records[^1].Sequence : cursor,
                records));
        });
    }

    // Absent means the ring an operator wants first: Core's own decisions, not the request trail.
    internal static bool TryParseRing(string? value, out CoreLogRingKind kind)
    {
        kind = CoreLogRingKind.Hosty;
        if (string.IsNullOrWhiteSpace(value))
        {
            return true;
        }

        switch (value.Trim().ToLowerInvariant())
        {
            case "hosty":
                kind = CoreLogRingKind.Hosty;
                return true;
            case "framework":
                kind = CoreLogRingKind.Framework;
                return true;
            default:
                return false;
        }
    }

    internal static bool TryParseLevel(string? value, out LogLevel level)
    {
        level = LogLevel.Trace;
        if (string.IsNullOrWhiteSpace(value))
        {
            return true;
        }

        switch (value.Trim().ToLowerInvariant())
        {
            case "trace":
                level = LogLevel.Trace;
                return true;
            case "debug":
                level = LogLevel.Debug;
                return true;
            case "information":
            case "info":
                level = LogLevel.Information;
                return true;
            case "warning":
            case "warn":
                level = LogLevel.Warning;
                return true;
            case "error":
                level = LogLevel.Error;
                return true;
            case "critical":
                level = LogLevel.Critical;
                return true;
            default:
                return false;
        }
    }
}

// `runId` identifies this Core process run: the rings are in memory, so a consumer holding a cursor
// uses it to tell a quiet host from a restarted one.
internal sealed record CoreLogsResponse(string RunId, string Ring, IReadOnlyList<CoreLogRecord> Records);

// The pull shape. `nextCursor` is what the caller sends back as `after`; `runId` tells it whether the
// cursor still refers to the same Core process — the rings are in memory, so a restart resets them and
// the consumer must restart from zero rather than wait for a sequence that will never come again.
internal sealed record CoreLogPullResponse(string RunId, long NextCursor, IReadOnlyList<CoreLogRecord> Records);
