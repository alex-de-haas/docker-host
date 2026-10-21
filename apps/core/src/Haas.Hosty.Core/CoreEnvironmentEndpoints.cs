namespace Haas.Hosty.Core;

internal sealed class CoreEnvironmentAuthorization(AppServiceTokenService services, AppRegistryStore apps,
    AppIdentityService identity, UserDirectoryStore users, AppSessionGrantStore sessions)
{
    public async Task<SandboxActor> RequireAsync(HttpRequest request, string appId, bool read, CancellationToken ct)
    {
        if (!services.ValidateToken(appId, CoreSessionAuthorization.ReadBearerToken(request) ?? "")
            || request.Cookies.ContainsKey(CoreSessionAuthorization.SessionCookieName))
            throw new AppIdentityException("token_invalid", "Use the calling installation's service credential without a Core cookie.");
        var app = await apps.GetAppAsync(appId, ct);
        var permission = read ? CoreAppPermissions.CoreEnvironmentsRead : CoreAppPermissions.CoreEnvironmentsManage;
        if (app is null || !AppManagementAuthorization.HasPermission(app, permission))
            throw new AppIdentityException("app_permission_required", "The app requires " + permission + ".");
        // A single-app background sandbox grant must not grow into authority over a whole Core.
        var hash = AppIdentityService.HashToken(request.Headers["X-Hosty-User-Token"].ToString());
        var actor = await identity.RequireOperationHashAsync(hash, appId,
            scope => scope.Kind == "core-environment" && scope.Actions.Contains(read ? "read" : "manage"), ct);
        if (!(await users.ReadAsync(ct)).Users.Any(u => u.Id == actor.UserId && !u.Disabled && AppAccessPolicy.IsAdmin(u)))
            throw new AppIdentityException("admin_required", "A current administrator is required.");
        var session = await sessions.TryResolveAsync(hash, ct);
        return new(actor.UserId, appId, app.InstalledAt, session?.BackgroundGrantId, session?.BackgroundScopeId);
    }
}

internal static class CoreEnvironmentEndpoints
{
    public static void Map(WebApplication app)
    {
        var routes = app.MapGroup("").AddEndpointFilter(async (context, next) =>
        { context.HttpContext.Response.Headers.CacheControl = "no-store"; return await next(context); });
        const string root = "/api/core-environments";
        routes.MapGet(root, async (HttpRequest request, UserDirectoryStore users, IClock clock, CoreEnvironmentService service, CancellationToken ct) =>
            await Admin(request, users, clock, true, actor => service.ListAsync(actor, ct), ct));
        routes.MapPost(root + "/from-workspace", async (CoreEnvironmentWorkspaceCreate input, HttpRequest request,
            UserDirectoryStore users, IClock clock, CoreEnvironmentService service, CancellationToken ct) =>
            await Admin(request, users, clock, false, actor => service.CreateFromWorkspaceAsync(actor, input, ct), ct));
        routes.MapPost(root + "/consents/{id}/revoke", async (string id, HttpRequest request, UserDirectoryStore users,
            IClock clock, CoreEnvironmentConsentService consent, CoreEnvironmentService service, CancellationToken ct) =>
            await Admin(request, users, clock, false, async actor =>
            {
                await consent.RevokeAsync(actor, id, ct);
                return await service.ListAsync(actor, ct);
            }, ct));
        routes.MapPost(root + "/{id}/consent/revoke", async (string id, HttpRequest request, UserDirectoryStore users,
            IClock clock, CoreEnvironmentService service, BackgroundGrantService grants, CancellationToken ct) =>
            await Admin(request, users, clock, false, async actor =>
            {
                var record = await service.RequireAsync(actor, id, ct);
                if (record.Consent is { } consent) await grants.RevokeAsync(actor.UserId, consent.GrantId, ct);
                return await service.ReadAsync(actor, id, ct);
            }, ct));
        routes.MapGet(root + "/{id}/initialization", async (string id, HttpRequest request,
            UserDirectoryStore users, IClock clock, CoreEnvironmentAccess access, CancellationToken ct) =>
            await Admin(request, users, clock, true, actor => access.InitializationAsync<Haas.Hosty.Initialization.InitializationStatus>(actor, id, "status", ct), ct));
        routes.MapPost(root + "/{id}/initialization/resume", async (string id, HttpRequest request,
            UserDirectoryStore users, IClock clock, CoreEnvironmentAccess access, CancellationToken ct) =>
            await Admin(request, users, clock, false, actor => access.InitializationAsync<Haas.Hosty.Initialization.InitializationStatus>(actor, id, "resume", ct), ct));
        routes.MapPost(root + "/{id}/setup-link", async (string id, HttpRequest request,
            UserDirectoryStore users, IClock clock, CoreEnvironmentAccess access, CancellationToken ct) =>
            await Admin(request, users, clock, false, actor => access.InitializationAsync<AuthBootstrapTokenResponse>(actor, id, "setup-link", ct), ct));
        routes.MapGet(root + "/{id}/apps", async (string id, HttpRequest request,
            UserDirectoryStore users, IClock clock, CoreEnvironmentAccess access, CancellationToken ct) =>
            await Admin(request, users, clock, true, actor => access.ApplicationsAsync(actor, id, ct), ct));
        routes.MapGet(root + "/{id}", async (string id, HttpRequest request, UserDirectoryStore users, IClock clock, CoreEnvironmentService service, CancellationToken ct) =>
            await Admin(request, users, clock, true, actor => service.ReadAsync(actor, id, ct), ct));
        routes.MapPost(root, async (CoreEnvironmentCreate input, HttpRequest request, UserDirectoryStore users, IClock clock, CoreEnvironmentService service, CancellationToken ct) =>
            await Admin(request, users, clock, false, actor => service.CreateAsync(actor, input, ct), ct));
        routes.MapPost(root + "/{id}/operations/{kind}", async (string id, string kind, CoreEnvironmentCommand input, HttpRequest request,
            UserDirectoryStore users, IClock clock, CoreEnvironmentService service, CancellationToken ct) =>
            await Admin(request, users, clock, false, actor => service.CommandAsync(actor, id, kind, input, ct), ct));
        routes.MapPost(root + "/{id}/setup", async (string id, CoreEnvironmentSetup input, HttpRequest request,
            UserDirectoryStore users, IClock clock, CoreEnvironmentAccess access, CancellationToken ct) =>
            await Admin(request, users, clock, false, actor => access.SetupAsync(actor, id, input, ct), ct));
        routes.MapPost(root + "/{id}/api", async (string id, CoreEnvironmentApiRequest input, HttpRequest request,
            UserDirectoryStore users, IClock clock, CoreEnvironmentAccess access, CancellationToken ct) =>
            await Admin(request, users, clock, false, actor => access.SendAsync(actor, id, input, ct), ct));
        const string internalRoot = "/api/internal/apps/{appId}/core-environments";
        routes.MapPost(internalRoot + "/consent", async (string appId, CoreEnvironmentCreate input, HttpRequest request,
            CoreEnvironmentAuthorization auth, CoreEnvironmentService service, CoreEnvironmentConsentService consent,
            InstallationApprovalStore approvals, InstallationApprovalService approvalService,
            CorePublicOriginResolver origins, IClock clock, CancellationToken ct) =>
            await SandboxEndpoints.Handle(async () =>
            {
                var actor = await auth.RequireAsync(request, appId, false, ct);
                if (actor.GrantId is not null) throw new AppIdentityException("interactive_required", "Review new consent with an interactive administrator.");
                await consent.RequestGate.WaitAsync(ct);
                try
                {
                    var plan = await consent.PlanAsync(actor, await service.ValidateCreateAsync(actor, input, ct), ct);
                    if (approvals.FindEnvironmentRequest(plan) is { } prior)
                    {
                        if (prior.Status == "draft")
                        {
                            await approvalService.RecordAsync(prior, "requested", ct);
                            approvals.Submit(prior, new());
                        }
                        if (prior.Status != "succeeded") return approvals.View(prior, origins.Effective);
                        try
                        {
                            _ = await consent.FindAsync(actor, plan.Request, ct);
                            return approvals.View(prior, origins.Effective);
                        }
                        catch (SandboxException ex) when (ex.Code == "environment_consent_required") { }
                    }
                    var entry = approvals.Add(new InstallationApproval { UserId = actor.UserId, CallerAppId = appId,
                        IdentityToken = request.Headers["X-Hosty-User-Token"].ToString(), CallerName = plan.DisplayName,
                        ExpiresAt = clock.UtcNow.Add(InstallationApprovalStore.Lifetime), EnvironmentPlan = plan });
                    await approvalService.RecordAsync(entry, "requested", ct);
                    approvals.Submit(entry, new());
                    return approvals.View(entry, origins.Effective);
                }
                finally { consent.RequestGate.Release(); }
            }));
        routes.MapGet(internalRoot, async (string appId, HttpRequest request, CoreEnvironmentAuthorization auth, CoreEnvironmentService service, CancellationToken ct) =>
            await SandboxEndpoints.Handle(async () => await service.ListAsync(await auth.RequireAsync(request, appId, true, ct), ct)));
        routes.MapGet(internalRoot + "/{id}", async (string appId, string id, HttpRequest request, CoreEnvironmentAuthorization auth, CoreEnvironmentService service, CancellationToken ct) =>
            await SandboxEndpoints.Handle(async () => await service.ReadAsync(await auth.RequireAsync(request, appId, true, ct), id, ct)));
        routes.MapPost(internalRoot, async (string appId, CoreEnvironmentCreate input, HttpRequest request, CoreEnvironmentAuthorization auth, CoreEnvironmentService service, CancellationToken ct) =>
            await SandboxEndpoints.Handle(async () => await service.CreateAsync(await auth.RequireAsync(request, appId, false, ct), input, ct)));
        routes.MapPost(internalRoot + "/{id}/operations/{kind}", async (string appId, string id, string kind, CoreEnvironmentCommand input,
            HttpRequest request, CoreEnvironmentAuthorization auth, CoreEnvironmentService service, CancellationToken ct) =>
            await SandboxEndpoints.Handle(async () => await service.CommandAsync(await auth.RequireAsync(request, appId, false, ct), id, kind, input, ct)));
        routes.MapGet(internalRoot + "/{id}/initialization", async (string appId, string id, HttpRequest request,
            CoreEnvironmentAuthorization auth, CoreEnvironmentAccess access, CancellationToken ct) =>
            await SandboxEndpoints.Handle(async () => await access.InitializationAsync<Haas.Hosty.Initialization.InitializationStatus>(await auth.RequireAsync(request, appId, true, ct), id, "status", ct)));
        routes.MapPost(internalRoot + "/{id}/initialization/resume", async (string appId, string id, HttpRequest request,
            CoreEnvironmentAuthorization auth, CoreEnvironmentAccess access, CancellationToken ct) =>
            await SandboxEndpoints.Handle(async () => await access.InitializationAsync<Haas.Hosty.Initialization.InitializationStatus>(await auth.RequireAsync(request, appId, false, ct), id, "resume", ct)));
        routes.MapPost(internalRoot + "/{id}/setup-link", async (string appId, string id, HttpRequest request,
            CoreEnvironmentAuthorization auth, CoreEnvironmentAccess access, CancellationToken ct) =>
            await SandboxEndpoints.Handle(async () => await access.InitializationAsync<AuthBootstrapTokenResponse>(await auth.RequireAsync(request, appId, false, ct), id, "setup-link", ct)));
        routes.MapPost(internalRoot + "/{id}/setup", async (string appId, string id, CoreEnvironmentSetup input,
            HttpRequest request, CoreEnvironmentAuthorization auth, CoreEnvironmentAccess access, CancellationToken ct) =>
            await SandboxEndpoints.Handle(async () => await access.SetupAsync(await auth.RequireAsync(request, appId, false, ct), id, input, ct)));
        routes.MapPost(internalRoot + "/{id}/api", async (string appId, string id, CoreEnvironmentApiRequest input,
            HttpRequest request, CoreEnvironmentAuthorization auth, CoreEnvironmentAccess access, CancellationToken ct) =>
            await SandboxEndpoints.Handle(async () => await access.SendAsync(await auth.RequireAsync(request, appId, false, ct), id, input, ct)));
    }
    private static Task<IResult> Admin<T>(HttpRequest request, UserDirectoryStore users, IClock clock, bool read,
        Func<SandboxActor, Task<T>> action, CancellationToken ct)
        => !read && AppManagementAuthorization.Caller(request) is { } caller
            ? AppAccessPolicy.IsAdmin(caller.User) ? SandboxEndpoints.Handle(() => action(new(caller.User.Id)))
                : Task.FromResult<IResult>(CoreJson.Json(new ErrorResponse("admin_required", "Administrator required."), 403))
            : read ? CoreSessionAuthorization.RequireSessionAsync(request, users, clock, user => AppAccessPolicy.IsAdmin(user)
            ? SandboxEndpoints.Handle(() => action(new(user.Id)))
            : Task.FromResult<IResult>(CoreJson.Json(new ErrorResponse("admin_required", "Administrator required."), 403)), cancellationToken: ct)
        : CoreSessionAuthorization.RequireAdminBrowserAsync(request, users, clock, user => SandboxEndpoints.Handle(() => action(new(user.Id))), ct);
}
