using Microsoft.AspNetCore.Cors;

namespace Haas.Hosty.Core;

// Credential issuance and consent stay on Core's isolated browser origin. These assets ship
// inside Core; no executable code or user credentials are loaded from a replaceable runtime app.
internal static class CoreAccountEndpoints
{
    public static void Map(WebApplication app)
    {
        foreach (var path in new[] { "/account/tokens", "/oauth/consent" })
            app.MapGet(path, PageAsync).WithMetadata(new DisableCorsAttribute());
        app.MapGet("/account/assets/account.js", () => Asset("account.js", "text/javascript"))
            .WithMetadata(new DisableCorsAttribute());
        app.MapGet("/account/assets/account.css", () => Asset("account.css", "text/css"))
            .WithMetadata(new DisableCorsAttribute());
    }

    private static async Task<IResult> PageAsync(HttpContext context, AppRegistryStore apps,
        UserDirectoryStore users, IClock clock)
    {
        var request = context.Request;
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers["Content-Security-Policy"] =
            "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'";
        context.Response.Headers["X-Frame-Options"] = "DENY";
        context.Response.Headers["X-Content-Type-Options"] = "nosniff";
        context.Response.Headers["Referrer-Policy"] = "same-origin";
        context.Response.Headers["Cross-Origin-Opener-Policy"] = "same-origin";
        if (!InstallationApprovalEndpoints.IsPageNavigation(request)) return Results.StatusCode(403);
        if (!await InstallationApprovalEndpoints.HasIsolatedCookieHostAsync(request, apps, context.RequestAborted))
            return Results.Text("Open account settings on Core's isolated browser origin.", statusCode: 409);
        if (await InstallationApprovalEndpoints.BrowserActorAsync(request, users, clock, context.RequestAborted) is null)
            return Results.Redirect("/login?returnTo=" + Uri.EscapeDataString(request.Path + request.QueryString));
        return Asset("account.html", "text/html");
    }

    private static IResult Asset(string name, string contentType)
    {
        var resource = typeof(CoreAccountEndpoints).Assembly.GetManifestResourceStream($"Haas.Hosty.Core.Browser.{name}")
            ?? throw new InvalidOperationException($"Missing Core browser asset: {name}");
        return Results.Stream(resource, contentType);
    }
}
