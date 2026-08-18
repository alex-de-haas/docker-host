using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Xunit;
using Haas.Hosty.TelemetryBackend.Query;

namespace Haas.Hosty.TelemetryBackend.Tests;

// Who may read this fleet's telemetry. Every refusal is asserted beside an acceptance, because a gate
// that refuses everything satisfies each negative on its own and is completely broken.
public class TelemetryCallerAuthTests
{
    private const string AppId = "hosty.telemetry";

    private static readonly ECDsa Key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
    private static readonly string PublicKey = Convert.ToBase64String(Key.ExportSubjectPublicKeyInfo());

    private static TelemetryCallerAuth Auth(string? publicKey = null, string appId = AppId)
        => new(publicKey ?? PublicKey, appId);

    [Fact]
    public void AcceptsThisAppsOwnIdentity()
    {
        // The telemetry UI is a sibling *service* of this same app, and Core mints identity per app —
        // so the legitimate app caller presents this app's id.
        var caller = Auth().Authenticate(Request(AppIdentity(AppId)));

        Assert.NotNull(caller);
        Assert.True(caller.IsApp);
        Assert.Equal(AppId, caller.Id);
    }

    [Fact]
    public void RefusesAnotherAppsIdentityEvenThoughCoreSignedIt()
    {
        // Core injects an identity token into every app, so "correctly signed" is nowhere near enough:
        // accepting any would let any installed app read the whole fleet's telemetry with no
        // administrator anywhere in the story. Asserted beside the one that must still work, since the
        // two differ only in which app they name.
        Assert.Null(Auth().Authenticate(Request(AppIdentity("com.haas.demo-app"))));
        Assert.NotNull(Auth().Authenticate(Request(AppIdentity(AppId))));
    }

    [Fact]
    public void AcceptsADelegatedTokenAddressedToThisApp()
    {
        var caller = Auth().Authenticate(Request(Delegated("user_admin", AppId)));

        Assert.NotNull(caller);
        Assert.False(caller.IsApp);
        Assert.Equal("user_admin", caller.Id);
    }

    [Fact]
    public void RefusesADelegatedTokenMintedForAnotherApp()
    {
        // The audience check is the whole of it: without it, any app's delegated token would read the
        // entire fleet's telemetry. Asserted beside the token that differs only in audience.
        Assert.Null(Auth().Authenticate(Request(Delegated("user_admin", "com.haas.demo-app"))));
        Assert.NotNull(Auth().Authenticate(Request(Delegated("user_admin", AppId))));
    }

    [Fact]
    public void RefusesAnExpiredDelegatedToken()
    {
        Assert.Null(Auth().Authenticate(Request(Delegated("user_admin", AppId, expiresInSeconds: -60))));
        Assert.NotNull(Auth().Authenticate(Request(Delegated("user_admin", AppId, expiresInSeconds: 60))));
    }

    [Fact]
    public void RefusesATokenSignedByAnotherKey()
    {
        // The signature is what makes any of this mean anything. A forged payload with a real shape
        // must fail, while the identically-shaped genuine one passes.
        using var impostor = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var forged = Sign(impostor, "hosty_app_identity", new { app = "hosty.telemetry-ui", iat = 1 });

        Assert.Null(Auth().Authenticate(Request(forged)));
        Assert.NotNull(Auth().Authenticate(Request(AppIdentity(AppId))));
    }

    [Fact]
    public void RefusesAMissingOrMalformedHeader()
    {
        Assert.Null(Auth().Authenticate(Request(null)));
        Assert.Null(Auth().Authenticate(Request("")));
        Assert.Null(Auth().Authenticate(Request("not-a-bearer")));
        Assert.Null(Auth().Authenticate(Request("hosty_app_identity.1.only-three-parts")));
        Assert.NotNull(Auth().Authenticate(Request(AppIdentity(AppId))));
    }

    [Fact]
    public void WithoutAVerificationKeyItRefusesEverythingRatherThanAllowingIt()
    {
        // The direction that matters. An unconfigured backend must be closed, not open: falling through
        // to "allow" would make the whole feature a no-op on exactly the deployments where the key
        // failed to arrive, and look identical to working.
        var unconfigured = Auth(publicKey: "");

        Assert.False(unconfigured.Configured);
        Assert.Null(unconfigured.Authenticate(Request(AppIdentity(AppId))));
    }

    [Fact]
    public void ATokenOfTheOtherTypeCannotBeReplayedAsThisOne()
    {
        // Both types are signed by the same key, so the prefix being part of the signed input is what
        // keeps them apart. Swap it and the signature no longer covers the string being verified.
        var delegated = Delegated("user_admin", AppId);
        var swapped = "hosty_app_identity" + delegated["hosty_delegated".Length..];

        Assert.Null(Auth().Authenticate(Request(swapped)));
    }

    /// <summary>The Authorization header a caller would send, or a malformed one as written.</summary>
    private static string? Request(string? token)
        => token is null ? null
            : token.StartsWith("hosty_", StringComparison.Ordinal) ? $"Bearer {token}"
            : token;

    private static string AppIdentity(string appId)
        => Sign(Key, "hosty_app_identity", new { app = appId, iat = DateTimeOffset.UtcNow.ToUnixTimeSeconds() });

    private static string Delegated(string sub, string aud, int expiresInSeconds = 300)
        => Sign(Key, "hosty_delegated", new
        {
            sub,
            aud,
            role = "host.admin",
            exp = DateTimeOffset.UtcNow.AddSeconds(expiresInSeconds).ToUnixTimeSeconds(),
        });

    private static string Sign(ECDsa key, string prefix, object claims)
    {
        var payload = Base64Url(JsonSerializer.SerializeToUtf8Bytes(claims));
        var signingInput = $"{prefix}.1.{payload}";
        var signature = key.SignData(Encoding.UTF8.GetBytes(signingInput), HashAlgorithmName.SHA256);
        return $"{signingInput}.{Base64Url(signature)}";
    }

    private static string Base64Url(byte[] bytes)
        => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
