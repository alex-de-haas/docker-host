using System.Text;
using System.Text.Json;

namespace Haas.Hosty.Core;

internal sealed record CoreAgentMcpTarget(string Kind, string? AppId = null, string? InstallationId = null, string? Key = null);
internal sealed record CoreAgentMcpRequest(string AdmissionRef, CoreAgentMcpTarget Target, string[]? Tools = null);
internal sealed record CoreAgentMcpToken(string Url, string Token, DateTimeOffset ExpiresAt);

internal sealed partial class CoreAgentExecution
{
    private async Task<(CoreAgentAuthorization Record, CoreCapabilityCaller Origin, AppRecord? Target,
        AssistantTargetGrant Grant, string[]? Allowed)> McpScope(AppRecord provider, string reference,
        string targetId, string? installation, string key, string[]? requested, CancellationToken ct)
    {
        var (record, origin) = await ValidateRecord(provider, await store.Get(reference, ct), ct);
        if (record.Authority is not null && (origin.App?.Id != record.CallerAppId || origin.App.InstalledAt != record.CallerInstallation))
            throw new CoreProviderException("mcp_origin_unsupported", "Configured MCP connections require the retained task's originating consumer grant.", 422);
        JsonElement selected = default;
        if (record.Request.Ceiling is { } ceiling && ceiling.TryGetProperty("mcp", out var mcp)
            && mcp.ValueKind == JsonValueKind.Object && mcp.TryGetProperty("targets", out var targets) && targets.ValueKind == JsonValueKind.Array)
            foreach (var entry in targets.EnumerateArray())
            {
                if (!entry.TryGetProperty("target", out var target)) continue;
                var kind = target.GetProperty("kind").GetString();
                if (targetId == AgentMcpDirectory.CoreId ? kind == "core" : kind == "app"
                    && target.GetProperty("appId").GetString() == targetId
                    && target.GetProperty("installationId").GetString() == installation
                    && target.GetProperty("key").GetString() == key) { selected = entry; break; }
            }
        if (selected.ValueKind == JsonValueKind.Undefined) throw new AppIdentityException("permission_denied", "This MCP target is outside the accepted execution ceiling.");
        var targetApp = targetId == AgentMcpDirectory.CoreId ? null : await apps.GetAppAsync(targetId, ct);
        if (targetId != AgentMcpDirectory.CoreId && (targetApp is null || PanelIdentity.Installation(targetApp) != installation
            || targetApp.Interfaces?.ContainsKey("mcp") != true)) throw new AppIdentityException("permission_denied", "The selected MCP installation changed.");
        var policy = (await policies.ReadAsync(ct)).Targets.GetValueOrDefault(targetId);
        var grant = policy?.Assistants?.GetValueOrDefault(record.CallerAppId);
        if (grant is null || !(grant.Enabled ?? policy!.Offered) || policy!.InstalledAt != targetApp?.InstalledAt
            || grant.InstalledAt != record.CallerInstallation) throw new AppIdentityException("mcp_access_denied", "The originating consumer has no current target grant.");
        if (targetApp is not null) await identity.RequireAccessibleUserAsync(targetId, record.UserId, ct);
        string[]? allowed = selected.TryGetProperty("tools", out var tools) && tools.ValueKind != JsonValueKind.Null ? tools.EnumerateArray().Select(t => t.GetString() ?? "").ToArray() : null;
        if (requested is not null)
        {
            if (requested.Length > 1000 || requested.Any(t => string.IsNullOrWhiteSpace(t) || allowed is not null && !allowed.Contains(t)))
                throw new AppIdentityException("permission_denied", "The requested tool subset exceeds the execution ceiling.");
            allowed = requested;
        }
        if (selected.TryGetProperty("policy", out var policySelection) && policySelection.ValueKind == JsonValueKind.Object
            && policySelection.TryGetProperty("tools", out var toolPolicies) && toolPolicies.ValueKind == JsonValueKind.Object)
        {
            var disabled = toolPolicies.EnumerateObject().Where(p => p.Value.GetProperty("mode").GetString() == "disabled").Select(p => p.Name);
            grant = grant with { DeniedTools = (grant.DeniedTools ?? []).Concat(disabled).Distinct(StringComparer.Ordinal).ToArray() };
        }
        return (record, origin, targetApp, grant, allowed);
    }
    internal async Task<CoreAgentMcpToken> McpToken(AppRecord provider, CoreAgentMcpRequest input, CancellationToken ct)
    {
        if (input.Target.Kind is not ("core" or "app")) throw Invalid("Select a declared Core or app MCP target.");
        var targetId = input.Target.Kind == "core" ? AgentMcpDirectory.CoreId : input.Target.AppId ?? "";
        var key = input.Target.Key ?? "default";
        var (record, _, target, grant, allowed) = await McpScope(provider, input.AdmissionRef, targetId,
            input.Target.InstallationId, key, input.Tools, ct);
        var url = target is null ? config.ListenUrl.TrimEnd('/') + "/api/mcp"
            : AppSummary.BuildInterfaceSummaries(target.Interfaces, target.Endpoints, useTransportUrls: true)?.GetValueOrDefault("mcp")?.SingleOrDefault(i => i.Key == key)?.Url;
        if (url is null) throw new CoreProviderException("provider_unavailable", "The MCP endpoint is unavailable.", 503, true);
        var expires = clock.UtcNow.AddMinutes(5); if (record.ExpiresAt < expires) expires = record.ExpiresAt;
        var claims = new AssistantMcpClaims(provider.Id, targetId, record.UserId, "", provider.InstalledAt,
            target?.InstalledAt, grant.Revision, expires.ToUnixTimeSeconds(), record.Request.SessionId,
            AgentAdmissionRef: record.Id, AgentTargetKey: key, AgentAllowedTools: allowed);
        var data = AssistantMcpAccess.Prefix + Encode(JsonSerializer.SerializeToUtf8Bytes(claims, CoreJson.TypeInfo<AssistantMcpClaims>()));
        return new(url, data + "." + Encode(signing.Sign(Encoding.UTF8.GetBytes(data))), expires);
    }
    internal async Task<AssistantMcpActor?> ValidateMcp(AssistantMcpClaims claims, CancellationToken ct)
    {
        var provider = await apps.GetAppAsync(claims.Caller, ct);
        if (provider is null || provider.InstalledAt != claims.CallerInstallation || claims.AgentAdmissionRef is null) return null;
        var target = claims.Audience == AgentMcpDirectory.CoreId ? null : await apps.GetAppAsync(claims.Audience, ct);
        var (record, origin, _, grant, allowed) = await McpScope(provider, claims.AgentAdmissionRef, claims.Audience,
            target is null ? null : PanelIdentity.Installation(target), claims.AgentTargetKey ?? "default", claims.AgentAllowedTools, ct);
        if (claims.UserId != record.UserId || claims.TargetInstallation != target?.InstalledAt || claims.GrantRevision != grant.Revision
            || claims.SessionId != record.Request.SessionId) return null;
        // Keep the same provenance as the permissions, including when the originating task
        // was itself admitted through a provider. Never substitute an intermediate provider.
        var permissionSource = origin.EffectivePermissions is null && origin.App is { } app
            ? new CoreAppPermissionSource(app.Id, app.InstalledAt) : origin.PermissionSource;
        if (permissionSource is null) return null;
        var permissions = (origin.EffectivePermissions ?? origin.App?.GrantedCorePermissions ?? []).ToArray();
        return new(record.UserId, origin.User.Role, provider, AllowedTools: allowed, DeniedTools: grant.DeniedTools,
            EffectivePermissions: permissions, AgentExecution: record.Id,
            PermissionSource: permissionSource);
    }
}
