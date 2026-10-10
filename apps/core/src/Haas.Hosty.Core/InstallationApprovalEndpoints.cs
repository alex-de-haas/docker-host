using System.Net;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Cors;

namespace Haas.Hosty.Core;

internal sealed record InstallationCaller(string UserId, string? AppId, string? Token, string Name);

internal sealed class InstallationApprovalService(
    InstallationApprovalStore approvals, CoreLifecycleService lifecycle, AppRegistryStore apps,
    AppIdentityService identity, AppServiceTokenService serviceTokens, AuditStore audit, IClock clock,
    PrivateSourceService? privateSources = null, AppManifestService? manifests = null, HostPathApprovalService? hostPaths = null, AgentMcpDirectory? agents = null)
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

    private async Task RequireSourceConnectionsAsync(InstallationCaller caller, CancellationToken ct)
    {
        if (caller.AppId is null) return;
        var app = await apps.GetAppAsync(caller.AppId, ct);
        if (app is null || (!AppManagementAuthorization.HasPermission(app, CoreAppPermissions.Sources) &&
            !AppManagementAuthorization.HasPermission(app, CoreAppPermissions.SourceConnections)))
            throw new AppIdentityException("app_permission_required", "Private source selection requires apps.sources.full or sources.connections.");
    }

    public async Task<InstallationApproval> PrepareAsync(InstallationCaller caller, InstallationPrepare input, CancellationToken ct)
    {
        if (input.HostPathChange is { } change)
        {
            if (input.RemoveAppId is not null || input.RemovalOptions is not null || input.PermissionsAppId is not null ||
                input.UpdateAppId is not null || input.ManifestPath is not null || input.FeedsUrl is not null ||
                input.FeedId is not null || input.SelectedRuntime is not null || input.PlanDigest is not null || input.SourceConnections is not null)
                throw new AppLifecycleException("host_path_request_invalid", "Choose a single host path operation.");
            await RequirePermissionAsync(caller, change.Permission, ct);
            var pathEntry = approvals.Add(new InstallationApproval
            {
                UserId = caller.UserId, CallerAppId = caller.AppId, IdentityToken = caller.Token,
                CallerName = caller.Name, ExpiresAt = clock.UtcNow.Add(InstallationApprovalStore.Lifetime),
                HostPathPlan = await (hostPaths ?? throw new InvalidOperationException()).PrepareAsync(change, caller.UserId, ct),
            });
            await RecordAsync(pathEntry, "requested", ct);
            return pathEntry;
        }
        if (input.RemoveAppId is not null || input.RemovalOptions is not null)
        {
            if (string.IsNullOrWhiteSpace(input.RemoveAppId) || input.PermissionsAppId is not null ||
                input.UpdateAppId is not null || input.ManifestPath is not null || input.FeedsUrl is not null ||
                input.FeedId is not null || input.SelectedRuntime is not null || input.PlanDigest is not null || input.SourceConnections is not null)
                throw new AppLifecycleException("removal_request_invalid", "Choose one installed app to remove; removal cannot be combined with other operations.");
            await RequirePermissionAsync(caller, CoreAppPermissions.Install, ct);
            var removalEntry = approvals.Add(new InstallationApproval
            {
                UserId = caller.UserId, CallerAppId = caller.AppId, IdentityToken = caller.Token,
                CallerName = caller.Name, ExpiresAt = clock.UtcNow.Add(InstallationApprovalStore.Lifetime),
                RemovalPlan = await lifecycle.CreateRemovalPlanAsync(input.RemoveAppId, input.RemovalOptions ?? new(), ct),
            });
            await RecordAsync(removalEntry, "requested", ct);
            return removalEntry;
        }
        if (input.PermissionsAppId is { } targetId)
        {
            if (caller.AppId is not null && caller.AppId != targetId)
                throw new AppIdentityException("app_access_denied", "An app may request changes only to its own permissions.");
            var target = await apps.GetAppAsync(targetId, ct)
                ?? throw new AppIdentityException("app_access_denied", "The app is not installed.");
            var permissionEntry = approvals.Add(new InstallationApproval
            {
                UserId = caller.UserId, CallerAppId = caller.AppId, IdentityToken = caller.Token,
                CallerName = caller.Name, ExpiresAt = clock.UtcNow.Add(InstallationApprovalStore.Lifetime),
                PermissionPlan = await lifecycle.CreatePermissionPlanAsync(target.Id, ct),
            });
            await RecordAsync(permissionEntry, "requested", ct);
            return permissionEntry;
        }
        var update = !string.IsNullOrWhiteSpace(input.UpdateAppId);
        await RequirePermissionAsync(caller, CoreAppPermissions.Install, ct);
        var installed = update ? await apps.GetAppAsync(input.UpdateAppId!, ct) : null;
        var requiresSources = input.SourceConnections is not null || HasPrivateSources(installed?.PrivateSources);
        if (requiresSources) await RequireSourceConnectionsAsync(caller, ct);
        RequireSourceOwner(caller.UserId, installed?.PrivateSources);
        var access = installed?.PrivateSources;
        if (input.SourceConnections is { } choice)
        {
            if (new[] { access?.Manifest, access?.Git }.OfType<SourceReadGrant>().Any(g => g.OwnerId != caller.UserId))
                throw PrivateSourceService.Denied("Only the source owner can replace these connections.");
            var sourceUrl = input.ManifestPath ?? installed?.ManifestUrl ?? installed?.InstallManifestPath ?? throw PrivateSourceService.Denied("Enter the manifest URL.");
            var reader = privateSources ?? throw PrivateSourceService.Denied();
            if ((choice.ClearManifestConnection && !string.IsNullOrWhiteSpace(choice.ManifestConnectionId)) ||
                (choice.ClearGitConnection && !string.IsNullOrWhiteSpace(choice.GitConnectionId)))
                throw PrivateSourceService.Denied("Choose either a connection or public access for each source.");
            var manifestGrant = choice.ClearManifestConnection ? null : string.IsNullOrWhiteSpace(choice.ManifestConnectionId) ? access?.Manifest
                : await reader.BindAsync(caller.UserId, choice.ManifestConnectionId, sourceUrl, true, ct);
            SourceReadGrant? gitGrant = choice.ClearGitConnection ? null : access?.Git;
            if (!string.IsNullOrWhiteSpace(choice.GitConnectionId))
            {
                var selected = await (manifests ?? throw PrivateSourceService.Denied()).LoadAsync(sourceUrl,
                    input.SelectedRuntime ?? installed?.SelectedRuntime, ct, manifestGrant: manifestGrant);
                var repository = selected.Manifest.Source?.Repository ?? throw PrivateSourceService.Denied("The manifest does not declare a Git source.");
                gitGrant = await reader.BindAsync(caller.UserId, choice.GitConnectionId, repository, false, ct);
            }
            access = new(manifestGrant, gitGrant);
        }
        AppInstallPlan? plan = null;
        AppUpdatePlan? updatePlan = null;
        AppFeedInstallPlan? feed = null;
        if (update)
        {
            updatePlan = input.SourceConnections is not null || string.IsNullOrWhiteSpace(input.PlanDigest)
                ? await lifecycle.CreateUpdatePlanAsync(input.UpdateAppId!, new AppUpdatePlanRequest(input.ManifestPath, input.SelectedRuntime) { PrivateSources = access }, ct)
                : await lifecycle.GetReviewedUpdatePlanAsync(input.UpdateAppId!, input.PlanDigest);
        }
        else if (!string.IsNullOrWhiteSpace(input.FeedsUrl))
        {
            if (input.SourceConnections is not null) throw PrivateSourceService.Denied("Private feeds are not supported. Use a direct manifest URL.");
            feed = await lifecycle.CreateApprovalFeedPlanAsync(new(input.FeedsUrl, input.FeedId, input.SelectedRuntime), ct);
            plan = feed.Install;
        }
        else
        {
            if (string.IsNullOrWhiteSpace(input.ManifestPath))
                throw new AppLifecycleException("manifest_path_required", "A manifest or feed source is required.");
            plan = await lifecycle.CreateInstallPlanAsync(new AppInstallPlanRequest(input.ManifestPath, input.SelectedRuntime) { PrivateSources = access }, ct);
        }
        if (plan is { Action: not "install" })
            throw new AppLifecycleException("already_installed", "This app is already installed. Use its update flow.");
        // Cached plans may contain a newly selected binding absent from the installed record.
        requiresSources |= HasPrivateSources(plan?.PrivateSources) || HasPrivateSources(updatePlan?.PrivateSources);
        if (requiresSources) await RequireSourceConnectionsAsync(caller, ct);
        RequireSourceOwner(caller.UserId, plan?.PrivateSources);
        RequireSourceOwner(caller.UserId, updatePlan?.PrivateSources);
        var entry = approvals.Add(new InstallationApproval
        {
            RequiresSources = requiresSources,
            UserId = caller.UserId, CallerAppId = caller.AppId, IdentityToken = caller.Token,
            CallerName = caller.Name, ExpiresAt = clock.UtcNow.Add(InstallationApprovalStore.Lifetime),
            InstallPlan = plan, UpdatePlan = updatePlan, FeedsUrl = feed?.FeedsUrl, FeedId = feed?.FeedId,
        });
        await RecordAsync(entry, "requested", ct);
        return entry;
    }

    private static bool HasPrivateSources(PrivateSourceAccess? access) => access?.Manifest is not null || access?.Git is not null;

    private static void RequireSourceOwner(string userId, PrivateSourceAccess? access)
    {
        if (new[] { access?.Manifest, access?.Git }.OfType<SourceReadGrant>().Any(g => g.OwnerId != userId))
            throw PrivateSourceService.Denied("Only the source owner can review these private connections.");
    }

    public async Task RequireRequestPermissionsAsync(InstallationCaller caller, InstallationApproval entry, CancellationToken ct)
    {
        if (entry.Permission is { } permission) await RequirePermissionAsync(caller, permission, ct);
        if (entry.RequiresSources) await RequireSourceConnectionsAsync(caller, ct);
    }

    public Task RecordAsync(InstallationApproval entry, string outcome, CancellationToken ct)
        => audit.AppendAsync(new AuditRecord($"audit_{Guid.NewGuid():N}", entry.AssistantAccessPlan is not null ? "app.mcp.approval" : entry.PermissionPlan is null ? "app.installation.approval" : "app.permissions.approval", "app",
            entry.AssistantAccessPlan?.AssistantId ?? entry.HostPathPlan?.Change.AppId ?? entry.PermissionPlan?.AppId ?? entry.RemovalPlan?.AppId ?? entry.InstallPlan?.AppId ?? entry.UpdatePlan?.AppId, outcome, entry.UserId, clock.UtcNow,
            new Dictionary<string, string> { ["requestId"] = entry.Id, ["caller"] = entry.CallerAppId ?? "operator",
                ["hostPathChange"] = entry.HostPathPlan is { } path ? CoreJson.Text(path.Change) : "",
                ["operation"] = entry.AssistantAccessPlan is not null ? "mcp-access" : entry.HostPathPlan?.Change.Kind ?? (entry.RemovalPlan is not null ? "remove" : entry.PermissionPlan is not null ? "permissions" : entry.UpdatePlan is not null ? "update" : "install"),
                ["removalOptions"] = entry.RemovalPlan is { } removal ? CoreJson.Text(removal.Options) : "",
                ["assistantTarget"] = entry.AssistantAccessPlan?.Target.Id ?? "",
                ["assistantAccessEnabled"] = entry.AgentEnabled.ToString(),
                ["assistantInstructions"] = string.Join(",", entry.AgentSkills),
                ["selectedOptionalPermissions"] = string.Join(",", entry.SelectedOptionalPermissions ?? []) }), ct);

    public InstallationApproval Owned(string id, InstallationCaller caller)
    {
        var entry = approvals.Get(id);
        if (entry.UserId != caller.UserId || entry.CallerAppId != caller.AppId)
            throw new AppIdentityException("app_access_denied", "This request belongs to another caller.");
        return entry;
    }

    public async Task SubmitAsync(InstallationApproval entry, InstallationSubmit input, CancellationToken ct)
    {
        var reviewed = entry.InstallPlan is { } plan
            ? await lifecycle.GetReviewedInstallReadinessAsync(plan, input.Settings, ct) : null;
        approvals.Submit(entry, input, reviewed);
    }

    public async Task<AppInstallPlan> SelectRuntimeAsync(InstallationApproval entry, string runtime, CancellationToken ct)
    {
        var plan = entry.InstallPlan ?? throw new AppLifecycleException("approval_invalid", "Only installation has a runtime choice.");
        return await lifecycle.SelectReviewedInstallRuntimeAsync(plan, runtime, entry.Settings, ct);
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
                await RequireRequestPermissionsAsync(new(entry.UserId, appId, entry.IdentityToken, entry.CallerName), entry, ct);
            }
            if (entry.AssistantAccessPlan is { } agentPlan)
                await (agents ?? throw new InvalidOperationException()).ApplyAssistantReviewAsync(agentPlan,
                    entry.AgentEnabled, entry.AgentSkills, entry.UserId, ct);
            else if (entry.HostPathPlan is { } pathPlan)
                await (hostPaths ?? throw new InvalidOperationException()).ApplyAsync(pathPlan, entry.UserId, ct, async () =>
                {
                    if (entry.CallerAppId is not { } callerAppId) return;
                    var currentActor = await identity.RevalidateAsync(entry.IdentityToken, callerAppId, ct);
                    if (currentActor.UserId != entry.UserId || currentActor.HostRole != "host.admin")
                        throw new AppIdentityException("admin_required", "The requesting administrator no longer has access.");
                    await RequireRequestPermissionsAsync(new(entry.UserId, callerAppId, entry.IdentityToken, entry.CallerName), entry, ct);
                });
            else if (entry.PermissionPlan is { } permissionPlan)
                await lifecycle.ApplyOptionalPermissionsAsync(permissionPlan, entry.SelectedOptionalPermissions ?? [], ct);
            else if (entry.RemovalPlan is { } removal)
                _ = await lifecycle.ApplyRemovalAsync(removal, ct);
            else if (entry.UpdatePlan is { } update)
                _ = await lifecycle.ApplyUpdateAsync(update.AppId, new(PlanDigest: update.PlanDigest,
                    OptionalPermissions: entry.SelectedOptionalPermissions), ct);
            else if (entry.InstallPlan is { } plan)
                _ = await lifecycle.InstallAsync(new(plan.ManifestPath, plan.TargetRuntime,
                    Settings: entry.Settings, Autostart: entry.Autostart, PlanId: plan.PlanId,
                    StartOnInstall: true, FeedsUrl: entry.FeedsUrl, FeedId: entry.FeedId,
                    OptionalPermissions: entry.SelectedOptionalPermissions), ct);
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
                return SubmitAsync(entry);
                async Task<IResult> SubmitAsync(InstallationApproval pending)
                {
                    await service.RequireRequestPermissionsAsync(caller, pending, ct);
                    await service.SubmitAsync(pending, input, ct);
                    return CoreJson.Json(store.View(pending, origins.Effective));
                }
            }, ct));
        app.MapGet("/api/apps/{id}/permissions", async (string id, HttpRequest request,
            UserDirectoryStore users, IClock clock, CoreLifecycleService lifecycle, CancellationToken ct) =>
            await BrowserAsync(request, users, clock, async _ =>
                CoreJson.Json(await lifecycle.ObservePermissionsAsync(id, true, ct)), ct, csrf: false));
        app.MapGet("/api/installations/{id}", async (string id, HttpRequest request,
            UserDirectoryStore users, IClock clock, InstallationApprovalService service,
            InstallationApprovalStore store, CorePublicOriginResolver origins, CancellationToken ct) =>
            await BrowserAsync(request, users, clock, async caller =>
            {
                var entry = service.Owned(id, caller);
                await service.RequireRequestPermissionsAsync(caller, entry, ct);
                return CoreJson.Json(store.View(entry, origins.Effective));
            }, ct, csrf: false));

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
                await service.RequireRequestPermissionsAsync(caller, entry, ct);
                await service.SubmitAsync(entry, input, ct);
                return CoreJson.Json(store.View(entry, origins.Effective));
            }));
        app.MapGet("/api/internal/apps/{appId}/installations/{id}", async (string appId, string id,
            HttpRequest request, InstallationApprovalService service, InstallationApprovalStore store,
            CorePublicOriginResolver origins, CancellationToken ct) => await HandleAsync(async () =>
            {
                var caller = await service.AuthenticateAppAsync(appId, request, ct);
                var entry = service.Owned(id, caller);
                await service.RequireRequestPermissionsAsync(caller, entry, ct);
                return CoreJson.Json(store.View(entry, origins.Effective));
            }));

        app.MapGet("/install/agents/{appId}/{targetId}", async (string appId, string targetId, HttpContext context,
            InstallationApprovalStore store, AgentMcpDirectory agents, InstallationApprovalService service,
            UserDirectoryStore users, AppRegistryStore apps, IClock clock) => await HandleAsync(async () =>
            {
                ProtectPage(context.Response);
                if (!await HasIsolatedCookieHostAsync(context.Request, apps, context.RequestAborted))
                    return Results.Text("Open MCP review on Core's isolated browser origin.", statusCode: 409);
                if (!IsPageNavigation(context.Request)) return Results.StatusCode(403);
                var actor = await BrowserActorAsync(context.Request, users, clock, context.RequestAborted);
                if (actor is null)
                    return Results.Redirect($"/login?returnTo={Uri.EscapeDataString(context.Request.Path)}");
                if (!AppAccessPolicy.IsAdmin(actor)) return Results.StatusCode(403);
                var plan = await agents.ReviewAssistantAsync(appId, targetId, context.RequestAborted);
                var entry = store.Add(new InstallationApproval { UserId = actor.Id, CallerName = "Core MCP review",
                    ExpiresAt = clock.UtcNow.Add(InstallationApprovalStore.Lifetime), AssistantAccessPlan = plan });
                await service.RecordAsync(entry, "requested", context.RequestAborted);
                store.Submit(entry, new());
                return Results.Redirect($"/install/confirm/{entry.Id}");
            })).WithMetadata(new DisableCorsAttribute());

        app.MapGet("/install/permissions/{appId}", async (string appId, HttpContext context,
            InstallationApprovalStore store, InstallationApprovalService service,
            UserDirectoryStore users, AppRegistryStore apps, IClock clock) => await HandleAsync(async () =>
            {
                ProtectPage(context.Response);
                if (!await HasIsolatedCookieHostAsync(context.Request, apps, context.RequestAborted))
                    return Results.Text("Open permission review on Core's isolated browser origin.", statusCode: 409);
                if (!IsPageNavigation(context.Request)) return Results.StatusCode(403);
                var actor = await BrowserActorAsync(context.Request, users, clock, context.RequestAborted);
                if (actor is null)
                    return Results.Redirect($"/login?returnTo={Uri.EscapeDataString($"/install/permissions/{appId}")}");
                if (!AppAccessPolicy.IsAdmin(actor)) return Results.StatusCode(403);
                var entry = await service.PrepareAsync(new(actor.Id, null, null, "Core permission recovery"),
                    new(PermissionsAppId: appId), context.RequestAborted);
                store.Submit(entry, new());
                return Results.Redirect($"/install/confirm/{entry.Id}");
            })).WithMetadata(new DisableCorsAttribute());

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
            UserDirectoryStore users, AppRegistryStore apps, IClock clock, IHostApplicationLifetime lifetime,
            ILogger<InstallationApprovalService> logger) => await HandleAsync(async () =>
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
                var nonce = form["nonce"].ToString();
                var sessionId = CoreSessionAuthorization.ReadSessionId(context.Request)!;
                bool? autostart = form["installOptions"] == "true" ? form["autostart"] == "true" : null;
                if (entry.InstallPlan is { } install && (approve || form["decision"] == "runtime"))
                {
                    store.RequireDecisionNonce(entry, nonce, sessionId);
                    var runtime = form["runtime"].Count == 0 ? install.TargetRuntime : form["runtime"].ToString();
                    if (runtime != install.TargetRuntime || form["decision"] == "runtime")
                    {
                        var changed = await service.SelectRuntimeAsync(entry, runtime, context.RequestAborted);
                        store.ChangeInstallRuntime(entry, nonce, sessionId, changed, autostart);
                        return Results.Content(Render(entry, store.IssueNonce(entry, sessionId),
                            notice: "Review the selected runtime before installing."), "text/html");
                    }
                }
                else if (form["decision"] == "runtime")
                    throw new AppLifecycleException("approval_invalid", "This request has no runtime choice.");
                store.Decide(entry, nonce, sessionId, approve, form["optionalPermission"].Select(p => p!).ToArray(),
                    form["agentEnabled"] == "true", form["agentSkill"].Select(p => p!).ToArray(), autostart);
                try
                {
                    await service.RecordAsync(entry, approve ? "approved" : "denied", lifetime.ApplicationStopping);
                }
                catch (Exception ex)
                {
                    // The nonce is already consumed. Fail closed, clear credentials and allow normal
                    // expiration instead of leaving an executing request with no worker to finish it.
                    store.Complete(entry, "The decision could not be recorded. No operation was started. Prepare a new request after Core's audit log is available.");
                    logger.LogError(ex, "Could not record installation decision for request {RequestId}", entry.Id);
                    return Results.Content(Render(entry, ""), "text/html", statusCode: 503);
                }
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
                foreach (var origin in new[] { endpoint.Url, configured, LocalBrowserOrigins.App(app, endpoint) })
                    if (Uri.TryCreate(origin, UriKind.Absolute, out var uri) && string.Equals(uri.Host, host, StringComparison.OrdinalIgnoreCase)) return false;
            }
        }
        return true;
    }

    internal static async Task<HostUserRecord?> BrowserActorAsync(HttpRequest request, UserDirectoryStore users, IClock clock, CancellationToken ct)
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
            ? HandleAsync(() => action(AppManagementAuthorization.Caller(request) is { } caller
                ? new(user.Id, caller.App.Id, request.Headers[AppManagementAuthorization.IdentityHeader].ToString(), caller.App.DisplayName)
                : new(user.Id, null, null, "Host management client")))
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

    internal static void ProtectPage(HttpResponse response, bool closeWindow = false)
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

    internal static string Render(InstallationApproval entry, string nonce, bool closeWindow = false, string? notice = null)
    {
        static string E(string? text) => WebUtility.HtmlEncode(text ?? "");
        var installing = entry.InstallPlan is not null;
        var title = entry.AssistantAccessPlan is not null ? "Review assistant MCP access" : entry.HostPathPlan is not null ? "Confirm host path access" : entry.RemovalPlan is not null ? "Confirm app removal" : entry.PermissionPlan is not null ? "Review app permissions" : installing ? "Confirm app installation" : "Confirm app update";
        var name = entry.AssistantAccessPlan?.DisplayName ?? entry.HostPathPlan?.DisplayName ?? entry.RemovalPlan?.DisplayName ?? entry.PermissionPlan?.DisplayName ?? entry.InstallPlan?.DisplayName ?? entry.UpdatePlan?.DisplayName ?? entry.UpdatePlan?.AppId;
        var permissions = entry.PermissionPlan?.Required ?? entry.InstallPlan?.CorePermissions ?? entry.UpdatePlan?.TargetCorePermissions ?? [];
        var before = entry.PermissionPlan?.Granted ?? entry.UpdatePlan?.CurrentCorePermissions ?? [];
        var optional = entry.PermissionPlan?.Optional ?? entry.InstallPlan?.OptionalCorePermissions ?? entry.UpdatePlan?.TargetOptionalCorePermissions ?? [];
        string DeclarationChange(string permission, bool required)
        {
            var plan = entry.PermissionPlan;
            var update = entry.UpdatePlan;
            if (plan is null && update is null) return "";
            var requiredBefore = plan is not null ? plan.AcceptedRequired ?? plan.Required : update!.PreviousRequiredCorePermissions;
            var optionalBefore = plan is not null ? plan.AcceptedOptional ?? plan.Optional : update!.PreviousOptionalCorePermissions;
            if (requiredBefore is null || optionalBefore is null) return "";
            var wasRequired = requiredBefore.Contains(permission, StringComparer.Ordinal);
            var wasOptional = optionalBefore.Contains(permission, StringComparer.Ordinal);
            return required && wasOptional ? " <strong>(optional → required)</strong>"
                : !required && wasRequired ? " <strong>(required → optional)</strong>"
                : !wasRequired && !wasOptional ? " <strong>(new declaration)</strong>" : "";
        }
        // Defaults come only from the reviewed persisted grants, never the requesting app.
        // New installs have none; previously granted rights remain checked across declaration changes.
        var optionalDefaults = before;
        var optionalReview = optional.Count == 0 ? "" : "<fieldset><legend>Optional permissions</legend>" + string.Join("", optional.Select(p =>
            !CoreAppPermissions.Known.Contains(p, StringComparer.Ordinal)
                ? $"<p>Unsupported optional permission (not granted): <code>{E(p)}</code></p>"
                : $"<p><label><input type=checkbox name=optionalPermission value=\"{E(p)}\"{(optionalDefaults.Contains(p, StringComparer.Ordinal) ? " checked" : "")}> {E(CoreAppPermissions.Describe(p))} <code>{E(p)}</code>{DeclarationChange(p, false)}</label></p>")) + "</fieldset>";
        var rights = permissions.Count == 0 ? "<li>No Core permissions requested</li>" : string.Join("", permissions.Select(p =>
            $"<li>{E(CoreAppPermissions.Describe(p))} <code>{E(p)}</code>{DeclarationChange(p, true)}{(!installing && !before.Contains(p, StringComparer.Ordinal) ? " <span class=muted>(currently not granted; approval grants access)</span>" : "")}</li>"));
        var removed = before.Concat(entry.PermissionPlan?.AcceptedRequired ?? entry.UpdatePlan?.PreviousRequiredCorePermissions ?? []).Concat(entry.PermissionPlan?.AcceptedOptional ?? entry.UpdatePlan?.PreviousOptionalCorePermissions ?? []).Distinct(StringComparer.Ordinal).Except(permissions.Concat(optional), StringComparer.Ordinal).Select(p => $"<li>Removed: {E(CoreAppPermissions.Describe(p))}</li>");
        var roles = entry.InstallPlan?.RequestedRoles ?? entry.UpdatePlan?.TargetRoles ?? [];
        var previousRoles = entry.UpdatePlan?.CurrentConfirmedRoles ?? [];
        var roleItems = roles.Count == 0 ? "<li>No provider roles requested</li>" : string.Join("", roles.Select(role =>
            $"<li>{E(PlatformCapabilities.DescribeRole(role))}{(!installing && !previousRoles.Contains(role, StringComparer.Ordinal) ? " <strong>(new)</strong>" : "")}</li>"));
        roleItems += string.Join("", previousRoles.Except(roles, StringComparer.Ordinal).Select(role => $"<li>Removed: {E(PlatformCapabilities.DescribeRole(role))}</li>"));
        var source = entry.FeedsUrl ?? entry.InstallPlan?.ManifestPath ?? entry.UpdatePlan?.ManifestPath;
        var warning = entry.InstallPlan?.TargetRuntimeType is "localCommand" or "mixed"
            ? "<p class=warning>This app runs commands directly on your host, outside a container. Only install code you trust.</p>" : "";
        if (entry.InstallPlan is { System: true })
            warning += "<p class=warning><strong>System app.</strong> Administrators have access; other users need an explicit assignment. App permissions still apply.</p>";
        var access = entry.InstallPlan?.PrivateSources ?? entry.UpdatePlan?.PrivateSources;
        var grants = string.Join("", new[] { access?.Manifest, access?.Git }.OfType<SourceReadGrant>().Select(g =>
            $"<li>{E(g.ManifestUrl is null ? "Git source" : "Manifest and display assets")}: {E(g.ManifestUrl ?? g.Repository)} — {E(g.Label)} ({E(g.AccountName)})</li>"));
        if (access is not null)
            grants += (access.Manifest is null ? "<li>Manifest: no personal connection</li>" : "")
                + (access.Git is null ? "<li>Git source: no personal connection</li>" : "");
        var accessReview = grants.Length == 0 ? "" : $"<h2>Private source access</h2><ul>{grants}</ul><p>Allow Core to read these resources for this app, its background updates and source workspaces you request using your connections, including after you sign out. Disconnecting a connection or disabling your account blocks new reads; the installed app keeps running. Other app users do not receive your credentials.</p>";
        var version = entry.RemovalPlan?.Version ?? entry.InstallPlan?.TargetVersion ?? entry.UpdatePlan?.TargetVersion;
        var nameLine = $"<p><strong>{E(name)}</strong>{(version is null ? "" : " · " + E(version))}</p>";
        var sourceReview = string.IsNullOrWhiteSpace(source) ? "" : $"<p class=source>Source: {E(source)}</p>";
        if (entry.InstallPlan is { } feedInstall && !string.IsNullOrWhiteSpace(entry.FeedsUrl))
            sourceReview = $"<p class=source>Feed: {E(entry.FeedsUrl)}</p>"
                + (string.IsNullOrWhiteSpace(entry.FeedId) ? "" : $"<p class=source>Selected feed: {E(entry.FeedId)}</p>")
                + $"<p class=source>Manifest: {E(feedInstall.ManifestPath)}</p>";
        var sourceAndRoles = entry.PermissionPlan is not null ? "" : sourceReview
            + (roles.Count == 0 && previousRoles.Count == 0 ? "" : $"<h2>Provider roles</h2><ul>{roleItems}</ul>");
        var review = entry.AssistantAccessPlan is not null ? "" : entry.HostPathPlan is { } pathPlan ? "<ul>" + string.Join("", pathPlan.Details.Select(d => $"<li>{E(d)}</li>")) + "</ul>" : entry.RemovalPlan is { } removal ? RenderRemoval(removal, entry.CallerAppId)
            : $"{sourceAndRoles}{(permissions.Count == 0 && !removed.Any() ? "" : $"<h2>Core permissions</h2><ul>{rights}{string.Join("", removed)}</ul>")}{warning}{accessReview}";
        if (entry.UpdatePlan is { } updatePlan)
            review = RenderUpdateMetadata(updatePlan) + review;
        if (entry.InstallPlan is { ConfigurationReadiness.Required: true } installPlan)
            review += RenderConfigurationWarning(installPlan.ConfigurationReadiness, installPlan.AppId == "hosty.shell");
        var installChoices = entry.InstallPlan is { } installation ? RenderInstallChoices(installation, entry.Autostart) : "";
        var unavailableRuntime = entry.InstallPlan is { RuntimeChoices.Count: > 0 } runtimePlan &&
            !runtimePlan.RuntimeChoices.Any(choice => choice.Key == runtimePlan.TargetRuntime && choice.Available);
        if (entry.AssistantAccessPlan is { } agentPlan) optionalReview = RenderAssistantAccess(agentPlan);
        var action = entry.AssistantAccessPlan is not null ? "Save MCP access" : entry.HostPathPlan is not null ? "Approve change" : entry.RemovalPlan is not null ? "Remove app" : entry.PermissionPlan is not null ? "Save permissions" : installing ? "Install app" : "Apply update";
        var body = entry.Status == "pending"
            ? $"{nameLine}<p class=muted>Requested by {E(entry.CallerName)}</p>{(notice is null ? "" : $"<p role=status>{E(notice)}</p>")}{review}<form method=post>{installChoices}{optionalReview}<div class=actions><input type=hidden name=nonce value=\"{E(nonce)}\"><button name=decision value=deny>Cancel</button><button class=primary name=decision value=approve{(unavailableRuntime ? " disabled" : "")}>{action}</button></div></form>"
            : $"<p role=status>{E(entry.Status switch { "succeeded" => "Completed. You can close this window.", "denied" => "Cancelled. Nothing was changed. You can close this window.", "failed" => entry.Error ?? "The operation failed.", "executing" => "Your request was accepted. Follow its progress in the app. You can close this window.", _ => "Finish preparing this request in the app first." })}</p>";
        if (closeWindow) body += $"<script>{CloseWindowScript}</script>";
        return $"<!doctype html><html lang=en><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>{title} — Hosty Core</title><style>:root{{color-scheme:light dark;font-family:system-ui}}body{{margin:0;padding:24px;background:Canvas;color:CanvasText}}main{{max-width:560px;margin:0 auto}}h1{{font-size:1.5rem}}h2{{font-size:1rem}}li{{margin:8px 0;overflow-wrap:anywhere}}.muted{{font-size:.9rem;opacity:.75}}dl{{display:grid;grid-template-columns:110px minmax(0,1fr);gap:8px;font-size:.9rem}}dt{{opacity:.75}}dd{{margin:0;overflow-wrap:anywhere}}select{{font:inherit;padding:8px;max-width:100%}}button:disabled{{opacity:.5;cursor:default}}.source{{overflow-wrap:anywhere;font-size:.9rem;opacity:.75}}.warning{{padding:12px;border:1px solid #b7791f;border-radius:8px}}form{{margin-top:20px}}.actions{{display:flex;justify-content:flex-end;gap:12px;margin-top:24px}}fieldset{{min-width:0;border:1px solid GrayText;border-radius:8px}}button{{font:inherit;padding:10px 18px;border:1px solid GrayText;border-radius:8px;cursor:pointer}}.primary{{background:#2563eb;color:white;border-color:#2563eb}}button:focus-visible{{outline:3px solid #60a5fa;outline-offset:3px}}</style><main><p>HOSTY CORE</p><h1>{title}</h1>{body}</main></html>";
    }

    private static string RenderInstallChoices(AppInstallPlan plan, bool autostart)
    {
        static string E(string? value) => WebUtility.HtmlEncode(value ?? "");
        var choices = plan.RuntimeChoices.Count > 0 ? plan.RuntimeChoices : plan.RuntimeProfiles
            .Select(profile => new AppInstallRuntimeChoice(profile.Key, profile.Type, profile.Default, true)).ToArray();
        var options = string.Join("", choices.Select(choice =>
            $"<option value=\"{E(choice.Key)}\"{(choice.Key == plan.TargetRuntime ? " selected" : "")}{(!choice.Available ? " disabled" : "")}>{E(choice.Key)} · {E(choice.Type)}{(choice.Default ? " (default)" : "")}{(!choice.Available ? " (unavailable)" : "")}</option>"));
        var unavailable = choices.FirstOrDefault(choice => choice.Key == plan.TargetRuntime) is { Available: false } current
            ? $"<p class=warning>{E(current.Error ?? "The selected runtime is unavailable. Choose an available alternative.")}</p>" : "";
        return $"<input type=hidden name=installOptions value=true><fieldset><legend>Installation</legend>{unavailable}<p><label>Runtime <select name=runtime>{options}</select></label> <button name=decision value=runtime>Review runtime</button></p>"
            + $"<p><label><input type=checkbox name=autostart value=true{(autostart ? " checked" : "")}>Start automatically after installation and when Core starts</label></p></fieldset>";
    }

    private static string RenderConfigurationWarning(AppConfigurationReadiness readiness, bool shell = false)
    {
        static string E(string? value) => WebUtility.HtmlEncode(value ?? "");
        if (!readiness.Required) return "";
        var missing = readiness.MissingSettings.Select(key => $"<li>Setting: <code>{E(key)}</code></li>")
            .Concat(readiness.Mounts.Select(mount => $"<li>Mount: {E(mount.Label ?? mount.Key)} <code>{E(mount.Key)}</code></li>"));
        var items = string.Join("", missing);
        var guidance = shell
            ? "Shell stays offline after confirmation. Configure the missing launch settings or mounts through the local Core control API, then run <code>hosty apps start hosty.shell</code>. The automatic startup preference stays saved."
            : "After confirmation, this version stays stopped until configured. Start automatically stays saved. Open app settings in Shell, then start it explicitly.";
        return "<section class=warning><strong>Configuration required</strong><p>" + guidance + "</p>"
            + (items.Length == 0 ? "" : "<ul>" + items + "</ul>")
            + (readiness.Error is null ? "" : "<p>Core cannot verify the shared mount configuration. Check Core mount settings before starting.</p>")
            + "</section>";
    }

    private static string RenderUpdateMetadata(AppUpdatePlan plan)
    {
        static string E(string? value) => WebUtility.HtmlEncode(value ?? "");
        var runtime = plan.CurrentRuntime == plan.TargetRuntime
            ? E(plan.TargetRuntime) : $"{E(plan.CurrentRuntime)} → {E(plan.TargetRuntime)}";
        if (plan.TargetRuntimeType is not null && plan.TargetRuntimeType != plan.TargetRuntime)
            runtime += " · " + E(plan.TargetRuntimeType);
        var metadata = $"<dl><dt>Version</dt><dd>{E(plan.CurrentVersion)} → {E(plan.TargetVersion)}</dd><dt>Runtime</dt><dd>{runtime}</dd><dt>Backup</dt><dd>{(plan.WillCreatePreUpdateBackup ? "App data is backed up before updating" : "No app data backup is needed")}</dd></dl>";
        if (plan.FeedsUrl is not null) metadata += $"<p class=source>Feed: {E(plan.FeedsUrl)}{(plan.FeedId is null ? "" : " · " + E(plan.FeedId))}</p>";
        if (!plan.SourceConfigured) metadata += "<p class=warning>No external update source is configured. This review uses the selected manifest.</p>";
        if (plan.Error is not null) metadata += $"<p class=warning>{E(plan.Error)}</p>";
        if (plan.PreviousRequiredCorePermissions is null || plan.PreviousOptionalCorePermissions is null)
            metadata += "<p class=muted>Previous permission declarations are unavailable for this older installation. Current grants are shown separately; declaration changes are not inferred.</p>";
        if (plan.SettingChanges.Count > 0)
            metadata += "<h2>Settings changes</h2><ul>" + string.Join("", plan.SettingChanges.Select(change =>
                $"<li><code>{E(change.Key)}</code>{(change.Label is null ? "" : " · " + E(change.Label))}: {E(change.Change)}{(change.Detail is null ? "" : " — " + E(change.Detail))}</li>")) + "</ul>";
        var other = plan.Changes.Where(change => !change.StartsWith("version:", StringComparison.Ordinal)
            && !change.StartsWith("runtime:", StringComparison.Ordinal)
            && !(plan.SettingChanges.Count > 0 && change.StartsWith("setting:", StringComparison.Ordinal))
            && !change.StartsWith("Core permission ", StringComparison.Ordinal)
            && !change.StartsWith("Optional permission ", StringComparison.Ordinal)
            && !change.StartsWith("Provider role ", StringComparison.Ordinal)
            && change != "configuration:required").Select(DescribeUpdateChange).OfType<string>().ToArray();
        if (other.Length > 0)
        {
            var list = "<ul>" + string.Join("", other.Select(change => $"<li>{E(change)}</li>")) + "</ul>";
            metadata += other.Length > 8 ? $"<details><summary>Other changes ({other.Length})</summary>{list}</details>" : "<h2>Other changes</h2>" + list;
        }
        if (plan.ConfigurationReadiness is { Required: true } readiness) metadata += RenderConfigurationWarning(readiness, plan.AppId == "hosty.shell");
        if (plan.TargetRuntimeType is "localCommand" or "mixed") metadata += "<p class=warning>This update runs commands directly on your host, outside a container.</p>";
        return metadata;
    }

    private static string? DescribeUpdateChange(string change)
    {
        // Keep exact references and digests in the frozen plan; consent highlights source changes.
        var parts = change.Split(':', 3);
        if (parts.Length == 3 && parts[0] is "image" or "artifact" && parts[1].Length > 0)
        {
            var references = parts[2].Split("->", 2, StringSplitOptions.None);
            if (references.Length == 2 && references.All(reference => !string.IsNullOrWhiteSpace(reference)))
            {
                if (parts[0] == "artifact")
                    return references[1] == "unknown" ? $"Image for {parts[1]} could not be verified" : null;
                if (CoreLifecycleService.IsSameRepositoryImageChange(change)) return null;
                var current = CoreLifecycleService.ImageRepository(references[0]);
                var target = CoreLifecycleService.ImageRepository(references[1]);
                return references[0] == "none" ? $"Image source for {parts[1]} added: {target}"
                    : references[1] == "none" ? $"Image source for {parts[1]} removed: {current}"
                    : $"Image source for {parts[1]} changed: {current} → {target}";
            }
        }
        return change.StartsWith("source-access:", StringComparison.Ordinal)
            ? "Private source access changed; review the listed connections" : DescribeMountChange(change);
    }

    private static string DescribeMountChange(string change)
    {
        if (!change.StartsWith("mount:", StringComparison.Ordinal)) return change;
        var parts = change.Split(':', 4);
        if (parts.Length != 4) return change;
        var detail = parts[3].Replace("->", " → ", StringComparison.Ordinal);
        return parts[2] switch
        {
            "added" => $"Mount {parts[1]} added: {detail}",
            "removed" => $"Mount {parts[1]} removed: {detail}; saved bindings are retained but inactive",
            "mode" => $"Mount {parts[1]} access: {detail.Replace("ro", "read-only", StringComparison.Ordinal).Replace("rw", "read/write", StringComparison.Ordinal)}",
            "service" => $"Mount {parts[1]} service scope: {detail}",
            "multiple" => $"Mount {parts[1]} multiple bindings: {detail}",
            "required" => $"Mount {parts[1]} required at launch: {detail}",
            "kind" => $"Mount {parts[1]} source kind: {detail}",
            _ => change,
        };
    }

    private static string RenderAssistantAccess(AssistantAccessPlan plan)
    {
        static string E(string? value) => WebUtility.HtmlEncode(value ?? "");
        var target = plan.Target;
        var enabled = target.Offered && target.AssistantIds?.Contains(plan.AssistantId, StringComparer.Ordinal) == true;
        var skills = string.Join("", target.Skills.Select(skill =>
            $"<details><summary>{E(skill.Key)} instructions</summary><pre style='white-space:pre-wrap;overflow-wrap:anywhere'>{E(skill.Markdown ?? "Instructions unavailable")}</pre></details>"
            + (skill.Digest is null ? "" : skill.Digest == skill.ApprovedDigest
                ? "<p>These exact instructions are already approved.</p>"
                : $"<label><input type=checkbox name=agentSkill value=\"{E(skill.Key)}\">Approve these exact instructions for Hosty assistants</label>")));
        return $"<h2>{E(target.DisplayName)}</h2><p>Change MCP access for {E(plan.DisplayName)} only. Tool execution still requires a Core-authorized conversation and the acting user's access.</p>"
            + $"<label><input type=checkbox name=agentEnabled value=true{(enabled ? " checked" : "")}>Allow this assistant to use this application's MCP</label>"
            + (!target.Offered ? "<p class=warning>Enabling access also makes this target available in the host MCP directory. Other assistants are not assigned automatically.</p>" : "")
            + (skills.Length == 0 ? "<p>No application instructions.</p>" : "<h2>Application instructions</h2><p>Instruction approval is shared across Hosty consumers. Enabling access alone does not approve instructions.</p>" + skills);
    }

    private static string RenderRemoval(AppRemovalPlan plan, string? callerAppId)
    {
        static string E(string? text) => WebUtility.HtmlEncode(text ?? "");
        var options = plan.Options;
        var cleanup = $"<li>Runtime state: {(options.DeleteRuntimeState ? "delete" : "keep")}</li>"
            + $"<li>App data, cache, stored secrets and retained configuration: {(options.DeleteData ? "delete permanently" : "keep")}</li>"
            + $"<li>Backups: {(options.DeleteBackups ? "delete permanently" : "keep")}</li>"
            + $"<li>Managed source checkout: {(options.DeleteSource ? "delete permanently" : "keep")}</li>"
            + $"<li>Runtime errors: {(options.IgnoreRuntimeErrors ? "ignore and continue cleanup" : "stop removal")}</li>";
        var impact = plan.Impact;
        var dependents = string.Join("", impact.Dependents.Select(d => $"<li>{E(d.DisplayName)} ({E(d.AppId)}) {(d.Required ? "requires" : "uses")} this app; its dependency connection is lost on its next start.</li>"));
        var consumers = string.Join("", impact.Capabilities.SelectMany(c => c.Consumers.Select(d => $"<li>{E(d.DisplayName)} ({E(d.AppId)}) uses {E(c.Slot)} provided by this app.</li>")));
        var publications = string.Join("", impact.PublicOrigins.Select(p => $"<li>{E(p.Hostname)}: tunnel route removed; {(p.OwnershipState == "adopted" ? "existing DNS record kept" : "Hosty-created DNS record removed")}.</li>"));
        return $"<p>App ID: <code>{E(plan.AppId)}</code></p><p>This stops and removes the app's runtime services.</p><h2>Removal options</h2><ul>{cleanup}</ul>"
            + (options.DeleteData || options.DeleteBackups || options.DeleteSource ? "<p class=warning>Selected data is permanently deleted. This cannot be undone through Hosty.</p>" : "")
            + (callerAppId == plan.AppId ? "<p class=warning>This removes the app requesting confirmation. Its interface becomes unavailable; Core continues the operation.</p>" : "")
            + (dependents.Length + consumers.Length > 0 ? $"<h2>Affected apps</h2><ul>{dependents}{consumers}</ul>" : "")
            + (publications.Length > 0 ? $"<h2>Published addresses going offline</h2><ul>{publications}</ul>" : "");
    }
}
