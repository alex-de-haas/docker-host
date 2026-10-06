namespace Haas.Hosty.Core.Tests;

public sealed class AppSignInCookieHostTests
{
    [Theory]
    [InlineData("127.1", "127.0.0.1")]
    [InlineData("2130706433", "127.0.0.1")]
    [InlineData("0x7f000001", "127.0.0.1")]
    [InlineData("0177.0.0.1", "127.0.0.1")]
    [InlineData("[0:0:0:0:0:0:0:1]", "::1")]
    [InlineData("BÜCHER.Example.", "xn--bcher-kva.example")]
    [InlineData("Core.Example.", "core.example")]
    [InlineData("127.0.0.999", null)]
    [InlineData("example..", null)]
    [InlineData("fe80::1%eth0", null)]
    public void CanonicalCookieHosts_MatchBrowserAliases_AndRejectAmbiguity(string host, string? expected)
        => Assert.Equal(expected, AppSignInCookieHost.CanonicalHost(host));
}
