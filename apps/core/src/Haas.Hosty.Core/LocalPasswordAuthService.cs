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
    private static readonly TimeSpan FailureWindow = TimeSpan.FromMinutes(10);
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
        var throttleKey = BuildThrottleKey(email, remoteAddress);
        if (IsThrottled(throttleKey, now))
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
        var valid = user is not null &&
            !user.Disabled &&
            credential is not null &&
            VerifyPassword(request.Password, credential);

        if (!valid)
        {
            RegisterFailure(throttleKey, now);
            await AppendAuditAsync("auth.login.failed", user?.Id, "failed", new Dictionary<string, string>
            {
                ["email"] = email,
            }, cancellationToken);
            throw new LocalPasswordAuthException(
                "login_invalid",
                "Email or password is invalid.",
                StatusCodes.Status403Forbidden);
        }

        ClearFailures(throttleKey);
        var authenticatedUser = user!;
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

    private bool IsThrottled(string key, DateTimeOffset now)
    {
        lock (throttleLock)
        {
            TrimFailuresLocked(key, now);
            return failuresByKey.TryGetValue(key, out var failures) &&
                failures.Count >= MaxFailedAttempts;
        }
    }

    private void RegisterFailure(string key, DateTimeOffset now)
    {
        lock (throttleLock)
        {
            TrimFailuresLocked(key, now);
            if (!failuresByKey.TryGetValue(key, out var failures))
            {
                failures = [];
                failuresByKey[key] = failures;
            }

            failures.Add(now);
        }
    }

    private void ClearFailures(string key)
    {
        lock (throttleLock)
        {
            failuresByKey.Remove(key);
        }
    }

    private void TrimFailuresLocked(string key, DateTimeOffset now)
    {
        if (!failuresByKey.TryGetValue(key, out var failures))
        {
            return;
        }

        failures.RemoveAll(failedAt => failedAt <= now.Subtract(FailureWindow));
        if (failures.Count == 0)
        {
            failuresByKey.Remove(key);
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
            ActorUserId: userId,
            CreatedAt: clock.UtcNow,
            Details: details), cancellationToken);

    private static string BuildThrottleKey(string email, string? remoteAddress)
        => $"{email}|{NormalizeOptional(remoteAddress) ?? "unknown"}";

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
