using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class SecretComparisonTests
{
    private const string Secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    [Fact]
    public void HexEquals_AcceptsTheExactSecret()
        => Assert.True(SecretComparison.HexEquals(Secret, Secret));

    [Fact]
    public void HexEquals_AcceptsTheSameBytesInUpperCase()
    {
        // Core mints the secret lowercase, but the comparison is over decoded bytes, so a caller
        // echoing it back upper-cased presents the same credential and is accepted.
        Assert.True(SecretComparison.HexEquals(Secret, Secret.ToUpperInvariant()));
    }

    [Theory]
    // Same length, differs only in the final nibble — the case ordinary string equality would
    // resolve late, and the reason this comparison must not short-circuit.
    [InlineData("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde0")]
    // Differs in the first nibble.
    [InlineData("f123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")]
    // Correct prefix, truncated.
    [InlineData("0123456789abcdef")]
    // Longer than the secret.
    [InlineData("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdefff")]
    // Not hex at all.
    [InlineData("not-a-hex-secret")]
    // Right length, but contains non-hex characters.
    [InlineData("zzzz456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")]
    // Multi-value header rendering (StringValues joins with a comma).
    [InlineData("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef,x")]
    public void HexEquals_RejectsAnythingElse(string submitted)
        => Assert.False(SecretComparison.HexEquals(Secret, submitted));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public void HexEquals_RejectsMissingInput(string? submitted)
        => Assert.False(SecretComparison.HexEquals(Secret, submitted));

    [Fact]
    public void HexEquals_RejectsEverythingWhenNoSecretIsConfigured()
    {
        Assert.False(SecretComparison.HexEquals(null, Secret));
        Assert.False(SecretComparison.HexEquals(string.Empty, Secret));
    }

    [Fact]
    public void Equals_MatchesOpaqueSecretsExactly()
    {
        Assert.True(SecretComparison.Equals("proxy-secret", "proxy-secret"));
        Assert.False(SecretComparison.Equals("proxy-secret", "proxy-secreT"));
        Assert.False(SecretComparison.Equals("proxy-secret", "proxy-secret "));
        Assert.False(SecretComparison.Equals("proxy-secret", null));
        Assert.False(SecretComparison.Equals(null, "proxy-secret"));
    }
}
