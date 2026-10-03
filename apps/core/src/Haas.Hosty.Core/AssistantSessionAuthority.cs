using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Net;

namespace Haas.Hosty.Core;

internal sealed record AssistantSessionLease(string AppId, DateTimeOffset Installation, string UserId,
    string SessionId, string BrowserSessionId, DateTimeOffset ActiveUntil, string Revision);
internal sealed record AssistantSessionLeaseState(int SchemaVersion, IReadOnlyList<AssistantSessionLease> Leases);
internal sealed record AssistantSessionAuthorityStatus(bool Active, DateTimeOffset? ActiveUntil, string ReviewUrl);

// Identity and explicit session authority are separate. Only a protected browser decision writes
// leases; neither the assistant service token nor a live app activity window can create one.
internal sealed class AssistantSessionAuthority(CoreDataPaths paths, AppRegistryStore apps,
    AppIdentityService identity, IClock clock, CorePublicOriginResolver origins)
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly ConcurrentDictionary<string, Decision> decisions = new(StringComparer.Ordinal);
    private string StatePath => Path.Combine(paths.AuthRoot, "assistant-session-authority.json");
    internal sealed record Decision(string AppId, DateTimeOffset Installation, string UserId, string SessionId,
        string BrowserSessionId, DateTimeOffset ExpiresAt);
    private Task<AssistantSessionLeaseState?> ReadAsync(CancellationToken ct)
        => JsonStorage.ReadAsync<AssistantSessionLeaseState>(StatePath, ct);
    internal static void ValidateSessionId(string id)
    {
        if (id.Length is < 1 or > 128 || id.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not '-' and not '_'))
            throw new AppIdentityException("assistant_session_invalid", "A valid assistant session ID is required.");
    }
    internal async Task<AppRecord> RequireAssistantAsync(string appId, CancellationToken ct)
    {
        var app = await apps.GetAppAsync(appId, ct);
        if (app is null || !AgentMcpDirectory.IsAssistant(app))
            throw new AppIdentityException("mcp_assistant_required", "A confirmed assistant is required.");
        return app;
    }
    internal async Task<AssistantSessionLease> RequireAsync(string appId, string sessionId, string grantHash, CancellationToken ct)
    {
        ValidateSessionId(sessionId);
        var actor = await identity.RequireBrowserIdentityHashAsync(grantHash, appId, ct);
        var app = await RequireAssistantAsync(appId, ct);
        var lease = (await ReadAsync(ct))?.Leases.FirstOrDefault(x => x.AppId == appId && x.UserId == actor.UserId && x.SessionId == sessionId && x.Installation == app.InstalledAt);
        if (lease is null || lease.ActiveUntil <= clock.UtcNow)
            throw new AppIdentityException("reauth_required", "Grant or renew this assistant session's tool authority in Core.");
        await identity.RequireLiveAuthorizingSessionAsync(lease.BrowserSessionId, actor.UserId, ct);
        return lease;
    }
    internal async Task<AssistantSessionAuthorityStatus> StatusAsync(string appId, string sessionId, string token, CancellationToken ct)
    {
        ValidateSessionId(sessionId);
        // Expired identity provenance must trigger browser recovery, not look like a missing lease.
        await identity.RequireBrowserIdentityHashAsync(AppIdentityService.HashToken(token), appId, ct);
        DateTimeOffset? until = null;
        try { until = (await RequireAsync(appId, sessionId, AppIdentityService.HashToken(token), ct)).ActiveUntil; }
        catch (AppIdentityException e) when (e.Code == "reauth_required") { }
        return new(until is not null, until, $"{origins.Effective}/activity/assistants/{Uri.EscapeDataString(appId)}/{Uri.EscapeDataString(sessionId)}");
    }
    internal async Task<string> CreateDecisionAsync(string appId, string sessionId, string userId, string browserSession, CancellationToken ct)
    {
        ValidateSessionId(sessionId);
        var app = await RequireAssistantAsync(appId, ct);
        await identity.RequireLiveAuthorizingSessionAsync(browserSession, userId, ct);
        foreach (var old in decisions.Where(x => x.Value.ExpiresAt <= clock.UtcNow)) decisions.TryRemove(old.Key, out _);
        var nonce = Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32));
        decisions[nonce] = new(appId, app.InstalledAt, userId, sessionId, browserSession, clock.UtcNow.AddMinutes(5));
        return nonce;
    }
    internal async Task DecideAsync(string nonce, string appId, string sessionId, string userId, string browserSession, string choice, CancellationToken ct)
    {
        if (!decisions.TryRemove(nonce, out var decision) || decision.ExpiresAt <= clock.UtcNow ||
            decision.AppId != appId || decision.SessionId != sessionId || decision.UserId != userId || decision.BrowserSessionId != browserSession)
            throw new AppIdentityException("activity_review_stale", "Open a fresh session authority review in Core.");
        await identity.RequireLiveAuthorizingSessionAsync(browserSession, userId, ct);
        var mutex = apps.OperationLock(appId);
        await mutex.WaitAsync(ct);
        try
        {
            if ((await RequireAssistantAsync(appId, ct)).InstalledAt != decision.Installation)
                throw new AppIdentityException("activity_review_stale", "The assistant installation changed.");
            if (choice is not "approve" and not "revoke") return;
            await gate.WaitAsync(ct);
            try
            {
                var state = await ReadAsync(ct) ?? new(1, []);
                var next = state.Leases.Where(x => x.ActiveUntil > clock.UtcNow && !(x.AppId == appId && x.UserId == userId && x.SessionId == sessionId)).ToList();
                if (choice == "approve") next.Add(new(appId, decision.Installation, userId, sessionId, browserSession, clock.UtcNow.AddHours(1), Guid.NewGuid().ToString("N")));
                await JsonStorage.WriteAsync(StatePath, new AssistantSessionLeaseState(1, next), restrictToOwner: true, ct);
            }
            finally { gate.Release(); }
        }
        finally { mutex.Release(); }
    }
}

internal static class AssistantSessionAuthorityEndpoints
{
    internal static void Map(WebApplication app)
    {
        app.MapGet("/api/internal/apps/{appId}/sessions/{sessionId}/authority", async (string appId, string sessionId, HttpRequest request,
            AppServiceTokenService services, AssistantSessionAuthority authority, CancellationToken ct) =>
        {
            if (!services.ValidateToken(appId, CoreSessionAuthorization.ReadBearerToken(request) ?? "")) return Results.StatusCode(401);
            try { return CoreJson.Json(await authority.StatusAsync(appId, sessionId, request.Headers["X-Hosty-User-Token"].ToString(), ct)); }
            catch (AppIdentityException e) { return CoreJson.Json(new ErrorResponse(e.Code, e.Message), AuthEndpoints.MapIdentityErrorStatus(e.Code)); }
        });
        app.MapMethods("/activity/assistants/{appId}/{sessionId}", ["GET", "POST"], async (string appId, string sessionId, HttpContext context,
            UserDirectoryStore users, IClock clock, AppRegistryStore apps, AssistantSessionAuthority authority, CancellationToken ct) =>
        {
            var request = context.Request;
            InstallationApprovalEndpoints.ProtectPage(context.Response);
            if (!await InstallationApprovalEndpoints.HasIsolatedCookieHostAsync(request, apps, ct)) return Results.StatusCode(409);
            if (request.Method == "GET" && !InstallationApprovalEndpoints.IsPageNavigation(request)) return Results.StatusCode(403);
            var actor = await InstallationApprovalEndpoints.BrowserActorAsync(request, users, clock, ct);
            if (actor is null) return request.Method == "GET"
                ? Results.Redirect($"/login?returnTo={Uri.EscapeDataString(request.Path)}") : Results.StatusCode(401);
            if (!AppAccessPolicy.IsAdmin(actor)) return Results.StatusCode(403);
            try
            {
                var browser = CoreSessionAuthorization.ReadSessionId(request)!;
                if (request.Method == "POST")
                {
                    if (!InstallationApprovalEndpoints.IsSameOriginDecision(request)) return Results.StatusCode(403);
                    var form = await request.ReadFormAsync(ct);
                    await authority.DecideAsync(form["nonce"].ToString(), appId, sessionId, actor.Id, browser, form["decision"].ToString(), ct);
                    return Results.Content("<!doctype html><title>Assistant authority</title><p>Decision saved. Return to the assistant. You can close this window.</p>", "text/html");
                }
                var assistant = await authority.RequireAssistantAsync(appId, ct);
                var nonce = await authority.CreateDecisionAsync(appId, sessionId, actor.Id, browser, ct);
                static string E(string value) => WebUtility.HtmlEncode(value);
                return Results.Content($$"""
                    <!doctype html><html><head><meta name="viewport" content="width=device-width"><title>Assistant session authority</title>
                    <style>body{font:16px system-ui;max-width:640px;margin:48px auto;padding:20px}button{margin:12px 8px 0 0;padding:10px}</style></head><body>
                    <h1>Assistant session authority</h1><p>{{E(assistant.DisplayName)}} · {{E(appId)}}</p><p>Session: <code>{{E(sessionId)}}</code></p>
                    <p>Allow this session to use its approved MCP targets and source/workspace permissions on your behalf for one hour.
                    This does not add app permissions. The assistant cannot extend this window itself.</p>
                    <p>When time expires, new tool calls stop receiving authority; the conversation and agent run remain available.</p>
                    <form method="post"><input type="hidden" name="nonce" value="{{nonce}}">
                    <button name="decision" value="deny">Cancel</button><button name="decision" value="revoke">Revoke session authority</button>
                    <button name="decision" value="approve">Allow for one hour</button></form></body></html>
                    """, "text/html");
            }
            catch (AppIdentityException e) { return CoreJson.Json(new ErrorResponse(e.Code, e.Message), AuthEndpoints.MapIdentityErrorStatus(e.Code)); }
        });
    }
}
