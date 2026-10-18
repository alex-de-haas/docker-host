using System.Net;

namespace Haas.Hosty.Core;

internal static class SandboxAuthEndpoints
{
    public static void Map(WebApplication app)
    {
        var routes = app.MapGroup("").AddEndpointFilter(async (context, next) => { context.HttpContext.Response.Headers.CacheControl = "no-store"; return await next(context); });
        const string root = "/api/sandbox-runtime/{id}";
        routes.MapGet(root + "/protocol", () => CoreJson.Json(new AppAuthProtocolResponse(2)));
        routes.MapPost(root + "/token", async (string id, SandboxCodeRequest input, HttpRequest request, SandboxServiceCredentials credentials,
            SandboxRealm realm, CancellationToken ct) => await SandboxEndpoints.Handle(async () =>
            { await credentials.RequireAsync(id, Bearer(request), ct); return await realm.ExchangeAsync(id, input, ct); }));
        routes.MapPost(root + "/revalidate", async (string id, SandboxRevalidateRequest input, HttpRequest request,
            SandboxServiceCredentials credentials, SandboxRealm realm, CancellationToken ct) => await SandboxEndpoints.Handle(async () =>
            { await credentials.RequireAsync(id, Bearer(request), ct); return await realm.RevalidateAsync(id, input.AccessToken, ct); }));
        routes.MapGet(root + "/directory", async (string id, HttpRequest request, SandboxServiceCredentials credentials,
            SandboxRealm realm, CancellationToken ct) => await SandboxEndpoints.Handle(async () =>
            { await credentials.RequireAsync(id, Bearer(request), ct); return await realm.DirectoryAsync(id, request.Headers["X-Hosty-User-Token"].ToString(), ct); }));

        routes.MapGet(root + "/browser/login", async (string id, HttpContext context, SandboxServiceCredentials credentials,
            HostyCoreRuntimeConfig config, CancellationToken ct) => await Page(async () =>
        {
            var instance = await credentials.RequireAsync(id, Bearer(context.Request), ct);
            RequireAuthOrigin(context, instance, false);
            var challenge = context.Request.Query["codeChallenge"].ToString();
            var redirect = context.Request.Query["redirectUri"].ToString();
            var state = context.Request.Query["state"].ToString();
            SandboxRealm.ValidateRedirect(instance, challenge, redirect, state);
            FormPolicy(context, redirect);
            var operatorUrl = config.EffectiveCorePublicOrigin + $"/api/sandbox-instances/{id}/authorize?codeChallenge={Uri.EscapeDataString(challenge)}&redirectUri={Uri.EscapeDataString(redirect)}&state={Uri.EscapeDataString(state)}";
            var persona = context.Request.Query["persona"].ToString();
            if (persona.Length > 0)
            {
                if (persona.Length > 100) throw new SandboxException("sandbox_persona_invalid", "Select a sandbox test user.", 400);
                return Results.Redirect(operatorUrl + (persona == "core" ? "" : "&persona=" + Uri.EscapeDataString(persona)));
            }
            static string E(string value) => WebUtility.HtmlEncode(value);
            return Results.Content($$"""
                <!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
                <title>Sandbox sign in · Hosty</title><main><h1>Sandbox sign in</h1>
                <p>This test account grants access only to this temporary application instance.</p>
                <form method="post" action="/login">
                <input type="hidden" name="codeChallenge" value="{{E(challenge)}}">
                <input type="hidden" name="redirectUri" value="{{E(redirect)}}">
                <input type="hidden" name="state" value="{{E(state)}}">
                <label>Test login <input name="loginId" autocomplete="off" required maxlength="100"></label>
                <label>One-time password <input type="password" name="password" autocomplete="off" required maxlength="1024"></label>
                <button type="submit">Sign in to sandbox</button></form>
                <p><a href="{{E(operatorUrl)}}">Continue with my Core account</a></p></main></html>
                """, "text/html");
        }));
        routes.MapPost(root + "/browser/login", async (string id, HttpContext context, SandboxServiceCredentials credentials,
            SandboxRealm realm, CancellationToken ct) => await Page(async () =>
        {
            var instance = await credentials.RequireAsync(id, Bearer(context.Request), ct);
            RequireAuthOrigin(context, instance, true);
            if (!context.Request.HasFormContentType || context.Request.ContentLength is null or > 8192)
                throw new SandboxException("sandbox_login_invalid", "A bounded login form is required.", 400);
            var form = await context.Request.ReadFormAsync(ct);
            return Results.Redirect(await realm.LoginAsync(id, form["loginId"].ToString(), form["password"].ToString(),
                form["codeChallenge"].ToString(), form["redirectUri"].ToString(), form["state"].ToString(), ct));
        }));
        routes.MapGet("/api/sandbox-instances/{id}/authorize", async (string id, HttpContext context, SandboxStore store,
            AppRegistryStore apps, UserDirectoryStore users, IClock clock, SandboxRealm realm, CancellationToken ct) => await Page(async () =>
        {
            if (!InstallationApprovalEndpoints.IsPageNavigation(context.Request)
                || !await InstallationApprovalEndpoints.HasIsolatedCookieHostAsync(context.Request, apps, ct))
                throw new SandboxException("sandbox_operator_origin_required", "Open preview using the isolated Core browser origin.", 403);
            var instance = await store.ReadAsync(id, ct) ?? throw new SandboxException("sandbox_not_found", "Sandbox not found.", 404);
            var challenge = context.Request.Query["codeChallenge"].ToString();
            var redirect = context.Request.Query["redirectUri"].ToString();
            var state = context.Request.Query["state"].ToString();
            SandboxRealm.ValidateRedirect(instance, challenge, redirect, state);
            var actor = await InstallationApprovalEndpoints.BrowserActorAsync(context.Request, users, clock, ct);
            if (actor is null) return Results.Redirect("/login?returnTo=" + Uri.EscapeDataString(context.Request.Path + context.Request.QueryString));
            var persona = context.Request.Query["persona"].ToString();
            if (persona.Length > 0)
            {
                var choice = await realm.BeginPersonaAsync(id, actor, context.Request.Cookies[CoreSessionAuthorization.SessionCookieName] ?? "",
                    persona, challenge, redirect, state, ct);
                FormPolicy(context, redirect);
                // Preserve Origin on native form POSTs without disclosing the challenge/state query.
                context.Response.Headers["Referrer-Policy"] = "origin";
                return Results.Content($"<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><title>Sandbox persona · Hosty</title>"
                    + $"<main><h1>Preview as a test user</h1><p>{WebUtility.HtmlEncode(choice.DisplayName)} · {WebUtility.HtmlEncode(choice.Role)}</p>"
                    + "<p>This changes only this sandbox preview. Your Core account remains unchanged.</p>"
                    + $"<form method=\"post\" action=\"/api/sandbox-instances/{id}/persona/confirm\"><input type=\"hidden\" name=\"nonce\" value=\"{WebUtility.HtmlEncode(choice.Nonce)}\">"
                    + "<button type=\"submit\">Open as this test user</button></form></main></html>", "text/html");
            }
            return Results.Redirect(await realm.AuthorizeOperatorAsync(id, actor.Id, challenge, redirect, state, ct));
        }));
        routes.MapPost("/api/sandbox-instances/{id}/persona/confirm", async (string id, HttpContext context,
            AppRegistryStore apps, UserDirectoryStore users, IClock clock, SandboxRealm realm, CancellationToken ct) => await Page(async () =>
        {
            if (!await InstallationApprovalEndpoints.HasIsolatedCookieHostAsync(context.Request, apps, ct)
                || context.Request.Headers.Origin != context.Request.Scheme + "://" + context.Request.Host
                || !context.Request.HasFormContentType || context.Request.ContentLength is null or > 8192)
                throw new SandboxException("sandbox_persona_origin_invalid", "Confirm the test persona on the Core page.", 403);
            var actor = await InstallationApprovalEndpoints.BrowserActorAsync(context.Request, users, clock, ct)
                ?? throw new SandboxException("sandbox_operator_required", "Sign in with your Core account.", 401);
            var form = await context.Request.ReadFormAsync(ct);
            return Results.Redirect(await realm.ConfirmPersonaAsync(id, actor, context.Request.Cookies[CoreSessionAuthorization.SessionCookieName] ?? "", form["nonce"].ToString(), ct));
        }));
    }

    internal static bool IsOperatorContinuation(ReadOnlySpan<char> path)
    {
        const string prefix = "/api/sandbox-instances/", suffix = "/authorize";
        return path.Length == prefix.Length + 32 + suffix.Length && path.StartsWith(prefix, StringComparison.Ordinal)
            && path.EndsWith(suffix, StringComparison.Ordinal) && Guid.TryParseExact(path.Slice(prefix.Length, 32), "N", out _);
    }
    private static void FormPolicy(HttpContext context, string validatedRedirect)
    {
        // Chromium applies form-action to redirects too. Only the previously validated
        // instance callback origin joins the form's own origin; no wildcard is permitted.
        var target = new Uri(validatedRedirect).GetLeftPart(UriPartial.Authority);
        context.Response.Headers["Content-Security-Policy"] = $"default-src 'none'; frame-ancestors 'none'; form-action 'self' {target}; base-uri 'none'";
        context.Response.Headers["Referrer-Policy"] = "origin";
    }
    private static string? Bearer(HttpRequest request) => CoreSessionAuthorization.ReadBearerToken(request);
    private static void RequireAuthOrigin(HttpContext context, SandboxInstance instance, bool mutation)
    {
        var request = context.Request;
        if (instance.AuthOrigin is null || request.Headers["X-Hosty-Sandbox-Origin"] != instance.AuthOrigin
            || (mutation && request.Headers.Origin != instance.AuthOrigin))
            throw new SandboxException("sandbox_auth_origin_invalid", "Use the exact sandbox authentication origin.", 403);
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'";
        // Preserve Origin on native form POSTs without disclosing the challenge/state query.
        context.Response.Headers["Referrer-Policy"] = "origin";
        context.Response.Headers["X-Content-Type-Options"] = "nosniff";
    }
    private static async Task<IResult> Page(Func<Task<IResult>> action)
    {
        try { return await action(); }
        catch (SandboxException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), ex.Status); }
    }
}
