namespace Haas.Hosty.Core.Tests;

public sealed class AppCodeProofTests
{
    [Fact]
    public void S256_MatchesTheRfcVector_AndRequiresAnIndependentVerifier()
    {
        Assert.True(AppCodeProof.Matches(AuthCodeProof.Challenge, AuthCodeProof.Verifier));
        Assert.False(AppCodeProof.Matches(AuthCodeProof.Challenge, AuthCodeProof.Challenge));
        Assert.False(AppCodeProof.Matches(null, AuthCodeProof.Verifier));
        Assert.False(AppCodeProof.IsVerifier(new string('a', 129)));
        Assert.False(AppCodeProof.IsVerifier(new string('a', 42)));
        Assert.True(AppCodeProof.IsVerifier(new string('~', 128)));
    }

    [Theory]
    [InlineData(null, "S256")]
    [InlineData("short", "S256")]
    [InlineData("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cN", "S256")]
    [InlineData(AuthCodeProof.Challenge, null)]
    [InlineData(AuthCodeProof.Challenge, "plain")]
    [InlineData(AuthCodeProof.Challenge, "s256")]
    public void Challenge_RefusesUnboundDowngradedAndNoncanonicalValues(string? challenge, string? method)
        => Assert.Equal("code_challenge_invalid", Assert.Throws<AppIdentityException>(() => AppCodeProof.RequireChallenge(challenge, method)).Code);
}
