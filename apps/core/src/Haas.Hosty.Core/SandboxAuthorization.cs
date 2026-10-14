namespace Haas.Hosty.Core;

internal sealed class SandboxAuthorization(AppServiceTokenService services, AppRegistryStore apps,
    AppIdentityService identity, AppSessionGrantStore sessions, BackgroundGrantService background,
    SandboxStore store, UserDirectoryStore users)
{
    internal static readonly string[] Actions = ["plan", "prepare", "read", "seed", "users", "start", "restart", "stop", "reset", "dispose", "browser", "export", "viewers", "evidence-clear", "browser-cancel"];

    public async Task<SandboxActor> RequireAsync(HttpRequest request, string callerId, string action,
        string? instanceId, SandboxPlanRequest? input, string? planId, CancellationToken ct)
    {
        if (!services.ValidateToken(callerId, CoreSessionAuthorization.ReadBearerToken(request) ?? ""))
            throw new AppIdentityException("token_invalid", "The calling installation's app service credential is required.");
        if (request.Cookies.ContainsKey(CoreSessionAuthorization.SessionCookieName))
            throw new AppIdentityException("app_credential_mixed", "Use app authority without a Core cookie.");
        var caller = await apps.GetAppAsync(callerId, ct);
        var permission = action is "read" or "export" ? CoreAppPermissions.SandboxesRead : CoreAppPermissions.SandboxesManage;
        if (caller is null || !AppManagementAuthorization.HasPermission(caller, permission))
            throw new AppIdentityException("app_permission_required", "The app needs the reviewed " + permission + " permission.");
        var token = request.Headers["X-Hosty-User-Token"].ToString();
        if (!token.StartsWith("hostyg_", StringComparison.Ordinal))
            throw new AppIdentityException("token_invalid", "Interactive or explicit background authority is required.");
        var hash = AppIdentityService.HashToken(token);
        var actor = await identity.RequireOperationHashAsync(hash, callerId,
            scope => scope.Kind == "sandbox" && scope.Actions.Contains(action, StringComparer.Ordinal), ct);
        if (!(await users.ReadAsync(ct)).Users.Any(user => user.Id == actor.UserId && !user.Disabled && AppAccessPolicy.IsAdmin(user)))
            throw new AppIdentityException("admin_required", "Sandbox management requires a current authorizing administrator.");
        var grant = await sessions.TryResolveAsync(hash, ct);
        if (grant?.BackgroundGrantId is null) return new(actor.UserId, callerId, caller.InstalledAt);
        var (_, scope) = await background.ValidateAsync(callerId, grant.BackgroundGrantId, grant.BackgroundScopeId!, ct);
        var policy = scope.Sandbox ?? throw BackgroundGrantService.Error("Sandbox input policy is missing.");
        if (instanceId is not null)
        {
            var instance = await store.ReadAsync(instanceId, ct);
            if (instance is not null) input = instance.Request;
            else if (action != "read" && action != "dispose") throw new SandboxException("sandbox_not_found", "Sandbox not found.", 404);
        }
        if (planId is not null)
        {
            var plan = await JsonStorage.ReadAsync<SandboxPlanRecord>(store.PlanPath(planId), ct)
                ?? throw new SandboxException("sandbox_plan_not_found", "Sandbox plan not found.", 404);
            if (plan.Input.Digest != policy.InputDigest)
                throw BackgroundGrantService.Error("The reviewed recipe exceeds the delegated scope.");
            input = plan.Plan.Request;
        }
        if (input is not null)
        {
            var limits = SandboxValidation.Limits(input.Limits);
            if (input.AppId != scope.TargetAppId || input.Source.Kind != policy.SourceKind
                || input.Source.WorktreeId != policy.WorktreeId
                || (input.Source.Kind == "appArtifact" && input.Source.ArtifactDigest != policy.InputDigest)
                || limits.MemoryBytes > policy.Limits.MemoryBytes || limits.Cpus > policy.Limits.Cpus
                || limits.Pids > policy.Limits.Pids || limits.DataBytes > policy.Limits.DataBytes
                || limits.CacheBytes > policy.Limits.CacheBytes || limits.StartupSeconds > policy.Limits.StartupSeconds)
                throw BackgroundGrantService.Error("The sandbox target, input or limits exceed the delegated scope.");
            if (instanceId is not null && (await store.ReadAsync(instanceId, ct)) is { } existing && existing.Input.Digest != policy.InputDigest)
                throw BackgroundGrantService.Error("The runtime recipe exceeds the delegated scope.");
        }
        return new(actor.UserId, callerId, caller.InstalledAt, grant.BackgroundGrantId, grant.BackgroundScopeId);
    }
}
