using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Haas.Hosty.Core;

internal sealed class AppIdentityService(
    UserDirectoryStore users,
    AppAuthCodeStore codes,
    AppRegistryStore apps,
    CoreDataPaths paths,
    IClock clock)
{
    private static readonly TimeSpan AuthCodeLifetime = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan IdentityTokenLifetime = TimeSpan.FromMinutes(5);

    public async Task<AppAuthorizeResult> CreateAuthorizationCodeAsync(
        string appId,
        string userId,
        string redirectUri,
        CancellationToken cancellationToken = default)
    {
        await RequireAllowedRedirectUriAsync(appId, redirectUri, cancellationToken);
        var user = await RequireAccessibleUserAsync(appId, userId, cancellationToken);
        var now = clock.UtcNow;
        var code = CreateOpaqueToken();
        var state = await codes.ReadAsync(cancellationToken);
        var nextCodes = state.Codes
            .Where(candidate => candidate.ExpiresAt > now && candidate.ConsumedAt is null)
            .Append(new AppAuthCodeRecord(code, appId, user.Id, redirectUri, now, now.Add(AuthCodeLifetime), null))
            .ToArray();
        await codes.WriteAsync(state with { Codes = nextCodes }, cancellationToken);

        return new AppAuthorizeResult(code, BuildRedirectUri(redirectUri, code), now.Add(AuthCodeLifetime));
    }

    public async Task<AppIdentityTokenResult> ExchangeCodeAsync(string code, CancellationToken cancellationToken = default)
    {
        var now = clock.UtcNow;
        var state = await codes.ReadAsync(cancellationToken);
        var match = state.Codes.FirstOrDefault(candidate => string.Equals(candidate.Code, code, StringComparison.Ordinal));
        if (match is null)
        {
            throw new AppIdentityException("invalid_code", "Authorization code is invalid.");
        }

        if (match.ConsumedAt is not null)
        {
            throw new AppIdentityException("code_consumed", "Authorization code has already been consumed.");
        }

        if (match.ExpiresAt <= now)
        {
            throw new AppIdentityException("code_expired", "Authorization code has expired.");
        }

        var user = await RequireAccessibleUserAsync(match.AppId, match.UserId, cancellationToken);
        var consumed = state.Codes
            .Select(candidate => string.Equals(candidate.Code, code, StringComparison.Ordinal)
                ? candidate with { ConsumedAt = now }
                : candidate)
            .ToArray();
        await codes.WriteAsync(state with { Codes = consumed }, cancellationToken);

        return await CreateIdentityTokenAsync(match.AppId, user, cancellationToken);
    }

    public async Task<AppIdentityTokenResult> CreateLaunchTokenAsync(
        string appId,
        string userId,
        CancellationToken cancellationToken = default)
    {
        var user = await RequireAccessibleUserAsync(appId, userId, cancellationToken);
        return await CreateIdentityTokenAsync(appId, user, cancellationToken);
    }

    public async Task<AppSessionValidationResult> RevalidateAsync(
        string token,
        CancellationToken cancellationToken = default)
    {
        var claims = await ValidateTokenAsync(token, cancellationToken);
        _ = await RequireAccessibleUserAsync(claims.Audience, claims.Subject, cancellationToken);
        return new AppSessionValidationResult(true, claims.Audience, claims.Subject, claims.ExpiresAt);
    }

    private async Task<AppIdentityTokenResult> CreateIdentityTokenAsync(
        string appId,
        HostUserRecord user,
        CancellationToken cancellationToken)
    {
        var now = clock.UtcNow;
        var expiresAt = now.Add(IdentityTokenLifetime);
        var claims = new AppIdentityClaims(
            Issuer: "hosty-core",
            Audience: appId,
            Subject: user.Id,
            Email: user.Email,
            DisplayName: user.DisplayName,
            Role: user.Role,
            IssuedAt: now.ToUnixTimeSeconds(),
            ExpiresAtUnix: expiresAt.ToUnixTimeSeconds(),
            JwtId: CreateOpaqueToken());
        var token = await SignTokenAsync(claims, cancellationToken);
        return new AppIdentityTokenResult(token, "Bearer", expiresAt, (int)IdentityTokenLifetime.TotalSeconds);
    }

    private async Task<AppIdentityClaims> ValidateTokenAsync(string token, CancellationToken cancellationToken)
    {
        var parts = token.Split('.');
        if (parts.Length != 3)
        {
            throw new AppIdentityException("token_invalid", "Identity token is malformed.");
        }

        var signingKey = await GetSigningKeyAsync(cancellationToken);
        var signedValue = $"{parts[0]}.{parts[1]}";
        var expectedSignature = Base64UrlEncode(HMACSHA256.HashData(signingKey, Encoding.UTF8.GetBytes(signedValue)));
        if (!string.Equals(expectedSignature, parts[2], StringComparison.Ordinal))
        {
            throw new AppIdentityException("token_invalid", "Identity token signature is invalid.");
        }

        var claims = JsonSerializer.Deserialize<AppIdentityClaims>(Base64UrlDecode(parts[1]), JsonStorage.Options) ??
            throw new AppIdentityException("token_invalid", "Identity token claims are invalid.");
        if (claims.ExpiresAt <= clock.UtcNow)
        {
            throw new AppIdentityException("token_expired", "Identity token has expired.");
        }

        return claims;
    }

    private async Task<string> SignTokenAsync(AppIdentityClaims claims, CancellationToken cancellationToken)
    {
        var header = Base64UrlEncode(JsonSerializer.SerializeToUtf8Bytes(new JwtHeader("HS256", "JWT"), JsonStorage.Options));
        var payload = Base64UrlEncode(JsonSerializer.SerializeToUtf8Bytes(claims, JsonStorage.Options));
        var signingInput = $"{header}.{payload}";
        var signingKey = await GetSigningKeyAsync(cancellationToken);
        var signature = Base64UrlEncode(HMACSHA256.HashData(signingKey, Encoding.UTF8.GetBytes(signingInput)));
        return $"{signingInput}.{signature}";
    }

    private async Task<byte[]> GetSigningKeyAsync(CancellationToken cancellationToken)
    {
        var path = Path.Combine(paths.AuthRoot, "app-identity-signing.key");
        try
        {
            return Convert.FromBase64String((await File.ReadAllTextAsync(path, cancellationToken)).Trim());
        }
        catch (Exception ex) when (ex is FileNotFoundException or DirectoryNotFoundException)
        {
            Directory.CreateDirectory(paths.AuthRoot);
            var key = RandomNumberGenerator.GetBytes(32);
            await File.WriteAllTextAsync(path, Convert.ToBase64String(key), cancellationToken);
            return key;
        }
    }

    private async Task<HostUserRecord> RequireAccessibleUserAsync(
        string appId,
        string userId,
        CancellationToken cancellationToken)
    {
        var state = await users.ReadAsync(cancellationToken);
        _ = await RequireInstalledAppAsync(appId, cancellationToken);
        var user = state.Users.FirstOrDefault(candidate => string.Equals(candidate.Id, userId, StringComparison.Ordinal)) ??
            throw new AppIdentityException("user_not_found", "Host user was not found.");
        if (user.Disabled)
        {
            throw new AppIdentityException("user_disabled", "Host user is disabled.");
        }

        var hasAssignmentsForApp = state.Assignments.Any(assignment => string.Equals(assignment.AppId, appId, StringComparison.Ordinal));
        var userAssigned = state.Assignments.Any(assignment =>
            string.Equals(assignment.AppId, appId, StringComparison.Ordinal) &&
            string.Equals(assignment.UserId, user.Id, StringComparison.Ordinal));
        if (!string.Equals(user.Role, "host.admin", StringComparison.Ordinal) && hasAssignmentsForApp && !userAssigned)
        {
            throw new AppIdentityException("app_access_denied", "Host user is not assigned to this app.");
        }

        return user;
    }

    private async Task<AppRecord> RequireInstalledAppAsync(string appId, CancellationToken cancellationToken)
        => await apps.GetAppAsync(appId, cancellationToken) ??
            throw new AppIdentityException("app_not_found", "Runtime app was not found.");

    private async Task RequireAllowedRedirectUriAsync(
        string appId,
        string redirectUri,
        CancellationToken cancellationToken)
    {
        var redirect = ValidateRedirectUri(redirectUri);
        var app = await RequireInstalledAppAsync(appId, cancellationToken);
        var allowed = app.Endpoints
            .Where(endpoint => !string.IsNullOrWhiteSpace(endpoint.Url))
            .Select(endpoint => Uri.TryCreate(endpoint.Url, UriKind.Absolute, out var uri) ? uri : null)
            .OfType<Uri>()
            .Any(endpointUri => SameOrigin(endpointUri, redirect));

        if (!allowed)
        {
            throw new AppIdentityException("redirect_uri_denied", "Redirect URI must target an installed app endpoint origin.");
        }
    }

    private static string BuildRedirectUri(string redirectUri, string code)
    {
        var separator = redirectUri.Contains('?', StringComparison.Ordinal) ? '&' : '?';
        return $"{redirectUri}{separator}code={Uri.EscapeDataString(code)}";
    }

    private static Uri ValidateRedirectUri(string redirectUri)
    {
        if (!Uri.TryCreate(redirectUri, UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps) ||
            !string.IsNullOrEmpty(uri.Fragment))
        {
            throw new AppIdentityException("redirect_uri_invalid", "Redirect URI must be an absolute http(s) URI without a fragment.");
        }

        return uri;
    }

    private static bool SameOrigin(Uri left, Uri right)
        => string.Equals(left.Scheme, right.Scheme, StringComparison.OrdinalIgnoreCase) &&
            string.Equals(left.Host, right.Host, StringComparison.OrdinalIgnoreCase) &&
            left.Port == right.Port;

    private static string CreateOpaqueToken()
        => Base64UrlEncode(RandomNumberGenerator.GetBytes(32));

    private static string Base64UrlEncode(byte[] bytes)
        => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] Base64UrlDecode(string value)
    {
        var padded = value.Replace('-', '+').Replace('_', '/');
        padded = padded.PadRight(padded.Length + (4 - padded.Length % 4) % 4, '=');
        return Convert.FromBase64String(padded);
    }
}

internal sealed record JwtHeader(string Alg, string Typ);

internal sealed record AppIdentityClaims(
    string Issuer,
    string Audience,
    string Subject,
    string? Email,
    string? DisplayName,
    string Role,
    long IssuedAt,
    long ExpiresAtUnix,
    string JwtId)
{
    public DateTimeOffset ExpiresAt => DateTimeOffset.FromUnixTimeSeconds(ExpiresAtUnix);
}

internal sealed record AppAuthorizeResult(string Code, string RedirectUri, DateTimeOffset ExpiresAt);

internal sealed record AppIdentityTokenResult(string AccessToken, string TokenType, DateTimeOffset ExpiresAt, int ExpiresInSeconds);

internal sealed record AppSessionValidationResult(bool Active, string AppId, string UserId, DateTimeOffset ExpiresAt);

internal sealed class AppIdentityException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}
