using System.Security.Cryptography;
using System.Text.Json;
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
            DevelopmentWorkspaceService workspaces,
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

                    return await ServeAsync(app, assetPath, request, response, paths, workspaces, cancellationToken);
                },
                cancellationToken: cancellationToken));
    }

    private static async Task<IResult> ServeAsync(
        AppRecord app,
        string assetPath,
        HttpRequest request,
        HttpResponse response,
        CoreDataPaths paths,
        DevelopmentWorkspaceService workspaces,
        CancellationToken ct)
    {
        // Only the admitted app icon is public from a workspace. The repository can contain private
        // images and documents that were never declared as display assets by this installation.
        var icon = CoreDataPaths.NormalizeRelativeAssetPath("", app.CatalogMetadata?.Icon);
        var isIconRequest = assetPath == icon;
        if (isIconRequest && ContentTypes.TryGetValue(Path.GetExtension(assetPath), out var iconType) &&
            iconType.StartsWith("image/", StringComparison.Ordinal))
        {
            try
            {
                var root = await workspaces.ActiveAppDisplayRootAsync(app, ct);
                if (root is not null && TryResolveAssetUnderRoot(root, assetPath, out var sourcePath, out _) &&
                    await ReadIconAsync(sourcePath, ct) is { } bytes &&
                    MountPathPolicy.ResolveRealPath(root) == Path.GetFullPath(root) &&
                    !CoreDataPaths.ContainsSymbolicLink(root, sourcePath))
                {
                    SetSecurityHeaders(response);
                    // Source bytes can change without a version, length or timestamp change. Do not
                    // let a stale version query or If-Modified-Since make them immutable/unchanged.
                    response.Headers.CacheControl = "private, no-cache";
                    var iconEtag = new EntityTagHeaderValue($"\"{Convert.ToHexStringLower(SHA256.HashData(bytes))}\"");
                    return Results.File(bytes, iconType, entityTag: iconEtag, enableRangeProcessing: false);
                }
            }
            catch (Exception ex) when (ex is AppLifecycleException or IOException or UnauthorizedAccessException or JsonException)
            {
                // Display-only source failures leave the installed package available. Never repair
                // workspace metadata or copy files into an installed package from a GET.
            }
        }

        if (!TryResolveAsset(paths.AppsRoot, app.Id, assetPath, out var fullPath, out var contentType))
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

        SetSecurityHeaders(response);
        // A ?v= cache-buster (the app version) makes the URL change whenever the asset does, so the body
        // is safe to cache immutably; without it, revalidate against the ETag. `private` either way:
        // the response is authorized per session, so a shared cache must never serve it to another user.
        // `no-cache` on its own only forces revalidation — a shared cache may still store the body,
        // so the private directive has to be explicit in both branches.
        // A temporarily unavailable development icon can recover at this same URL. Its packaged
        // fallback must not become immutable while the journal still selects development mode.
        response.Headers.CacheControl = !(isIconRequest && app.DevModeId is not null) && request.Query.ContainsKey("v")
            ? "private, max-age=31536000, immutable"
            : "private, no-cache";

        // Stream from disk (assets can be sizeable) and let the file result handle conditional GET
        // (If-None-Match / If-Modified-Since) against the weak ETag; range processing is disabled.
        var etag = new EntityTagHeaderValue($"\"{info.Length:x}-{info.LastWriteTimeUtc.Ticks:x}\"", isWeak: true);
        return Results.File(fullPath, contentType, lastModified: info.LastWriteTimeUtc, entityTag: etag, enableRangeProcessing: false);
    }

    private static void SetSecurityHeaders(HttpResponse response)
    {
        response.Headers["X-Content-Type-Options"] = "nosniff";
        response.Headers["Content-Security-Policy"] = "default-src 'none'; sandbox";
    }

    private static async Task<byte[]?> ReadIconAsync(string path, CancellationToken ct)
    {
        const int maxBytes = 512 * 1024;
        await AppSourceService.RequireRegularFileAsync(path, ct);
        await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete,
            bufferSize: 4096, FileOptions.Asynchronous | FileOptions.SequentialScan);
        if (stream.Length > maxBytes) return null;
        // Read one byte beyond the budget so a growing file cannot bypass the length check.
        var bytes = new byte[maxBytes + 1];
        var count = await stream.ReadAtLeastAsync(bytes, bytes.Length, throwOnEndOfStream: false, cancellationToken: ct);
        return count > maxBytes ? null : bytes[..count];
    }

    // Resolve a requested asset to a servable file: allowlisted extension, contained under the app's
    // folder, existing, and (if a symlink) with its real target still inside the folder. Returns false
    // for anything else so the endpoint answers a plain 404. Extracted for direct testing of the guard.
    internal static bool TryResolveAsset(string appsRoot, string appId, string assetPath, out string fullPath, out string contentType)
    {
        fullPath = string.Empty;
        contentType = string.Empty;
        if (!CoreDataPaths.TryResolveContainedPath(appsRoot, appId, out var appRoot) ||
            // Check the root itself as well as descendants before entering the common path guard.
            CoreDataPaths.ContainsSymbolicLink(appsRoot, appRoot))
        {
            return false;
        }

        return TryResolveAssetUnderRoot(appRoot, assetPath, out fullPath, out contentType);
    }

    private static bool TryResolveAssetUnderRoot(string appRoot, string assetPath, out string fullPath, out string contentType)
    {
        fullPath = string.Empty;
        contentType = string.Empty;
        if (!ContentTypes.TryGetValue(Path.GetExtension(assetPath), out var resolvedType) ||
            !CoreDataPaths.TryResolveContainedRelativePath(appRoot, assetPath, out var candidate) ||
            !File.Exists(candidate) || CoreDataPaths.IsReservedAppRootPath(assetPath) ||
            CoreDataPaths.ContainsSymbolicLink(appRoot, candidate))
        {
            return false;
        }

        fullPath = candidate;
        contentType = resolvedType;
        return true;
    }
}
