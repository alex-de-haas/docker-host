using Haas.DockerHost.Cli.Commands;

namespace Haas.DockerHost.Cli.Tests.Commands;

public sealed class SelfUpdateServiceTests
{
    [Fact]
    public void CurrentExecutableMatches_SameArtifactBytes_ReturnsTrue()
    {
        var executablePath = Path.Combine(Path.GetTempPath(), $"docker-host-test-{Guid.NewGuid():N}");
        var artifactBytes = "current artifact"u8.ToArray();
        File.WriteAllBytes(executablePath, artifactBytes);

        try
        {
            var matches = SelfUpdateService.CurrentExecutableMatches(
                executablePath,
                SelfUpdateService.CalculateSha256(artifactBytes));

            Assert.True(matches);
        }
        finally
        {
            File.Delete(executablePath);
        }
    }

    [Fact]
    public void CurrentExecutableMatches_DifferentArtifactBytes_ReturnsFalse()
    {
        var executablePath = Path.Combine(Path.GetTempPath(), $"docker-host-test-{Guid.NewGuid():N}");
        File.WriteAllText(executablePath, "current artifact");

        try
        {
            var matches = SelfUpdateService.CurrentExecutableMatches(
                executablePath,
                SelfUpdateService.CalculateSha256("new artifact"u8.ToArray()));

            Assert.False(matches);
        }
        finally
        {
            File.Delete(executablePath);
        }
    }

    [Fact]
    public void TryFindChecksum_ArtifactEntryExists_ReturnsChecksum()
    {
        const string checksums = """
            1111111111111111111111111111111111111111111111111111111111111111  docker-host-linux-arm64
            abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd  docker-host-linux-x64
            """;

        var found = SelfUpdateService.TryFindChecksum(
            checksums,
            "docker-host-linux-x64",
            out var sha256);

        Assert.True(found);
        Assert.Equal("abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd", sha256);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("1111111111111111111111111111111111111111111111111111111111111111  docker-host-linux-arm64")]
    public void TryFindChecksum_ArtifactEntryMissing_ReturnsFalse(string? checksums)
    {
        var found = SelfUpdateService.TryFindChecksum(
            checksums,
            "docker-host-linux-x64",
            out var sha256);

        Assert.False(found);
        Assert.Equal(string.Empty, sha256);
    }
}
