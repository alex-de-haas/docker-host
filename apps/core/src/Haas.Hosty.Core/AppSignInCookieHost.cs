using System.Globalization;
using System.Net;

namespace Haas.Hosty.Core;

internal static class AppSignInCookieHost
{
    internal static string? CanonicalHost(string host)
    {
        host = host.Trim('[', ']');
        if (host.EndsWith("..", StringComparison.Ordinal) || host.Contains('%')) return null;
        host = host.TrimEnd('.');
        if (IPAddress.TryParse(host, out var address)) return address.ToString().ToLowerInvariant();
        // Browsers interpret hosts ending in a number as IPv4, including abbreviated/octal/hex forms.
        // A failed IP parse must not be accepted as a DNS name and compared under different rules.
        var finalLabel = host.Split('.').Last();
        if (finalLabel.All(char.IsAsciiDigit) || finalLabel.StartsWith("0x", StringComparison.OrdinalIgnoreCase)) return null;
        try
        {
            var ascii = new IdnMapping().GetAscii(host).ToLowerInvariant();
            return ascii.Length is > 0 and <= 253 && ascii.Split('.').All(label =>
                label.Length is > 0 and <= 63 && label[0] != '-' && label[^1] != '-' &&
                label.All(character => character is >= 'a' and <= 'z' or >= '0' and <= '9' or '-')) ? ascii : null;
        }
        catch (ArgumentException) { return null; }
    }

    internal static async Task<bool> IsSafeAsync(HttpRequest request, AppRegistryStore apps, CancellationToken ct)
    {
        var coreHost = CanonicalHost(request.Host.Host);
        if (coreHost is null || (!request.IsHttps && !IPAddress.TryParse(coreHost, out _))) return false;
        foreach (var app in await apps.ListAppRecordsAsync(ct))
        {
            foreach (var endpoint in app.Endpoints)
            {
                foreach (var origin in AppIdentityService.GetAllowedEndpointOrigins(app, endpoint))
                {
                    if (string.IsNullOrWhiteSpace(origin)) continue;
                    if (!Uri.TryCreate(origin, UriKind.Absolute, out var uri)) return false;
                    // Endpoint declarations do not constrain the traffic an app server accepts.
                    // WebSocket handshakes also send cookies, so every configured host is checked.
                    var appHost = CanonicalHost(uri.Host);
                    if (appHost is null || appHost == coreHost) return false;
                }
            }
        }
        return true;
    }
}
