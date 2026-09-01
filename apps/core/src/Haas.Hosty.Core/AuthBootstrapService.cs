using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

internal sealed class AuthBootstrapTokenStore(CoreDataPaths paths)
{
    // Serializes read-modify-write so token issuance and single-use consumption never race on a stale
    // snapshot — the whole point of C-M2 (mirrors UserDirectoryStore.gate).
    private readonly SemaphoreSlim gate = new(1, 1);

    private string StatePath => Path.Combine(paths.AuthRoot, "bootstrap-tokens.json");

    public async Task<AuthBootstrapTokenState> ReadAsync(CancellationToken cancellationToken = default)
        => await JsonStorage.ReadAsync<AuthBootstrapTokenState>(StatePath, cancellationToken) ??
            new AuthBootstrapTokenState(1, []);

    private async Task WriteAsync(AuthBootstrapTokenState state, CancellationToken cancellationToken = default)
        => await JsonStorage.WriteAsync(StatePath, state, restrictToOwner: true, cancellationToken);

    // Atomic read-modify-write under the gate. The mutate delegate sees the freshest state and its
    // result is written before the gate releases, so a concurrent consumer cannot observe or overwrite
    // an intermediate value.
    public async Task<T> UpdateAsync<T>(
        Func<AuthBootstrapTokenState, (AuthBootstrapTokenState State, T Result)> mutate,
        CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            var current = await ReadAsync(cancellationToken);
            var (next, result) = mutate(current);
            // Skip the write when the mutation was a no-op (the delegate returned the same instance):
            // a failed token claim — an invalid/expired/used token — must not rewrite the file. The
            // bootstrap/recovery routes are unauthenticated, so writing on every bad token would let a
            // request with any syntactically valid email force serialized disk writes and stall a real
            // claim, where before it only read.
            if (!ReferenceEquals(next, current))
            {
                await WriteAsync(next, cancellationToken);
            }

            return result;
        }
        finally
        {
            gate.Release();
        }
    }
}

internal sealed class AuthBootstrapService(
    UserDirectoryStore users,
    AuthBootstrapTokenStore tokens,
    AuditStore audit,
    LocalPasswordAuthService passwords,
    CorePublicOriginResolver coreOrigins,
    IClock clock)
{
    private static readonly TimeSpan TokenTtl = TimeSpan.FromMinutes(15);
    private const string SetupKind = "setup";
    private const string RecoveryKind = "recovery";

    public async Task<AuthBootstrapTokenResponse> CreateSetupTokenAsync(CancellationToken cancellationToken = default)
    {
        var userState = await users.ReadAsync(cancellationToken);
        if (HasEnabledAdmin(userState))
        {
            throw new AuthBootstrapException(
                "setup_unavailable",
                "First administrator setup is unavailable after an enabled Host administrator exists.",
                StatusCodes.Status409Conflict);
        }

        var issued = await IssueTokenAsync(SetupKind, "dhstp", cancellationToken);
        await AppendAuditAsync("auth.setup_token.created", "auth.setup_token", issued.Id, "succeeded", new Dictionary<string, string>(), cancellationToken);
        return new AuthBootstrapTokenResponse(
            issued.Token,
            $"{ResolveCoreOrigin().TrimEnd('/')}/setup?setupToken={Uri.EscapeDataString(issued.Token)}",
            null,
            issued.ExpiresAt);
    }

    public async Task<AuthBootstrapTokenResponse> CreateRecoveryTokenAsync(CancellationToken cancellationToken = default)
    {
        var userState = await users.ReadAsync(cancellationToken);
        if (userState.Users.Count == 0)
        {
            throw new AuthBootstrapException(
                "recovery_unavailable",
                "Administrator recovery is unavailable before Host users exist. Use setup-token for first administrator setup.",
                StatusCodes.Status409Conflict);
        }

        var issued = await IssueTokenAsync(RecoveryKind, "dhrec", cancellationToken);
        await AppendAuditAsync("auth.recovery_token.created", "auth.recovery_token", issued.Id, "succeeded", new Dictionary<string, string>(), cancellationToken);
        return new AuthBootstrapTokenResponse(
            issued.Token,
            null,
            $"{ResolveCoreOrigin().TrimEnd('/')}/recovery?recoveryToken={Uri.EscapeDataString(issued.Token)}",
            issued.ExpiresAt);
    }

    public async Task<HostUserRecord> BootstrapAsync(AuthBootstrapRequest request, CancellationToken cancellationToken = default)
    {
        var now = clock.UtcNow;
        var email = NormalizeEmail(request.Email);
        if (string.IsNullOrWhiteSpace(email))
        {
            // Cheap input check before touching the token, so a client-preventable typo does not burn it.
            throw new AuthBootstrapException("invalid_email", "Enter a valid email address.", StatusCodes.Status400BadRequest);
        }

        // Consume the token in a single atomic pending->used transition BEFORE the privileged mutation
        // (C-M2): the transition is the claim, so two concurrent requests carrying the same token cannot
        // both proceed to create an admin. A consumed token is spent even if the mutation below fails —
        // request a fresh token to retry.
        if (await TryConsumeTokenAsync(SetupKind, request.SetupToken, now, cancellationToken) is null)
        {
            throw new AuthBootstrapException("setup_token_invalid", "Setup token is invalid or expired.", StatusCodes.Status404NotFound);
        }

        var user = new HostUserRecord(
            Id: $"user_{Guid.NewGuid():N}",
            Email: email,
            DisplayName: NormalizeOptional(request.DisplayName) ?? email,
            Role: "host.admin",
            Disabled: false,
            CreatedAt: now,
            UpdatedAt: now);
        await users.UpdateAsync(userState =>
        {
            // Re-check against the freshest state under the lock so two racing setups can't both create
            // the first admin.
            if (HasEnabledAdmin(userState))
            {
                throw new AuthBootstrapException(
                    "setup_unavailable",
                    "First administrator setup is unavailable after an enabled Host administrator exists.",
                    StatusCodes.Status409Conflict);
            }

            if (userState.Users.Any(existing => string.Equals(existing.Email, email, StringComparison.OrdinalIgnoreCase)))
            {
                throw new AuthBootstrapException("email_exists", "A Host user with this email already exists. Use recovery-token to restore an existing account.", StatusCodes.Status409Conflict);
            }

            var credentials = passwords.UpsertCredential(userState.PasswordCredentials, user.Id, request.Password, now);
            return userState with
            {
                Users = userState.Users.Append(user).ToArray(),
                PasswordCredentials = credentials,
            };
        }, cancellationToken);
        await AppendAuditAsync("auth.bootstrap.completed", "auth.user", user.Id, "succeeded", new Dictionary<string, string>
        {
            ["email"] = email,
        }, cancellationToken);
        return user;
    }

    public async Task<HostUserRecord> RecoverAsync(AuthRecoveryRequest request, CancellationToken cancellationToken = default)
    {
        var now = clock.UtcNow;
        var email = NormalizeEmail(request.Email);
        if (string.IsNullOrWhiteSpace(email))
        {
            // Cheap input check before touching the token, so a client-preventable typo does not burn it.
            throw new AuthBootstrapException("invalid_email", "Enter a valid email address.", StatusCodes.Status400BadRequest);
        }

        // Atomic single-use claim before the privileged mutation (C-M2): two concurrent requests with
        // the same recovery token can no longer both promote an account. A consumed token is spent even
        // if the mutation below fails — request a fresh token to retry.
        if (await TryConsumeTokenAsync(RecoveryKind, request.RecoveryToken, now, cancellationToken) is null)
        {
            throw new AuthBootstrapException("recovery_token_invalid", "Recovery token is invalid or expired.", StatusCodes.Status404NotFound);
        }

        var (recovered, hadExistingUser) = await users.UpdateAsync<(HostUserRecord Recovered, bool HadExisting)>(userState =>
        {
            var existing = userState.Users.FirstOrDefault(user => string.Equals(user.Email, email, StringComparison.OrdinalIgnoreCase));
            if (existing is null)
            {
                var created = new HostUserRecord(
                    Id: $"user_{Guid.NewGuid():N}",
                    Email: email,
                    DisplayName: NormalizeOptional(request.DisplayName) ?? email,
                    Role: "host.admin",
                    Disabled: false,
                    CreatedAt: now,
                    UpdatedAt: now);
                var credentials = passwords.UpsertCredential(userState.PasswordCredentials, created.Id, request.Password, now);
                return (userState with
                {
                    Users = userState.Users.Append(created).ToArray(),
                    PasswordCredentials = credentials,
                }, (created, false));
            }

            var restored = existing with
            {
                DisplayName = NormalizeOptional(request.DisplayName) ?? existing.DisplayName ?? email,
                Role = "host.admin",
                Disabled = false,
                UpdatedAt = now,
            };
            var restoredCredentials = passwords.UpsertCredential(userState.PasswordCredentials, restored.Id, request.Password, now);
            return (userState with
            {
                Users = userState.Users.Select(user => string.Equals(user.Id, existing.Id, StringComparison.Ordinal) ? restored : user).ToArray(),
                Sessions = RevokeSessions(userState.Sessions, existing.Id, now),
                PasswordCredentials = restoredCredentials,
            }, (restored, true));
        }, cancellationToken);

        await AppendAuditAsync("auth.recovery.completed", "auth.user", recovered.Id, "succeeded", new Dictionary<string, string>
        {
            ["email"] = email,
            ["existingUser"] = hadExistingUser.ToString(System.Globalization.CultureInfo.InvariantCulture),
        }, cancellationToken);
        return recovered;
    }

    private async Task<IssuedAuthBootstrapToken> IssueTokenAsync(string kind, string prefix, CancellationToken cancellationToken)
    {
        var now = clock.UtcNow;
        var rawToken = $"{prefix}_{Base64UrlEncode(RandomNumberGenerator.GetBytes(32))}";
        var record = new AuthBootstrapTokenRecord(
            Id: $"token_{Guid.NewGuid():N}",
            Kind: kind,
            TokenHash: HashToken(rawToken),
            Status: "pending",
            ExpiresAt: now.Add(TokenTtl),
            CreatedAt: now);
        // Under the store gate: revoke any still-pending token of the same kind and append the new one
        // in one write, so a concurrent issue/consume cannot lose either change (C-M2).
        await tokens.UpdateAsync<object?>(state =>
        {
            var records = state.Tokens
                .Select(token => string.Equals(token.Kind, kind, StringComparison.Ordinal) &&
                        GetTokenStatus(token, now) == "pending"
                    ? token with { Status = "revoked", RevokedAt = now }
                    : token)
                .Append(record)
                .ToArray();
            return (state with { Tokens = records }, null);
        }, cancellationToken);
        return new IssuedAuthBootstrapToken(record.Id, rawToken, record.ExpiresAt);
    }

    // Atomically claims a pending token: finds the matching pending record and flips it to used in a
    // single gated read-modify-write, returning the consumed record or null when no pending token
    // matches (invalid, expired, already used, or lost the race to a concurrent consumer). This one
    // transition is the single-use guarantee — callers do the privileged mutation only after it wins.
    private Task<AuthBootstrapTokenRecord?> TryConsumeTokenAsync(string kind, string? rawToken, DateTimeOffset now, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(rawToken))
        {
            return Task.FromResult<AuthBootstrapTokenRecord?>(null);
        }

        var hash = HashToken(rawToken);
        return tokens.UpdateAsync<AuthBootstrapTokenRecord?>(state =>
        {
            var match = state.Tokens.FirstOrDefault(record =>
                string.Equals(record.Kind, kind, StringComparison.Ordinal) &&
                string.Equals(record.TokenHash, hash, StringComparison.Ordinal) &&
                GetTokenStatus(record, now) == "pending");
            if (match is null)
            {
                return (state, null);
            }

            var consumed = match with { Status = "used", UsedAt = now };
            var records = state.Tokens
                .Select(token => string.Equals(token.Id, match.Id, StringComparison.Ordinal) ? consumed : token)
                .ToArray();
            return (state with { Tokens = records }, consumed);
        }, cancellationToken);
    }

    private async Task AppendAuditAsync(
        string action,
        string resourceType,
        string? resourceId,
        string outcome,
        IReadOnlyDictionary<string, string> details,
        CancellationToken cancellationToken)
        => await audit.AppendAsync(new AuditRecord(
            Id: $"audit_{Guid.NewGuid():N}",
            Action: action,
            ResourceType: resourceType,
            ResourceId: resourceId,
            Outcome: outcome,
            ActorUserId: null,
            CreatedAt: clock.UtcNow,
            Details: details), cancellationToken);

    // Read per link rather than captured at startup: a setup or recovery link minted after the operator
    // corrected the public origin must carry the corrected one.
    private string ResolveCoreOrigin()
        => coreOrigins.Effective;

    private static string GetTokenStatus(AuthBootstrapTokenRecord token, DateTimeOffset now)
    {
        if (token.RevokedAt is not null || token.Status == "revoked")
        {
            return "revoked";
        }

        if (token.UsedAt is not null || token.Status == "used")
        {
            return "used";
        }

        return token.ExpiresAt <= now ? "expired" : "pending";
    }

    private static bool HasEnabledAdmin(UserDirectoryState state)
        => state.Users.Any(user => string.Equals(user.Role, "host.admin", StringComparison.Ordinal) && !user.Disabled);

    private static IReadOnlyList<AuthSessionRecord> RevokeSessions(
        IReadOnlyList<AuthSessionRecord> sessions,
        string userId,
        DateTimeOffset now)
        => sessions
            .Select(session => string.Equals(session.UserId, userId, StringComparison.Ordinal) &&
                    session.RevokedAt is null &&
                    session.ExpiresAt > now
                ? session with { RevokedAt = now }
                : session)
            .ToArray();

    private static string NormalizeEmail(string? value)
    {
        var email = NormalizeOptional(value)?.ToLowerInvariant();
        return email is not null && email.Contains('@', StringComparison.Ordinal) ? email : "";
    }

    private static string? NormalizeOptional(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static string HashToken(string token)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token))).ToLowerInvariant();

    private static string Base64UrlEncode(byte[] bytes)
        => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}

internal sealed record AuthBootstrapTokenState(int SchemaVersion, IReadOnlyList<AuthBootstrapTokenRecord> Tokens);

internal sealed record AuthBootstrapTokenRecord(
    string Id,
    string Kind,
    string TokenHash,
    string Status,
    DateTimeOffset ExpiresAt,
    DateTimeOffset CreatedAt,
    DateTimeOffset? UsedAt = null,
    DateTimeOffset? RevokedAt = null);

internal sealed record AuthBootstrapTokenResponse(
    string Token,
    string? SetupUrl,
    string? RecoveryUrl,
    DateTimeOffset ExpiresAt);

internal sealed record AuthBootstrapRequest(string SetupToken, string Email, string? DisplayName = null, string? Password = null);

internal sealed record AuthRecoveryRequest(string RecoveryToken, string Email, string? DisplayName = null, string? Password = null);

// RedirectTo is null when the host has no Shell installed: there is no UI client to continue to.
internal sealed record AuthBootstrapCompleteResponse(HostUserRecord User, string? RedirectTo);

internal sealed record AuthRecoveryCompleteResponse(HostUserRecord User, string? RedirectTo);

internal sealed record IssuedAuthBootstrapToken(string Id, string Token, DateTimeOffset ExpiresAt);

internal sealed class AuthBootstrapException(string code, string message, int statusCode) : Exception(message)
{
    public string Code { get; } = code;

    public int StatusCode { get; } = statusCode;
}
