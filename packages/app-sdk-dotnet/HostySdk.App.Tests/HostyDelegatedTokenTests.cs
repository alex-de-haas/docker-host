using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using HostySdk.App;
using Xunit;

namespace HostySdk.App.Tests;

/// <summary>
/// Delegated-token validation, against tokens minted the way Core mints them.
/// </summary>
/// <remarks>
/// This is the credential an agent's MCP call arrives with, so the tests are mostly about refusal: a
/// validator that accepts a token addressed to another app, or one whose payload was edited after
/// signing, is worse than no validator, because the route in front of it believes the caller.
/// </remarks>
public sealed class HostyDelegatedTokenTests
{
    private const string AppId = "com.haas.notes";
    private readonly ECDsa _core = ECDsa.Create(ECCurve.NamedCurves.nistP256);

    [Fact]
    public void A_token_minted_for_this_app_validates_and_carries_the_actor()
    {
        var claims = HostyDelegatedToken.Validate(Mint(), AppId, PublicKey());

        Assert.NotNull(claims);
        Assert.Equal("user_admin", claims.Subject);
        Assert.Equal("host.admin", claims.Role);
        Assert.Equal(AppId, claims.Audience);
    }

    [Fact]
    public void A_token_addressed_to_another_app_is_refused()
    {
        // The property the whole credential rests on. Core mints one token per target app precisely so
        // a token handed to one app cannot be replayed against another; skipping the audience check
        // here would hand that back.
        Assert.Null(HostyDelegatedToken.Validate(Mint(audience: "com.haas.other"), AppId, PublicKey()));
    }

    [Fact]
    public void An_expired_token_is_refused_and_a_live_one_is_not()
    {
        var now = DateTimeOffset.UtcNow;
        var token = Mint(expiresAt: now.AddMinutes(5));

        Assert.NotNull(HostyDelegatedToken.Validate(token, AppId, PublicKey(), now));
        // Paired, because a validator that refused everything would pass the expiry assertion alone.
        Assert.Null(HostyDelegatedToken.Validate(token, AppId, PublicKey(), now.AddMinutes(6)));
    }

    [Fact]
    public void A_payload_edited_after_signing_is_refused()
    {
        // The attack the signature exists to stop: take a real token for a plain user and rewrite the
        // role to host.admin. The claims are readable by anyone holding the token, so nothing but the
        // signature stands between reading them and rewriting them.
        var parts = Mint(role: "host.user").Split('.');
        var forged = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(Base64UrlDecode(parts[2]))!;
        forged["role"] = JsonSerializer.SerializeToElement("host.admin");
        var tampered = $"{parts[0]}.{parts[1]}.{Base64UrlEncode(JsonSerializer.SerializeToUtf8Bytes(forged))}.{parts[3]}";

        Assert.Null(HostyDelegatedToken.Validate(tampered, AppId, PublicKey()));
    }

    [Fact]
    public void A_token_signed_by_a_different_key_is_refused()
    {
        using var impostor = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var token = Mint(signer: impostor);

        Assert.Null(HostyDelegatedToken.Validate(token, AppId, PublicKey()));
    }

    [Fact]
    public void An_app_identity_token_cannot_pass_as_a_delegated_one()
    {
        // They are different credentials with different lifetimes and different revocation stories. The
        // type is inside the signed input on both sides, so neither can stand in for the other — and an
        // app that let one through would be accepting a credential it never checked the audience of.
        Assert.Null(HostyDelegatedToken.Validate("hosty_app_identity.1.payload.signature", AppId, PublicKey()));
    }

    [Theory]
    [InlineData("")]
    [InlineData("not-a-token")]
    [InlineData("hosty_delegated.1.only-three-parts")]
    [InlineData("hosty_delegated.2.cGF5bG9hZA.c2ln")]
    [InlineData("hosty_delegated.1.!!!not-base64!!!.c2ln")]
    public void Malformed_input_is_refused_rather_than_thrown(string token)
    {
        // A route treats null as it treats a missing token. An exception here would turn a bad request
        // into a 500 and, on a JSON-RPC surface, end the caller's turn instead of answering it.
        Assert.Null(HostyDelegatedToken.Validate(token, AppId, PublicKey()));
    }

    [Fact]
    public void Without_an_audience_or_a_key_nothing_validates()
    {
        // Falling back to "no audience configured means any audience" is the failure mode worth naming:
        // it would accept every token the host ever minted, for any app.
        var token = Mint();

        Assert.Null(HostyDelegatedToken.Validate(token, appId: null, PublicKey()));
        Assert.Null(HostyDelegatedToken.Validate(token, AppId, publicKeyBase64: null));
    }

    [Theory]
    [InlineData("Bearer abc", "abc")]
    [InlineData("bearer abc", "abc")]
    [InlineData("Basic abc", null)]
    [InlineData("", null)]
    [InlineData(null, null)]
    public void The_bearer_reader_takes_only_a_bearer(string? header, string? expected)
        => Assert.Equal(expected, HostyDelegatedToken.ReadBearer(header));

    /// <summary>Mints a token exactly as <c>DelegatedTokenService</c> does, including the extra claims.</summary>
    private string Mint(
        string audience = AppId,
        string role = "host.admin",
        DateTimeOffset? expiresAt = null,
        ECDsa? signer = null)
    {
        var now = DateTimeOffset.UtcNow;
        var payload = new Dictionary<string, object?>
        {
            ["sub"] = "user_admin",
            ["role"] = role,
            ["aud"] = audience,
            ["iat"] = now.ToUnixTimeSeconds(),
            ["exp"] = (expiresAt ?? now.AddMinutes(5)).ToUnixTimeSeconds(),
            ["jti"] = Guid.NewGuid().ToString("N"),
            // Core carries these too; a validator that only tolerates the fields it reads would reject
            // every real token the moment the platform adds one.
            ["chainOrigin"] = now.ToUnixTimeSeconds(),
            ["branched"] = true,
        };

        var payloadPart = Base64UrlEncode(JsonSerializer.SerializeToUtf8Bytes(payload));
        var signingInput = $"hosty_delegated.1.{payloadPart}";
        var signature = (signer ?? _core).SignData(
            Encoding.UTF8.GetBytes(signingInput), HashAlgorithmName.SHA256);
        return $"{signingInput}.{Base64UrlEncode(signature)}";
    }

    private string PublicKey() => Convert.ToBase64String(_core.ExportSubjectPublicKeyInfo());

    private static string Base64UrlEncode(byte[] value)
        => Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static byte[] Base64UrlDecode(string value)
    {
        var padded = value.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(padded.PadRight(padded.Length + ((4 - (padded.Length % 4)) % 4), '='));
    }
}
