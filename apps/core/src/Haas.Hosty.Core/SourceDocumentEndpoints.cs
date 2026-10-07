namespace Haas.Hosty.Core;

// The credential's audience is always the service-token caller, never a supplied user or repository.
// MCP credentials are accepted only on these bounded documentation reads.
internal sealed class SourceDocumentAuthorization(AppServiceTokenService serviceTokens, AppRegistryStore apps,
    AppIdentityService identity, AssistantMcpAccess mcp, UserDirectoryStore users, IClock clock,
    AuthLifetimes lifetimes, OAuthStore oauth)
{
    public async Task<string> RequireAsync(HttpRequest request, string appId, CancellationToken ct)
    {
        if (!serviceTokens.ValidateToken(appId, CoreSessionAuthorization.ReadBearerToken(request) ?? ""))
            throw new AppIdentityException("token_invalid", "An app service token is required.");
        var caller = await apps.GetAppAsync(appId, ct)
            ?? throw new AppIdentityException("app_access_denied", "The calling app is no longer installed.");
        if (!AppManagementAuthorization.HasPermission(caller, CoreAppPermissions.SourcesRead))
            throw new AppIdentityException("app_permission_required", "The calling app requires apps.sources.read.");
        if (request.Cookies.ContainsKey(CoreSessionAuthorization.SessionCookieName))
            throw new AppIdentityException("app_credential_mixed", "Use the app's user credential without a Core session cookie.");
        var credential = request.Headers["X-Hosty-User-Token"].ToString();
        string userId;
        AuthSessionRecord? scopedRecord = null;
        if (credential.StartsWith(AssistantMcpAccess.Prefix, StringComparison.Ordinal))
        {
            var actor = await mcp.ValidateAsync(credential, appId, ct);
            if (actor is null || actor.DiscoveryOnly)
                throw new AppIdentityException("token_invalid", "A current MCP invocation credential addressed to the calling app is required.");
            userId = actor.UserId;
        }
        else if (credential.StartsWith("hostyg_", StringComparison.Ordinal))
        {
            userId = (await identity.RequireActivityAsync(credential, appId, ct)).UserId;
        }
        else
        {
            var directory = await users.ReadAsync(ct);
            var scoped = ScopedCredentials.Resolve(directory, credential, clock.UtcNow, lifetimes, appId);
            if (scoped is null || !AccessTokenScopes.Grants(scoped.Record.Scopes, AccessTokenScopes.McpRead))
                throw new AppIdentityException("token_invalid", "An app identity or app-addressed MCP invocation credential is required.");
            await identity.RequireAccessibleUserAsync(appId, scoped.User.Id, ct);
            userId = scoped.User.Id;
            scopedRecord = scoped.Record;
        }
        var current = (await users.ReadAsync(ct)).Users.FirstOrDefault(user => user.Id == userId && !user.Disabled);
        if (current?.Role != "host.admin")
            throw new AppIdentityException("admin_required", "Source documentation requires a current administrator.");
        if (scopedRecord is not null)
            await CoreSessionAuthorization.TouchSessionAsync(users, scopedRecord, clock.UtcNow, ct, oauth);
        return userId;
    }
}

internal static class SourceDocumentEndpoints
{
    public static void Map(WebApplication app)
    {
        var routes = app.MapGroup("/api/internal/apps/{appId}/source-documents")
            .AddEndpointFilter(async (context, next) =>
            {
                context.HttpContext.Response.Headers.CacheControl = "no-store";
                return await next(context);
            });
        routes.MapGet("/repositories", async (string appId, HttpRequest request,
            SourceDocumentAuthorization auth, SourceDocumentService documents, CancellationToken ct) =>
            await Handle(async () => await documents.ListRepositoriesAsync(await auth.RequireAsync(request, appId, ct), ct)));
        routes.MapGet("/repositories/{repositoryId}/documents", async (string appId, string repositoryId, HttpRequest request,
            SourceDocumentAuthorization auth, SourceDocumentService documents, CancellationToken ct) =>
            await Handle(async () =>
            {
                var user = await auth.RequireAsync(request, appId, ct);
                var value = request.Query["refresh"].ToString();
                var refresh = false;
                if (value.Length != 0 && !bool.TryParse(value, out refresh))
                    throw new AppLifecycleException("source_document_request_invalid", "Refresh must be true or false.");
                return await documents.ListDocumentsAsync(repositoryId, user, refresh, ct,
                    Optional(request, "version") ?? "target", Optional(request, "workspaceId"), Optional(request, "path"));
            }));
        routes.MapGet("/repositories/{repositoryId}/content", async (string appId, string repositoryId, HttpRequest request,
            SourceDocumentAuthorization auth, SourceDocumentService documents, CancellationToken ct) =>
            await Handle(async () => await documents.ReadContentAsync(repositoryId, await auth.RequireAsync(request, appId, ct),
                new SourceDocumentRead(request.Query["path"].ToString(), Optional(request, "version") ?? "target",
                    Optional(request, "workspaceId"), Optional(request, "commit"), Optional(request, "expectedSha")), ct)));
        routes.MapGet("/workspaces", async (string appId, HttpRequest request,
            SourceDocumentAuthorization auth, SourceDocumentService documents, CancellationToken ct) =>
            await Handle(async () => await documents.ListWorkspacesAsync(await auth.RequireAsync(request, appId, ct),
                Optional(request, "repositoryId"), ct)));
    }

    private static string? Optional(HttpRequest request, string key)
        => request.Query[key].ToString() is { Length: > 0 } value ? value : null;

    private static async Task<IResult> Handle<T>(Func<Task<T>> action)
    {
        try { return CoreJson.Json(await action()); }
        catch (AppIdentityException ex)
        { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), AuthEndpoints.MapIdentityErrorStatus(ex.Code)); }
        catch (AppLifecycleException ex)
        {
            var status = ex.Code.EndsWith("not_found", StringComparison.Ordinal) ? 404
                : ex.Code.EndsWith("forbidden", StringComparison.Ordinal) || ex.Code.Contains("access_denied", StringComparison.Ordinal) ? 403
                : ex.Code.EndsWith("invalid", StringComparison.Ordinal) || ex.Code.EndsWith("required", StringComparison.Ordinal) ? 400
                : ex.Code.EndsWith("unavailable", StringComparison.Ordinal) ? 503 : 409;
            return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), status);
        }
    }
}
