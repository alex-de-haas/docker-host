namespace Haas.Hosty.Core;

internal static class PublicOriginSettings
{
    public const string Prefix = "HOSTY_PUBLIC_ORIGIN_";

    public static string BuildSettingKey(string endpointKey)
        => $"{Prefix}{NormalizeSettingKey(endpointKey)}";

    public static bool IsSettingKey(string key)
        => key.StartsWith(Prefix, StringComparison.Ordinal);

    public static string NormalizeSettingKey(string value)
    {
        var chars = value.Length == 0 ? "endpoint".ToCharArray() : value.ToCharArray();
        for (var index = 0; index < chars.Length; index++)
        {
            chars[index] = char.IsAsciiLetterOrDigit(chars[index])
                ? char.ToUpperInvariant(chars[index])
                : '_';
        }

        var normalized = new string(chars).Trim('_');
        return normalized.Length == 0 ? "ENDPOINT" : normalized;
    }

    public static bool TryNormalizeOrigin(string? value, out string origin)
    {
        origin = "";
        if (string.IsNullOrWhiteSpace(value) ||
            !Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri) ||
            uri.Scheme is not ("http" or "https") ||
            !string.IsNullOrWhiteSpace(uri.UserInfo) ||
            !string.IsNullOrEmpty(uri.PathAndQuery.Trim('/')) ||
            !string.IsNullOrWhiteSpace(uri.Fragment))
        {
            return false;
        }

        origin = uri.GetLeftPart(UriPartial.Authority);
        return true;
    }
}
