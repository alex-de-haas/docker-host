using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

internal sealed class AuthBootstrapTokenStore(CoreDataPaths paths)
{
    private string StatePath => Path.Combine(paths.AuthRoot, "bootstrap-tokens.json");

    public async Task<AuthBootstrapTokenState> ReadAsync(CancellationToken cancellationToken = default)
        => await JsonStorage.ReadAsync<AuthBootstrapTokenState>(StatePath, cancellationToken) ??
            new AuthBootstrapTokenState(1, []);

    public async Task WriteAsync(AuthBootstrapTokenState state, CancellationToken cancellationToken = default)
        => await JsonStorage.WriteAsync(StatePath, state, restrictToOwner: true, cancellationToken);
}

internal sealed class AuthBootstrapService(
    UserDirectoryStore users,
    AuthBootstrapTokenStore tokens,
    AuditStore audit,
    LocalPasswordAuthService passwords,
    HostyCoreRuntimeConfig config,
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
        var tokenState = await tokens.ReadAsync(cancellationToken);
        var token = FindValidToken(tokenState, SetupKind, request.SetupToken, now) ??
            throw new AuthBootstrapException("setup_token_invalid", "Setup token is invalid or expired.", StatusCodes.Status404NotFound);
        var email = NormalizeEmail(request.Email);
        if (string.IsNullOrWhiteSpace(email))
        {
            throw new AuthBootstrapException("invalid_email", "Enter a valid email address.", StatusCodes.Status400BadRequest);
        }

        var userState = await users.ReadAsync(cancellationToken);
        if (HasEnabledAdmin(userState))
        {
            throw new AuthBootstrapException(
                "setup_unavailable",
                "First administrator setup is unavailable after an enabled Host administrator exists.",
                StatusCodes.Status409Conflict);
        }

        if (userState.Users.Any(user => string.Equals(user.Email, email, StringComparison.OrdinalIgnoreCase)))
        {
            throw new AuthBootstrapException("email_exists", "A Host user with this email already exists. Use recovery-token to restore an existing account.", StatusCodes.Status409Conflict);
        }

        var user = new HostUserRecord(
            Id: $"user_{Guid.NewGuid():N}",
            Email: email,
            DisplayName: NormalizeOptional(request.DisplayName) ?? email,
            Role: "host.admin",
            Disabled: false,
            CreatedAt: now,
            UpdatedAt: now);
        var credentials = passwords.UpsertCredential(userState.PasswordCredentials, user.Id, request.Password, now);
        await users.WriteAsync(userState with
        {
            Users = userState.Users.Append(user).ToArray(),
            PasswordCredentials = credentials,
        }, cancellationToken);
        await MarkTokenUsedAsync(tokenState, token.Id, now, cancellationToken);
        await AppendAuditAsync("auth.bootstrap.completed", "auth.user", user.Id, "succeeded", new Dictionary<string, string>
        {
            ["email"] = email,
        }, cancellationToken);
        return user;
    }

    public async Task<HostUserRecord> RecoverAsync(AuthRecoveryRequest request, CancellationToken cancellationToken = default)
    {
        var now = clock.UtcNow;
        var tokenState = await tokens.ReadAsync(cancellationToken);
        var token = FindValidToken(tokenState, RecoveryKind, request.RecoveryToken, now) ??
            throw new AuthBootstrapException("recovery_token_invalid", "Recovery token is invalid or expired.", StatusCodes.Status404NotFound);
        var email = NormalizeEmail(request.Email);
        if (string.IsNullOrWhiteSpace(email))
        {
            throw new AuthBootstrapException("invalid_email", "Enter a valid email address.", StatusCodes.Status400BadRequest);
        }

        var userState = await users.ReadAsync(cancellationToken);
        var existing = userState.Users.FirstOrDefault(user => string.Equals(user.Email, email, StringComparison.OrdinalIgnoreCase));
        HostUserRecord recovered;
        UserDirectoryState nextState;
        if (existing is null)
        {
            recovered = new HostUserRecord(
                Id: $"user_{Guid.NewGuid():N}",
                Email: email,
                DisplayName: NormalizeOptional(request.DisplayName) ?? email,
                Role: "host.admin",
                Disabled: false,
                CreatedAt: now,
                UpdatedAt: now);
            var credentials = passwords.UpsertCredential(userState.PasswordCredentials, recovered.Id, request.Password, now);
            nextState = userState with
            {
                Users = userState.Users.Append(recovered).ToArray(),
                PasswordCredentials = credentials,
            };
        }
        else
        {
            recovered = existing with
            {
                DisplayName = NormalizeOptional(request.DisplayName) ?? existing.DisplayName ?? email,
                Role = "host.admin",
                Disabled = false,
                UpdatedAt = now,
            };
            var credentials = passwords.UpsertCredential(userState.PasswordCredentials, recovered.Id, request.Password, now);
            nextState = userState with
            {
                Users = userState.Users.Select(user => string.Equals(user.Id, existing.Id, StringComparison.Ordinal) ? recovered : user).ToArray(),
                Sessions = RevokeSessions(userState.Sessions, existing.Id, now),
                PasswordCredentials = credentials,
            };
        }

        await users.WriteAsync(nextState, cancellationToken);
        await MarkTokenUsedAsync(tokenState, token.Id, now, cancellationToken);
        await AppendAuditAsync("auth.recovery.completed", "auth.user", recovered.Id, "succeeded", new Dictionary<string, string>
        {
            ["email"] = email,
            ["existingUser"] = (existing is not null).ToString(System.Globalization.CultureInfo.InvariantCulture),
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
        var state = await tokens.ReadAsync(cancellationToken);
        var records = state.Tokens
            .Select(token => string.Equals(token.Kind, kind, StringComparison.Ordinal) &&
                    GetTokenStatus(token, now) == "pending"
                ? token with { Status = "revoked", RevokedAt = now }
                : token)
            .Append(record)
            .ToArray();
        await tokens.WriteAsync(state with { Tokens = records }, cancellationToken);
        return new IssuedAuthBootstrapToken(record.Id, rawToken, record.ExpiresAt);
    }

    private AuthBootstrapTokenRecord? FindValidToken(AuthBootstrapTokenState state, string kind, string token, DateTimeOffset now)
    {
        if (string.IsNullOrWhiteSpace(token))
        {
            return null;
        }

        var hash = HashToken(token);
        return state.Tokens.FirstOrDefault(record =>
            string.Equals(record.Kind, kind, StringComparison.Ordinal) &&
            string.Equals(record.TokenHash, hash, StringComparison.Ordinal) &&
            GetTokenStatus(record, now) == "pending");
    }

    private async Task MarkTokenUsedAsync(
        AuthBootstrapTokenState state,
        string tokenId,
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        var records = state.Tokens
            .Select(token => string.Equals(token.Id, tokenId, StringComparison.Ordinal)
                ? token with { Status = "used", UsedAt = now }
                : token)
            .ToArray();
        await tokens.WriteAsync(state with { Tokens = records }, cancellationToken);
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

    private string ResolveCoreOrigin()
        => config.EffectiveCorePublicOrigin;

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

internal sealed record AuthBootstrapCompleteResponse(HostUserRecord User, string RedirectTo);

internal sealed record AuthRecoveryCompleteResponse(HostUserRecord User, string RedirectTo);

internal sealed record IssuedAuthBootstrapToken(string Id, string Token, DateTimeOffset ExpiresAt);

internal sealed class AuthBootstrapException(string code, string message, int statusCode) : Exception(message)
{
    public string Code { get; } = code;

    public int StatusCode { get; } = statusCode;
}
