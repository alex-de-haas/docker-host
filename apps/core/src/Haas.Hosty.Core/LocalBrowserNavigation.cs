namespace Haas.Hosty.Core;

internal static class LocalBrowserNavigation
{
    public static async Task InvokeAsync(HttpContext context, Func<Task> next)
    {
        var request = context.Request;
        // Only document navigation to known entry pages is canonicalized. Control/API clients and
        // form submissions keep their direct transport; never replay credentials through redirects.
        var navigation = request.Headers["Sec-Fetch-Mode"] == "navigate" && request.Headers["Sec-Fetch-Dest"] == "document";
        var entry = request.Path == "/login" || request.Path.StartsWithSegments("/install/confirm") || request.Path.StartsWithSegments("/install/permissions") ||
            (!request.QueryString.HasValue && request.Path.Value is "/setup" or "/setup/invite" or "/recovery");
        var origins = context.RequestServices.GetRequiredService<CorePublicOriginResolver>();
        if (HttpMethods.IsGet(request.Method) && navigation && entry &&
            Uri.TryCreate($"{request.Scheme}://{request.Host}", UriKind.Absolute, out var incoming) &&
            LocalBrowserOrigins.IsPlainLoopback(incoming) && Uri.TryCreate(origins.Effective, UriKind.Absolute, out var target) &&
            target.Scheme == "http" && target.Host.EndsWith(".localhost", StringComparison.Ordinal) && incoming.Port == target.Port)
        {
            var query = "";
            if (request.Path == "/login" && AuthEndpoints.IsAllowedLoginContinuation(request.Query["returnTo"]))
                query = "?returnTo=" + Uri.EscapeDataString(request.Query["returnTo"].ToString());
            context.Response.Headers.CacheControl = "no-store";
            context.Response.Headers["Referrer-Policy"] = "no-referrer";
            context.Response.Redirect(origins.Effective + request.Path + query);
            return;
        }
        await next();
    }
}
