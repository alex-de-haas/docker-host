using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using Haas.DockerHost.Cli.Docker;

namespace Haas.DockerHost.Cli.Tests.Docker;

public sealed class DockerEngineClientTests
{
    [Fact]
    public async Task CreateHostContainerAsync_PassesBindAddressToEnvironmentAndPortBinding()
    {
        var transport = new CapturingDockerTransport();
        using var client = new DockerEngineClient(transport);
        var plan = new HostContainerPlan(
            "docker-host:dev",
            "docker-host",
            "/host/data",
            "/data",
            "/Users/example/.docker/run/docker.sock",
            "/var/run/docker.sock",
            "docker-host-modules",
            "unless-stopped",
            "127.0.0.1",
            "",
            "",
            "disabled",
            "root_test",
            3000);

        await client.CreateHostContainerAsync(plan);

        Assert.NotNull(transport.Body);
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(transport.Body));
        var root = json.RootElement;
        var env = root.GetProperty("Env").EnumerateArray()
            .Select(value => value.GetString())
            .ToArray();
        var hostIp = root
            .GetProperty("HostConfig")
            .GetProperty("PortBindings")
            .GetProperty("3000/tcp")[0]
            .GetProperty("HostIp")
            .GetString();
        var binds = root
            .GetProperty("HostConfig")
            .GetProperty("Binds")
            .EnumerateArray()
            .Select(value => value.GetString())
            .ToArray();

        Assert.Contains("HOST_BIND_ADDRESS=127.0.0.1", env);
        Assert.Contains("HOST_DOCKER_SOCKET=/var/run/docker.sock", env);
        Assert.Contains("HOST_DATA_ROOT_MARKER=root_test", env);
        Assert.Contains("/Users/example/.docker/run/docker.sock:/var/run/docker.sock", binds);
        Assert.Equal("127.0.0.1", hostIp);
    }

    private sealed class CapturingDockerTransport : IDockerEngineTransport
    {
        public object? Body { get; private set; }

        public Task<DockerEngineResponse> SendAsync(
            string operation,
            HttpMethod method,
            string pathAndQuery,
            object? body = null,
            CancellationToken cancellationToken = default)
        {
            Body = body;
            return Task.FromResult(Response(operation, HttpStatusCode.Created, "{}"));
        }

        public void Dispose()
        {
        }

        private static DockerEngineResponse Response(string operation, HttpStatusCode statusCode, string body)
        {
            var bytes = Encoding.UTF8.GetBytes(body);
            return new DockerEngineResponse(
                operation,
                statusCode,
                body,
                bytes,
                new Dictionary<string, IReadOnlyList<string>>(StringComparer.OrdinalIgnoreCase));
        }
    }
}
