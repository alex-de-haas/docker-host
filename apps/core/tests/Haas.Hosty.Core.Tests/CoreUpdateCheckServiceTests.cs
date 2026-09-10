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
    // A marker written with a `v` prefix would reach a client that adds its own as "vv0.97.0", so the
    // bare version is the only accepted spelling.
    [InlineData("v0.97.0")]
    [InlineData("release-0.97.0")]
    // A body long enough that the read cap truncated it is not a version by definition.
    [InlineData("00000000001111111111222222222233333333334444444444555555555566666")]
    public void SanitizeVersion_RejectsAnythingThatIsNotPlainlyAVersion(string body)
        => Assert.Null(CoreUpdateCheckService.SanitizeVersion(body));

    [Fact]
    public void FailedCheckKeepsLastSuccessfulResultUntilRecovery()
    {
        var checkedAt = DateTimeOffset.Parse("2026-09-10T10:00:00Z");
        var success = CoreUpdateCheckService.MergeStatus(null, new("0.99.0", true, "main", checkedAt, Error: null, AvailableVersion: "0.100.0"));
        var failed = CoreUpdateCheckService.MergeStatus(success, new("0.99.0", false, "main", checkedAt.AddMinutes(5), Error: "Offline"));
        Assert.True(failed.UpdateAvailable);
        Assert.Equal("0.100.0", failed.AvailableVersion);
        Assert.Equal(checkedAt, failed.LastSuccessfulCheckAt);
        Assert.Equal("Offline", failed.Error);
        var recovered = CoreUpdateCheckService.MergeStatus(failed, new("0.99.0", false, "main", checkedAt.AddMinutes(10), Error: null));
        Assert.False(recovered.UpdateAvailable);
        Assert.Null(recovered.Error);
        Assert.Equal(checkedAt.AddMinutes(10), recovered.LastSuccessfulCheckAt);
    }

    [Theory]
    [InlineData("0.100.0", "main")]
    [InlineData("0.99.0", "preview")]
    public void FailedCheckDoesNotRetainAnOfferForAnotherVersionOrChannel(string version, string channel)
    {
        var previous = new CoreUpdateStatus("0.99.0", true, "main", DateTimeOffset.UtcNow, Error: null);
        var current = new CoreUpdateStatus(version, false, channel, DateTimeOffset.UtcNow, Error: "Offline");
        Assert.Equal(current, CoreUpdateCheckService.MergeStatus(previous, current));
    }
}
