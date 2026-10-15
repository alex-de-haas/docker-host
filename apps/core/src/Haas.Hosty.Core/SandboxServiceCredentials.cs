using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

// Purpose separation is also a parser boundary: no installed-app/Core authenticator accepts
// this prefix. The current persisted generation and installation are checked on every use.
internal sealed class SandboxServiceCredentials(AppServiceSigningKey key, SandboxStore store,
    AppRegistryStore apps, UserDirectoryStore users, BackgroundGrantService background, ISandboxInputs inputs)
{
    public string Create(SandboxInstance instance)
    {
        var scope = string.Join('\n', instance.Id, instance.Generation, instance.DataRevision,
            instance.Input.AppId, instance.Input.Installation.ToString("O"));
        return "hostysb_service_" + Convert.ToHexString(HMACSHA256.HashData(key.Value,
            Encoding.UTF8.GetBytes("hosty-sandbox-service-v1\n" + scope))).ToLowerInvariant();
    }

    public async Task<SandboxInstance> RequireAsync(string id, string? token, CancellationToken ct, bool starting = false)
    {
        if (token is null || !token.StartsWith("hostysb_service_", StringComparison.Ordinal) || !Guid.TryParseExact(id, "N", out _))
            throw new SandboxException("sandbox_service_invalid", "The instance service credential is invalid.", 401);
        var instance = await store.ReadAsync(id, ct);
        if (instance is null || token is null || !CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(Create(instance)), Encoding.UTF8.GetBytes(token)))
            throw new SandboxException("sandbox_service_invalid", "The instance service credential is invalid.", 401);
        store.RequireNotRevoked(id);
        if (!(instance.State == "ready" && !instance.AccessRevoked) && !(starting && instance.State == "starting"))
            throw new SandboxException("sandbox_unavailable", "The sandbox is not accepting access.", 403);
        var app = await apps.GetAppAsync(instance.Input.AppId, ct);
        var directory = await users.ReadAsync(ct);
        if (app?.InstalledAt != instance.Input.Installation
            || !directory.Users.Any(user => user.Id == instance.Owner.UserId && !user.Disabled && AppAccessPolicy.IsAdmin(user)))
            throw new SandboxException("sandbox_authority_revoked", "The owning account or app installation is unavailable.", 403);
        if (instance.Owner.AppId is { } callerId)
        {
            var caller = await apps.GetAppAsync(callerId, ct);
            if (caller is null || caller.InstalledAt != instance.Owner.Installation || !AppManagementAuthorization.HasPermission(caller, CoreAppPermissions.SandboxesManage))
                throw new SandboxException("sandbox_authority_revoked", "The creating app's sandbox authority is unavailable.", 403);
            if (instance.Owner.GrantId is { } grantId)
            {
                try
                {
                    var (_, scope) = await background.ValidateAsync(callerId, grantId, instance.Owner.ScopeId!, ct);
                    if (scope.Kind != "sandbox" || scope.TargetAppId != instance.Input.AppId || scope.Sandbox?.InputDigest != instance.Input.Digest)
                        throw new SandboxException("sandbox_authority_revoked", "The background grant no longer covers this instance.", 403);
                }
                catch (AppIdentityException) { throw new SandboxException("sandbox_authority_revoked", "The background grant is unavailable.", 403); }
            }
        }
        try { await inputs.ValidateAuthorityAsync(instance, ct); }
        catch (AppLifecycleException) { throw new SandboxException("sandbox_source_forbidden", "The current source authority is unavailable.", 403); }
        return instance;
    }
}
