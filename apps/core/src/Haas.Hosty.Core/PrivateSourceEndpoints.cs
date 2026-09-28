namespace Haas.Hosty.Core;

internal sealed record AppPrivateSourceResponse(string? ManifestUrl, PrivateSourceAccess? Access, string Status, bool HasGitSource);
internal static class PrivateSourceEndpoints
{
    internal static void Map(WebApplication app)
    {
        app.MapGet("/api/apps/{appId}/source-access", async (string appId, HttpRequest request,
            UserDirectoryStore users, IClock clock, AppRegistryStore apps, PrivateSourceService reader, CancellationToken ct) =>
        {
            request.HttpContext.Response.Headers.CacheControl = "no-store";
            return await CoreSessionAuthorization.RequireSessionAsync(request, users, clock, async user =>
            {
                if (!AppAccessPolicy.IsAdmin(user)) return Results.StatusCode(403);
                var installed = await apps.GetAppAsync(appId, ct);
                if (installed is null) return Results.NotFound();
                if (new[] { installed.PrivateSources?.Manifest, installed.PrivateSources?.Git }.OfType<SourceReadGrant>().Any(g => g.OwnerId != user.Id))
                    return CoreJson.Json(new ErrorResponse("source_owner_required", "Only the source owner can inspect or replace private connections."), 403);
                var status = "available";
                try { await reader.ValidateAsync(installed.PrivateSources, ct); }
                catch (AppLifecycleException) { status = "reconnect-required"; }
                return CoreJson.Json(new AppPrivateSourceResponse(installed.ManifestUrl, installed.PrivateSources, status, !string.IsNullOrWhiteSpace(installed.SourceState?.Repository)));
            }, cancellationToken: ct);
        });
    }
}
