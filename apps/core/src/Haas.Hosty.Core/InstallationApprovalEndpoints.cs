using System.Net;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Cors;

namespace Haas.Hosty.Core;

internal sealed record InstallationCaller(string UserId, string? AppId, string? Token, string Name);

internal sealed class InstallationApprovalService(
    InstallationApprovalStore approvals, CoreLifecycleService lifecycle, AppRegistryStore apps,
    AppIdentityService identity, AppServiceTokenService serviceTokens, AuditStore audit, IClock clock)
{
    public async Task<InstallationCaller> AuthenticateAppAsync(string appId, HttpRequest request, CancellationToken ct)
    {
        if (!serviceTokens.ValidateToken(appId, CoreSessionAuthorization.ReadBearerToken(request) ?? ""))
            throw new AppIdentityException("token_invalid", "App service token is missing or invalid.");
        var token = request.Headers["X-Hosty-App-Identity"].ToString();
        var actor = await identity.RevalidateAsync(token, appId, ct);
        if (actor.HostRole != "host.admin")
            throw new AppIdentityException("admin_required", "Installation requests require an administrator.");
        var app = await apps.GetAppAsync(appId, ct)
            ?? throw new AppIdentityException("app_access_denied", "The requesting app is not installed.");
        return new(actor.UserId, appId, token, app.DisplayName);
    }

    public async Task RequirePermissionAsync(InstallationCaller caller, string permission, CancellationToken ct)
    {
        // A direct full Core session is the operator interface. App-delegated callers always need
        // a persisted grant; neither role:system nor an app's ID supplies it.
        if (caller.AppId is null) return;
        var app = await apps.GetAppAsync(caller.AppId, ct);
        if (app?.GrantedCorePermissions?.Contains(permission, StringComparer.Ordinal) != true)
            throw new AppIdentityException("app_permission_required", $"The app has not been granted '{permission}'. Approve its permission change through a reviewed update.");
    }

    public async Task<InstallationApproval> PrepareAsync(InstallationCaller caller, InstallationPrepare input, CancellationToken ct)
    {
        var update = !string.IsNullOrWhiteSpace(input.UpdateAppId);
        await RequirePermissionAsync(caller, update ? CoreAppPermissions.Update : CoreAppPermissions.Install, ct);
        AppInstallPlan? plan = null;
        AppUpdatePlan? updatePlan = null;
        AppFeedInstallPlan? feed = null;
        if (update)
        {
            updatePlan = string.IsNullOrWhiteSpace(input.PlanDigest)
                ? await lifecycle.CreateUpdatePlanAsync(input.UpdateAppId!, new AppUpdatePlanRequest(input.ManifestPath, input.SelectedRuntime), ct)
                : await lifecycle.GetReviewedUpdatePlanAsync(input.UpdateAppId!, input.PlanDigest);
        }
        else if (!string.IsNullOrWhiteSpace(input.FeedsUrl))
        {
            feed = await lifecycle.CreateApprovalFeedPlanAsync(new(input.FeedsUrl, input.FeedId, input.SelectedRuntime), ct);
            plan = feed.Install;
        }
        else
        {
            if (string.IsNullOrWhiteSpace(input.ManifestPath))
                throw new AppLifecycleException("manifest_path_required", "A manifest or feed source is required.");
            plan = await lifecycle.CreateInstallPlanAsync(new(input.ManifestPath, input.SelectedRuntime), ct);
        }
        if (plan is { Action: not "install" })
            throw new AppLifecycleException("already_installed", "This app is already installed. Use its update flow.");
        var entry = approvals.Add(new InstallationApproval
        {
            UserId = caller.UserId, CallerAppId = caller.AppId, IdentityToken = caller.Token,
            CallerName = caller.Name, ExpiresAt = clock.UtcNow.Add(InstallationApprovalStore.Lifetime),
            InstallPlan = plan, UpdatePlan = updatePlan, FeedsUrl = feed?.FeedsUrl, FeedId = feed?.FeedId,
        });
        await RecordAsync(entry, "requested", ct);
        return entry;
    }

    public Task RecordAsync(InstallationApproval entry, string outcome, CancellationToken ct)
        => audit.AppendAsync(new AuditRecord($"audit_{Guid.NewGuid():N}", "app.installation.approval", "app",
            entry.InstallPlan?.AppId ?? entry.UpdatePlan?.AppId, outcome, entry.UserId, clock.UtcNow,
            new Dictionary<string, string> { ["requestId"] = entry.Id, ["caller"] = entry.CallerAppId ?? "operator" }), ct);

    public InstallationApproval Owned(string id, InstallationCaller caller)
    {
        var entry = approvals.Get(id);
        if (entry.UserId != caller.UserId || entry.CallerAppId != caller.AppId)
            throw new AppIdentityException("app_access_denied", "This request belongs to another caller.");
        return entry;
    }

    public async Task ExecuteAsync(InstallationApproval entry, CancellationToken ct)
    {
        try
        {
            if (entry.CallerAppId is { } appId)
            {
                var actor = await identity.RevalidateAsync(entry.IdentityToken, appId, ct);
                if (actor.UserId != entry.UserId || actor.HostRole != "host.admin")
                    throw new AppIdentityException("admin_required", "The requesting administrator no longer has access.");
                await RequirePermissionAsync(new(entry.UserId, appId, entry.IdentityToken, entry.CallerName), entry.Permission, ct);
            }
            if (entry.UpdatePlan is { } update)
                _ = await lifecycle.ApplyUpdateAsync(update.AppId, new(PlanDigest: update.PlanDigest), ct);
            else if (entry.InstallPlan is { } plan)
                _ = await lifecycle.InstallAsync(new(plan.ManifestPath, plan.TargetRuntime,
                    Settings: entry.Settings, Autostart: entry.Autostart, PlanId: plan.PlanId,
                    StartOnInstall: true, FeedsUrl: entry.FeedsUrl, FeedId: entry.FeedId), ct);
            approvals.Complete(entry, null);
        }
        catch (Exception ex)
        {
            // A failed execution is not replayable. The operator must prepare and approve a new plan.
            approvals.Complete(entry, ex is AppLifecycleException or AppIdentityException
                ? ex.Message : "The operation failed. Inspect the Core logs before preparing a new request.");
        }
    }
}

internal static class InstallationApprovalEndpoints
{
    public static void Map(WebApplication app)
    {
        // Browser operator transport, used by Shell. Having a Core session can prepare a request;
        // it cannot manufacture the page-only decision nonce or bypass final confirmation.
        app.MapPost("/api/installations", async (HttpRequest request, UserDirectoryStore users, IClock clock,
            InstallationPrepare input, InstallationApprovalService service, InstallationApprovalStore store,
            CorePublicOriginResolver origins, CancellationToken ct) =>
            await BrowserAsync(request, users, clock, async caller =>
                CoreJson.Json(store.View(await service.PrepareAsync(caller, input, ct), origins.Effective)), ct));
        app.MapPost("/api/installations/{id}/submit", async (string id, HttpRequest request,
            UserDirectoryStore users, IClock clock, InstallationSubmit input, InstallationApprovalService service,
            InstallationApprovalStore store, CorePublicOriginResolver origins, CancellationToken ct) =>
            await BrowserAsync(request, users, clock, caller =>
            {
                var entry = service.Owned(id, caller);
                store.Submit(entry, input);
                return Task.FromResult(CoreJson.Json(store.View(entry, origins.Effective)));
            }, ct));
        app.MapGet("/api/installations/{id}", async (string id, HttpRequest request,
            UserDirectoryStore users, IClock clock, InstallationApprovalService service,
            InstallationApprovalStore store, CorePublicOriginResolver origins, CancellationToken ct) =>
            await BrowserAsync(request, users, clock, caller =>
                Task.FromResult(CoreJson.Json(store.View(service.Owned(id, caller), origins.Effective))), ct, csrf: false));

        app.MapPost("/api/internal/apps/{appId}/installations", async (string appId, HttpRequest request,
            InstallationPrepare input, InstallationApprovalService service, InstallationApprovalStore store,
            CorePublicOriginResolver origins, CancellationToken ct) => await HandleAsync(async () =>
                CoreJson.Json(store.View(await service.PrepareAsync(await service.AuthenticateAppAsync(appId, request, ct), input, ct), origins.Effective))));
        app.MapPost("/api/internal/apps/{appId}/installations/{id}/submit", async (string appId, string id,
            HttpRequest request, InstallationSubmit input, InstallationApprovalService service,
            InstallationApprovalStore store, CorePublicOriginResolver origins, CancellationToken ct) => await HandleAsync(async () =>
            {
                var caller = await service.AuthenticateAppAsync(appId, request, ct);
                var entry = service.Owned(id, caller);
                await service.RequirePermissionAsync(caller, entry.Permission, ct);
                store.Submit(entry, input);
                return CoreJson.Json(store.View(entry, origins.Effective));
            }));
        app.MapGet("/api/internal/apps/{appId}/installations/{id}", async (string appId, string id,
            HttpRequest request, InstallationApprovalService service, InstallationApprovalStore store,
            CorePublicOriginResolver origins, CancellationToken ct) => await HandleAsync(async () =>
                CoreJson.Json(store.View(service.Owned(id, await service.AuthenticateAppAsync(appId, request, ct)), origins.Effective))));

        app.MapGet("/install/confirm/{id}", async (string id, HttpContext context,
            InstallationApprovalStore store, UserDirectoryStore users, AppRegistryStore apps, IClock clock) => await HandleAsync(async () =>
            {
                ProtectPage(context.Response);
                if (!await HasIsolatedCookieHostAsync(context.Request, apps, context.RequestAborted))
                    return Results.Content("Core confirmation requires a hostname that no runtime app uses. Configure a separate Core public origin, then sign in there again.", "text/plain", statusCode: 409);
                // Cross-origin fetch must not read the nonce, including from the legacy Shell origin.
                if (!IsPageNavigation(context.Request)) return Results.StatusCode(403);
                var actor = await BrowserActorAsync(context.Request, users, clock, context.RequestAborted);
                if (actor is null)
                    return Results.Redirect($"/login?returnTo={Uri.EscapeDataString($"/install/confirm/{id}")}");
                if (!AppAccessPolicy.IsAdmin(actor)) return Results.StatusCode(403);
                var entry = store.Get(id);
                if (entry.UserId != actor.Id) return Results.StatusCode(403);
                var nonce = store.IssueNonce(entry, CoreSessionAuthorization.ReadSessionId(context.Request)!);
                return Results.Content(Render(entry, nonce), "text/html");
            })).WithMetadata(new DisableCorsAttribute());
        app.MapPost("/install/confirm/{id}", async (string id, HttpContext context,
            InstallationApprovalStore store, InstallationApprovalService service,
            UserDirectoryStore users, AppRegistryStore apps, IClock clock, IHostApplicationLifetime lifetime) => await HandleAsync(async () =>
            {
                ProtectPage(context.Response);
                if (!await HasIsolatedCookieHostAsync(context.Request, apps, context.RequestAborted))
                    return Results.Content("Core confirmation requires a hostname that no runtime app uses. Configure a separate Core public origin, then sign in there again.", "text/plain", statusCode: 409);
                if (!IsSameOriginDecision(context.Request))
                    return Results.Text("Confirmation must be submitted from its Core page. Open the confirmation link again.", statusCode: 403);
                var actor = await BrowserActorAsync(context.Request, users, clock, context.RequestAborted);
                if (actor is null || !AppAccessPolicy.IsAdmin(actor)) return Results.StatusCode(403);
                var entry = store.Get(id);
                if (entry.UserId != actor.Id) return Results.StatusCode(403);
                var form = await context.Request.ReadFormAsync(context.RequestAborted);
                var approve = form["decision"] == "approve";
                store.Decide(entry, form["nonce"].ToString(), CoreSessionAuthorization.ReadSessionId(context.Request)!, approve);
                await service.RecordAsync(entry, approve ? "approved" : "denied", lifetime.ApplicationStopping);
                // The accepted decision outlives this window. The app polls Core for completion;
                // closing the popup must not cancel installation or wait for runtime startup.
                if (approve) _ = service.ExecuteAsync(entry, lifetime.ApplicationStopping);
                ProtectPage(context.Response, closeWindow: true);
                return Results.Content(Render(entry, "", closeWindow: true), "text/html");
            })).WithMetadata(new DisableCorsAttribute());
    }

    internal static bool IsPageNavigation(HttpRequest request)
        => (request.Headers["Sec-Fetch-Mode"].Count == 0 || request.Headers["Sec-Fetch-Mode"] == "navigate")
           && (request.Headers["Sec-Fetch-Dest"].Count == 0 || request.Headers["Sec-Fetch-Dest"] == "document");

    internal static bool IsSameOriginDecision(HttpRequest request)
        => request.HasFormContentType &&
           string.Equals(request.Headers.Origin.ToString(), $"{request.Scheme}://{request.Host}", StringComparison.OrdinalIgnoreCase)
           && (request.Headers["Sec-Fetch-Site"].Count == 0 || request.Headers["Sec-Fetch-Site"] == "same-origin");

    internal static async Task<bool> HasIsolatedCookieHostAsync(HttpRequest request, AppRegistryStore apps, CancellationToken ct)
    {
        // Cookies are scoped by host, not port. A server on another localhost port receives the
        // Core cookie too. Never claim an app-resistant decision on a shared cookie host.
        var host = request.Host.Host;
        foreach (var app in await apps.ListAppRecordsAsync(ct))
        {
            foreach (var endpoint in app.Endpoints.Where(endpoint => endpoint.Public))
            {
                var configured = app.Settings.TryGetValue(PublicOriginSettings.BuildSettingKey(endpoint.Key), out var setting) ? setting.Value : null;
                foreach (var origin in new[] { endpoint.Url, configured })
                    if (Uri.TryCreate(origin, UriKind.Absolute, out var uri) && string.Equals(uri.Host, host, StringComparison.OrdinalIgnoreCase)) return false;
            }
        }
        return true;
    }

    private static async Task<HostUserRecord?> BrowserActorAsync(HttpRequest request, UserDirectoryStore users, IClock clock, CancellationToken ct)
    {
        var credential = CoreSessionAuthorization.ReadSessionCredential(request);
        if (credential.Source != SessionCredentialSource.Cookie) return null;
        var state = await users.ReadAsync(ct);
        if (state.Sessions.FirstOrDefault(session => session.Id == credential.Value) is not { Kind: null } session ||
            !string.Equals(session.BrowserOrigin, $"{request.Scheme}://{request.Host}", StringComparison.OrdinalIgnoreCase)) return null;
        return await CoreSessionAuthorization.TryResolveSessionAsync(request, users, clock, ct);
    }

    private static Task<IResult> BrowserAsync(HttpRequest request, UserDirectoryStore users, IClock clock,
        Func<InstallationCaller, Task<IResult>> action, CancellationToken ct, bool csrf = true)
        => CoreSessionAuthorization.RequireSessionAsync(request, users, clock, user => AppAccessPolicy.IsAdmin(user)
            ? HandleAsync(() => action(new(user.Id, null, null, "Host management client")))
            : Task.FromResult<IResult>(CoreJson.Json(new ErrorResponse("admin_required", "Administrator access is required."), 403)),
            requireCsrf: csrf, cancellationToken: ct);

    private static async Task<IResult> HandleAsync(Func<Task<IResult>> action)
    {
        try { return await action(); }
        catch (AppIdentityException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), AuthEndpoints.MapIdentityErrorStatus(ex.Code)); }
        catch (AppLifecycleException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), 409); }
        catch (AppManifestException ex) { return CoreJson.Json(new ErrorResponse("manifest_invalid", ex.Message), 400); }
    }

    private const string CloseWindowScript = "window.close();";
    private static readonly string CloseWindowScriptHash = Convert.ToBase64String(SHA256.HashData(Encoding.UTF8.GetBytes(CloseWindowScript)));

    private static void ProtectPage(HttpResponse response, bool closeWindow = false)
    {
        response.Headers.CacheControl = "no-store";
        response.Headers["Content-Security-Policy"] = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'";
        if (closeWindow)
            response.Headers["Content-Security-Policy"] += $"; script-src 'sha256-{CloseWindowScriptHash}'";
        response.Headers["X-Frame-Options"] = "DENY";
        // no-referrer makes browsers send Origin: null for native form POSTs. Keep same-origin
        // form submissions verifiable while disclosing no referrer to other origins.
        response.Headers["Referrer-Policy"] = "same-origin";
        response.Headers["Cross-Origin-Opener-Policy"] = "same-origin";
    }

    internal static string Render(InstallationApproval entry, string nonce, bool closeWindow = false)
    {
        static string E(string? text) => WebUtility.HtmlEncode(text ?? "");
        var installing = entry.InstallPlan is not null;
        var title = installing ? "Confirm app installation" : "Confirm app update";
        var name = entry.InstallPlan?.DisplayName ?? entry.UpdatePlan?.AppId;
        var permissions = entry.InstallPlan?.CorePermissions ?? entry.UpdatePlan?.TargetCorePermissions ?? [];
        var before = entry.UpdatePlan?.CurrentCorePermissions ?? [];
        var rights = permissions.Count == 0 ? "<li>No Core permissions requested</li>" : string.Join("", permissions.Select(p =>
            $"<li>{E(CoreAppPermissions.Describe(p))}{(!installing && !before.Contains(p, StringComparer.Ordinal) ? " <strong>(new)</strong>" : "")}</li>"));
        var removed = before.Except(permissions, StringComparer.Ordinal).Select(p => $"<li>Removed: {E(CoreAppPermissions.Describe(p))}</li>");
        var source = entry.FeedsUrl ?? entry.InstallPlan?.ManifestPath ?? entry.UpdatePlan?.ManifestPath;
        var warning = entry.InstallPlan?.TargetRuntimeType == "localCommand"
            ? "<p class=warning>This app runs commands directly on your host, outside a container. Only install code you trust.</p>" : "";
        var body = entry.Status == "pending"
            ? $"<p><strong>{E(name)}</strong> · {E(entry.InstallPlan?.TargetVersion ?? entry.UpdatePlan?.TargetVersion)}</p><p>Requested by {E(entry.CallerName)}</p><p class=source>Source: {E(source)}</p><h2>Core permissions</h2><ul>{rights}{string.Join("", removed)}</ul>{warning}<form method=post><input type=hidden name=nonce value=\"{E(nonce)}\"><button name=decision value=deny>Cancel</button><button class=primary name=decision value=approve>{(installing ? "Install app" : "Apply update")}</button></form>"
            : $"<p role=status>{E(entry.Status switch { "succeeded" => "Completed. You can close this window.", "denied" => "Cancelled. Nothing was changed. You can close this window.", "failed" => entry.Error ?? "The operation failed.", "executing" => "Your request was accepted. Follow its progress in the app. You can close this window.", _ => "Finish preparing this request in the app first." })}</p>";
        if (closeWindow) body += $"<script>{CloseWindowScript}</script>";
        return $"<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>{title} — Hosty Core</title><style>:root{{color-scheme:light dark;font-family:system-ui}}body{{margin:0;padding:24px;background:Canvas;color:CanvasText}}main{{max-width:560px;margin:8vh auto}}h1{{font-size:1.5rem}}h2{{font-size:1rem}}li{{margin:12px 0}}.source{{overflow-wrap:anywhere;font-size:.9rem;opacity:.75}}.warning{{padding:12px;border:1px solid #b7791f;border-radius:8px}}form{{display:flex;justify-content:flex-end;gap:12px;margin-top:32px}}button{{font:inherit;padding:10px 18px;border:1px solid GrayText;border-radius:8px;cursor:pointer}}.primary{{background:#2563eb;color:white;border-color:#2563eb}}button:focus-visible{{outline:3px solid #60a5fa;outline-offset:3px}}</style><main><p>HOSTY CORE</p><h1>{title}</h1>{body}</main></html>";
    }
}
