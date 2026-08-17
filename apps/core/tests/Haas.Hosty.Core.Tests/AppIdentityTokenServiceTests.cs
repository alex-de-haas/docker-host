namespace Haas.Hosty.Core.Tests;

// The credential an app presents to another app to prove which app it is.
//
// It shares a key pair with delegated tokens, so the property that keeps the two apart — the prefix
// being part of the signed input — is the one worth pinning: without it either could be replayed as
// the other, and both are minted by the same Core.
public class AppIdentityTokenServiceTests
{
    private static readonly DelegatedTokenSigningKey Key = CreateKey();

    private static AppIdentityTokenService Service(IClock? clock = null)
        => new(Key, clock ?? new SystemClock());

    [Fact]
    public void RoundTripsTheAppItWasMintedFor()
    {
        var service = Service();

        Assert.Equal("com.haas.demo-app", service.ResolveAppId(service.CreateToken("com.haas.demo-app")));
    }

    [Fact]
    public void RefusesATokenSignedByAnotherKey()
    {
        // The signature is the whole mechanism: an app that could forge one could claim to be any other
        // app, which is exactly the weakness that ruled out sharing the HMAC service-token key.
        var impostor = new AppIdentityTokenService(CreateKey(), new SystemClock());

        Assert.Null(Service().ResolveAppId(impostor.CreateToken("com.haas.demo-app")));
    }

    [Fact]
    public void ATamperedPayloadIsRefused()
    {
        // Changing the app id without re-signing must fail — otherwise the claim is decoration.
        var token = Service().CreateToken("com.haas.demo-app");
        var parts = token.Split('.');
        var forged = string.Join('.', parts[0], parts[1], Base64Url("{\"app\":\"hosty.telemetry\",\"iat\":1}"), parts[3]);

        Assert.Null(Service().ResolveAppId(forged));
    }

    [Fact]
    public void ADelegatedTokenCannotBePresentedAsAnAppIdentity()
    {
        // Both are signed by this same key. The prefix is inside the signed string, so swapping it
        // breaks the signature rather than passing a user's token off as an app's.
        var delegated = new DelegatedTokenService(Key, new SystemClock()).CreateToken("hosty.telemetry", "user_1", "host.admin");
        var swapped = "hosty_app_identity" + delegated.Token["hosty_delegated".Length..];

        Assert.Null(Service().ResolveAppId(swapped));
    }

    [Fact]
    public void MalformedInputIsRefusedRatherThanThrowing()
    {
        var service = Service();

        Assert.Null(service.ResolveAppId(""));
        Assert.Null(service.ResolveAppId("nonsense"));
        Assert.Null(service.ResolveAppId("hosty_app_identity.1.not-base64!.sig"));
        Assert.Null(service.ResolveAppId("hosty_app_identity.2." + Base64Url("{\"app\":\"x\"}") + ".sig"));
        // Beside one that must still work, so "refuses everything" cannot pass for correct.
        Assert.NotNull(service.ResolveAppId(service.CreateToken("com.haas.demo-app")));
    }

    private static string Base64Url(string json)
        => Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(json))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');

    private static DelegatedTokenSigningKey CreateKey()
    {
        using var ecdsa = System.Security.Cryptography.ECDsa.Create(
            System.Security.Cryptography.ECCurve.NamedCurves.nistP256);
        return new DelegatedTokenSigningKey(ecdsa.ExportPkcs8PrivateKey());
    }
}
