using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

// The release version marker is an untrusted download whose only job is to be rendered next to the
// installed version, so what it accepts is worth pinning: the verdict stays the hash comparison, and
// anything that is not plainly a version must reach a client as no version at all.
public sealed class CoreUpdateCheckServiceTests
{
    [Theory]
    [InlineData("0.97.0", "0.97.0")]
    // The workflow writes the marker with a trailing newline.
    [InlineData("0.97.0\n", "0.97.0")]
    [InlineData(" 0.97.0 \r\n", "0.97.0")]
    [InlineData("1.0.0-rc.2", "1.0.0-rc.2")]
    [InlineData("1.0.0+build.5", "1.0.0+build.5")]
    public void SanitizeVersion_AcceptsAReleasedVersion(string body, string expected)
        => Assert.Equal(expected, CoreUpdateCheckService.SanitizeVersion(body));

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    // An error page, a redirect notice, or any other file served where the marker was expected.
    [InlineData("<!doctype html><html><body>Not Found</body></html>")]
    [InlineData("0.97.0 (build 12)")]
    [InlineData("../../etc/passwd")]
    // A body long enough that the read cap truncated it is not a version by definition.
    [InlineData("00000000001111111111222222222233333333334444444444555555555566666")]
    public void SanitizeVersion_RejectsAnythingThatIsNotPlainlyAVersion(string body)
        => Assert.Null(CoreUpdateCheckService.SanitizeVersion(body));
}
