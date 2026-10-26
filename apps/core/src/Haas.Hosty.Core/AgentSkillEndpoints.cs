namespace Haas.Hosty.Core;

/// <summary>App-neutral catalog, administration and native delivery endpoints.</summary>
internal static class AgentSkillEndpoints
{
    private static readonly object OwnerKey = new();

    public static void Map(WebApplication app)
    {
        var api = app.MapGroup("/api/skills").AddEndpointFilter(async (context, next) =>
        {
            var http = context.HttpContext;
            var services = http.RequestServices;
            http.Response.Headers.CacheControl = "no-store";
            return await CoreSessionAuthorization.RequireSessionAsync(http.Request,
                services.GetRequiredService<UserDirectoryStore>(), services.GetRequiredService<IClock>(), async user =>
                {
                    if (http.Request.Method != "GET" && !AppAccessPolicy.IsAdmin(user))
                        return CoreJson.Json(new ErrorResponse("admin_required", "Skill management requires an administrator."), 403);
                    http.Items[OwnerKey] = "user:" + user.Id;
                    var result = (IResult)(await next(context))!;
                    if (http.Request.Method != "GET" && http.Request.Path.Value is { } route &&
                        !route.EndsWith("/discover", StringComparison.Ordinal) && !route.EndsWith("/check-updates", StringComparison.Ordinal) &&
                        (result as IStatusCodeHttpResult)?.StatusCode is null or >= 200 and < 300)
                        await services.GetRequiredService<AuditStore>().AppendAsync(new AuditRecord($"audit_{Guid.NewGuid():N}",
                            "skills.library.modified", "skill-library", route, "succeeded", user.Id,
                            services.GetRequiredService<IClock>().UtcNow, new Dictionary<string, string> { ["method"] = http.Request.Method }), http.RequestAborted);
                    return result;
                }, requireCsrf: http.Request.Method != "GET", cancellationToken: http.RequestAborted);
        });
        MapReads(api);
        api.MapPost("/discover", (AgentSkillGitRequest body, HttpContext http, AgentSkillLibrary library, CancellationToken ct) =>
            Handle(() => library.DiscoverAsync(User(http), body, ct)));
        api.MapPost("/install", (AgentSkillInstallRequest body, HttpContext http, AgentSkillLibrary library, CancellationToken ct) =>
            Handle(() => library.InstallAsync(User(http), body, ct)));
        api.MapPost("/check-updates", (AgentSkillUpdateRequest body, HttpContext http, AgentSkillLibrary library, CancellationToken ct) =>
            Handle(() => library.UpdateAsync(User(http), body, false, ct)));
        api.MapPost("/update", (AgentSkillUpdateRequest body, HttpContext http, AgentSkillLibrary library, CancellationToken ct) =>
            Handle(() => library.UpdateAsync(User(http), body, true, ct)));
        api.MapDelete("/{id}", async (string id, AgentSkillLibrary library, CancellationToken ct) =>
            await Handle(async () => { await library.RemoveAsync(id, ct); return await library.CatalogAsync(ct); }));

        var internalApi = app.MapGroup("/api/internal/apps/{appId}/skills").AddEndpointFilter(async (context, next) =>
        {
            var http = context.HttpContext;
            var services = http.RequestServices;
            var id = http.Request.RouteValues["appId"]?.ToString() ?? "";
            if (!services.GetRequiredService<AppServiceTokenService>().ValidateToken(id, CoreSessionAuthorization.ReadBearerToken(http.Request) ?? ""))
                return CoreJson.Json(new ErrorResponse("token_invalid", "An app service token is required."), 401);
            var caller = await services.GetRequiredService<AppRegistryStore>().GetAppAsync(id, http.RequestAborted);
            if (caller is null || !AppManagementAuthorization.HasPermission(caller, CoreAppPermissions.ReadSkills))
                return CoreJson.Json(new ErrorResponse("app_permission_required", "The calling app requires apps.skills.read."), 403);
            http.Response.Headers.CacheControl = "no-store";
            http.Items[OwnerKey] = "app:" + id;
            return await next(context);
        });
        MapReads(internalApi);
        MapExports(internalApi);

        var control = app.MapGroup("/control/v1/skills").AddEndpointFilter(async (context, next) =>
        {
            var http = context.HttpContext;
            return await HostyCoreApplication.RequireControlSecret(http.Request, http.RequestServices.GetRequiredService<ControlSecret>(), async () =>
            {
                http.Items[OwnerKey] = "control";
                return (IResult)(await next(context))!;
            });
        });
        MapReads(control);
        MapExports(control);
    }

    private static string User(HttpContext http) => ((string)http.Items[OwnerKey]!)[5..];

    private static void MapReads(RouteGroupBuilder group)
    {
        group.MapGet("/", (AgentSkillLibrary library, CancellationToken ct) => Handle(() => library.CatalogAsync(ct)));
        group.MapGet("/{id}/content", (string id, string? path, AgentSkillLibrary library, CancellationToken ct) =>
            Handle(() => library.ContentAsync(id, path ?? "SKILL.md", ct)));
    }

    private static void MapExports(RouteGroupBuilder group)
    {
        group.MapPost("/exports", (AgentSkillExportRequest body, HttpContext http, AgentSkillLibrary library, CancellationToken ct) =>
            Handle(() => library.ExportAsync((string)http.Items[OwnerKey]!, body, ct)));
        group.MapDelete("/exports/{id}", (string id, HttpContext http, AgentSkillLibrary library, CancellationToken ct) =>
            Handle(async () => { await library.ReleaseExportAsync((string)http.Items[OwnerKey]!, id, ct); return new AgentSkillCatalog([]); }));
    }

    private static async Task<IResult> Handle<T>(Func<Task<T>> action)
    {
        try { return CoreJson.Json(await action()); }
        catch (AppLifecycleException ex)
        {
            var status = ex.Code.EndsWith("not_found", StringComparison.Ordinal) ? 404 :
                ex.Code is "skill_package_invalid" ? 400 :
                ex.Code is "source_access_required" ? 403 :
                ex.Code.EndsWith("unavailable", StringComparison.Ordinal) ? 503 : 409;
            return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), status);
        }
    }
}
