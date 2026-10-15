using System.Security.Cryptography;

namespace Haas.Hosty.Core;

internal sealed record CoreEnvironmentPolicy(string Mode, string Target, string TargetDigest,
    CoreEnvironmentLimits Limits, string Contract = "trusted-core-v1", string? RequestDigest = null);
internal sealed record CoreEnvironmentConsent(string GrantId, string ScopeId, CoreEnvironmentPolicy Policy);
internal sealed record CoreEnvironmentConsentPlan(string AppId, DateTimeOffset Installation, string UserId,
    string? AuthRevision, string DisplayName, CoreEnvironmentCreate Request, CoreEnvironmentPolicy Policy);
internal sealed record CoreEnvironmentSavedConsent(string Id, string AppId, string Label, string Mode, string Target, CoreEnvironmentLimits Limits, string State);
internal sealed record CoreEnvironmentEffectiveAccess(string State, string? GrantId, bool Saved, string Description);

// Consent delegates a trusted process, not a filtered copy of the child's API. The normal grant
// store owns revocation, account revisions, installation binding and short-lived credentials.
internal sealed class CoreEnvironmentConsentService(HostyCoreRuntimeConfig config, BackgroundGrantService grants,
    AppRegistryStore apps, UserDirectoryStore users)
{
    internal readonly SemaphoreSlim RequestGate = new(1, 1);
    private readonly SemaphoreSlim approvalGate = new(1, 1);
    internal static readonly string[] Actions = ["read", "manage"];
    internal const string Description = "Trusted child Core with ordinary administrator rights, outbound networking and shared Docker. App installation and shared mounts use the child's normal Core review. Revoking parent access does not stop the child or revoke its own accounts; use Stop or Finish.";

    internal static bool Valid(CoreEnvironmentPolicy policy)
    {
        if (policy.Contract != "trusted-core-v1" || policy.Mode is not ("current" or "release" or "source")
            || string.IsNullOrWhiteSpace(policy.Target) || policy.Target.Length > 4096
            || !Digest(policy.TargetDigest) || policy.RequestDigest is not null && !Digest(policy.RequestDigest)
            || policy.Limits is null) return false;
        try { CoreEnvironmentResources.Validate(policy.Limits); return true; }
        catch (SandboxException) { return false; }
    }
    private static bool Digest(string? value) => value is { Length: 64 } && value.All(char.IsAsciiHexDigit);
    internal static bool Covers(CoreEnvironmentPolicy policy, CoreEnvironmentPolicy requested)
    {
        var a = policy.Limits; var b = requested.Limits;
        return policy.Contract == requested.Contract && policy.Mode == requested.Mode
            && policy.Target == requested.Target && policy.TargetDigest == requested.TargetDigest
            && (policy.RequestDigest is null || policy.RequestDigest == requested.RequestDigest)
            && b.MemoryBytes <= a.MemoryBytes && b.Cpus <= a.Cpus && b.Pids <= a.Pids && b.DiskBytes <= a.DiskBytes
            && b.ApplicationMemoryBytes <= a.ApplicationMemoryBytes && b.ApplicationCpus <= a.ApplicationCpus
            && b.ApplicationPids <= a.ApplicationPids;
    }
    internal async Task<CoreEnvironmentPolicy> PolicyAsync(CoreEnvironmentCreate request, CancellationToken ct, Dictionary<string, Task<string>>? digests = null)
    {
        var target = request.Mode == "source" ? Path.GetFullPath(request.ProjectPath!)
            : request.Mode == "release" ? Path.Combine(config.DataRoot, "core", "bin", OperatingSystem.IsWindows() ? "hosty-core.exe" : "hosty-core")
            : "current";
        string digest;
        if (request.Mode == "source")
        {
            // Source approval explicitly trusts edits in this project/worktree. Do not bind a Git
            // commit or hash source files: doing so would turn every edit into another prompt.
            digest = SandboxValidation.Hash("trusted-core-source-v1|" + target);
        }
        else
        {
            // Generation paths and retention markers change during an otherwise identical parent
            // restart. Bind executable content and runtime metadata, not that incidental location.
            var directory = request.Mode == "release" ? Path.GetDirectoryName(target)! : AppContext.BaseDirectory;
            var key = request.Mode + "|" + target;
            if (digests is null || !digests.TryGetValue(key, out var pending))
            {
                pending = request.Mode == "release" ? HashFilesAsync(directory, [target], ct) : CurrentDigestAsync(directory, ct);
                digests?.Add(key, pending);
            }
            digest = await pending;
        }
        return new(request.Mode, target, digest, request.Limits ?? new(), RequestDigest: SandboxValidation.Hash(CoreJson.Text(request)));
    }
    internal static Task<string> CurrentDigestAsync(string directory, CancellationToken ct)
        => HashFilesAsync(directory, CoreEnvironmentRuntime.PreparedEntries(directory)
            .OfType<FileInfo>().Select(file => file.FullName), ct);
    private static async Task<string> HashFilesAsync(string directory, IEnumerable<string> files, CancellationToken ct)
    {
        var selected = files.Order(StringComparer.Ordinal).ToArray();
        if (selected.Length == 0 || selected.Any(p => !File.Exists(p)))
            throw new SandboxException("environment_binary_missing", "The selected Core target is unavailable.", 409);
        var hashes = new List<string>();
        foreach (var file in selected)
        {
            await using var stream = File.OpenRead(file);
            hashes.Add(Path.GetRelativePath(directory, file)
                + ":" + Convert.ToHexString(await SHA256.HashDataAsync(stream, ct)));
        }
        return SandboxValidation.Hash(string.Join("\n", hashes));
    }
    internal async Task<CoreEnvironmentConsentPlan> PlanAsync(SandboxActor actor, CoreEnvironmentCreate request, CancellationToken ct)
    {
        var app = await apps.GetAppAsync(actor.AppId!, ct)
            ?? throw new AppIdentityException("app_access_denied", "The requesting app is unavailable.");
        var user = (await users.ReadAsync(ct)).Users.First(u => u.Id == actor.UserId);
        return new(app.Id, app.InstalledAt, user.Id, user.AuthRevision, app.DisplayName, request, await PolicyAsync(request, ct));
    }
    internal async Task ApproveAsync(CoreEnvironmentConsentPlan plan, bool saved, CancellationToken ct)
    {
        await approvalGate.WaitAsync(ct);
        try
        {
            var user = (await users.ReadAsync(ct)).Users.FirstOrDefault(u => u.Id == plan.UserId);
            var app = await apps.GetAppAsync(plan.AppId, ct);
            var current = await PolicyAsync(plan.Request, ct);
            if (user is null || user.AuthRevision != plan.AuthRevision || app is null || app.InstalledAt != plan.Installation
                || current != plan.Policy)
                throw new AppIdentityException("environment_consent_changed", "The owner, installation or Core target changed. Review a new request.");
            var actions = Actions.Where(action => AppManagementAuthorization.HasPermission(app, action == "read"
                ? CoreAppPermissions.CoreEnvironmentsRead : CoreAppPermissions.CoreEnvironmentsManage)).ToArray();
            var policy = saved ? plan.Policy with { RequestDigest = null } : plan.Policy;
            // Approval pages are temporary, while grants survive Core restarts. Re-preparing or
            // concurrently approving the same authority must not leave duplicate live grants.
            foreach (var grant in (await grants.ReadAsync(ct))?.Grants ?? [])
            {
                if (grant.AppId != plan.AppId || grant.UserId != plan.UserId || grant.Scopes.Count != 1) continue;
                var scope = grant.Scopes[0];
                if (scope.Kind != "core-environment" || scope.TargetAppId != AgentMcpDirectory.CoreId
                    || scope.Environment != policy || !scope.Actions.ToHashSet(StringComparer.Ordinal).SetEquals(actions)) continue;
                try { _ = await grants.ValidateAsync(plan.AppId, grant.Id, scope.Id, ct); return; }
                catch (AppIdentityException) { }
            }
            _ = await grants.CreateAsync(user, new(plan.AppId, plan.Request.Label,
                [new("environment", "core-environment", AgentMcpDirectory.CoreId, actions, Environment: policy)]), ct);
        }
        finally { approvalGate.Release(); }
    }

    internal async Task<CoreEnvironmentConsent> FindAsync(SandboxActor actor, CoreEnvironmentCreate request, CancellationToken ct)
    {
        var policy = await PolicyAsync(request, ct);
        var candidates = (await grants.ReadAsync(ct))?.Grants.Where(g => g.AppId == actor.AppId && g.UserId == actor.UserId
            && (actor.GrantId is null || actor.GrantId == g.Id)) ?? [];
        foreach (var grant in candidates.Reverse())
        foreach (var scope in grant.Scopes.Where(s => s.Kind == "core-environment" && s.Actions.Contains("manage")
            && (actor.ScopeId is null || actor.ScopeId == s.Id)))
        {
            try
            {
                var valid = await grants.ValidateAsync(actor.AppId!, grant.Id, scope.Id, ct);
                if (valid.Scope.Environment is { } approved && Covers(approved, policy)) return new(grant.Id, scope.Id, policy);
            }
            catch (AppIdentityException) { }
        }
        throw new SandboxException("environment_consent_required", "Review this trusted Core launch through environment_consent, then retry the original creation request. No matching active consent covers this caller, mode, target and limits.", 403);
    }
    internal async Task RequireAsync(SandboxActor actor, CoreEnvironmentRecord record, bool launch, CancellationToken ct)
    {
        // Direct operators retain ordinary authority, including recovery after delegation is revoked.
        if (actor.AppId is null) return;
        if (record.Consent is not { } consent)
        {
            if (record.OperatorApproved) return;
            throw new SandboxException("environment_consent_required", "Review this existing trusted Core through environment_consent, then retry its original creation request.", 403);
        }
        if (actor.GrantId is not null && (actor.GrantId != consent.GrantId || actor.ScopeId != consent.ScopeId))
            throw new AppIdentityException("environment_consent_denied", "The environment belongs to another consent.");
        var (grant, scope) = await grants.ValidateAsync(actor.AppId, consent.GrantId, consent.ScopeId, ct);
        if (grant.UserId != actor.UserId || scope.Kind != "core-environment" || !scope.Actions.Contains("manage")
            || scope.Environment is not { } policy || !Covers(policy, consent.Policy)
            || launch && !Covers(policy, await PolicyAsync(record.Request, ct)))
            throw new AppIdentityException("environment_consent_denied", "The launch target or consent changed. Review a new request.");
    }
    internal async Task FinishAsync(CoreEnvironmentRecord record, CancellationToken ct)
    {
        if (record.Consent is not { } consent) return;
        var grant = (await grants.ReadAsync(ct))?.Grants.FirstOrDefault(g => g.Id == consent.GrantId && g.UserId == record.Owner.UserId);
        if (grant?.Scopes.SingleOrDefault(s => s.Id == consent.ScopeId)?.Environment?.RequestDigest is not null)
            await grants.RevokeAsync(record.Owner.UserId, consent.GrantId, ct);
    }
    internal async Task<IReadOnlyList<CoreEnvironmentSavedConsent>> ListAsync(SandboxActor actor, CancellationToken ct, Dictionary<string, Task<string>>? digests = null)
    {
        digests ??= new(StringComparer.Ordinal);
        var result = new List<CoreEnvironmentSavedConsent>();
        foreach (var grant in (await grants.ReadAsync(ct))?.Grants ?? [])
        {
            if (grant.UserId != actor.UserId || grant.Scopes.Count != 1 || grant.RevokedAt is not null
                || actor.AppId is not null && actor.AppId != grant.AppId
                || actor.GrantId is not null && actor.GrantId != grant.Id) continue;
            var scope = grant.Scopes[0];
            if (scope.Kind != "core-environment" || scope.Environment is not { RequestDigest: null } policy) continue;
            var state = "active";
            try
            {
                _ = await grants.ValidateAsync(grant.AppId, grant.Id, scope.Id, ct);
                var request = new CoreEnvironmentCreate(Guid.Empty.ToString("N"), grant.Label, policy.Mode,
                    policy.Mode == "source" ? policy.Target : null, Limits: policy.Limits);
                if (!await TargetMatchesAsync(policy, request, ct, digests)) state = "target-changed";
            }
            catch (AppIdentityException) { state = "unavailable"; }
            result.Add(new(grant.Id, grant.AppId, grant.Label, policy.Mode, policy.Target, policy.Limits, state));
        }
        return result;
    }
    internal async Task RevokeAsync(SandboxActor actor, string id, CancellationToken ct)
    {
        var grant = (await grants.ReadAsync(ct))?.Grants.FirstOrDefault(g => g.Id == id && g.UserId == actor.UserId);
        if (actor.AppId is not null || grant is null || grant.Scopes.Any(s => s.Kind != "core-environment"))
            throw new AppIdentityException("environment_consent_denied", "Select your own trusted Core consent.");
        await grants.RevokeAsync(actor.UserId, id, ct);
    }
    private async Task<bool> TargetMatchesAsync(CoreEnvironmentPolicy policy, CoreEnvironmentCreate request, CancellationToken ct, Dictionary<string, Task<string>>? digests)
    {
        try { return Covers(policy, await PolicyAsync(request, ct, digests)); }
        catch (Exception ex) when (ex is SandboxException or IOException or UnauthorizedAccessException) { return false; }
    }
    internal async Task<CoreEnvironmentEffectiveAccess> AccessAsync(CoreEnvironmentRecord record, CancellationToken ct, Dictionary<string, Task<string>>? digests = null)
    {
        if (record.Consent is not { } consent)
            return new(record.Owner.AppId is null || record.OperatorApproved ? "operator" : "revoked-or-unavailable", null, false, Description);
        try
        {
            var (_, scope) = await grants.ValidateAsync(record.Owner.AppId!, consent.GrantId, consent.ScopeId, ct);
            if (scope.Environment is not { } policy || !Covers(policy, consent.Policy))
                return new("revoked-or-unavailable", consent.GrantId, false, Description);
            var current = await TargetMatchesAsync(policy, record.Request, ct, digests);
            return new(current ? "active" : "target-changed", consent.GrantId, policy.RequestDigest is null, Description);
        }
        catch (AppIdentityException) { return new("revoked-or-unavailable", consent.GrantId, false, Description); }
    }
}
