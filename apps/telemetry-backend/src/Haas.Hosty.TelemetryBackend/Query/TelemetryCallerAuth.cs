using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Haas.Hosty.TelemetryBackend.Query;

/// <summary>
/// Who is allowed to read this fleet's telemetry.
/// </summary>
/// <remarks>
/// <para>
/// Until this existed the query API carried <b>no authentication at all</b>, which its own source said
/// plainly and which is why nothing could be built on top of it: the app-MCP contract is "Core
/// authenticates, the app authorizes", and an app with no authentication cannot honour it.
/// </para>
/// <para>
/// Two shapes of caller, verified with one key — the public half of Core's delegated-token key pair,
/// which Core already injects as <c>HOSTY_DELEGATED_TOKEN_PUBLIC_KEY</c>:
/// </para>
/// <list type="bullet">
/// <item><b>An app</b> (the telemetry UI) presents <c>hosty_app_identity</c>, minted for it at start.</item>
/// <item><b>A user</b>, through MCP, presents a short-TTL <c>hosty_delegated</c> token whose audience
/// is this app — the ordinary app-MCP contract.</item>
/// </list>
/// <para>
/// The administrator requirement is <b>inherited, not re-implemented</b>: telemetry is a system app,
/// and Core refuses to mint a delegated token for a system app to anyone who is not a host
/// administrator. Re-checking the role here would be a second copy of a rule that already exists, and
/// the copy is the one that goes stale.
/// </para>
/// <para>
/// Verification is local and offline. Core is not in the read path, so a query costs no round trip and
/// keeps working while Core restarts.
/// </para>
/// </remarks>
internal sealed class TelemetryCallerAuth
{
    private const string AppIdentityPrefix = "hosty_app_identity";
    private const string DelegatedPrefix = "hosty_delegated";
    private const string Version = "1";

    private readonly byte[]? publicKeySpki;
    private readonly string appId;

    public TelemetryCallerAuth(string? publicKeySpkiBase64, string appId)
    {
        this.appId = appId;
        publicKeySpki = string.IsNullOrWhiteSpace(publicKeySpkiBase64)
            ? null
            : TryDecode(publicKeySpkiBase64);
    }

    /// <summary>
    /// True when Core injected a verification key. False means this backend cannot authenticate
    /// anybody, which is a refusal rather than a bypass — see <see cref="Authenticate"/>.
    /// </summary>
    public bool Configured => publicKeySpki is not null;

    /// <summary>
    /// Identifies the caller, or returns null when it cannot be identified.
    /// </summary>
    /// <remarks>
    /// Fails closed on a missing key. An earlier draft of this had it fall through to "allow" when Core
    /// injected nothing, on the grounds that an unconfigured backend should not break — which would
    /// have made the entire feature a no-op on exactly the deployments where the key failed to arrive,
    /// and looked identical to working.
    /// </remarks>
    /// <param name="authorizationHeader">
    /// The raw header. Taken as a string rather than an <c>HttpRequest</c> so the rule can be tested
    /// without a web host — the thing under test is the credential, not the plumbing that carries it.
    /// </param>
    public TelemetryCaller? Authenticate(string? authorizationHeader)
    {
        if (publicKeySpki is null)
        {
            return null;
        }

        var header = authorizationHeader ?? string.Empty;
        if (!header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var token = header["Bearer ".Length..].Trim();
        var parts = token.Split('.');
        if (parts is not [var prefix, Version, var payloadPart, var signaturePart])
        {
            return null;
        }

        if (!Verify($"{prefix}.{Version}.{payloadPart}", signaturePart))
        {
            return null;
        }

        return prefix switch
        {
            AppIdentityPrefix => ReadAppCaller(payloadPart),
            DelegatedPrefix => ReadUserCaller(payloadPart),
            _ => null,
        };
    }

    private TelemetryCaller? ReadAppCaller(string payloadPart)
    {
        var payload = Read<AppIdentityClaims>(payloadPart);
        return string.IsNullOrWhiteSpace(payload?.App) ? null : new TelemetryCaller(payload.App, IsApp: true);
    }

    private TelemetryCaller? ReadUserCaller(string payloadPart)
    {
        var payload = Read<DelegatedClaims>(payloadPart);
        if (payload is null || string.IsNullOrWhiteSpace(payload.Sub))
        {
            return null;
        }

        // The audience check is what stops a token minted for a *different* app being replayed here.
        // Without it any app's delegated token would read the whole fleet's telemetry.
        if (!string.Equals(payload.Aud, appId, StringComparison.Ordinal))
        {
            return null;
        }

        return payload.Exp > DateTimeOffset.UtcNow.ToUnixTimeSeconds()
            ? new TelemetryCaller(payload.Sub, IsApp: false)
            : null;
    }

    private bool Verify(string signingInput, string signaturePart)
    {
        try
        {
            using var ecdsa = ECDsa.Create();
            ecdsa.ImportSubjectPublicKeyInfo(publicKeySpki, out _);
            return ecdsa.VerifyData(
                Encoding.UTF8.GetBytes(signingInput),
                Base64UrlDecode(signaturePart),
                HashAlgorithmName.SHA256);
        }
        catch (Exception ex) when (ex is CryptographicException or FormatException)
        {
            return false;
        }
    }

    private static T? Read<T>(string payloadPart)
    {
        try
        {
            return JsonSerializer.Deserialize<T>(
                Base64UrlDecode(payloadPart),
                new JsonSerializerOptions(JsonSerializerDefaults.Web));
        }
        catch (Exception ex) when (ex is FormatException or JsonException)
        {
            return default;
        }
    }

    private static byte[]? TryDecode(string value)
    {
        try
        {
            return Convert.FromBase64String(value.Trim());
        }
        catch (FormatException)
        {
            return null;
        }
    }

    private static byte[] Base64UrlDecode(string value)
    {
        var padded = value.Replace('-', '+').Replace('_', '/');
        padded = padded.PadRight(padded.Length + (4 - padded.Length % 4) % 4, '=');
        return Convert.FromBase64String(padded);
    }

    private sealed record AppIdentityClaims(string? App);

    private sealed record DelegatedClaims(string? Sub, string? Aud, long Exp);
}

/// <summary>An authenticated caller: an app id, or a user id when the call came through MCP.</summary>
internal sealed record TelemetryCaller(string Id, bool IsApp);
