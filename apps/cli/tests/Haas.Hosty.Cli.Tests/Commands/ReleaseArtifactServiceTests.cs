using Haas.Hosty.Cli.Commands;

namespace Haas.Hosty.Cli.Tests.Commands;

public sealed class ReleaseArtifactServiceTests
{
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
