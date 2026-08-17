using System.Text;
using System.Text.Json;

namespace Haas.Hosty.Core;

/// <summary>
/// Mints the token an app presents to <b>another app</b> to prove which app it is
/// (docs/features/telemetry-mcp/plan.md).
/// </summary>
/// <remarks>
/// <para>
/// The gap it fills: <see cref="AppServiceTokenService"/> already proves app identity, but its key is
/// an <b>HMAC</b>. Only Core can check it, and handing that key to a verifying app would let that app
/// mint a token for any other — which destroys the attribution the credential exists to provide.
/// </para>
/// <para>
/// It reuses <see cref="DelegatedTokenSigningKey"/> rather than introducing a second key pair. That
/// key is already ECDSA, already durable, and its public half is <i>already</i> injected into every
/// app as <c>HOSTY_DELEGATED_TOKEN_PUBLIC_KEY</c> — so a verifier needs nothing new distributed to it.
/// Cross-type replay is impossible because the prefix and version are part of the signed input: a
/// delegated token cannot be presented as an app identity, or the reverse, without the signature
/// failing.
/// </para>
/// <para>
/// <b>No expiry, deliberately.</b> The token is minted when the app starts and injected into its
/// environment, so it lives exactly as long as the process does — the same shape and the same trust
/// level as the service token beside it. Adding a TTL without a refresh path would buy a bounded leak
/// at the price of telemetry that silently stops after N days on a long-running host, which is the
/// worse failure: one is a risk, the other is a certainty.
/// </para>
/// Format: <c>hosty_app_identity.1.&lt;b64url(payload json)&gt;.&lt;b64url(ECDSA P-256/SHA-256 over
/// "hosty_app_identity.1.&lt;payload&gt;", IEEE P1363)&gt;</c>.
/// </remarks>
internal sealed class AppIdentityTokenService(DelegatedTokenSigningKey key, IClock clock)
{
    private const string Prefix = "hosty_app_identity";
    private const string Version = "1";

    public string CreateToken(string appId)
    {
        var payload = new AppIdentityTokenPayload(appId.Trim(), clock.UtcNow.ToUnixTimeSeconds());
        var payloadPart = Base64UrlEncode(JsonSerializer.SerializeToUtf8Bytes(
            payload, CoreJsonSerializerContext.Default.AppIdentityTokenPayload));
        var signingInput = $"{Prefix}.{Version}.{payloadPart}";
        var signature = Base64UrlEncode(key.Sign(Encoding.UTF8.GetBytes(signingInput)));
        return $"{signingInput}.{signature}";
    }

    /// <summary>The app id a valid token names, or null when it is not one Core signed.</summary>
    /// <remarks>Core-side twin of what a verifying app does with the injected public key; used by tests.</remarks>
    public string? ResolveAppId(string token)
    {
        var parts = token.Split('.');
        if (parts is not [Prefix, Version, var payloadPart, var signaturePart])
        {
            return null;
        }

        try
        {
            var signingInput = $"{Prefix}.{Version}.{payloadPart}";
            if (!key.Verify(Encoding.UTF8.GetBytes(signingInput), Base64UrlDecode(signaturePart)))
            {
                return null;
            }

            var payload = JsonSerializer.Deserialize(
                Base64UrlDecode(payloadPart), CoreJsonSerializerContext.Default.AppIdentityTokenPayload);
            return string.IsNullOrWhiteSpace(payload?.App) ? null : payload.App;
        }
        catch (Exception ex) when (ex is FormatException or JsonException)
        {
            return null;
        }
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

/// <summary>
/// The signed claims. Just the app and when it was issued — this credential answers one question, and
/// a claim it does not carry is one nothing can come to depend on.
/// </summary>
internal sealed record AppIdentityTokenPayload(string App, long Iat);
