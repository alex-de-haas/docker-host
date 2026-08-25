using System.ComponentModel;
using Microsoft.Extensions.DependencyInjection;
using ModelContextProtocol.Server;

namespace Haas.Hosty.Core;

// Core MCP (docs/features/core-mcp/plan.md): an embedded Model Context Protocol endpoint over the
// registry data Core already owns, so an agent client gets typed tools instead of guessing at shell
// commands. Control-plane only — it never proxies an app's domain API.
//
// Read-only. Lifecycle mutations are the obvious next step, but Core MCP has no approval mechanism
// of its own and the assistant's gate lives in its harness, which only pauses that harness's own
// calls — a mutation tool here would be reachable by any external client with a credential,
// bypassing it. Adding one means deciding where its approval lives first; the scope machinery this
// endpoint now accepts is where that decision is expected to land
// (docs/features/core-mcp/plan.md).
internal static class McpEndpoints
{
    public static void Map(WebApplication app)
    {
        // Under /api on purpose: Core's guardrail tests require every /api route to reject anonymous
        // callers, and this endpoint should be held to that rule rather than sitting outside it.
        var group = app.MapGroup("/api/mcp");

        // Gated before the protocol handler sees anything, on either of two credentials: an
        // administrator session, or an access token scoped to `core` carrying `mcp:read`
        // (docs/features/scoped-access-tokens/feature.md) — the first credential reaching Core that
        // is narrower than "an administrator". requireCsrf is on for the browser case; a bearer
        // credential — what an external MCP client presents — is CSRF-exempt by design, so agent
        // clients are unaffected.
        group.AddEndpointFilter(async (context, next) =>
        {
            var http = context.HttpContext;
            var users = http.RequestServices.GetRequiredService<UserDirectoryStore>();
            var clock = http.RequestServices.GetRequiredService<IClock>();

            // A credential scoped to `hosty:core` is checked first, because the session path refuses
            // outright — falling through would answer "not a session" to a credential minted for
            // exactly this endpoint. Every tool here declares `readOnlyHint: true`, so `mcp:read` is
            // the whole of what this surface offers, and a scoped credential without it is refused
            // by name rather than told it is not an administrator, which it never claimed to be.
            var bearer = CoreSessionAuthorization.ReadBearerToken(http.Request);
            if (bearer is not null)
            {
                var lifetimes = http.RequestServices.GetRequiredService<AuthLifetimes>();
                var state = await users.ReadAsync(http.RequestAborted);

                // A delegated token minted for this endpoint on a user's behalf, which is how the
                // MCP facade puts Core's tools in one aggregated catalog beside the apps'
                // (docs/features/mcp-facade/). Signature-verified and five minutes long, so it is
                // checked before the opaque forms below; the actor's role is re-read from the
                // directory rather than trusted from the claims, because this surface is
                // administrator-only and a token outlives a demotion by up to its whole TTL.
                var delegated = http.RequestServices.GetRequiredService<DelegatedTokenService>();
                if (delegated.ReadClaims(bearer) is { } claims &&
                    string.Equals(claims.Aud, AccessTokenScopes.CoreAudience, StringComparison.Ordinal))
                {
                    var actor = state.Users.FirstOrDefault(candidate =>
                        string.Equals(candidate.Id, claims.Sub, StringComparison.Ordinal));
                    if (actor is null || actor.Disabled || !AppAccessPolicy.IsAdmin(actor))
                    {
                        return CoreJson.Json(
                            new ErrorResponse("admin_required", "This Core operation requires a Host administrator."),
                            statusCode: StatusCodes.Status403Forbidden);
                    }

                    return await next(context);
                }
                var scoped = ScopedCredentials.Resolve(
                    state, bearer, clock.UtcNow, lifetimes, AccessTokenScopes.CoreAudience);
                if (scoped is not null)
                {
                    // A scope narrows what a credential may do; it never widens who may hold one.
                    // This surface is administrator-only, so the actor is still required to be an
                    // administrator — re-read here rather than trusted from issuance, because a role
                    // downgrade has to reach a long-lived credential. Without this check the scope
                    // would have been an escalation: any signed-in user could mint themselves a
                    // `hosty:core` credential and read the whole fleet through it.
                    if (!AppAccessPolicy.IsAdmin(scoped.User))
                    {
                        return CoreJson.Json(
                            new ErrorResponse(
                                "admin_required",
                                "This Core operation requires a Host administrator."),
                            statusCode: StatusCodes.Status403Forbidden);
                    }

                    if (!AccessTokenScopes.Grants(scoped.Record.Scopes, AccessTokenScopes.McpRead))
                    {
                        return CoreJson.Json(
                            new ErrorResponse(
                                "scope_required",
                                $"This credential does not carry the '{AccessTokenScopes.McpRead}' scope."),
                            statusCode: StatusCodes.Status403Forbidden);
                    }

                    await CoreSessionAuthorization.TouchSessionAsync(
                        users, scoped.Record, clock.UtcNow, http.RequestAborted);
                    return await next(context);
                }
            }

            var authorized = false;
            var denial = await CoreSessionAuthorization.RequireAdminSessionAsync(
                http.Request,
                users,
                clock,
                () =>
                {
                    authorized = true;
                    return Task.FromResult<IResult>(Results.Empty);
                },
                requireCsrf: true,
                cancellationToken: http.RequestAborted);

            // RequireAdminSessionAsync only invokes the action when the caller passes, so an
            // untouched flag means the returned IResult is the 401/403 to send back.
            return authorized ? await next(context) : denial;
        });

        group.MapMcp();
    }
}

// Tool results are returned as JSON strings serialized through Core's source-generated context
// rather than as objects: it keeps every byte on the AOT-safe path and makes the projection
// explicit, which matters because these payloads land in a model's context window.
[McpServerToolType]
internal sealed class HostyCoreTools
{
    // A fleet can be large and a model's context cannot. The list tool projects only what an agent
    // needs to pick a target; everything else is one get_app away.
    [McpServerTool(Name = "list_apps", ReadOnly = true)]
    [Description("Lists the runtime apps installed on this Hosty host: id, display name, version, runtime state, and whether it is a system app. Start here to resolve an app the user named informally (\"Solitaire\") to its id.")]
    public static async Task<string> ListAppsAsync(
        CoreLifecycleService lifecycle,
        CancellationToken cancellationToken)
    {
        var apps = await lifecycle.ListAppsAsync(cancellationToken);
        var payload = new McpAppList(apps
            .Select(app => new McpAppSummary(
                app.Id,
                app.DisplayName,
                app.Version,
                app.RuntimeState,
                app.OperationStatus,
                app.System,
                app.LastError))
            .ToArray());
        return CoreJson.Text(payload);
    }

    [McpServerTool(Name = "get_app", ReadOnly = true)]
    [Description("Returns one app's detail: runtime state, selected runtime profile, endpoint URLs, declared platform interfaces, and the last error if it has one. Use the id from list_apps.")]
    public static async Task<string> GetAppAsync(
        [Description("Reverse-DNS app id, e.g. com.haas.solitaire.")] string appId,
        CoreLifecycleService lifecycle,
        CancellationToken cancellationToken)
    {
        var apps = await lifecycle.ListAppsAsync(cancellationToken);
        var app = apps.FirstOrDefault(candidate => string.Equals(candidate.Id, appId, StringComparison.Ordinal));
        if (app is null)
        {
            return CoreJson.Text(new McpError($"No app with id '{appId}' is installed. Call list_apps for the installed ids."));
        }

        var endpoints = app.Endpoints
            .Select(endpoint => new McpAppEndpoint(endpoint.Key, endpoint.PublicOrigin ?? endpoint.Url, endpoint.Availability))
            .ToArray();
        var interfaces = (app.Interfaces ?? new Dictionary<string, IReadOnlyList<AppInterfaceSummary>>())
            .SelectMany(pair => pair.Value.Select(declaration => new McpAppInterface(pair.Key, declaration.Url)))
            .ToArray();

        return CoreJson.Text(new McpAppDetail(
            app.Id,
            app.DisplayName,
            app.Description,
            app.Version,
            app.RuntimeState,
            app.OperationStatus,
            app.System,
            app.SelectedRuntime,
            app.LastError,
            endpoints,
            interfaces));
    }

    [McpServerTool(Name = "get_host_status", ReadOnly = true)]
    [Description("Returns the host's overall state: Core version and how many apps are running, stopped, or reporting an error. Answers \"is anything wrong here\" in one call.")]
    public static async Task<string> GetHostStatusAsync(
        CoreLifecycleService lifecycle,
        CancellationToken cancellationToken)
    {
        var apps = await lifecycle.ListAppsAsync(cancellationToken);
        var running = apps.Count(app => string.Equals(app.RuntimeState, "running", StringComparison.OrdinalIgnoreCase));
        var failing = apps.Count(app => !string.IsNullOrWhiteSpace(app.LastError));
        return CoreJson.Text(new McpHostStatus(
            CoreStatusResponse.PlatformVersionString,
            apps.Count,
            running,
            apps.Count - running,
            failing));
    }

    // Deliberately named "tail": Core's logs are an on-demand read of the process/container output,
    // not a searchable store. Structured, queryable logs belong to the telemetry app.
    [McpServerTool(Name = "tail_app_logs", ReadOnly = true)]
    [Description("Returns the tail of one app's console output. This is a live tail, not a searchable log store — ask for more lines rather than expecting to filter.")]
    public static async Task<string> TailAppLogsAsync(
        [Description("Reverse-DNS app id, e.g. com.haas.solitaire.")] string appId,
        CoreLifecycleService lifecycle,
        CancellationToken cancellationToken,
        [Description("How many lines to return (1-500, default 100).")] int lines = 100)
    {
        // Clamped rather than trusted: an agent asking for 100000 lines would otherwise blow its own
        // context window and Core's response budget. The budget that was actually used is echoed back
        // either way, so an agent that asked for more knows it was capped rather than concluding the
        // app only ever logged this much.
        var tail = Math.Clamp(lines, 1, 500);
        try
        {
            var logs = await lifecycle.GetLogsAsync(appId, tail, cancellationToken);
            return CoreJson.Text(new McpLogTail(appId, tail, logs.Text ?? "", null));
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            // Returned as a result rather than thrown: a model can act on an explanation, but a
            // transport-level failure just ends the turn.
            return CoreJson.Text(new McpLogTail(appId, tail, null, $"Could not read logs for '{appId}': {exception.Message}"));
        }
    }
}

internal sealed record McpAppList(IReadOnlyList<McpAppSummary> Apps);

internal sealed record McpAppSummary(
    string Id,
    string DisplayName,
    string Version,
    string RuntimeState,
    string OperationStatus,
    bool System,
    string? LastError);

internal sealed record McpAppDetail(
    string Id,
    string DisplayName,
    string? Description,
    string Version,
    string RuntimeState,
    string OperationStatus,
    bool System,
    string? SelectedRuntime,
    string? LastError,
    IReadOnlyList<McpAppEndpoint> Endpoints,
    IReadOnlyList<McpAppInterface> Interfaces);

internal sealed record McpAppEndpoint(string Key, string? Url, string? Availability);

internal sealed record McpAppInterface(string Name, string? Url);

internal sealed record McpHostStatus(string CoreVersion, int Apps, int Running, int NotRunning, int WithErrors);

internal sealed record McpLogTail(string AppId, int Lines, string? Text, string? Error);

internal sealed record McpError(string Error);
