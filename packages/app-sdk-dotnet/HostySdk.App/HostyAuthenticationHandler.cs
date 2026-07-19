using System.Security.Claims;
using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace HostySdk.App;

/// <summary>Per-app knobs for <see cref="HostyAuthenticationHandler"/>: the cookie namespace
/// stays app-owned (never unified across apps), and the optional role mapper turns the raw
/// Host role into the app's own role claim.</summary>
public sealed class HostyAuthenticationOptions : AuthenticationSchemeOptions
{
    /// <summary>The app-origin identity cookie name (e.g. <c>hosty_identity</c>).</summary>
    public string IdentityCookieName { get; set; } = "hosty_identity";

    /// <summary>Optional Host-role → app-role mapping; when set, the result becomes the
    /// <see cref="ClaimTypes.Role"/> claim. The raw role always rides in <c>hosty_role</c>.</summary>
    public Func<string, string?>? MapHostRole { get; set; }
}

/// <summary>
/// Authenticates requests carrying a Hosty app identity token. The token is accepted from
/// (in priority order) the <c>Authorization: Bearer</c> header used by a web BFF, the
/// <c>X-Docker-Host-Identity</c> compatibility header, or the app-origin cookie. It is always
/// revalidated against Core via <see cref="IHostyIdentityValidator"/> — the app never trusts a
/// client-supplied token on its own.
/// </summary>
public sealed class HostyAuthenticationHandler(
    IOptionsMonitor<HostyAuthenticationOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder,
    IHostyIdentityValidator validator)
    : AuthenticationHandler<HostyAuthenticationOptions>(options, logger, encoder)
{
    public const string SchemeName = "Hosty";

    /// <summary>The frozen inbound identity header (a protocol constant that survived the
    /// docker-host→hosty rename; wire literals do not track branding).</summary>
    public const string IdentityHeader = "X-Docker-Host-Identity";

    protected override async Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var token = ExtractToken(Request, Options.IdentityCookieName);
        if (string.IsNullOrWhiteSpace(token))
        {
            return AuthenticateResult.NoResult();
        }

        var session = await validator.ValidateAsync(token, Context.RequestAborted);
        if (session is null)
        {
            return AuthenticateResult.Fail("Hosty identity token is invalid or could not be revalidated.");
        }

        var claims = new List<Claim>
        {
            new(ClaimTypes.NameIdentifier, session.UserId),
            new("hosty_role", session.HostRole),
        };

        if (Options.MapHostRole?.Invoke(session.HostRole) is { Length: > 0 } appRole)
        {
            claims.Add(new Claim(ClaimTypes.Role, appRole));
        }

        if (!string.IsNullOrEmpty(session.Email))
        {
            claims.Add(new Claim(ClaimTypes.Email, session.Email));
        }

        if (!string.IsNullOrEmpty(session.DisplayName))
        {
            claims.Add(new Claim(ClaimTypes.Name, session.DisplayName));
        }

        var identity = new ClaimsIdentity(claims, SchemeName);
        var ticket = new AuthenticationTicket(new ClaimsPrincipal(identity), SchemeName);
        return AuthenticateResult.Success(ticket);
    }

    private static string? ExtractToken(HttpRequest request, string cookieName)
    {
        var authorization = request.Headers.Authorization.ToString();
        if (authorization.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
        {
            return authorization["Bearer ".Length..].Trim();
        }

        if (request.Headers.TryGetValue(IdentityHeader, out var header) && !string.IsNullOrWhiteSpace(header))
        {
            return header.ToString().Trim();
        }

        if (request.Cookies.TryGetValue(cookieName, out var cookie) && !string.IsNullOrWhiteSpace(cookie))
        {
            return cookie;
        }

        return null;
    }
}
