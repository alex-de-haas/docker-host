using System.ComponentModel;
using Microsoft.Extensions.DependencyInjection;
using ModelContextProtocol.Server;

namespace Haas.Hosty.Core;

// Core MCP (docs/features/core-mcp/feature.md): an embedded Model Context Protocol endpoint over the
// registry data Core already owns, so an agent client gets typed tools instead of guessing at shell
// commands. Control-plane only — it never proxies an app's domain API.
//
// Read-only. Lifecycle mutations are the obvious next step, but Core MCP has no approval mechanism
// of its own and the assistant's gate lives in its harness, which only pauses that harness's own
// calls — a mutation tool here would be reachable by any external client with a credential,
// bypassing it. Adding one means deciding where its approval lives first; the scope machinery this
// endpoint now accepts is where that decision is expected to land
// (docs/features/core-mcp/feature.md).
internal static class McpEndpoints
{
    public static void Map(WebApplication app)
    {
        // Under /api on purpose: Core's guardrail tests require every /api route to reject anonymous
        // callers, and this endpoint should be held to that rule rather than sitting outside it.
        var group = app.MapGroup("/api/mcp");

        // Gated before the protocol handler sees anything, on either of two credentials: an
        // administrator session, or an access token scoped to `hosty:core` carrying `mcp:read`
        // (docs/features/scoped-access-tokens/feature.md) — the first credential reaching Core that
        // is narrower than "an administrator". requireCsrf is on for the browser case; a bearer
        // credential — what an external MCP client presents — is CSRF-exempt by design, so agent
        // clients are unaffected.
        group.AddEndpointFilter(async (context, next) =>
        {
            var http = context.HttpContext;
            var users = http.RequestServices.GetRequiredService<UserDirectoryStore>();
            var clock = http.RequestServices.GetRequiredService<IClock>();

            // The MCP authorization handshake: a 401 from this surface names where its resource
            // metadata lives, which is how a stock client discovers the OAuth flow instead of
            // dead-ending. On the response's way out rather than per refusal site, so no refusal
            // path can forget it.
            http.Response.OnStarting(() =>
            {
                if (http.Response.StatusCode == StatusCodes.Status401Unauthorized)
                {
                    var origin = http.RequestServices.GetRequiredService<CorePublicOriginResolver>()
                        .Effective.TrimEnd('/');
                    http.Response.Headers.WWWAuthenticate =
                        $"Bearer resource_metadata=\"{origin}/.well-known/oauth-protected-resource/api/mcp\"";
                }

                return Task.CompletedTask;
            });

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

                    // Read-only, whatever the actor's role. A delegated token carries sub, role and
                    // audience — never the scopes of the credential it descends from — so the
                    // on-behalf-of path cannot prove the standing grant mutations require. Inferring
                    // lifecycle from the admin role here would let a facade client whose own token
                    // holds only mcp:read reach mutations around the grant. The facade exports only
                    // read-only tools anyway, so nothing an external client can see is lost.
                    http.Items[McpCallerGrants.Key] = new McpCallerGrants(Lifecycle: false, Update: false, actor.Id);
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

                    // What this credential may do beyond reading is exactly what it says: the gate
                    // stops being all-or-nothing the moment mutation tools exist, and the scope is
                    // the standing grant those tools check.
                    http.Items[McpCallerGrants.Key] = new McpCallerGrants(
                        AccessTokenScopes.Grants(scoped.Record.Scopes, AccessTokenScopes.McpLifecycle),
                        AccessTokenScopes.Grants(scoped.Record.Scopes, AccessTokenScopes.McpUpdate),
                        scoped.User.Id);
                    return await next(context);
                }
            }

            // Inlined rather than RequireAdminSessionAsync, because the tools need to know *who* is
            // acting — the audit line for a mutation names the actor — and that wrapper never hands
            // the user out. The refusal is byte-for-byte the one it produced.
            McpCallerGrants? sessionGrants = null;
            var denial = await CoreSessionAuthorization.RequireSessionAsync(
                http.Request,
                users,
                clock,
                user =>
                {
                    if (!string.Equals(user.Role, "host.admin", StringComparison.Ordinal))
                    {
                        return Task.FromResult<IResult>(CoreJson.Json(
                            new ErrorResponse("admin_required", "This Core operation requires a Host administrator session."),
                            statusCode: StatusCodes.Status403Forbidden));
                    }

                    // An administrator's session is the full-role credential; lifecycle and update
                    // come with the role, exactly as they do on every /api route the same person
                    // could call directly. The scopes narrow *tokens*, never the role itself.
                    sessionGrants = new McpCallerGrants(Lifecycle: true, Update: true, user.Id);
                    return Task.FromResult<IResult>(Results.Empty);
                },
                requireCsrf: true,
                cancellationToken: http.RequestAborted);

            // The grants double as the authorized flag: the action sets them only on success, so
            // null means the returned IResult is the 401/403 to send back — and what goes into
            // Items is provably non-null, which is the invariant the tools' fail-closed check
            // depends on.
            if (sessionGrants is null)
            {
                return denial;
            }

            http.Items[McpCallerGrants.Key] = sessionGrants;
            return await next(context);
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

        // Telemetry attributes Hosty Core's own records to a reserved id, so an agent that has just read
        // the fleet's logs can arrive here holding one. It is not an installed app and never will be:
        // say so plainly, rather than letting the lifecycle lookup surface a raw "app not found" that
        // reads like the host is broken.
        if (string.Equals(appId, CoreLogBuffer.CoreSourceId, StringComparison.Ordinal))
        {
            return CoreJson.Text(new McpLogTail(
                appId,
                tail,
                null,
                $"'{appId}' is Hosty Core itself — the host kernel, not an installed app, so it has no " +
                "console output to tail. Its own logs are on the host in ~/.hosty/core/logs/core.log, " +
                "and in the Core logs dialog on Shell's Dashboard."));
        }

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

    [McpServerTool(Name = "search_audit", ReadOnly = true)]
    [Description(
        "Searches the host's audit log: who did what to this host and whether it worked. Distinct from tail_app_logs, " +
        "which is an app's own output — this records actions taken *on* apps and on the host's own credentials, " +
        "users and backups. Coverage is uneven today: lifecycle actions are recorded only when an agent performed " +
        "them, so an absent entry is not evidence that nothing happened.")]
    public static async Task<string> SearchAuditAsync(
        AuditStore audit,
        IClock clock,
        CancellationToken cancellationToken,
        [Description("Only entries about this resource, e.g. an app id from list_apps. Omit for all.")] string? resourceId = null,
        [Description("Only actions starting with this, e.g. 'app.lifecycle' or 'auth'. Omit for all.")] string? actionPrefix = null,
        [Description("Only this outcome: succeeded, failed, refused, reported. Omit for all.")] string? outcome = null,
        [Description("How far back to look, in seconds (60 to 30 days, default 86400).")] int rangeSeconds = 86_400,
        [Description("How many entries to return (1-200, default 50).")] int limit = 50)
    {
        var result = await audit.SearchAsync(
            new AuditQuery(resourceId, actionPrefix, outcome, rangeSeconds, limit),
            clock.UtcNow,
            cancellationToken: cancellationToken);

        return CoreJson.Text(new McpAuditSearch(
            result.Entries.Select(entry => new McpAuditEntry(
                entry.CreatedAt,
                entry.Action,
                entry.ResourceType,
                entry.ResourceId,
                entry.Outcome,
                // Who authorized it is the whole point of this record: an audit entry without an actor
                // answers "something happened" rather than the question anyone asks of an audit.
                entry.ActorUserId,
                entry.Details)).ToArray(),
            result.Window));
    }

    // --- Lifecycle mutations (docs/features/core-mcp/feature.md) ----------------------------------
    //
    // Gated on the mcp:lifecycle standing grant, resolved by the endpoint filter into
    // McpCallerGrants. The refusal is a tool *result* naming the scope, never a transport error:
    // a model can explain "this credential may not do that" and only give up on a JSON-RPC error.
    //
    // Every call is audited — actor, tool, target app, outcome, refusals included — because this is
    // where an agent's word becomes an action on the host, and the refusals are the more
    // interesting half of that record.

    [McpServerTool(Name = "start_app", Destructive = false, Idempotent = true)]
    [Description("Starts an installed app. Requires a credential carrying the mcp:lifecycle scope; refused otherwise. Use the id from list_apps.")]
    public static Task<string> StartAppAsync(
        [Description("Reverse-DNS app id, e.g. com.haas.solitaire.")] string appId,
        CoreLifecycleService lifecycle,
        IHttpContextAccessor httpContext,
        AuditStore audit,
        IClock clock,
        CancellationToken cancellationToken)
        => MutateAsync("start_app", "start", appId, lifecycle.StartAsync, httpContext, audit, clock, cancellationToken);

    // Destructive on purpose: stopping interrupts whatever the app is doing for its users right
    // now. Idempotent, because stopping a stopped app changes nothing further.
    [McpServerTool(Name = "stop_app", Destructive = true, Idempotent = true)]
    [Description("Stops a running app, interrupting whatever it is doing for its users. Requires a credential carrying the mcp:lifecycle scope; refused otherwise.")]
    public static Task<string> StopAppAsync(
        [Description("Reverse-DNS app id, e.g. com.haas.solitaire.")] string appId,
        CoreLifecycleService lifecycle,
        IHttpContextAccessor httpContext,
        AuditStore audit,
        IClock clock,
        CancellationToken cancellationToken)
        => MutateAsync("stop_app", "stop", appId, lifecycle.StopAsync, httpContext, audit, clock, cancellationToken);

    // Not idempotent: the end state repeats, but every call is another interruption.
    [McpServerTool(Name = "restart_app", Destructive = true, Idempotent = false)]
    [Description("Restarts an app: a stop, then a start. Requires a credential carrying the mcp:lifecycle scope; refused otherwise.")]
    public static Task<string> RestartAppAsync(
        [Description("Reverse-DNS app id, e.g. com.haas.solitaire.")] string appId,
        CoreLifecycleService lifecycle,
        IHttpContextAccessor httpContext,
        AuditStore audit,
        IClock clock,
        CancellationToken cancellationToken)
        => MutateAsync("restart_app", "restart", appId, lifecycle.RestartAsync, httpContext, audit, clock, cancellationToken);

    // --- Updates (docs/features/core-mcp/plan.md) ------------------------------------------------
    //
    // Two steps, mirroring what the CLI and Shell already do, because the shape *is* the safeguard:
    // planning names the versions and the changes, and applying names the plan it was shown. An
    // approval then attaches to a specific plan rather than to "update this app, whatever that turns
    // out to mean by the time it runs".

    [McpServerTool(Name = "plan_app_update", Destructive = false, Idempotent = true)]
    [Description(
        "Computes what updating an app would do - versions, runtime, whether a pre-update backup is taken, and the " +
        "changes found - and returns a planDigest to pass to apply_app_update. Changes nothing. Requires the " +
        "mcp:update scope. Read sourceConfigured before concluding anything from an empty change list.")]
    public static async Task<string> PlanAppUpdateAsync(
        [Description("Reverse-DNS app id, e.g. com.haas.solitaire.")] string appId,
        CoreLifecycleService lifecycle,
        IHttpContextAccessor httpContext,
        CancellationToken cancellationToken)
    {
        if (httpContext.HttpContext?.Items[McpCallerGrants.Key] is not McpCallerGrants grants)
        {
            return CoreJson.Text(new McpError("The caller's authorization could not be established."));
        }

        // Gated even though it mutates nothing: a plan reaches out to the app's source and reports
        // what is available there, which is more than a credential without the update grant was given.
        if (!grants.Update)
        {
            return CoreJson.Text(new McpError(
                $"This credential does not carry the '{AccessTokenScopes.McpUpdate}' scope, which plan_app_update requires."));
        }

        var target = NormalizeAppId(appId);
        try
        {
            var plan = await lifecycle.CreateUpdatePlanAsync(target, new AppUpdatePlanRequest(), cancellationToken);
            return CoreJson.Text(new McpUpdatePlan(
                plan.AppId,
                plan.CurrentVersion,
                plan.TargetVersion,
                plan.CurrentRuntime,
                plan.TargetRuntime,
                plan.PlanDigest,
                plan.WillCreatePreUpdateBackup,
                plan.Changes,
                // Carried because an empty change list means two different things, and only this tells
                // them apart: nothing new, or nothing Core could check. Reporting the first when it is
                // the second would have an agent announce an app is up to date on the strength of a
                // question that was never asked.
                plan.SourceConfigured,
                null));
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            return CoreJson.Text(new McpUpdatePlan(
                target, null, null, null, null, null, false, [], false,
                $"Could not plan an update for '{target}': {exception.Message}"));
        }
    }

    [McpServerTool(Name = "apply_app_update", Destructive = true, Idempotent = false)]
    [Description(
        "Applies an update previously computed by plan_app_update, naming its planDigest. The app is stopped and " +
        "replaced, interrupting whatever it is doing for its users. Refused if the plan no longer matches what the " +
        "host would do now. Requires the mcp:update scope.")]
    public static async Task<string> ApplyAppUpdateAsync(
        [Description("Reverse-DNS app id, e.g. com.haas.solitaire.")] string appId,
        [Description("The planDigest returned by plan_app_update for this app.")] string planDigest,
        CoreLifecycleService lifecycle,
        IHttpContextAccessor httpContext,
        AuditStore audit,
        IClock clock,
        CancellationToken cancellationToken)
    {
        if (httpContext.HttpContext?.Items[McpCallerGrants.Key] is not McpCallerGrants grants)
        {
            return CoreJson.Text(new McpError("The caller's authorization could not be established."));
        }

        var target = NormalizeAppId(appId);
        if (!grants.Update)
        {
            await AppendLifecycleAuditAsync(audit, clock, "update", target, "apply_app_update", grants.ActorUserId, "refused");
            return CoreJson.Text(new McpError(
                $"This credential does not carry the '{AccessTokenScopes.McpUpdate}' scope, which apply_app_update requires. " +
                "A host administrator can issue a Core credential with app updates, or run this from their own session."));
        }

        // The digest is the approval. Core refuses one that no longer describes what it would do now,
        // so an update that changed underneath the plan cannot be applied on the strength of the older
        // one - which is the whole reason this is two calls rather than one.
        var digest = NormalizeAppId(planDigest);
        string payload;
        string outcome;
        try
        {
            var result = await lifecycle.EnqueueUpdateAsync(target, new AppUpdateApplyRequest(digest), cancellationToken);

            // **Accepted, not succeeded.** The apply runs detached — EnqueueUpdateAsync returns
            // "updating" the moment the work is queued — so calling this a success would report an
            // outcome nobody has yet. The runtime state in that response is still the *pre-update*
            // one, which is exactly how a model concludes the update is done and moves on.
            //
            // The settled outcome lands on the app record, not here, and audit does not learn it:
            // CoreLifecycleService holds no AuditStore, and giving it one belongs to the producer
            // deliverable in docs/features/core-mcp/plan.md. Until then this line says what it knows.
            outcome = "accepted";
            payload = CoreJson.Text(new McpLifecycleResult(
                target,
                "update",
                result.Status,
                null,
                "The update was accepted and runs in the background. Call get_app to see whether it finished; " +
                "the runtime state above is the one from before it started."));
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            outcome = "failed";
            payload = CoreJson.Text(new McpLifecycleResult(target, "update", null, $"Could not update '{target}': {exception.Message}", null));
        }

        await AppendLifecycleAuditAsync(audit, clock, "update", target, "apply_app_update", grants.ActorUserId, outcome);
        return payload;
    }

    private static async Task<string> MutateAsync(
        string tool,
        string verb,
        string appId,
        Func<string, CancellationToken, Task<AppLifecycleResponse>> action,
        IHttpContextAccessor httpContext,
        AuditStore audit,
        IClock clock,
        CancellationToken cancellationToken)
    {
        // The filter resolved who is calling and what they may do. A tool must not run without that
        // answer: grants missing means the request somehow reached the handler around the filter,
        // and the only safe reading of that is refusal.
        if (httpContext.HttpContext?.Items[McpCallerGrants.Key] is not McpCallerGrants grants)
        {
            return CoreJson.Text(new McpError("The caller's authorization could not be established."));
        }

        var target = NormalizeAppId(appId);
        if (!grants.Lifecycle)
        {
            await AppendLifecycleAuditAsync(audit, clock, verb, target, tool, grants.ActorUserId, "refused");
            return CoreJson.Text(new McpError(
                $"This credential does not carry the '{AccessTokenScopes.McpLifecycle}' scope, which {tool} requires. " +
                "A host administrator can issue a Core credential with app control, or run this from their own session."));
        }

        // The outcome is settled first and the audit line written after, decoupled on purpose. Once
        // the action ran, nothing may rewrite what happened: an audit append that fails inside a
        // catch block would have reported a *completed* mutation as a failed tool call — inviting a
        // client to repeat a restart that already succeeded — and burying the real answer under a
        // storage problem.
        string payload;
        string outcome;
        try
        {
            var result = await action(target, cancellationToken);
            outcome = "succeeded";
            payload = CoreJson.Text(new McpLifecycleResult(target, verb, result.App?.RuntimeState ?? result.Status, null));
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            // The attempt failed — an unknown id, a runtime that refused, a manifest problem.
            // Returned as a result the model can act on; a thrown error would just end the turn.
            outcome = "failed";
            payload = CoreJson.Text(new McpLifecycleResult(target, verb, null, $"Could not {verb} '{target}': {exception.Message}"));
        }

        await AppendLifecycleAuditAsync(audit, clock, verb, target, tool, grants.ActorUserId, outcome);
        return payload;
    }

    // Caller-supplied text on its way into a durable log and a runtime lookup: bounded and stripped
    // of control characters, the same treatment every other untrusted label gets. Bounded *before*
    // it is scanned or copied — this runs on the refusal path too, where a read-only credential can
    // land at no cost to itself, so the work must never be proportional to what the caller sent. A
    // legal app id fits in 63 characters; the slice is generous.
    private static string NormalizeAppId(string appId)
    {
        var span = (appId ?? "").AsSpan().Trim();
        if (span.Length > 120)
        {
            span = span[..120];
        }

        Span<char> buffer = stackalloc char[span.Length];
        var length = 0;
        foreach (var character in span)
        {
            if (!char.IsControl(character))
            {
                buffer[length++] = character;
            }
        }

        return new string(buffer[..length]);
    }

    // Best-effort, and never on the request's cancellation token: a client that disconnects right
    // after its restart completed must not be the reason the completed mutation left no trace. A
    // failed append costs the line — logged so an operator can see the trail has a hole — but it
    // must not falsify the response, which describes something that already happened.
    private static async Task AppendLifecycleAuditAsync(
        AuditStore audit,
        IClock clock,
        string verb,
        string appId,
        string tool,
        string actorUserId,
        string outcome)
    {
        try
        {
            await audit.AppendAsync(
                new AuditRecord(
                    Id: $"audit_{Guid.NewGuid():N}",
                    Action: $"app.lifecycle.{verb}",
                    ResourceType: "app",
                    ResourceId: appId,
                    Outcome: outcome,
                    ActorUserId: actorUserId,
                    CreatedAt: clock.UtcNow,
                    Details: new Dictionary<string, string>(StringComparer.Ordinal)
                    {
                        ["tool"] = tool,
                        ["via"] = "mcp",
                    }),
                CancellationToken.None);
        }
        catch (Exception exception)
        {
            Console.Error.WriteLine(
                $"[audit] failed to record app.lifecycle.{verb} ({outcome}) for '{appId}': {exception.Message}");
        }
    }
}

/// <summary>
/// What the authenticated caller of this MCP surface may do, resolved once by the endpoint filter
/// and read by the tools out of <c>HttpContext.Items</c>.
/// </summary>
/// <remarks>
/// Reading is always granted by passing the filter at all; what varies is mutation authority.
/// An administrator session carries it by role. A scoped access token carries it only with the
/// <c>mcp:lifecycle</c> scope. A delegated token never carries it, because it does not carry the
/// scopes of the credential it descends from — role alone must not stand in for the grant.
/// </remarks>
internal sealed record McpCallerGrants(bool Lifecycle, bool Update, string ActorUserId)
{
    /// <summary>The <c>HttpContext.Items</c> slot the filter writes and the tools read.</summary>
    public const string Key = "hosty:mcp-caller-grants";
}

internal sealed record McpUpdatePlan(
    string? AppId,
    string? CurrentVersion,
    string? TargetVersion,
    string? CurrentRuntime,
    string? TargetRuntime,
    string? PlanDigest,
    bool WillCreatePreUpdateBackup,
    IReadOnlyList<string> Changes,
    bool SourceConfigured,
    string? Error);

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

/// <summary>
/// Audit entries, and the window that produced them.
/// </summary>
/// <remarks>
/// The window is not decoration: without it an agent reports "nothing happened" when it means
/// "nothing in the newest fifty", which is a false statement about the host rather than a report
/// about the query.
/// </remarks>
internal sealed record McpAuditSearch(IReadOnlyList<McpAuditEntry> Entries, AuditWindow Window);

internal sealed record McpAuditEntry(
    DateTimeOffset At,
    string Action,
    string ResourceType,
    string? ResourceId,
    string Outcome,
    string? ActorUserId,
    IReadOnlyDictionary<string, string> Details);

internal sealed record McpError(string Error);

/// <summary>One lifecycle mutation's outcome: the state the app landed in, or why it did not.</summary>
internal sealed record McpLifecycleResult(
    string AppId,
    string Action,
    string? RuntimeState,
    string? Error,
    /// <summary>
    /// Set when the action was only *accepted*. Start, stop and restart settle before they answer;
    /// an update does not, and a result that looked identical either way is how a model reports a
    /// finished update that is still running — or has since failed.
    /// </summary>
    string? Note = null);
