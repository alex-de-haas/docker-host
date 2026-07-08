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
            UserDirectoryStore users,
            IClock clock,
            CancellationToken cancellationToken) =>
            // Any authenticated session may read display assets — the sidebar and app cards render them
            // for host.user accounts too, so this is not gated to administrators. A safe GET needs no CSRF.
            await CoreSessionAuthorization.RequireSessionAsync(
                request,
                users,
                clock,
                _ => ServeAsync(appId, assetPath, request, response, paths, cancellationToken),
                cancellationToken: cancellationToken));
    }

    private static async Task<IResult> ServeAsync(
        string appId,
        string assetPath,
        HttpRequest request,
        HttpResponse response,
        CoreDataPaths paths,
        CancellationToken cancellationToken)
    {
        if (!TryResolveAsset(paths.AppsRoot, appId, assetPath, out var fullPath, out var contentType))
        {
            return Results.NotFound();
        }

        var info = new FileInfo(fullPath);
        var etag = $"W/\"{info.Length:x}-{info.LastWriteTimeUtc.Ticks:x}\"";

        response.Headers["X-Content-Type-Options"] = "nosniff";
        response.Headers["Content-Security-Policy"] = "default-src 'none'; sandbox";
        response.Headers.ETag = etag;
        // A ?v= cache-buster (the app version) makes the URL change whenever the asset does, so the body
        // is safe to cache immutably; without it, revalidate against the ETag.
        response.Headers.CacheControl = request.Query.ContainsKey("v")
            ? "public, max-age=31536000, immutable"
            : "no-cache";

        if (request.Headers.IfNoneMatch.Any(value => string.Equals(value, etag, StringComparison.Ordinal)))
        {
            return Results.StatusCode(StatusCodes.Status304NotModified);
        }

        var bytes = await File.ReadAllBytesAsync(fullPath, cancellationToken);
        return Results.Bytes(bytes, contentType);
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
            !IsWithin(appRoot, ResolveRealPath(candidate)))
        {
            return false;
        }

        fullPath = candidate;
        contentType = resolvedType;
        return true;
    }

    private static string ResolveRealPath(string path)
    {
        try
        {
            return File.ResolveLinkTarget(path, returnFinalTarget: true)?.FullName ?? path;
        }
        catch (IOException)
        {
            return path;
        }
    }

    private static bool IsWithin(string root, string candidate)
    {
        var fullRoot = Path.GetFullPath(root);
        var prefix = fullRoot.EndsWith(Path.DirectorySeparatorChar) ? fullRoot : fullRoot + Path.DirectorySeparatorChar;
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        return Path.GetFullPath(candidate).StartsWith(prefix, comparison);
    }
}
