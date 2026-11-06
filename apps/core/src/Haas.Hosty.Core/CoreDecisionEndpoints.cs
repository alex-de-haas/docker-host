using HostySdk.App;
using System.Text.Json;

namespace Haas.Hosty.Core;

internal static class CoreDecisionEndpoints
{
    internal static void Map(WebApplication app)
    {
        MapRoutes(app, "/api/decisions/v1");
        MapRoutes(app, "/api/internal/apps/{appId}/decisions/v1");
    }
    private static void MapRoutes(WebApplication app, string root)
    {
        app.MapGet(root + "/events", (HttpContext ctx, CoreEventHub events, IHostApplicationLifetime lifetime) => CoreDecisionStream.RunAsync(ctx, events, lifetime));
        app.MapPost(root + "/requests", (HttpContext ctx, CoreDecisionService service) => Handle(ctx, CoreAppPermissions.DecisionsRequest,
            async actor => await service.CreateAsync(actor, await Read<HostyDecisionCreate>(ctx), ctx.RequestAborted)));
        app.MapGet(root + "/requests", (HttpContext ctx, CoreDecisionService service) => Handle(ctx, CoreAppPermissions.DecisionsRead,
            actor => service.QueryAsync(actor, Query(ctx), ct: ctx.RequestAborted)));
        app.MapGet(root + "/requests/{id}", (string id, HttpContext ctx, CoreDecisionService service) => Handle(ctx, CoreAppPermissions.DecisionsRead,
            actor => service.GetAsync(actor, id, ctx.RequestAborted)));
        app.MapPost(root + "/requests/{id}/resolve", (string id, HttpContext ctx, CoreDecisionService service) => Handle(ctx, CoreAppPermissions.DecisionsRespond,
            async actor => await service.ResolveAsync(actor, id, await Read<HostyDecisionResolve>(ctx), ctx.RequestAborted)));
        app.MapPost(root + "/requests/{id}/withdraw", (string id, HttpContext ctx, CoreDecisionService service) => Handle(ctx, CoreAppPermissions.DecisionsRequest,
            async actor => await service.WithdrawAsync(actor, id, await Read<HostyDecisionWithdraw>(ctx), ct: ctx.RequestAborted)));
        app.MapPost(root + "/requests/{id}/invalidate", (string id, HttpContext ctx, CoreDecisionService service) => Handle(ctx, CoreAppPermissions.DecisionsRequest,
            async actor => await service.WithdrawAsync(actor, id, await Read<HostyDecisionWithdraw>(ctx), stale: true, ct: ctx.RequestAborted)));
        app.MapGet(root + "/responses", (HttpContext ctx, CoreDecisionService service) => Handle(ctx, CoreAppPermissions.DecisionsRequest,
            actor => service.QueryAsync(actor, Query(ctx), responses: true, ct: ctx.RequestAborted)));
        app.MapPost(root + "/responses/{id}/ack", (string id, HttpContext ctx, CoreDecisionService service) => Handle(ctx, CoreAppPermissions.DecisionsRequest,
            async actor => await service.AckAsync(actor, id, await Read<HostyDecisionAck>(ctx), ctx.RequestAborted)));
        app.MapPost(root + "/requests/{id}/continuation", (string id, HttpContext ctx, CoreDecisionService service) => Handle(ctx, CoreAppPermissions.DecisionsRequest,
            async actor => await service.ContinueAsync(actor, id, await Read<HostyDecisionContinue>(ctx), ctx.RequestAborted)));
    }
    private static HostyDecisionQuery Query(HttpContext ctx)
    {
        var query = ctx.Request.Query;
        string? Value(string key) => query.TryGetValue(key, out var value) ? value.ToString() : null;
        var limit = Value("limit");
        if (limit is not null && !int.TryParse(limit, out _)) throw CoreDecisionValidation.Invalid("Invalid page size.");
        return new(Value("cursor"), limit is null ? 50 : int.Parse(limit, System.Globalization.CultureInfo.InvariantCulture), Value("state"), Value("subject"), Value("task"));
    }
    internal static Task<CoreCapabilityCaller> Operator(HttpRequest request, CoreCapabilityAuthorization auth, string permission, CancellationToken ct)
        => auth.RequireAsync(request, [AccessTokenScopes.McpDecisions], [permission], ct, administrator: false);
    private static Task<IResult> Handle<T>(HttpContext ctx, string permission, Func<CoreCapabilityCaller, Task<T>> operation)
    {
        ctx.Response.Headers.CacheControl = "no-store";
        return CoreProviderApi.Handle(async () =>
        {
            return await operation(await Caller(ctx, permission));
        });
    }
    internal static async Task<CoreCapabilityCaller> Caller(HttpContext ctx, string permission)
    {
        var services = ctx.RequestServices;
        CoreCapabilityCaller caller;
        if (ctx.Request.RouteValues["appId"] is string appId)
        {
            if (ctx.Request.Cookies.ContainsKey(CoreSessionAuthorization.SessionCookieName))
                throw new AppIdentityException("app_credential_mixed", "Do not combine Core cookies and application credentials.");
            var app = await services.GetRequiredService<ProviderAccessService>().AuthenticateAsync(appId, ctx.Request, ctx.RequestAborted);
            var identity = services.GetRequiredService<AppIdentityService>();
            var token = ctx.Request.Headers["X-Hosty-User-Token"].ToString();
            // No background credential fallback: unsupported unattended authority remains blocked.
            var actor = ctx.Request.Method == "GET" ? await identity.RevalidateAsync(token, appId, ctx.RequestAborted)
                : await identity.RequireActivityAsync(token, appId, ctx.RequestAborted);
            var (user, currentApp) = await identity.RequireAccessibleUserAsync(appId, actor.UserId, ctx.RequestAborted);
            if (currentApp.InstalledAt != app.InstalledAt) throw new AppIdentityException("app_access_denied", "The installation changed.");
            caller = new(user, CoreCapabilityAuthorization.AppPrincipal(currentApp), currentApp, null);
            caller.Require(AccessTokenScopes.McpDecisions, permission);
        }
        else caller = await Operator(ctx.Request, services.GetRequiredService<CoreCapabilityAuthorization>(), permission, ctx.RequestAborted);
        return caller;
    }
    private static async Task<T> Read<T>(HttpContext ctx) where T : class
    {
        if (ctx.Request.ContentType?.Split(';', 2)[0].Trim() != "application/json") throw CoreDecisionValidation.Invalid("Send application/json.");
        using var buffer = new MemoryStream(); var bytes = new byte[8192]; int count;
        while ((count = await ctx.Request.Body.ReadAsync(bytes, ctx.RequestAborted)) > 0)
        {
            if (buffer.Length + count > 65536) throw CoreDecisionValidation.Invalid("The request exceeds 64 KiB.");
            buffer.Write(bytes, 0, count);
        }
        try { return JsonSerializer.Deserialize(buffer.ToArray(), CoreJson.TypeInfo<T>()) ?? throw CoreDecisionValidation.Invalid("A body is required."); }
        catch (JsonException) { throw CoreDecisionValidation.Invalid("The request is not valid decision JSON."); }
    }
}
