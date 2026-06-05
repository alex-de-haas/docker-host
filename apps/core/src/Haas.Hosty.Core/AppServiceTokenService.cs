using System.Security.Cryptography;
using System.Text;

namespace Haas.Hosty.Core;

internal sealed class AppServiceTokenService(ControlSecret secret)
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
    {
        var parts = token.Split('.');
        if (parts is not [Prefix, Version, var appPart, var signature])
        {
            return false;
        }

        string tokenAppId;
        try
        {
            tokenAppId = Encoding.UTF8.GetString(Base64UrlDecode(appPart));
        }
        catch (FormatException)
        {
            return false;
        }

        if (!string.Equals(tokenAppId, appId, StringComparison.Ordinal))
        {
            return false;
        }

        var expected = Sign(appId);
        return CryptographicOperations.FixedTimeEquals(
            Encoding.UTF8.GetBytes(expected),
            Encoding.UTF8.GetBytes(signature));
    }

    private string Sign(string appId)
        => Base64UrlEncode(HMACSHA256.HashData(
            Encoding.UTF8.GetBytes(secret.Value),
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
