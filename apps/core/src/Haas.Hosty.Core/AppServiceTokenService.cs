using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

// Mints and validates HOSTY_APP_SERVICE_TOKEN. Signed with the durable AppServiceSigningKey (not
// the per-process ControlSecret): tokens are baked into app environments at container/process
// creation and must stay valid across a keep-apps Core restart, where the next Core adopts the
// still-running container instead of recreating it.
internal sealed class AppServiceTokenService(AppServiceSigningKey key)
{
    private const string Prefix = "hosty_app_service";
    private const string Version = "1";

    public string CreateToken(string appId)
    {
        var normalizedAppId = appId.Trim();
        var appPart = Base64UrlEncode(Encoding.UTF8.GetBytes(normalizedAppId));
        var signature = Sign(normalizedAppId);
        return $"{Prefix}.{Version}.{appPart}.{signature}";
    }

    public bool ValidateToken(string appId, string token)
        => string.Equals(ResolveAppId(token), appId, StringComparison.Ordinal);

    public string? ResolveAppId(string token)
    {
        var parts = token.Split('.');
        if (parts is not [Prefix, Version, var appPart, var signature])
        {
            return null;
        }

        string tokenAppId;
        try
        {
            tokenAppId = Encoding.UTF8.GetString(Base64UrlDecode(appPart));
        }
        catch (FormatException)
        {
            return null;
        }

        var expected = Sign(tokenAppId);
        var signatureValid = CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(expected),
            Encoding.UTF8.GetBytes(signature));
        return signatureValid ? tokenAppId : null;
    }

    private string Sign(string appId)
        => Base64UrlEncode(HMACSHA256.HashData(
            key.Value,
            Encoding.UTF8.GetBytes($"hosty-app-service:{appId}")));

    private static string Base64UrlEncode(byte[] bytes)
        => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] Base64UrlDecode(string value)
    {
        var padded = value.Replace('-', '+').Replace('_', '/');
        padded = padded.PadRight(padded.Length + (4 - padded.Length % 4) % 4, '=');
        return Convert.FromBase64String(padded);
    }
}
