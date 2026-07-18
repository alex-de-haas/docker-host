using Microsoft.Net.Http.Headers;

namespace Haas.Hosty.Core;

// Serves an installed app's manifest-declared display assets (icon, screenshots, markdown description
// and the images it references) from the app's own folder — the manifest-level app assets model. The
// app repository owns these; Core vendors them next to the internal manifest copy at install/update
// (see AppManifestService.VendorDisplayAssetsAsync) and hands them to any authenticated Shell session.
//
// Everything is display-only and defensive: the route serves only files that resolve, stay within the
// app folder, and carry an allowlisted image/markdown extension; anything else is a plain 404. SVG is
// served inert (nosniff + a locked-down CSP) so navigating straight to one can't execute script.
internal static class AppAssetEndpoints
{
    // Mirror of the catalog tooling allowlist (hosty-catalog D4) and the app asset vendor.
    private static readonly Dictionary<string, string> ContentTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        [".svg"] = "image/svg+xml",
        [".png"] = "image/png",
        [".webp"] = "image/webp",
        [".jpg"] = "image/jpeg",
        [".jpeg"] = "image/jpeg",
        [".gif"] = "image/gif",
        [".avif"] = "image/avif",
        [".md"] = "text/markdown; charset=utf-8",
    };

    public static void Map(WebApplication app)
    {
        app.MapGet("/api/apps/{appId}/assets/{**assetPath}", async (
            string appId,
            string assetPath,
            HttpRequest request,
            HttpResponse response,
            CoreDataPaths paths,
            AppRegistryStore apps,
            UserDirectoryStore users,
            IClock clock,
            CancellationToken cancellationToken) =>
            // Display assets are not admin-only — the sidebar and app cards render them for host.user
            // accounts too — but they are app-scoped: the same assignment policy as the apps listing
            // applies, or a regular user could read any installed app's files by id. A safe GET needs
            // no CSRF.
            await CoreSessionAuthorization.RequireSessionAsync(
                request,
                users,
                clock,
                async user =>
                {
                    // Requires the app to exist as well as be permitted, so an uninstalled app's stale
                    // directory is no longer addressable.
                    var app = await apps.GetAppAsync(appId, cancellationToken);
                    if (app is null)
                    {
                        return Results.NotFound();
                    }

                    var state = await users.ReadAsync(cancellationToken);
                    if (!AppAccessPolicy.CanAccessApp(state, user, app.Id, app.System))
                    {
                        // 404, not 403: a user who may not see the app should not learn it exists.
                        return Results.NotFound();
                    }

                    return Serve(appId, assetPath, request, response, paths);
                },
                cancellationToken: cancellationToken));
    }

    private static IResult Serve(
        string appId,
        string assetPath,
        HttpRequest request,
        HttpResponse response,
        CoreDataPaths paths)
    {
        if (!TryResolveAsset(paths.AppsRoot, appId, assetPath, out var fullPath, out var contentType))
        {
            return Results.NotFound();
        }

        FileInfo info;
        try
        {
            info = new FileInfo(fullPath);
            if (!info.Exists)
            {
                return Results.NotFound();
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // The file vanished or became inaccessible between resolution and serving — stay defensive.
            return Results.NotFound();
        }

        response.Headers["X-Content-Type-Options"] = "nosniff";
        response.Headers["Content-Security-Policy"] = "default-src 'none'; sandbox";
        // A ?v= cache-buster (the app version) makes the URL change whenever the asset does, so the body
        // is safe to cache immutably; without it, revalidate against the ETag. `private` either way:
        // the response is authorized per session, so a shared cache must never serve it to another user.
        response.Headers.CacheControl = request.Query.ContainsKey("v")
            ? "private, max-age=31536000, immutable"
            : "no-cache";

        // Stream from disk (assets can be sizeable) and let the file result handle conditional GET
        // (If-None-Match / If-Modified-Since) against the weak ETag; range processing is disabled.
        var etag = new EntityTagHeaderValue($"\"{info.Length:x}-{info.LastWriteTimeUtc.Ticks:x}\"", isWeak: true);
        return Results.File(fullPath, contentType, lastModified: info.LastWriteTimeUtc, entityTag: etag, enableRangeProcessing: false);
    }

    // Resolve a requested asset to a servable file: allowlisted extension, contained under the app's
    // folder, existing, and (if a symlink) with its real target still inside the folder. Returns false
    // for anything else so the endpoint answers a plain 404. Extracted for direct testing of the guard.
    internal static bool TryResolveAsset(string appsRoot, string appId, string assetPath, out string fullPath, out string contentType)
    {
        fullPath = string.Empty;
        contentType = string.Empty;
        if (!ContentTypes.TryGetValue(Path.GetExtension(assetPath), out var resolvedType))
        {
            return false;
        }

        if (!CoreDataPaths.TryResolveContainedPath(appsRoot, appId, out var appRoot) ||
            !CoreDataPaths.TryResolveContainedRelativePath(appRoot, assetPath, out var candidate) ||
            !File.Exists(candidate) ||
            // Reserved namespaces are not display assets. Vendoring refuses to write into them, but a
            // request can still name one directly, and app runtime data lives under data/ — which is
            // exactly the path the IDOR was read through.
            CoreDataPaths.IsReservedAppRootPath(assetPath) ||
            // Fails closed on a link anywhere below the app root, including an ancestor directory: the
            // containment above is lexical and says nothing about where a link inside the tree points.
            CoreDataPaths.ContainsSymbolicLink(appRoot, candidate))
        {
            return false;
        }

        fullPath = candidate;
        contentType = resolvedType;
        return true;
    }
}
