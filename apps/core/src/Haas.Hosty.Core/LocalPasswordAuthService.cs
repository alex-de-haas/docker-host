using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

internal sealed class LocalPasswordAuthService(
    UserDirectoryStore users,
    AuditStore audit,
    IClock clock)
{
    internal const string Algorithm = "pbkdf2-hmac-sha256";
    internal const int Iterations = 600_000;
    private const int SaltBytes = 16;
    private const int HashBytes = 32;
    private const int MinPasswordLength = 8;
    private const int MaxPasswordLength = 1024;
    private const int MaxFailedAttempts = 10;
    private const int MaxTrackedThrottleKeys = 10_000;
    private static readonly TimeSpan FailureWindow = TimeSpan.FromMinutes(10);
    private static readonly LocalPasswordCredentialRecord DummyCredential = new(
        UserId: "dummy",
        Algorithm: Algorithm,
        Iterations: Iterations,
        Salt: "AAAAAAAAAAAAAAAAAAAAAA==",
        Hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
        CreatedAt: DateTimeOffset.MinValue,
        UpdatedAt: DateTimeOffset.MinValue);
    private readonly object throttleLock = new();
    private readonly Dictionary<string, List<DateTimeOffset>> failuresByKey = new(StringComparer.Ordinal);

    public IReadOnlyList<LocalPasswordCredentialRecord> UpsertCredential(
        IReadOnlyList<LocalPasswordCredentialRecord>? credentials,
        string userId,
        string? password,
        DateTimeOffset now)
    {
        ValidatePassword(password);
        var existing = (credentials ?? []).FirstOrDefault(credential =>
            string.Equals(credential.UserId, userId, StringComparison.Ordinal));
        var salt = RandomNumberGenerator.GetBytes(SaltBytes);
        var hash = HashPassword(password!, salt, Iterations, HashBytes);
        var record = new LocalPasswordCredentialRecord(
            UserId: userId,
            Algorithm: Algorithm,
            Iterations: Iterations,
            Salt: Convert.ToBase64String(salt),
            Hash: Convert.ToBase64String(hash),
            CreatedAt: existing?.CreatedAt ?? now,
            UpdatedAt: now);

        return (credentials ?? [])
            .Where(credential => !string.Equals(credential.UserId, userId, StringComparison.Ordinal))
            .Append(record)
            .ToArray();
    }

    public async Task<HostUserRecord> AuthenticateAsync(
        LocalPasswordLoginRequest request,
        string? remoteAddress,
        CancellationToken cancellationToken = default)
    {
        var now = clock.UtcNow;
        var email = NormalizeEmail(request.Email);
        var throttleKeys = BuildThrottleKeys(email, remoteAddress);
        if (IsThrottled(throttleKeys, now))
        {
            await AppendAuditAsync("auth.login.throttled", null, "failed", new Dictionary<string, string>
            {
                ["email"] = email,
            }, cancellationToken);
            throw new LocalPasswordAuthException(
                "login_throttled",
                "Too many failed login attempts. Try again later.",
                StatusCodes.Status429TooManyRequests);
        }

        var state = await users.ReadAsync(cancellationToken);
        var user = string.IsNullOrWhiteSpace(email)
            ? null
            : state.Users.FirstOrDefault(candidate =>
                string.Equals(candidate.Email, email, StringComparison.OrdinalIgnoreCase));
        var credential = user is null
            ? null
            : FindCredential(state, user.Id);
        var passwordVerified = VerifyPassword(request.Password, credential ?? DummyCredential);
        var valid = user is not null &&
            !user.Disabled &&
            credential is not null &&
            passwordVerified;

        if (!valid)
        {
            RegisterFailure(throttleKeys, now);
            await AppendAuditAsync("auth.login.failed", user?.Id, "failed", new Dictionary<string, string>
            {
                ["email"] = email,
            }, cancellationToken);
            throw new LocalPasswordAuthException(
                "login_invalid",
                "Email or password is invalid.",
                StatusCodes.Status403Forbidden);
        }

        var authenticatedUser = user!;
        ClearEmailFailures(email);
        await AppendAuditAsync("auth.login.succeeded", authenticatedUser.Id, "succeeded", new Dictionary<string, string>
        {
            ["email"] = email,
        }, cancellationToken);
        return authenticatedUser;
    }

    private static LocalPasswordCredentialRecord? FindCredential(UserDirectoryState state, string userId)
        => (state.PasswordCredentials ?? []).FirstOrDefault(credential =>
            string.Equals(credential.UserId, userId, StringComparison.Ordinal));

    private static void ValidatePassword(string? password)
    {
        if (string.IsNullOrWhiteSpace(password) ||
            password.Length < MinPasswordLength ||
            password.Length > MaxPasswordLength)
        {
            throw new LocalPasswordAuthException(
                "password_invalid",
                $"Password must be between {MinPasswordLength} and {MaxPasswordLength} characters.",
                StatusCodes.Status400BadRequest);
        }
    }

    private static bool VerifyPassword(string? password, LocalPasswordCredentialRecord credential)
    {
        if (string.IsNullOrEmpty(password) ||
            !string.Equals(credential.Algorithm, Algorithm, StringComparison.Ordinal) ||
            credential.Iterations <= 0)
        {
            return false;
        }

        try
        {
            var salt = Convert.FromBase64String(credential.Salt);
            var expected = Convert.FromBase64String(credential.Hash);
            var actual = HashPassword(password, salt, credential.Iterations, expected.Length);
            return CryptographicOperations.FixedTimeEquals(actual, expected);
        }
        catch (FormatException)
        {
            return false;
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    private static byte[] HashPassword(string password, byte[] salt, int iterations, int outputLength)
    {
        var passwordBytes = Encoding.UTF8.GetBytes(password);
        try
        {
            return Rfc2898DeriveBytes.Pbkdf2(
                passwordBytes,
                salt,
                iterations,
                HashAlgorithmName.SHA256,
                outputLength);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(passwordBytes);
        }
    }

    private bool IsThrottled(IReadOnlyList<string> keys, DateTimeOffset now)
    {
        lock (throttleLock)
        {
            TrimExpiredFailuresLocked(now);
            return keys.Any(key => failuresByKey.TryGetValue(key, out var failures) &&
                failures.Count >= MaxFailedAttempts);
        }
    }

    private void RegisterFailure(IReadOnlyList<string> keys, DateTimeOffset now)
    {
        lock (throttleLock)
        {
            TrimExpiredFailuresLocked(now);
            foreach (var key in keys)
            {
                if (!failuresByKey.TryGetValue(key, out var failures))
                {
                    EnsureThrottleCapacityLocked();
                    failures = [];
                    failuresByKey[key] = failures;
                }

                failures.Add(now);
            }
        }
    }

    private void ClearEmailFailures(string email)
    {
        lock (throttleLock)
        {
            failuresByKey.Remove(BuildEmailThrottleKey(email));
        }
    }

    private void TrimExpiredFailuresLocked(DateTimeOffset now)
    {
        var cutoff = now.Subtract(FailureWindow);
        foreach (var item in failuresByKey.ToArray())
        {
            item.Value.RemoveAll(failedAt => failedAt <= cutoff);
            if (item.Value.Count == 0)
            {
                failuresByKey.Remove(item.Key);
            }
        }
    }

    private void EnsureThrottleCapacityLocked()
    {
        if (failuresByKey.Count < MaxTrackedThrottleKeys)
        {
            return;
        }

        var oldest = failuresByKey
            .OrderBy(item => item.Value.Count == 0 ? DateTimeOffset.MinValue : item.Value.Max())
            .FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(oldest.Key))
        {
            failuresByKey.Remove(oldest.Key);
        }
    }

    private async Task AppendAuditAsync(
        string action,
        string? userId,
        string outcome,
        IReadOnlyDictionary<string, string> details,
        CancellationToken cancellationToken)
        => await audit.AppendAsync(new AuditRecord(
            Id: $"audit_{Guid.NewGuid():N}",
            Action: action,
            ResourceType: "auth.user",
            ResourceId: userId,
            Outcome: outcome,
            ActorUserId: outcome == "succeeded" ? userId : null,
            CreatedAt: clock.UtcNow,
            Details: details), cancellationToken);

    private static IReadOnlyList<string> BuildThrottleKeys(string email, string? remoteAddress)
        =>
        [
            BuildEmailThrottleKey(email),
            $"ip:{NormalizeOptional(remoteAddress) ?? "unknown"}",
        ];

    private static string BuildEmailThrottleKey(string email)
        => $"email:{email}";

    private static string NormalizeEmail(string? value)
    {
        var email = NormalizeOptional(value)?.ToLowerInvariant();
        return email is not null && email.Contains('@', StringComparison.Ordinal) ? email : "";
    }

    private static string? NormalizeOptional(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}

internal sealed record LocalPasswordLoginRequest(string Email, string Password);

internal sealed class LocalPasswordAuthException(string code, string message, int statusCode) : Exception(message)
{
    public string Code { get; } = code;

    public int StatusCode { get; } = statusCode;
}
