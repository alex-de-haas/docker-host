using Microsoft.AspNetCore.Cors;
using System.Security.Cryptography;
using System.Text.Json;

namespace Haas.Hosty.Core;

// Only this Core-origin browser operation may maintain a browser parent. App service/grant
// credentials can revalidate a child but are never accepted as proof of this operation.
internal static class AppContinuityEndpoints
{
    internal static void Map(WebApplication app)
    {
        app.MapGet("/api/auth/apps/continuity/frame", FrameAsync).WithMetadata(new DisableCorsAttribute());
        app.MapPost("/api/auth/apps/continuity/maintain", MaintainAsync).WithMetadata(new DisableCorsAttribute());
    }

    private static async Task<IResult> FrameAsync(string grantId, string origin, string state,
        HttpContext context, AppIdentityService identity, AppSessionGrantStore grants, AppRegistryStore apps)
    {
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers["Referrer-Policy"] = "no-referrer";
        if (grantId.Length > 128 || state.Length != 64 || !state.All(char.IsAsciiHexDigit)
            || !Uri.TryCreate(origin, UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https")
            || uri.GetLeftPart(UriPartial.Authority) != origin || uri.UserInfo.Length != 0
            || !await AppSignInCookieHost.IsSafeAsync(context.Request, apps, context.RequestAborted))
            return Results.StatusCode(400);
        var grant = (await grants.ReadAsync(context.RequestAborted)).Grants.FirstOrDefault(g => g.Id == grantId);
        if (grant is null || grant.AuthorityVersion != 1 || grant.BackgroundGrantId is not null)
            return Results.StatusCode(404);
        try { await identity.RequireAllowedRedirectUriAsync(grant.AppId, origin, context.RequestAborted); }
        catch (AppIdentityException) { return Results.StatusCode(403); }
        var payload = CoreJson.Text(new AppContinuityFrame(grantId, origin, state));
        var nonce = Convert.ToBase64String(RandomNumberGenerator.GetBytes(24));
        context.Response.Headers["Content-Security-Policy"] =
            $"default-src 'none'; script-src 'nonce-{nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'";
        return Results.Content($$"""
            <!doctype html><meta charset="utf-8"><title>Hosty session maintenance</title>
            <script nonce="{{nonce}}">
            (() => {
              const config = {{payload}};
              let started = false;
              addEventListener('message', async event => {
                if (started || event.source !== parent || event.origin !== config.origin ||
                    event.data?.type !== 'hosty:continuity-check' || event.data.state !== config.state) return;
                started = true;
                let status = 'unavailable';
                try {
                  const csrf = await fetch('/api/auth/csrf', {credentials:'same-origin', redirect:'error', cache:'no-store'});
                  const proof = await csrf.json();
                  const response = await fetch('/api/auth/apps/continuity/maintain', {
                    method:'POST', credentials:'same-origin', redirect:'error', cache:'no-store',
                    headers:{'Content-Type':'application/json','X-Hosty-CSRF':proof.token},
                    body:JSON.stringify({grantId:config.grantId, origin:config.origin})
                  });
                  if (response.ok) status = 'maintained';
                } catch { /* Browser restrictions and outages leave existing authority unchanged. */ }
                parent.postMessage({type:'hosty:continuity-result',state:config.state,status}, config.origin);
              });
            })();
            </script>
            """, "text/html");
    }

    private static async Task<IResult> MaintainAsync(AppContinuityRequest input, HttpContext context,
        AppIdentityService identity, AppSessionGrantStore grants, AppRegistryStore apps,
        UserDirectoryStore users, IClock clock, AuthLifetimes lifetimes)
    {
        var request = context.Request;
        var ct = context.RequestAborted;
        context.Response.Headers.CacheControl = "no-store";
        var coreOrigin = $"{request.Scheme}://{request.Host}";
        if (input.GrantId is not { Length: > 0 and <= 128 } || input.Origin is not { Length: > 0 and <= 2048 }
            || request.Headers.ContainsKey("Authorization") || request.Headers.ContainsKey(AppManagementAuthorization.IdentityHeader)
            || request.Headers.Origin.Count != 1 || request.Headers.Origin != coreOrigin
            || !CoreSessionAuthorization.HasValidCsrfToken(request)
            || !await AppSignInCookieHost.IsSafeAsync(request, apps, ct))
            return CoreJson.Json(new ErrorResponse("browser_proof_required", "Core browser session proof is required."), 403);
        try
        {
            var grant = (await grants.ReadAsync(ct)).Grants.FirstOrDefault(g => g.Id == input.GrantId);
            if (grant is null || grant.AuthorityVersion != 1 || grant.BackgroundGrantId is not null)
                throw new AppIdentityException("token_invalid", "App session is unavailable.");
            await identity.RequireAllowedRedirectUriAsync(grant.AppId, input.Origin, ct);
            var cookie = request.Cookies[CoreSessionAuthorization.SessionCookieName];
            if (cookie is null || cookie != grant.AuthorizingSessionId)
                throw new AppIdentityException("token_invalid", "The authorizing browser session does not match.");
            var parent = await identity.TryLivePrincipalAsync(cookie, grant.UserId, ct);
            if (parent is null || parent.Kind is not null || parent.BrowserOrigin != coreOrigin)
                throw new AppIdentityException("token_expired", "The authorizing browser session has ended.");
            await identity.RevalidateHashAsync(grant.TokenHash, grant.AppId, ct);
            var now = clock.UtcNow;
            if (now - (parent.LastSeenAt ?? parent.CreatedAt) >= TimeSpan.FromMinutes(1))
                await users.UpdateAsync(directory => directory with
                {
                    Sessions = directory.Sessions.Select(s => s.Id == parent.Id && s.UserId == grant.UserId
                        && CoreSessionAuthorization.IsSessionLive(s, now, lifetimes.CoreSessionIdle)
                        ? s with { LastSeenAt = now } : s).ToArray(),
                }, ct);
            return CoreJson.Json(new AppContinuityResult("maintained", parent.ExpiresAt));
        }
        catch (AppIdentityException ex)
        { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), AuthEndpoints.MapIdentityErrorStatus(ex.Code)); }
    }
}

internal sealed record AppContinuityFrame(string GrantId, string Origin, string State);
internal sealed record AppContinuityRequest(string GrantId, string Origin);
internal sealed record AppContinuityResult(string Status, DateTimeOffset ExpiresAt);
