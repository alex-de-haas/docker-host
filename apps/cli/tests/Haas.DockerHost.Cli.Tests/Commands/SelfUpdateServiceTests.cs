using Haas.DockerHost.Cli.Commands;
using Spectre.Console;

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

    [Fact]
    public void CreateDownloadProgressColumns_KnownContentLength_UsesDeterminateProgressColumns()
    {
        var columns = SelfUpdateService.CreateDownloadProgressColumns(1024);

        Assert.Contains(columns, column => column is ProgressBarColumn);
        Assert.Contains(columns, column => column is PercentageColumn);
        Assert.Contains(columns, column => column is RemainingTimeColumn);
        Assert.DoesNotContain(columns, column => column is SpinnerColumn);
    }

    [Theory]
    [InlineData(null)]
    [InlineData(0L)]
    public void CreateDownloadProgressColumns_UnknownContentLength_UsesSpinnerColumns(long? contentLength)
    {
        var columns = SelfUpdateService.CreateDownloadProgressColumns(contentLength);

        Assert.Contains(columns, column => column is SpinnerColumn);
        Assert.DoesNotContain(columns, column => column is ProgressBarColumn);
        Assert.DoesNotContain(columns, column => column is PercentageColumn);
        Assert.DoesNotContain(columns, column => column is RemainingTimeColumn);
    }
}
