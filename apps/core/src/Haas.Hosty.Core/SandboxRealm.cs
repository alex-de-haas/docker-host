using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

internal sealed record SandboxLoginSecret(string LoginId, string Password, DateTimeOffset ExpiresAt);
internal sealed record SandboxRealmSubject(string Kind, string UserId, long Revision, string Authorizer, string? JobId = null, string? CoreAuthRevision = null);
internal sealed record SandboxLoginCredential(string LoginId, SandboxRealmSubject Subject, LocalPasswordCredentialRecord Password, DateTimeOffset ExpiresAt);
internal sealed record SandboxRealmCode(string Hash, string Challenge, SandboxRealmSubject Subject, DateTimeOffset ExpiresAt);
internal sealed record SandboxRealmGrant(string Hash, SandboxRealmSubject Subject, DateTimeOffset ExpiresAt);
internal sealed record SandboxPersonaConfirmation(string Hash, string SessionHash, string ActorId, string? AuthRevision,
    string UserId, long UserRevision, string Challenge, string RedirectUri, string State, DateTimeOffset ExpiresAt);
internal sealed record SandboxPersonaChoice(string Nonce, string DisplayName, string Role);
internal sealed record SandboxRealmState(string Generation, string DataRevision, SandboxLoginCredential[] Credentials,
    SandboxRealmCode[] Codes, SandboxRealmGrant[] Grants, int Failures = 0, DateTimeOffset? FailureWindow = null, SandboxPersonaConfirmation[]? Confirmations = null);
internal sealed record SandboxCodeRequest(string Code, string CodeVerifier);
internal sealed record SandboxRevalidateRequest(string AccessToken);
internal sealed record SandboxTokenResponse(string AccessToken, int ExpiresInSeconds);
internal sealed record SandboxIdentity(bool Active, string AppId, string RuntimeInstanceId, string Generation, string DataRevision,
    string IdentityRealm, string UserId, string? Email, string DisplayName, string? HostRole, string AppRole,
    string[] Permissions, DateTimeOffset ExpiresAt);
internal sealed record SandboxDirectoryEntry(string IdentityRealm, string UserId, string DisplayName, string AppRole, bool Enabled, string? HostRole = null);
internal sealed record SandboxDirectory(SandboxDirectoryEntry[] Users);

internal sealed class SandboxRealm(SandboxStore store, SandboxService service, SandboxServiceCredentials credentials,
    LocalPasswordAuthService passwords, UserDirectoryStore users, IClock clock)
{
    // Only the trusted coordinator receives this in memory. It is intentionally absent from
    // the HTTP serializer roots, agent tool schemas, logs, source mounts and container argv.
    internal Task<SandboxLoginSecret> ProvisionAsync(SandboxActor actor, string id, string userId, string jobId, CancellationToken ct)
        => Locked(id, async instance =>
        {
            await service.RequireAsync(actor, id, ct);
            var subject = instance.Users.SingleOrDefault(u => u.Id == userId && u.Enabled)
                ?? throw Denied("sandbox_user_unavailable");
            var state = await Read(instance, ct);
            if (state.Credentials.Length >= 8 || state.Grants.Length >= 256) throw Denied("sandbox_login_quota");
            var loginId = "sandbox_login_" + Guid.NewGuid().ToString("N");
            var password = RandomToken(32);
            var record = passwords.UpsertCredential([], loginId, password, clock.UtcNow).Single();
            var login = new SandboxLoginCredential(loginId, new("sandbox", subject.Id, subject.Revision, actor.UserId, jobId), record, clock.UtcNow.AddMinutes(10));
            await Write(instance, state with { Credentials = state.Credentials.Append(login).ToArray() }, ct);
            return new SandboxLoginSecret(loginId, password, login.ExpiresAt);
        }, ct);

    internal Task<string> LoginAsync(string id, string loginId, string password, string challenge, string redirectUri, string stateValue, CancellationToken ct)
        => Locked(id, async instance =>
        {
            ValidateRedirect(instance, challenge, redirectUri, stateValue);
            var state = await Read(instance, ct);
            if (state.Failures >= 10 && state.FailureWindow > clock.UtcNow.AddMinutes(-10)) throw Denied("sandbox_login_throttled", 429);
            var login = state.Credentials.FirstOrDefault(c => c.LoginId == loginId);
            if (password.Length > 1024 || login is null || !LocalPasswordAuthService.VerifyPassword(password, login.Password))
            {
                await Write(instance, state with { Failures = state.FailureWindow > clock.UtcNow.AddMinutes(-10) ? state.Failures + 1 : 1,
                    FailureWindow = state.FailureWindow > clock.UtcNow.AddMinutes(-10) ? state.FailureWindow : clock.UtcNow }, ct);
                throw Denied("sandbox_login_invalid", 401);
            }
            await ResolveSubject(instance, login.Subject, login.ExpiresAt, ct);
            var code = "hostysb_code_" + RandomToken(32);
            await Write(instance, state with { Credentials = state.Credentials.Where(c => c.LoginId != loginId).ToArray(),
                Codes = state.Codes.Append(new(SandboxValidation.Hash(code), challenge, login.Subject, clock.UtcNow.AddMinutes(1))).ToArray(), Failures = 0 }, ct);
            return redirectUri + "?code=" + Uri.EscapeDataString(code) + "&state=" + Uri.EscapeDataString(stateValue);
        }, ct);

    internal Task<string> AuthorizeOperatorAsync(string id, string userId, string challenge, string redirectUri, string stateValue, CancellationToken ct)
        => Locked(id, async instance =>
        {
            ValidateRedirect(instance, challenge, redirectUri, stateValue);
            if (userId != instance.Owner.UserId && !instance.Viewers.Contains(userId, StringComparer.Ordinal)) throw Denied("sandbox_preview_forbidden");
            var user = (await users.ReadAsync(ct)).Users.SingleOrDefault(u => u.Id == userId && !u.Disabled)
                ?? throw Denied("sandbox_viewer_unavailable");
            var subject = new SandboxRealmSubject("core", userId, 0, userId, CoreAuthRevision: user.AuthRevision);
            await ResolveSubject(instance, subject, clock.UtcNow.AddMinutes(10), ct);
            var state = await Read(instance, ct);
            if (state.Codes.Length >= 256) throw Denied("sandbox_login_quota");
            var code = "hostysb_code_" + RandomToken(32);
            await Write(instance, state with { Codes = state.Codes.Append(new(SandboxValidation.Hash(code), challenge, subject, clock.UtcNow.AddMinutes(1))).ToArray() }, ct);
            return redirectUri + "?code=" + Uri.EscapeDataString(code) + "&state=" + Uri.EscapeDataString(stateValue);
        }, ct);

    internal Task<SandboxPersonaChoice> BeginPersonaAsync(string id, HostUserRecord actor, string session,
        string userId, string challenge, string redirectUri, string stateValue, CancellationToken ct)
        => Locked(id, async instance =>
        {
            ValidateRedirect(instance, challenge, redirectUri, stateValue);
            if (actor.Id != instance.Owner.UserId || !AppAccessPolicy.IsAdmin(actor)) throw Denied("sandbox_persona_forbidden");
            var selected = instance.Users.SingleOrDefault(u => u.Id == userId && u.Enabled) ?? throw Denied("sandbox_user_unavailable");
            var state = await Read(instance, ct);
            if ((state.Confirmations?.Length ?? 0) >= 32) throw Denied("sandbox_login_quota");
            var nonce = RandomToken(32);
            var confirmation = new SandboxPersonaConfirmation(SandboxValidation.Hash(nonce), SandboxValidation.Hash(session), actor.Id, actor.AuthRevision,
                selected.Id, selected.Revision, challenge, redirectUri, stateValue, clock.UtcNow.AddMinutes(2));
            await Write(instance, state with { Confirmations = (state.Confirmations ?? []).Append(confirmation).ToArray() }, ct);
            return new SandboxPersonaChoice(nonce, selected.DisplayName, selected.Role);
        }, ct);

    internal Task<string> ConfirmPersonaAsync(string id, HostUserRecord actor, string session, string nonce, CancellationToken ct)
        => Locked(id, async instance =>
        {
            if (actor.Id != instance.Owner.UserId || !AppAccessPolicy.IsAdmin(actor) || nonce.Length > 100) throw Denied("sandbox_persona_forbidden");
            var state = await Read(instance, ct);
            var confirmation = (state.Confirmations ?? []).SingleOrDefault(c => c.Hash == SandboxValidation.Hash(nonce)
                && c.SessionHash == SandboxValidation.Hash(session) && c.ActorId == actor.Id && c.AuthRevision == actor.AuthRevision)
                ?? throw Denied("sandbox_persona_confirmation_invalid");
            var subject = new SandboxRealmSubject("sandbox", confirmation.UserId, confirmation.UserRevision, actor.Id);
            await ResolveSubject(instance, subject, confirmation.ExpiresAt, ct);
            if (state.Codes.Length >= 256) throw Denied("sandbox_login_quota");
            var code = "hostysb_code_" + RandomToken(32);
            await Write(instance, state with { Confirmations = (state.Confirmations ?? []).Where(c => c.Hash != confirmation.Hash).ToArray(),
                Codes = state.Codes.Append(new(SandboxValidation.Hash(code), confirmation.Challenge, subject, clock.UtcNow.AddMinutes(1))).ToArray() }, ct);
            return confirmation.RedirectUri + "?code=" + Uri.EscapeDataString(code) + "&state=" + Uri.EscapeDataString(confirmation.State);
        }, ct);

    internal Task<SandboxTokenResponse> ExchangeAsync(string id, SandboxCodeRequest request, CancellationToken ct)
        => Locked(id, async instance =>
        {
            if (request.Code is null || !request.Code.StartsWith("hostysb_code_", StringComparison.Ordinal)
                || request.CodeVerifier is null || request.CodeVerifier.Length is < 43 or > 128
                || request.CodeVerifier.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('-' or '.' or '_' or '~')))
                throw Denied("sandbox_code_invalid", 401);
            var state = await Read(instance, ct);
            var hash = SandboxValidation.Hash(request.Code);
            var code = state.Codes.FirstOrDefault(c => c.Hash == hash) ?? throw Denied("sandbox_code_invalid", 401);
            var challenge = Convert.ToBase64String(SHA256.HashData(Encoding.ASCII.GetBytes(request.CodeVerifier))).TrimEnd('=').Replace('+', '-').Replace('/', '_');
            if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(challenge), Encoding.ASCII.GetBytes(code.Challenge)))
                throw Denied("sandbox_code_invalid", 401);
            await ResolveSubject(instance, code.Subject, code.ExpiresAt, ct);
            state = state with { Codes = state.Codes.Where(c => c.Hash != hash).ToArray() };
            if (state.Grants.Length >= 256) throw Denied("sandbox_login_quota");
            var accessToken = "hostysb_grant_" + RandomToken(32);
            await Write(instance, state with { Grants = state.Grants.Append(new(SandboxValidation.Hash(accessToken), code.Subject, clock.UtcNow.AddMinutes(10))).ToArray() }, ct);
            return new SandboxTokenResponse(accessToken, 600);
        }, ct);

    public Task<SandboxIdentity> RevalidateAsync(string id, string token, CancellationToken ct)
        => Locked(id, async instance =>
        {
            if (token is null || !token.StartsWith("hostysb_grant_", StringComparison.Ordinal) || token.Length > 200) throw Denied("sandbox_grant_invalid", 401);
            var state = await Read(instance, ct);
            var grant = state.Grants.FirstOrDefault(g => g.Hash == SandboxValidation.Hash(token)) ?? throw Denied("sandbox_grant_invalid", 401);
            return await ResolveSubject(instance, grant.Subject, grant.ExpiresAt, ct);
        }, ct);

    public Task<SandboxDirectory> DirectoryAsync(string id, string token, CancellationToken ct)
        => Locked(id, async instance =>
        {
            if (token is null || !token.StartsWith("hostysb_grant_", StringComparison.Ordinal)) throw Denied("sandbox_grant_invalid", 401);
            var state = await Read(instance, ct);
            var grant = state.Grants.FirstOrDefault(g => g.Hash == SandboxValidation.Hash(token)) ?? throw Denied("sandbox_grant_invalid", 401);
            await ResolveSubject(instance, grant.Subject, grant.ExpiresAt, ct);
            // Only the current real viewer is projected, never the global Core directory.
            var entries = instance.Users.Select(u => new SandboxDirectoryEntry("sandbox", u.Id, u.DisplayName, u.Role, u.Enabled)).ToList();
            if (grant.Subject.Kind == "core")
            {
                var identity = await ResolveSubject(instance, grant.Subject, grant.ExpiresAt, ct);
                entries.Add(new("core", identity.UserId, identity.DisplayName, identity.AppRole, true, identity.HostRole));
            }
            return new SandboxDirectory(entries.ToArray());
        }, ct);

    internal Task RevokeJobAsync(string id, string jobId, CancellationToken ct)
        => Locked(id, async instance => { await RevokeJobLockedAsync(instance, jobId, ct); return true; }, ct);

    // Trusted recovery/cancellation callers already hold this instance's operation gate.
    internal async Task RevokeJobLockedAsync(SandboxInstance instance, string jobId, CancellationToken ct)
    {
        var state = await Read(instance, ct);
        await Write(instance, state with { Credentials = state.Credentials.Where(c => c.Subject.JobId != jobId).ToArray(),
            Codes = state.Codes.Where(c => c.Subject.JobId != jobId).ToArray(), Grants = state.Grants.Where(g => g.Subject.JobId != jobId).ToArray() }, ct);
    }

    internal static void ValidateRedirect(SandboxInstance instance, string challenge, string redirectUri, string state)
    {
        if (challenge.Length != 43 || challenge.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not ('-' or '_'))
            || state.Length != 64 || state.Any(c => !char.IsAsciiHexDigit(c))
            || !instance.Endpoints.Any(e => redirectUri == e.Url + "/_hosty/callback"))
            throw Denied("sandbox_redirect_invalid", 400);
    }
    private async Task<SandboxIdentity> ResolveSubject(SandboxInstance instance, SandboxRealmSubject subject, DateTimeOffset expires, CancellationToken ct)
    {
        if (expires <= clock.UtcNow) throw Denied("sandbox_grant_expired", 401);
        if (subject.Kind == "sandbox")
        {
            var user = instance.Users.SingleOrDefault(u => u.Id == subject.UserId && u.Enabled && u.Revision == subject.Revision)
                ?? throw Denied("sandbox_user_unavailable");
            return new(true, instance.Input.AppId, instance.Id, instance.Generation, instance.DataRevision, "sandbox", user.Id,
                null, user.DisplayName, null, user.Role, user.Permissions, expires);
        }
        if (subject.Kind != "core" || (subject.UserId != instance.Owner.UserId && !instance.Viewers.Contains(subject.UserId, StringComparer.Ordinal)))
            throw Denied("sandbox_preview_forbidden");
        var real = (await users.ReadAsync(ct)).Users.SingleOrDefault(u => u.Id == subject.UserId && !u.Disabled && u.AuthRevision == subject.CoreAuthRevision)
            ?? throw Denied("sandbox_viewer_unavailable");
        return new(true, instance.Input.AppId, instance.Id, instance.Generation, instance.DataRevision, "core", real.Id,
            real.Email, real.DisplayName ?? real.Email ?? real.Id, real.Role, real.Role, [], expires);
    }
    private async Task<T> Locked<T>(string id, Func<SandboxInstance, Task<T>> action, CancellationToken ct)
    {
        var gate = store.Gate(id); await gate.WaitAsync(ct);
        try
        {
            var instance = await store.ReadAsync(id, ct) ?? throw Denied("sandbox_not_found", 404);
            await credentials.RequireAsync(id, credentials.Create(instance), ct);
            return await action(instance);
        }
        finally { gate.Release(); }
    }
    private async Task<SandboxRealmState> Read(SandboxInstance instance, CancellationToken ct)
    {
        var state = await JsonStorage.ReadAsync<SandboxRealmState>(Path.Combine(store.InstanceRoot(instance.Id), "realm.json"), ct);
        if (state is null || state.Generation != instance.Generation || state.DataRevision != instance.DataRevision)
            return new(instance.Generation, instance.DataRevision, [], [], []);
        return state with { Credentials = state.Credentials.Where(c => c.ExpiresAt > clock.UtcNow).ToArray(),
            Codes = state.Codes.Where(c => c.ExpiresAt > clock.UtcNow).ToArray(), Grants = state.Grants.Where(g => g.ExpiresAt > clock.UtcNow).ToArray(),
            Confirmations = (state.Confirmations ?? []).Where(c => c.ExpiresAt > clock.UtcNow).ToArray() };
    }
    private Task Write(SandboxInstance instance, SandboxRealmState state, CancellationToken ct)
        => JsonStorage.WriteAsync(Path.Combine(store.InstanceRoot(instance.Id), "realm.json"), state, true, ct);
    private static string RandomToken(int bytes) => Convert.ToBase64String(RandomNumberGenerator.GetBytes(bytes)).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    private static SandboxException Denied(string code, int status = 403) => new(code, "Sandbox authentication could not be authorized.", status);
}
