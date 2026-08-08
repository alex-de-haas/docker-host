using System.Text;
using System.Text.Json;

namespace Haas.Hosty.Core;

// Mints the short-TTL signed tokens a browser client presents when calling a system app's API
// directly — the Shell→system-app data-plane path (docs/features/ai-gateway/plan.md). Unlike app
// session grants (opaque, revalidated online against Core) these are validated locally by the
// receiving app with the public key Core injects into its environment, keeping Core out of the
// per-request path per the agent-bridge auth rule. Deliberately short-lived and non-revocable:
// refresh is simply calling the issue endpoint again, and the issue endpoint re-runs the full
// access policy every time, so a role downgrade or revoked assignment stops fresh tokens within
// one TTL.
//
// Format: hosty_delegated.1.<b64url(payload json)>.<b64url(ECDSA P-256/SHA-256 over the token
// prefix "hosty_delegated.1.<payload>", IEEE P1363)>.
internal sealed class DelegatedTokenService(DelegatedTokenSigningKey key, IClock clock)
{
    private const string Prefix = "hosty_delegated";
    private const string Version = "1";

    public static readonly TimeSpan TokenLifetime = TimeSpan.FromMinutes(5);

    public DelegatedTokenResponse CreateToken(string appId, string userId, string role)
    {
        var now = clock.UtcNow;
        var expiresAt = now.Add(TokenLifetime);
        var payload = new DelegatedTokenPayload(
            Sub: userId,
            Role: role,
            Aud: appId.Trim(),
            Iat: now.ToUnixTimeSeconds(),
            Exp: expiresAt.ToUnixTimeSeconds(),
            Jti: Guid.NewGuid().ToString("N"));
        var payloadPart = Base64UrlEncode(JsonSerializer.SerializeToUtf8Bytes(
            payload, CoreJsonSerializerContext.Default.DelegatedTokenPayload));
        var signingInput = $"{Prefix}.{Version}.{payloadPart}";
        var signature = Base64UrlEncode(key.Sign(Encoding.UTF8.GetBytes(signingInput)));
        return new DelegatedTokenResponse(
            Token: $"{signingInput}.{signature}",
            TokenType: "Bearer",
            AppId: payload.Aud,
            ExpiresAt: expiresAt,
            ExpiresInSeconds: (int)TokenLifetime.TotalSeconds);
    }

    // Core-side twin of the SDK validator, used by tests and available for future introspection.
    // Returns the claims when the signature, audience, and expiry all hold; null otherwise.
    public DelegatedTokenPayload? ValidateToken(string token, string expectedAppId)
    {
        var parts = token.Split('.');
        if (parts is not [Prefix, Version, var payloadPart, var signaturePart])
        {
            return null;
        }

        DelegatedTokenPayload? payload;
        try
        {
            var signingInput = $"{Prefix}.{Version}.{payloadPart}";
            if (!key.Verify(Encoding.UTF8.GetBytes(signingInput), Base64UrlDecode(signaturePart)))
            {
                return null;
            }

            payload = JsonSerializer.Deserialize(
                Base64UrlDecode(payloadPart), CoreJsonSerializerContext.Default.DelegatedTokenPayload);
        }
        catch (Exception ex) when (ex is FormatException or JsonException)
        {
            return null;
        }

        if (payload is null ||
            !string.Equals(payload.Aud, expectedAppId, StringComparison.Ordinal) ||
            payload.Exp <= clock.UtcNow.ToUnixTimeSeconds())
        {
            return null;
        }

        return payload;
    }

    private static string Base64UrlEncode(byte[] bytes)
        => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] Base64UrlDecode(string value)
    {
        var padded = value.Replace('-', '+').Replace('_', '/');
        padded = padded.PadRight(padded.Length + (4 - padded.Length % 4) % 4, '=');
        return Convert.FromBase64String(padded);
    }
}

// The signed claims. JSON keys follow the JWT vocabulary (sub/aud/iat/exp/jti, camelCased by the
// Web serializer defaults) so SDK validators read familiar names, but the token is deliberately
// not a JWT: no header, no algorithm agility, one fixed format.
internal sealed record DelegatedTokenPayload(
    string Sub,
    string Role,
    string Aud,
    long Iat,
    long Exp,
    string Jti);

internal sealed record DelegatedTokenResponse(
    string Token,
    string TokenType,
    string AppId,
    DateTimeOffset ExpiresAt,
    int ExpiresInSeconds);
