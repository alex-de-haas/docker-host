using Haas.DockerHost.Cli.Commands;

namespace Haas.DockerHost.Cli.Tests.Commands;

public sealed class DevCommandTests
{
    [Fact]
    public void BuildTargetProbeUrl_HostDockerInternal_UsesLoopbackHost()
    {
        var url = DevCommand.BuildTargetProbeUrl("http://HOST.DOCKER.INTERNAL:3100/health?ready=true");

        Assert.Equal("http://127.0.0.1:3100/health?ready=true", url);
    }

    [Fact]
    public void BuildTargetProbeUrl_OtherHost_KeepsOriginalUrl()
    {
        var original = "http://example.test:3100/host.docker.internal?ready=true";

        var url = DevCommand.BuildTargetProbeUrl(original);

        Assert.Equal(original, url);
    }
}
