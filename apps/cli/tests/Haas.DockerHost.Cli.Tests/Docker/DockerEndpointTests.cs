using Haas.DockerHost.Cli.Docker;

namespace Haas.DockerHost.Cli.Tests.Docker;

public sealed class DockerEndpointTests
{
    [Theory]
    [InlineData("unix:///var/run/docker.sock", "UnixSocket", "/var/run/docker.sock")]
    [InlineData("npipe:////./pipe/docker_engine", "NamedPipe", "docker_engine")]
    public void Parse_SupportedLocalEndpoint_ReturnsEndpoint(
        string value,
        string expectedKind,
        string expectedAddress)
    {
        var endpoint = DockerEndpoint.Parse(value);

        Assert.Equal(expectedKind, endpoint.Kind.ToString());
        Assert.Equal(expectedAddress, endpoint.Address);
    }

    [Theory]
    [InlineData("tcp://127.0.0.1:2375")]
    [InlineData("ssh://docker.example")]
    [InlineData("unix://relative.sock")]
    [InlineData("npipe:////./pipe/docker/engine")]
    public void Parse_UnsupportedEndpoint_ThrowsDockerEngineException(string value)
    {
        var exception = Assert.Throws<DockerEngineException>(() => DockerEndpoint.Parse(value));

        Assert.Equal("parse Docker endpoint", exception.Operation);
        Assert.NotEmpty(exception.Message);
        Assert.False(string.IsNullOrWhiteSpace(exception.NextStep));
    }
}
