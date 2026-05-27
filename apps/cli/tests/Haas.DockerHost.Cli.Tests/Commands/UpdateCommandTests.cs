using System.Net;
using System.Net.Http;
using System.Text;
using Haas.DockerHost.Cli.Commands;
using Haas.DockerHost.Cli.Configuration;
using Haas.DockerHost.Cli.Docker;
using Haas.DockerHost.Cli.HostApi;
using Spectre.Console;

namespace Haas.DockerHost.Cli.Tests.Commands;

public sealed class UpdateCommandTests : IDisposable
{
    private const string RootVariable = "DOCKER_HOST_HOME";
    private readonly string? previousRoot;
    private readonly string rootDirectory;

    public UpdateCommandTests()
    {
        previousRoot = Environment.GetEnvironmentVariable(RootVariable);
        rootDirectory = Path.Combine(Path.GetTempPath(), $"docker-host-update-tests-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable(RootVariable, rootDirectory);
    }

    [Fact]
    public async Task ExecuteAsync_HostWasRunning_RestartsUpdatedContainer()
    {
        var transport = new FakeDockerTransport(HostContainerState.Running);
        var context = CreateContext(transport);

        var exitCode = await new UpdateCommand(context).ExecuteAsync(["--host-only"]);

        Assert.Equal(0, exitCode);
        Assert.Equal(
            [
                "/version",
                "/networks/docker-host-modules",
                $"/images/create?fromImage={Uri.EscapeDataString("ghcr.io/alex-de-haas/docker-host:latest")}",
                "/containers/docker-host/json",
                "/containers/docker-host/stop?t=10",
                "/containers/docker-host?force=true&v=false",
                "/containers/create?name=docker-host",
                "/containers/docker-host/start",
            ],
            transport.Requests.Select(request => request.PathAndQuery));
    }

    [Fact]
    public async Task ExecuteAsync_HostWasStopped_DoesNotStartUpdatedContainer()
    {
        var transport = new FakeDockerTransport(HostContainerState.Stopped);
        var context = CreateContext(transport);

        var exitCode = await new UpdateCommand(context).ExecuteAsync(["--host-only"]);

        Assert.Equal(0, exitCode);
        Assert.Equal(
            [
                "/version",
                "/networks/docker-host-modules",
                $"/images/create?fromImage={Uri.EscapeDataString("ghcr.io/alex-de-haas/docker-host:latest")}",
                "/containers/docker-host/json",
                "/containers/docker-host?force=true&v=false",
                "/containers/create?name=docker-host",
            ],
            transport.Requests.Select(request => request.PathAndQuery));
    }

    [Fact]
    public async Task ExecuteAsync_HostWasMissing_DoesNotStartCreatedContainer()
    {
        var transport = new FakeDockerTransport(HostContainerState.Missing);
        var context = CreateContext(transport);

        var exitCode = await new UpdateCommand(context).ExecuteAsync(["--host-only"]);

        Assert.Equal(0, exitCode);
        Assert.Equal(
            [
                "/version",
                "/networks/docker-host-modules",
                $"/images/create?fromImage={Uri.EscapeDataString("ghcr.io/alex-de-haas/docker-host:latest")}",
                "/containers/docker-host/json",
                "/containers/create?name=docker-host",
            ],
            transport.Requests.Select(request => request.PathAndQuery));
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable(RootVariable, previousRoot);

        if (Directory.Exists(rootDirectory))
        {
            Directory.Delete(rootDirectory, recursive: true);
        }
    }

    private static CommandContext CreateContext(FakeDockerTransport transport)
    {
        var environment = DockerHostEnvironment.Current();
        return new CommandContext(
            CreateConsole(),
            environment,
            new LaunchSettingsStore(environment),
            new FakeDockerEngineClientFactory(transport),
            new HostControlClientFactory());
    }

    private static IAnsiConsole CreateConsole()
    {
        var output = new StringWriter();
        return AnsiConsole.Create(new AnsiConsoleSettings
        {
            Out = new AnsiConsoleOutput(output),
            Interactive = InteractionSupport.No,
        });
    }

    private sealed class FakeDockerEngineClientFactory(IDockerEngineTransport transport) : DockerEngineClientFactory
    {
        public override DockerEngineClient Create(string endpoint) => new(transport);
    }

    private sealed class FakeDockerTransport(HostContainerState hostContainerState) : IDockerEngineTransport
    {
        public List<(HttpMethod Method, string PathAndQuery)> Requests { get; } = [];

        public Task<DockerEngineResponse> SendAsync(
            string operation,
            HttpMethod method,
            string pathAndQuery,
            object? body = null,
            CancellationToken cancellationToken = default)
        {
            Requests.Add((method, pathAndQuery));

            if (method == HttpMethod.Get && pathAndQuery == "/version")
            {
                return Task.FromResult(Response(operation, HttpStatusCode.OK, """{"Os":"linux","OSType":"linux"}"""));
            }

            if (method == HttpMethod.Get && pathAndQuery == "/networks/docker-host-modules")
            {
                return Task.FromResult(Response(operation, HttpStatusCode.OK, "{}"));
            }

            if (method == HttpMethod.Post && pathAndQuery.StartsWith("/images/create?", StringComparison.Ordinal))
            {
                return Task.FromResult(Response(operation, HttpStatusCode.OK, "{}"));
            }

            if (method == HttpMethod.Get && pathAndQuery == "/containers/docker-host/json")
            {
                if (hostContainerState == HostContainerState.Missing)
                {
                    return Task.FromResult(Response(operation, HttpStatusCode.NotFound, """{"message":"not found"}"""));
                }

                var running = hostContainerState == HostContainerState.Running;
                var status = running ? "running" : "exited";
                var bodyJson =
                    $$"""
                    {
                      "Id": "host",
                      "Name": "/docker-host",
                      "Config": {
                        "Image": "ghcr.io/alex-de-haas/docker-host:latest"
                      },
                      "State": {
                        "Status": "{{status}}",
                        "Running": {{running.ToString().ToLowerInvariant()}},
                        "ExitCode": 0
                      },
                      "NetworkSettings": {
                        "Ports": {
                          "3000/tcp": [
                            {
                              "HostIp": "127.0.0.1",
                              "HostPort": "31234"
                            }
                          ]
                        }
                      }
                    }
                    """;

                return Task.FromResult(Response(operation, HttpStatusCode.OK, bodyJson));
            }

            if (method == HttpMethod.Post && pathAndQuery == "/containers/docker-host/stop?t=10")
            {
                return Task.FromResult(Response(operation, HttpStatusCode.NoContent, ""));
            }

            if (method == HttpMethod.Delete && pathAndQuery == "/containers/docker-host?force=true&v=false")
            {
                return Task.FromResult(Response(operation, HttpStatusCode.NoContent, ""));
            }

            if (method == HttpMethod.Post && pathAndQuery == "/containers/create?name=docker-host")
            {
                return Task.FromResult(Response(operation, HttpStatusCode.Created, "{}"));
            }

            if (method == HttpMethod.Post && pathAndQuery == "/containers/docker-host/start")
            {
                return Task.FromResult(Response(operation, HttpStatusCode.NoContent, ""));
            }

            return Task.FromResult(Response(operation, HttpStatusCode.NotFound, """{"message":"not found"}"""));
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

    private enum HostContainerState
    {
        Missing,
        Stopped,
        Running,
    }
}
