using Microsoft.AspNetCore.Cors;

namespace Haas.Hosty.Core;

internal static class BackgroundGrantEndpoints
{
    internal static void Map(WebApplication app)
    {
        const string route = "/api/auth/background-grants";
        app.MapGet(route, (HttpContext ctx, BackgroundGrantService grants) => BrowserAsync(ctx, async user =>
            CoreJson.Json((await grants.ReadAsync(ctx.RequestAborted))?.Grants.Where(g => g.UserId == user.Id).ToArray() ?? [])))
            .WithMetadata(new DisableCorsAttribute());
        app.MapPost(route, (HttpContext ctx, BackgroundGrantRequest input, BackgroundGrantService grants) => BrowserAsync(ctx,
            async user => CoreJson.Json(await grants.CreateAsync(user.Id, input, ctx.RequestAborted))))
            .WithMetadata(new DisableCorsAttribute());
        app.MapDelete(route + "/{id}", (string id, HttpContext ctx, BackgroundGrantService grants) => BrowserAsync(ctx, async user =>
        {
            await grants.RevokeAsync(user.Id, id, ctx.RequestAborted);
            return Results.NoContent();
        })).WithMetadata(new DisableCorsAttribute());
        app.MapPost(route + "/revoke-all-authorizations", (HttpContext ctx, BackgroundGrantService grants,
            UserDirectoryStore users, OAuthStore oauth, IClock clock) => BrowserAsync(ctx, async user =>
        {
            // AuthRevision ends every issued child credential as well as devices/OAuth and browser authority.
            await users.UpdateAsync(state => state with
            {
                Users = state.Users.Select(u => u.Id == user.Id ? u with { AuthRevision = Guid.NewGuid().ToString("N"), UpdatedAt = clock.UtcNow } : u).ToArray(),
                Sessions = state.Sessions.Select(s => s.UserId == user.Id ? s with { RevokedAt = clock.UtcNow } : s).ToArray(),
            }, ctx.RequestAborted);
            await oauth.UpdateAsync<object?>(state => (state with
            {
                Grants = state.Grants.Select(g => g.UserId == user.Id ? g with { RevokedAt = clock.UtcNow } : g).ToArray(),
            }, null), ctx.RequestAborted);
            await grants.RevokeAsync(user.Id, null, ctx.RequestAborted);
            return Results.NoContent();
        })).WithMetadata(new DisableCorsAttribute());

        const string control = "/control/v1/auth/background-grants";
        app.MapGet(control, (string user, HttpRequest request, ControlSecret secret, UserDirectoryStore users,
            BackgroundGrantService grants, CancellationToken ct) => HostyCoreApplication.RequireControlSecret(request, secret, () => HandleAsync(async () =>
                CoreJson.Json((await grants.ReadAsync(ct))?.Grants.Where(g => g.UserId == user).ToArray() ?? []))));
        app.MapPost(control, (string user, BackgroundGrantRequest input, HttpRequest request, ControlSecret secret,
            BackgroundGrantService grants, CancellationToken ct) => HostyCoreApplication.RequireControlSecret(request, secret, () => HandleAsync(async () =>
                CoreJson.Json(await grants.CreateAsync(user, input, ct)))));
        app.MapDelete(control + "/{id}", (string id, string user, HttpRequest request, ControlSecret secret,
            BackgroundGrantService grants, CancellationToken ct) => HostyCoreApplication.RequireControlSecret(request, secret, () => HandleAsync(async () =>
            { await grants.RevokeAsync(user, id, ct); return Results.NoContent(); })));
        app.MapPost("/api/internal/apps/{appId}/background/token", (string appId, BackgroundTokenRequest input,
            HttpRequest request, AppServiceTokenService services, BackgroundGrantService grants, CancellationToken ct) => HandleAsync(async () =>
            services.ValidateToken(appId, CoreSessionAuthorization.ReadBearerToken(request) ?? "")
                ? CoreJson.Json(await grants.IssueAsync(appId, input, ct))
                : CoreJson.Json(new ErrorResponse("token_invalid", "An app service credential is required."), 401)));
    }

    private static async Task<IResult> BrowserAsync(HttpContext ctx, Func<HostUserRecord, Task<IResult>> action)
    {
        var services = ctx.RequestServices;
        var request = ctx.Request;
        ctx.Response.Headers.CacheControl = "no-store";
        if (request.Headers.ContainsKey("Authorization") || request.Headers.ContainsKey(AppManagementAuthorization.IdentityHeader)
            || (request.Method != "GET" && (!CoreSessionAuthorization.HasValidCsrfToken(request)
                || request.Headers.Origin != $"{request.Scheme}://{request.Host}"))
            || !await AppSignInCookieHost.IsSafeAsync(request, services.GetRequiredService<AppRegistryStore>(), ctx.RequestAborted))
            return Results.StatusCode(403);
        var user = await InstallationApprovalEndpoints.BrowserActorAsync(request, services.GetRequiredService<UserDirectoryStore>(),
            services.GetRequiredService<IClock>(), ctx.RequestAborted);
        if (user is null || !AppAccessPolicy.IsAdmin(user)) return Results.StatusCode(403);
        return await HandleAsync(() => action(user));
    }

    private static async Task<IResult> HandleAsync(Func<Task<IResult>> action)
    {
        try { return await action(); }
        catch (AppIdentityException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), 403); }
    }
}
