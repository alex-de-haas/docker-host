using System.Net;
using System.Net.Http;
using System.Text;
using Haas.DockerHost.Cli.Commands;
using Haas.DockerHost.Cli.Configuration;
using Haas.DockerHost.Cli.Docker;
using Haas.DockerHost.Cli.HostApi;
using Spectre.Console;

namespace Haas.DockerHost.Cli.Tests.Commands;

public sealed class StopCommandTests : IDisposable
{
    private const string RootVariable = "DOCKER_HOST_HOME";
    private readonly string? previousRoot;
    private readonly string rootDirectory;

    public StopCommandTests()
    {
        previousRoot = Environment.GetEnvironmentVariable(RootVariable);
        rootDirectory = Path.Combine(Path.GetTempPath(), $"docker-host-stop-tests-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable(RootVariable, rootDirectory);
    }

    [Fact]
    public async Task ExecuteAsync_StopsModuleContainersBeforeHostContainer()
    {
        Directory.CreateDirectory(rootDirectory);
        File.WriteAllText(
            Path.Combine(rootDirectory, "modules.json"),
            """
            {
              "modules": [
                {
                  "id": "com.acme.reports",
                  "containers": [
                    {
                      "key": "web",
                      "containerName": "mod-com-acme-reports-web"
                    },
                    {
                      "key": "worker",
                      "containerName": "mod-com-acme-reports-worker"
                    }
                  ]
                }
              ]
            }
            """);
        var transport = new FakeDockerTransport();
        var context = CreateContext(transport);

        var exitCode = await new StopCommand(context).ExecuteAsync([]);

        Assert.Equal(0, exitCode);
        Assert.Equal(
            [
                "/containers/mod-com-acme-reports-worker/stop?t=10",
                "/containers/mod-com-acme-reports-web/stop?t=10",
                "/containers/docker-host/json",
                "/containers/docker-host/stop?t=10",
            ],
            transport.Requests.Select(request => request.PathAndQuery));
    }

    [Fact]
    public async Task ExecuteAsync_ModuleContainerStopFails_ContinuesStoppingHostContainer()
    {
        Directory.CreateDirectory(rootDirectory);
        File.WriteAllText(
            Path.Combine(rootDirectory, "modules.json"),
            """
            {
              "modules": [
                {
                  "id": "com.acme.reports",
                  "containers": [
                    {
                      "key": "web",
                      "containerName": "mod-com-acme-reports-web"
                    },
                    {
                      "key": "worker",
                      "containerName": "mod-com-acme-reports-worker"
                    }
                  ]
                }
              ]
            }
            """);
        var transport = new FakeDockerTransport(["/containers/mod-com-acme-reports-worker/stop?t=10"]);
        var context = CreateContext(transport);

        var exitCode = await new StopCommand(context).ExecuteAsync([]);

        Assert.Equal(0, exitCode);
        Assert.Equal(
            [
                "/containers/mod-com-acme-reports-worker/stop?t=10",
                "/containers/mod-com-acme-reports-web/stop?t=10",
                "/containers/docker-host/json",
                "/containers/docker-host/stop?t=10",
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
            new HostApiClientFactory());
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

    private sealed class FakeDockerTransport(IReadOnlyCollection<string>? failedStopPaths = null) : IDockerEngineTransport
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

            if (method == HttpMethod.Get && pathAndQuery == "/containers/docker-host/json")
            {
                return Task.FromResult(Response(
                    operation,
                    HttpStatusCode.OK,
                    """
                    {
                      "Id": "host",
                      "Name": "/docker-host",
                      "Config": {
                        "Image": "ghcr.io/alex-de-haas/docker-host:latest"
                      },
                      "State": {
                        "Status": "running",
                        "Running": true,
                        "ExitCode": 0
                      },
                      "NetworkSettings": {
                        "Ports": {}
                      }
                    }
                    """));
            }

            if (method == HttpMethod.Post && pathAndQuery.EndsWith("/stop?t=10", StringComparison.Ordinal))
            {
                if (failedStopPaths?.Contains(pathAndQuery) == true)
                {
                    return Task.FromResult(Response(operation, HttpStatusCode.InternalServerError, """{"message":"stop failed"}"""));
                }

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
}
