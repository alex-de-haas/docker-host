using Haas.Hosty.Cli.Commands;

namespace Haas.Hosty.Cli.Tests.Commands;

public sealed class ReleaseArtifactServiceTests
{
    [Theory]
    [InlineData("stable", "stable")]
    [InlineData("v0.32.0", "v0.32.0")]
    [InlineData("cli-dev", "cli-dev")]
    public void ResolveTag_ValidTag_IsUsed(string tag, string expected)
        => Assert.Equal(expected, ReleaseArtifactService.ResolveTag(tag));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("bad tag with spaces")]
    [InlineData("../../etc/passwd")]
    [InlineData("release/0.32")]
    [InlineData("tag?query=1")]
    public void ResolveTag_MissingOrUnsafe_FallsBackToDefault(string? tag)
        => Assert.Equal(ReleaseArtifactService.DefaultReleaseTag, ReleaseArtifactService.ResolveTag(tag));

    [Fact]
    public void RequireChecksum_ArtifactEntryExists_ReturnsChecksum()
    {
        const string checksums = """
            1111111111111111111111111111111111111111111111111111111111111111  hosty-linux-arm64
            abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd  hosty-linux-x64
            """;

        var sha256 = ReleaseArtifactService.RequireChecksum(checksums, "hosty-linux-x64");

        Assert.Equal("abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd", sha256);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not a checksum file")]
    [InlineData("1111111111111111111111111111111111111111111111111111111111111111  hosty-linux-arm64")]
    public void RequireChecksum_ChecksumUnavailable_Throws(string? checksums)
    {
        var exception = Assert.Throws<InvalidOperationException>(
            () => ReleaseArtifactService.RequireChecksum(checksums, "hosty-linux-x64"));

        Assert.Contains("SHA256SUMS", exception.Message);
        Assert.Contains("hosty-linux-x64", exception.Message);
    }
}
