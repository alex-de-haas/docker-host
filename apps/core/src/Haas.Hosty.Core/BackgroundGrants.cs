using System.Security.Cryptography;
using Microsoft.AspNetCore.Routing;

namespace Haas.Hosty.Core;

internal sealed record BackgroundScope(string Id, string Kind, string TargetAppId, IReadOnlyList<string> Actions,
    string? ProviderKind = null, string? Key = null, DateTimeOffset? Installation = null, SandboxBackgroundPolicy? Sandbox = null, CoreEnvironmentPolicy? Environment = null);
internal sealed record BackgroundGrant(string Id, string UserId, string? AuthRevision, string AppId,
    DateTimeOffset Installation, string Label, IReadOnlyList<BackgroundScope> Scopes,
    DateTimeOffset CreatedAt, DateTimeOffset? ExpiresAt, DateTimeOffset? RevokedAt = null);
internal sealed record BackgroundGrantState(int Version, IReadOnlyList<BackgroundGrant> Grants);
internal sealed record BackgroundGrantRequest(string AppId, string Label, IReadOnlyList<BackgroundScope> Scopes,
    DateTimeOffset? ExpiresAt = null);
internal sealed record BackgroundTokenRequest(string GrantId, string ScopeId);
internal sealed record BackgroundTokenResponse(string AccessToken, DateTimeOffset ExpiresAt);

// Immutable, explicitly reviewed delegation. IDs are references: issuance also authenticates
// the consuming installation, and every dispatch rechecks the saved scope and live permissions.
internal sealed class BackgroundGrantService(CoreDataPaths paths, AppRegistryStore apps, UserDirectoryStore users,
    AppSessionGrantStore sessions, AgentPolicyStore policies, IClock clock, AuditStore audit)
{
    private readonly SemaphoreSlim mutex = new(1, 1);
    private string Path => System.IO.Path.Combine(paths.AuthRoot, "background-grants.json");
    internal Task<BackgroundGrantState?> ReadAsync(CancellationToken ct) => JsonStorage.ReadAsync<BackgroundGrantState>(Path, ct);
    internal static readonly IReadOnlyDictionary<string, (string Route, string Permission)> CoreActions =
        new Dictionary<string, (string, string)>(StringComparer.Ordinal)
        {
            ["health"] = ("GET /api/apps/{appId}/health", CoreAppPermissions.ReadApps),
            ["update-status"] = ("GET /api/apps/{appId}/update-status", CoreAppPermissions.ReadApps),
            ["update-plan"] = ("POST /api/apps/{appId}/update/plan", CoreAppPermissions.Install),
            ["update"] = ("POST /api/apps/{appId}/update", CoreAppPermissions.Install),
            ["start"] = ("POST /api/apps/{appId}/start", CoreAppPermissions.AppLifecycle),
            ["stop"] = ("POST /api/apps/{appId}/stop", CoreAppPermissions.AppLifecycle),
            ["restart"] = ("POST /api/apps/{appId}/restart", CoreAppPermissions.AppLifecycle),
        };

    internal Task<BackgroundGrant> CreateAsync(string owner, BackgroundGrantRequest input, CancellationToken ct)
        => CreateAsync(owner, input, ct, null);

    // Preserve the browser authorization snapshot: never adopt a revision created by concurrent revoke-all.
    internal Task<BackgroundGrant> CreateAsync(HostUserRecord actor, BackgroundGrantRequest input, CancellationToken ct)
        => CreateAsync(actor.Id, input, ct, actor);

    private async Task<BackgroundGrant> CreateAsync(string owner, BackgroundGrantRequest input, CancellationToken ct,
        HostUserRecord? actor)
    {
        var directory = await users.ReadAsync(ct);
        var user = directory.Users.FirstOrDefault(u => u.Id == owner || u.Email == owner);
        if (user is null || user.Disabled || !AppAccessPolicy.IsAdmin(user)) Deny("An enabled administrator must own the delegation.");
        if (actor is not null && user!.AuthRevision != actor.AuthRevision)
            Deny("The authorizing browser account changed. Sign in again.");
        if (string.IsNullOrWhiteSpace(input.AppId) || input.AppId.Length > 256
            || string.IsNullOrWhiteSpace(input.Label) || input.Label.Length > 120 || input.Scopes is not { Count: > 0 and <= 32 }
            || input.Scopes.Any(s => s is null || s.Id is not { Length: > 0 and <= 64 }
                || string.IsNullOrWhiteSpace(s.TargetAppId) || s.TargetAppId.Length > 256)
            || input.Scopes.Select(s => s.Id).Distinct(StringComparer.Ordinal).Count() != input.Scopes.Count
            || input.ExpiresAt <= clock.UtcNow) Deny("Choose a label, unique scopes and a future expiry or until revoked.");
        var caller = await apps.GetAppAsync(input.AppId, ct) ?? throw Error("The consuming app is not installed.");
        var scopes = new List<BackgroundScope>();
        foreach (var scope in input.Scopes)
        {
            var target = scope.TargetAppId == AgentMcpDirectory.CoreId ? null : await apps.GetAppAsync(scope.TargetAppId, ct);
            if (scope.TargetAppId != AgentMcpDirectory.CoreId && target is null) Deny("A scope target is not installed.");
            var pinned = scope with { Installation = target?.InstalledAt };
            await CheckScopeAsync(caller, pinned, ct);
            scopes.Add(pinned);
        }
        var grant = new BackgroundGrant(Guid.NewGuid().ToString("N"), user!.Id, user.AuthRevision, caller.Id,
            caller.InstalledAt, input.Label, scopes, clock.UtcNow, input.ExpiresAt);
        await mutex.WaitAsync(ct);
        try
        {
            var currentUser = (await users.ReadAsync(ct)).Users.FirstOrDefault(u => u.Id == grant.UserId);
            if (currentUser is null || currentUser.Disabled || !AppAccessPolicy.IsAdmin(currentUser)
                || currentUser.AuthRevision != grant.AuthRevision)
                Deny("The owner's authorization changed.");
            // A later revision change still invalidates this pinned grant, even if it races the write.
            var state = await ReadAsync(ct) ?? new(1, []);
            await JsonStorage.WriteAsync(Path, state with { Grants = state.Grants.Append(grant).ToArray() }, true, ct);
        }
        finally { mutex.Release(); }
        await AuditAsync(grant, "create", ct);
        return grant;
    }

    internal async Task RevokeAsync(string owner, string? id, CancellationToken ct)
    {
        await mutex.WaitAsync(ct);
        try
        {
            var state = await ReadAsync(ct) ?? new(1, []);
            var selected = state.Grants.Where(g => g.UserId == owner && (id is null || g.Id == id) && g.RevokedAt is null).ToArray();
            await JsonStorage.WriteAsync(Path, state with { Grants = state.Grants.Select(g => selected.Contains(g)
                ? g with { RevokedAt = clock.UtcNow } : g).ToArray() }, true, ct);
            foreach (var grant in selected) await AuditAsync(grant, "revoke", ct);
        }
        finally { mutex.Release(); }
    }

    internal async Task<(BackgroundGrant Grant, BackgroundScope Scope)> ValidateAsync(string appId, string id, string scopeId, CancellationToken ct)
    {
        var grant = (await ReadAsync(ct))?.Grants.FirstOrDefault(g => g.Id == id && g.AppId == appId)
            ?? throw Error("Background delegation is unavailable.");
        if (grant.RevokedAt is not null || grant.ExpiresAt <= clock.UtcNow) Deny("Background delegation has ended.");
        var user = (await users.ReadAsync(ct)).Users.FirstOrDefault(u => u.Id == grant.UserId);
        if (user is null || user.Disabled || !AppAccessPolicy.IsAdmin(user) || user.AuthRevision != grant.AuthRevision)
            Deny("The owner's authorization changed.");
        var caller = await apps.GetAppAsync(appId, ct);
        if (caller is null || caller.InstalledAt != grant.Installation) Deny("The consuming installation changed.");
        var scope = grant.Scopes.FirstOrDefault(s => s.Id == scopeId) ?? throw Error("The selected scope is unavailable.");
        await CheckScopeAsync(caller!, scope, ct);
        return (grant, scope);
    }

    private async Task CheckScopeAsync(AppRecord caller, BackgroundScope scope, CancellationToken ct)
    {
        var target = scope.TargetAppId == AgentMcpDirectory.CoreId ? null : await apps.GetAppAsync(scope.TargetAppId, ct);
        if (scope.TargetAppId != AgentMcpDirectory.CoreId && (target is null || target.InstalledAt != scope.Installation)) Deny("The target installation changed.");
        if (scope.Actions is null || scope.Actions.Count > 32 || scope.Actions.Any(a => string.IsNullOrWhiteSpace(a) || a.Length > 128 || a.Contains('*')))
            Deny("Name exact actions without wildcards.");
        switch (scope.Kind)
        {
            case "core-environment":
                if (scope.TargetAppId != AgentMcpDirectory.CoreId || scope.Environment is not { } environment
                    || !CoreEnvironmentConsentService.Valid(environment) || scope.Actions.Count == 0
                    || scope.Actions.Any(a => !CoreEnvironmentConsentService.Actions.Contains(a, StringComparer.Ordinal)
                        || !AppManagementAuthorization.HasPermission(caller, a == "read"
                            ? CoreAppPermissions.CoreEnvironmentsRead : CoreAppPermissions.CoreEnvironmentsManage))
                    || environment.Mode == "source" && !AppManagementAuthorization.HasPermission(caller, CoreAppPermissions.Sources))
                    Deny("Trusted Core scope exceeds the reviewed launch target or current permissions.");
                break;
            case "sandbox":
                if (target is null || scope.Actions.Count == 0 || scope.Sandbox is not { } sandbox
                    || sandbox.InputDigest is null || sandbox.Limits is null || sandbox.InputDigest.Length != 64 || sandbox.InputDigest.Any(c => !char.IsAsciiHexDigit(c))
                    || sandbox.SourceKind is not ("appArtifact" or "worktree")
                    || (sandbox.SourceKind == "worktree" && (sandbox.WorktreeId is null
                        || !AppManagementAuthorization.HasPermission(caller, CoreAppPermissions.Sources)))
                    || scope.Actions.Any(action => !SandboxAuthorization.Actions.Contains(action, StringComparer.Ordinal)
                        || !AppManagementAuthorization.HasPermission(caller, action is "read" or "export"
                            ? CoreAppPermissions.SandboxesRead : CoreAppPermissions.SandboxesManage)))
                    Deny("Sandbox actions exceed this app's reviewed targets, inputs or permissions.");
                _ = SandboxValidation.Limits(scope.Sandbox!.Limits);
                break;
            case "core":
                if (target is null || scope.Actions.Count == 0 || scope.Actions.Any(a => !CoreActions.TryGetValue(a, out var policy)
                    || !AppManagementAuthorization.HasPermission(caller, policy.Permission))) Deny("Core actions exceed this app's current grants.");
                break;
            case "provider":
                if (scope.ProviderKind is not ("assistant" or "speech-to-text" or "tasks" or "task-executor") || string.IsNullOrWhiteSpace(scope.Key)
                    || scope.Actions.Count != 0 || target?.ConfirmedRoles?.Contains(scope.ProviderKind) != true
                    || target.Interfaces?.GetValueOrDefault(scope.ProviderKind)?.Any(i => i.Key == scope.Key) != true
                    || !AppManagementAuthorization.HasPermission(caller, ProviderAccessService.Permission(scope.ProviderKind)))
                    Deny("The provider scope is unavailable or exceeds current grants.");
                break;
            case "mcp":
                var policy = (await policies.ReadAsync(ct)).Targets.GetValueOrDefault(scope.TargetAppId);
                var binding = policy?.Assistants?.GetValueOrDefault(caller.Id);
                if (scope.Actions.Count == 0 || !AgentMcpDirectory.IsAssistant(caller) || policy is null || !(binding?.Enabled ?? policy.Offered)
                    || scope.Actions.Any(a => binding?.DeniedTools?.Contains(a, StringComparer.Ordinal) == true)
                    || policy.InstalledAt != target?.InstalledAt
                    || policy.Assistants?.GetValueOrDefault(caller.Id)?.InstalledAt != caller.InstalledAt
                    || (target is not null && target.Interfaces?.ContainsKey("mcp") != true)) Deny("The assistant has no reviewed MCP target grant.");
                if (target is null && scope.Actions.Any(a => !McpEndpoints.HasAppToolPermission(caller, a)))
                    Deny("Core tools exceed current app permissions.");
                break;
            default: Deny("Unknown background scope kind."); break;
        }
    }

    internal async Task<BackgroundTokenResponse> IssueAsync(string appId, BackgroundTokenRequest input, CancellationToken ct)
    {
        var (grant, _) = await ValidateAsync(appId, input.GrantId, input.ScopeId, ct);
        var now = clock.UtcNow;
        var expires = now.AddMinutes(5);
        if (grant.ExpiresAt < expires) expires = grant.ExpiresAt.Value;
        var token = "hostyg_" + Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        await sessions.AppendAsync(new(Guid.NewGuid().ToString("N"), appId, grant.UserId, AppIdentityService.HashToken(token),
            "background", now, now, expires, null, null, grant.AuthRevision, null, 1, grant.Installation, grant.Id, input.ScopeId), now, ct);
        await AuditAsync(grant, "issue", ct);
        return new(token, expires);
    }

    internal Task AuditAsync(BackgroundGrant grant, string action, CancellationToken ct) => audit.AppendAsync(new(
        Guid.NewGuid().ToString("N"), "auth.background." + action, "background-grant", grant.Id, "succeeded", grant.UserId,
        clock.UtcNow, new Dictionary<string, string> { ["appId"] = grant.AppId }), ct);
    internal static bool AllowsRoute(BackgroundScope scope, HttpRequest request) => scope.Kind == "core"
        && request.RouteValues["appId"]?.ToString() == scope.TargetAppId
        && scope.Actions.Any(a => CoreActions.TryGetValue(a, out var policy) && policy.Route ==
            $"{request.Method} {(request.HttpContext.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText}");
    internal static AppIdentityException Error(string message) => new("background_scope_denied", message);
    [System.Diagnostics.CodeAnalysis.DoesNotReturn]
    private static void Deny(string message) => throw Error(message);
}
