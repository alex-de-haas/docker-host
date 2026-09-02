using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace HostySdk.App;

/// <summary>
/// The claims carried by a delegated token: who is acting, in what Host role, for which app.
/// </summary>
/// <param name="Subject">Acting Host user id.</param>
/// <param name="Role">The actor's Host role at issuance (e.g. <c>host.admin</c>); gate admin surfaces on it.</param>
/// <param name="Audience">Audience app id — equal to this app's own id, or the token was not for it.</param>
public sealed record HostyDelegatedTokenClaims(
    string Subject,
    string Role,
    string Audience,
    long IssuedAtUnixSeconds,
    long ExpiresAtUnixSeconds,
    string TokenId);

/// <summary>
/// Validates a delegated token locally — the credential another app presents when calling this one on
/// an operator's behalf, and the one an agent's MCP call arrives with.
/// </summary>
/// <remarks>
/// <para>
/// The counterpart of <c>@hosty-sdk/app/delegated</c>, and deliberately the same contract: Core signs
/// with ECDSA P-256 and injects the verification key as <c>HOSTY_DELEGATED_TOKEN_PUBLIC_KEY</c>
/// (base64 SubjectPublicKeyInfo DER), so validation needs no round trip to Core and nothing new
/// distributed. The wire format is
/// <c>hosty_delegated.1.&lt;b64url(claims)&gt;.&lt;b64url(P1363 signature over "hosty_delegated.1.&lt;claims&gt;")&gt;</c>.
/// </para>
/// <para>
/// This is *not* an app identity token, and the two cannot stand in for each other: the type prefix is
/// inside the signed input, so <c>/api/auth/apps/revalidate</c> rejects a delegated token outright. An
/// app that authenticates its MCP surface with the identity handler alone therefore refuses every
/// agent call with a 401 while its browser traffic keeps working — the failure this type exists to
/// end.
/// </para>
/// <para>
/// Never throws. A route treats a null result exactly as it treats a missing token, which keeps
/// malformed input from turning into a 500.
/// </para>
/// </remarks>
public static class HostyDelegatedToken
{
    private const string Prefix = "hosty_delegated";
    private const string Version = "1";

    /// <summary>
    /// Validates <paramref name="token"/> and returns its claims, or null for anything invalid: bad
    /// format, unknown key, wrong audience, expiry, or a signature that does not verify.
    /// </summary>
    /// <param name="appId">
    /// Audience to require. Defaults to <c>HOSTY_APP_ID</c>; validation fails when neither is set,
    /// because a token accepted without an audience check is a token for somebody else.
    /// </param>
    /// <param name="publicKeyBase64">
    /// Base64 SPKI verification key. Defaults to <c>HOSTY_DELEGATED_TOKEN_PUBLIC_KEY</c>.
    /// </param>
    /// <param name="now">Clock override for tests.</param>
    public static HostyDelegatedTokenClaims? Validate(
        string? token,
        string? appId = null,
        string? publicKeyBase64 = null,
        DateTimeOffset? now = null)
    {
        var key = Trimmed(publicKeyBase64) ?? Trimmed(Environment.GetEnvironmentVariable("HOSTY_DELEGATED_TOKEN_PUBLIC_KEY"));
        var audience = Trimmed(appId) ?? Trimmed(Environment.GetEnvironmentVariable("HOSTY_APP_ID"));
        if (token is null || key is null || audience is null)
        {
            return null;
        }

        var parts = token.Split('.');
        if (parts.Length != 4 ||
            !string.Equals(parts[0], Prefix, StringComparison.Ordinal) ||
            !string.Equals(parts[1], Version, StringComparison.Ordinal))
        {
            return null;
        }

        try
        {
            var signingInput = Encoding.UTF8.GetBytes($"{parts[0]}.{parts[1]}.{parts[2]}");
            using var ecdsa = ECDsa.Create();
            ecdsa.ImportSubjectPublicKeyInfo(Convert.FromBase64String(key), out _);

            // VerifyData's default signature format is IEEE P1363 (raw r||s), which is what Core emits;
            // asking for the DER sequence here would reject every genuine token.
            if (!ecdsa.VerifyData(signingInput, FromBase64Url(parts[3]), HashAlgorithmName.SHA256))
            {
                return null;
            }

            var claims = JsonSerializer.Deserialize(
                FromBase64Url(parts[2]), DelegatedTokenJson.Default.DelegatedTokenPayload);
            if (claims?.Sub is null || claims.Role is null || claims.Aud is null || claims.Exp is null)
            {
                return null;
            }

            if (!string.Equals(claims.Aud, audience, StringComparison.Ordinal))
            {
                return null;
            }

            var nowSeconds = (now ?? DateTimeOffset.UtcNow).ToUnixTimeSeconds();
            if (claims.Exp.Value <= nowSeconds)
            {
                return null;
            }

            return new HostyDelegatedTokenClaims(
                claims.Sub, claims.Role, claims.Aud, claims.Iat ?? 0, claims.Exp.Value, claims.Jti ?? string.Empty);
        }
        catch (Exception exception) when (
            exception is CryptographicException or FormatException or JsonException or ArgumentException)
        {
            // Every one of these is untrusted input failing to be what it claimed: an unusable key, a
            // payload that is not base64url, claims that are not JSON. None is a fault of this process.
            return null;
        }
    }

    /// <summary>Reads a bearer token from an Authorization header value, or null when there is none.</summary>
    public static string? ReadBearer(string? authorizationHeader)
    {
        var value = Trimmed(authorizationHeader);
        return value is not null && value.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)
            ? Trimmed(value["Bearer ".Length..])
            : null;
    }

    private static string? Trimmed(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static byte[] FromBase64Url(string value)
    {
        var padded = value.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(padded.PadRight(padded.Length + ((4 - (padded.Length % 4)) % 4), '='));
    }
}

/// <summary>The token's payload exactly as Core writes it.</summary>
internal sealed record DelegatedTokenPayload(
    [property: JsonPropertyName("sub")] string? Sub,
    [property: JsonPropertyName("role")] string? Role,
    [property: JsonPropertyName("aud")] string? Aud,
    [property: JsonPropertyName("iat")] long? Iat,
    [property: JsonPropertyName("exp")] long? Exp,
    [property: JsonPropertyName("jti")] string? Jti);

/// <summary>
/// Source-generated so the SDK stays usable from a Native AOT app, where the reflection-based
/// serializer throws at runtime rather than failing to build.
/// </summary>
[JsonSerializable(typeof(DelegatedTokenPayload))]
internal sealed partial class DelegatedTokenJson : JsonSerializerContext;
