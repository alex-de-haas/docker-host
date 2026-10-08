using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Haas.Hosty.Core;

internal sealed record AssistantMcpTokenRequest(string TargetAppId, string? SessionId = null);
internal sealed record AssistantMcpClaims(string Caller, string Audience, string UserId, string GrantHash,
    DateTimeOffset CallerInstallation, DateTimeOffset? TargetInstallation, string GrantRevision, long Expires, string? SessionId = null, string? LeaseRevision = null, bool DiscoveryOnly = false);
internal sealed record AssistantMcpActor(string UserId, string Role, AppRecord Caller, bool DiscoveryOnly = false);

// A separate signed format is never accepted by session, delegated-token or app API validators.
// Receiving MCP handlers introspect every call, so policy and parent-session revocation apply online.
internal sealed class AssistantMcpAccess(AppRegistryStore apps, AppServiceTokenService services,
    AgentPolicyStore policies, AppIdentityService identity, AppSessionGrantStore grants, DelegatedTokenSigningKey signing, IClock clock, AuditStore audit, AssistantSessionAuthority authority)
{
    internal const string Prefix = "hosty_mcp.1.";

    private async Task<(AppRecord Caller, AppRecord? Target, AssistantTargetGrant Grant)> RequireLinkAsync(
        string callerId, string targetId, CancellationToken ct)
    {
        var caller = await apps.GetAppAsync(callerId, ct);
        if (caller is null || !AgentMcpDirectory.IsAssistant(caller))
            throw new AppIdentityException("mcp_assistant_required", "An installed, confirmed assistant is required.");
        var target = targetId == AgentMcpDirectory.CoreId ? null : await apps.GetAppAsync(targetId, ct);
        if (targetId != AgentMcpDirectory.CoreId && (target is null || target.Interfaces?.ContainsKey("mcp") != true))
            throw new AppIdentityException("mcp_target_invalid", "The target does not expose MCP.");
        var policy = (await policies.ReadAsync(ct)).Targets.GetValueOrDefault(targetId);
        var grant = policy?.Assistants?.GetValueOrDefault(callerId);
        if (policy?.Offered != true || policy.InstalledAt != target?.InstalledAt || grant?.InstalledAt != caller.InstalledAt)
            throw new AppIdentityException("mcp_access_denied", "Core has not granted this assistant access to the target MCP.");
        return (caller, target, grant);
    }

    private async Task RequireTargetUserAsync(string targetId, AppSessionValidationResult actor, CancellationToken ct)
    {
        if (targetId == AgentMcpDirectory.CoreId)
        {
            if (actor.HostRole != "host.admin") throw new AppIdentityException("admin_required", "Core MCP requires an administrator.");
        }
        else await identity.RequireAccessibleUserAsync(targetId, actor.UserId, ct);
    }

    internal async Task<DelegatedTokenResponse> IssueAsync(string callerId, string targetId, string? serviceToken,
        string userToken, CancellationToken ct, string? sessionId = null, bool discoveryOnly = false)
    {
        if (!services.ValidateToken(callerId, serviceToken ?? ""))
            throw new AppIdentityException("token_invalid", "The assistant's service token is required.");
        if (!discoveryOnly && string.IsNullOrWhiteSpace(sessionId)) throw new AppIdentityException("reauth_required", "An assistant session ID is required.");
        var actor = discoveryOnly ? await identity.RequireActivityAsync(userToken, callerId, ct)
            : await authority.RequireAsync(callerId, sessionId!, AppIdentityService.HashToken(userToken), ct);
        if (discoveryOnly && actor.HostRole != "host.admin")
            throw new AppIdentityException("admin_required", "Catalog settings require an administrator.");
        var link = await RequireLinkAsync(callerId, targetId, ct);
        var grantHash = AppIdentityService.HashToken(userToken);
        var parent = await grants.TryResolveAsync(grantHash, ct);
        if (parent is null || parent.CreatedAt < link.Caller.InstalledAt)
            throw new AppIdentityException("token_invalid", "Sign in again after reinstalling the assistant.");
        await RequireTargetUserAsync(targetId, actor, ct);
        var expires = clock.UtcNow.AddMinutes(5);
        if (actor.ActiveUntil is { } activeUntil && activeUntil < expires) expires = activeUntil;
        if (discoveryOnly) expires = clock.UtcNow.AddSeconds(30);
        var claims = new AssistantMcpClaims(callerId, targetId, actor.UserId, grantHash,
            link.Caller.InstalledAt, link.Target?.InstalledAt, link.Grant.Revision, expires.ToUnixTimeSeconds(), sessionId, DiscoveryOnly: discoveryOnly);
        var data = Prefix + Encode(JsonSerializer.SerializeToUtf8Bytes(claims, CoreJson.TypeInfo<AssistantMcpClaims>()));
        await audit.AppendAsync(new AuditRecord($"audit_{Guid.NewGuid():N}", "auth.assistant-mcp.issue", "app", targetId,
            "succeeded", actor.UserId, clock.UtcNow, new Dictionary<string, string> { ["callerAppId"] = callerId }), ct);
        return new(data + "." + Encode(signing.Sign(Encoding.UTF8.GetBytes(data))), "Bearer", targetId, expires, Math.Max(0, (int)(expires - clock.UtcNow).TotalSeconds));
    }

    internal async Task<AssistantMcpActor?> ValidateAsync(string token, string audience, CancellationToken ct)
    {
        try
        {
            if (token.Length > 8192 || !token.StartsWith(Prefix, StringComparison.Ordinal)) return null;
            var parts = token[Prefix.Length..].Split('.');
            if (parts.Length != 2 || !signing.Verify(Encoding.UTF8.GetBytes(Prefix + parts[0]), Decode(parts[1]))) return null;
            var claims = JsonSerializer.Deserialize(Decode(parts[0]), CoreJson.TypeInfo<AssistantMcpClaims>());
            if (claims is null || claims.Audience != audience || claims.Expires <= clock.UtcNow.ToUnixTimeSeconds()) return null;
            var link = await RequireLinkAsync(claims.Caller, audience, ct);
            if (link.Caller.InstalledAt != claims.CallerInstallation || link.Target?.InstalledAt != claims.TargetInstallation
                || link.Grant.Revision != claims.GrantRevision) return null;
            if (claims.DiscoveryOnly)
            {
                var active = await identity.RequireActivityHashAsync(claims.GrantHash, claims.Caller, ct);
                if (active.HostRole != "host.admin") return null;
            }
            else
            {
                if (claims.SessionId is null) return null;
                // Credentials issued under the retired conversation-lease model must be reminted.
                if (claims.LeaseRevision is not null) return null;
                await authority.RequireAsync(claims.Caller, claims.SessionId, claims.GrantHash, ct);
            }
            var actor = await identity.RevalidateHashAsync(claims.GrantHash, claims.Caller, ct);
            if (actor.UserId != claims.UserId) return null;
            await RequireTargetUserAsync(audience, actor, ct);
            return new(actor.UserId, actor.HostRole ?? "", link.Caller, claims.DiscoveryOnly);
        }
        catch (Exception ex) when (ex is FormatException or JsonException or CryptographicException or ArgumentException or AppIdentityException)
        { return null; }
    }

    private static string Encode(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private static byte[] Decode(string value)
    {
        var text = value.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(text.PadRight(text.Length + (4 - text.Length % 4) % 4, '='));
    }
}

internal static class AssistantMcpEndpoints
{
    internal static void Map(WebApplication app) => app.MapPost("/api/internal/apps/{appId}/mcp/token", async (
        string appId, AssistantMcpTokenRequest? input, HttpRequest request, AssistantMcpAccess access, AppServiceTokenService services, CancellationToken ct) =>
    {
        try
        {
            if (!services.ValidateToken(appId, CoreSessionAuthorization.ReadBearerToken(request) ?? ""))
                return CoreJson.Json(new ErrorResponse("token_invalid", "The assistant's service token is required."), 401);
            if (string.IsNullOrWhiteSpace(input?.TargetAppId)) return CoreJson.Json(new ErrorResponse("mcp_target_required", "Select an MCP target."), 400);
            return CoreJson.Json(await access.IssueAsync(appId, input.TargetAppId, CoreSessionAuthorization.ReadBearerToken(request),
                request.Headers["X-Hosty-User-Token"].ToString(), ct, input.SessionId));
        }
        catch (AppIdentityException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), ex.Code is "token_invalid" or "reauth_required" ? 401 : 403); }
    });
}
