using System.Net;
using System.Net.Http;
using System.Text;
using Haas.DockerHost.Cli.Commands;
using Haas.DockerHost.Cli.Configuration;
using Haas.DockerHost.Cli.Docker;
using Haas.DockerHost.Cli.HostApi;
using Spectre.Console;

namespace Haas.DockerHost.Cli.Tests.Commands;

public sealed class StartCommandTests : IDisposable
{
    private const string RootVariable = "DOCKER_HOST_HOME";
    private const string HostImage = "ghcr.io/alex-de-haas/docker-host:latest";
    private readonly string? previousRoot;
    private readonly string rootDirectory;

    public StartCommandTests()
    {
        previousRoot = Environment.GetEnvironmentVariable(RootVariable);
        rootDirectory = Path.Combine(Path.GetTempPath(), $"docker-host-start-tests-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable(RootVariable, rootDirectory);
    }

    [Fact]
    public async Task ExecuteAsync_StoppedHostRecreatesContainerWhenPulledImageChanged()
    {
        var transport = new FakeDockerTransport(
            HostContainerState.Stopped,
            initialImageId: "sha256:old",
            imageIdAfterPull: "sha256:new",
            containerImageId: "sha256:old");
        var context = CreateContext(transport);

        var exitCode = await new StartCommand(context).ExecuteAsync([]);

        Assert.Equal(0, exitCode);
        Assert.Equal(
            [
                "/version",
                "/networks/docker-host-modules",
                "/containers/docker-host/json",
                ImageInspectPath(HostImage),
                PullPath(HostImage),
                ImageInspectPath(HostImage),
                "/containers/docker-host?force=true&v=false",
                "/containers/create?name=docker-host",
                "/containers/docker-host/start",
                "/containers/docker-host/json",
            ],
            transport.Requests.Select(request => request.PathAndQuery));
    }

    [Fact]
    public async Task ExecuteAsync_StoppedHostStartsExistingContainerWhenPulledImageIsCurrent()
    {
        var transport = new FakeDockerTransport(
            HostContainerState.Stopped,
            initialImageId: "sha256:current",
            imageIdAfterPull: "sha256:current",
            containerImageId: "sha256:current");
        var context = CreateContext(transport);

        var exitCode = await new StartCommand(context).ExecuteAsync([]);

        Assert.Equal(0, exitCode);
        Assert.Equal(
            [
                "/version",
                "/networks/docker-host-modules",
                "/containers/docker-host/json",
                ImageInspectPath(HostImage),
                PullPath(HostImage),
                ImageInspectPath(HostImage),
                "/containers/docker-host/start",
                "/containers/docker-host/json",
            ],
            transport.Requests.Select(request => request.PathAndQuery));
    }

    [Fact]
    public async Task ExecuteAsync_StoppedHostStartsCachedContainerWhenRegistryPullFails()
    {
        var transport = new FakeDockerTransport(
            HostContainerState.Stopped,
            initialImageId: "sha256:current",
            imageIdAfterPull: "sha256:current",
            containerImageId: "sha256:current",
            failPull: true);
        var context = CreateContext(transport);

        var exitCode = await new StartCommand(context).ExecuteAsync([]);

        Assert.Equal(0, exitCode);
        Assert.Equal(
            [
                "/version",
                "/networks/docker-host-modules",
                "/containers/docker-host/json",
                ImageInspectPath(HostImage),
                PullPath(HostImage),
                "/containers/docker-host/start",
                "/containers/docker-host/json",
            ],
            transport.Requests.Select(request => request.PathAndQuery));
    }

    [Fact]
    public async Task ExecuteAsync_RunningHostDoesNotPullOrRecreate()
    {
        var transport = new FakeDockerTransport(HostContainerState.Running);
        var context = CreateContext(transport);

        var exitCode = await new StartCommand(context).ExecuteAsync([]);

        Assert.Equal(0, exitCode);
        Assert.Equal(
            [
                "/version",
                "/networks/docker-host-modules",
                "/containers/docker-host/json",
            ],
            transport.Requests.Select(request => request.PathAndQuery));
    }

    [Fact]
    public async Task ExecuteAsync_MissingHostPullsImageAndCreatesContainer()
    {
        var transport = new FakeDockerTransport(
            HostContainerState.Missing,
            initialImageId: null,
            imageIdAfterPull: "sha256:current");
        var context = CreateContext(transport);

        var exitCode = await new StartCommand(context).ExecuteAsync([]);

        Assert.Equal(0, exitCode);
        Assert.Equal(
            [
                "/version",
                "/networks/docker-host-modules",
                "/containers/docker-host/json",
                ImageInspectPath(HostImage),
                PullPath(HostImage),
                ImageInspectPath(HostImage),
                "/containers/create?name=docker-host",
                "/containers/docker-host/start",
                "/containers/docker-host/json",
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

    private static string ImageInspectPath(string image)
        => $"/images/{Uri.EscapeDataString(image).Replace("%2F", "/", StringComparison.OrdinalIgnoreCase)}/json";

    private static string PullPath(string image)
        => $"/images/create?fromImage={Uri.EscapeDataString(image)}";

    private sealed class FakeDockerEngineClientFactory(IDockerEngineTransport transport) : DockerEngineClientFactory
    {
        public override DockerEngineClient Create(string endpoint) => new(transport);
    }

    private sealed class FakeDockerTransport(
        HostContainerState hostContainerState,
        string? initialImageId = "sha256:current",
        string? imageIdAfterPull = "sha256:current",
        string? containerImageId = "sha256:current",
        bool failPull = false) : IDockerEngineTransport
    {
        private bool containerExists = hostContainerState != HostContainerState.Missing;
        private bool containerRunning = hostContainerState == HostContainerState.Running;
        private string? currentContainerImageId = containerImageId;
        private int pullCount;

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

            if (method == HttpMethod.Get &&
                pathAndQuery.StartsWith("/images/", StringComparison.Ordinal) &&
                pathAndQuery.EndsWith("/json", StringComparison.Ordinal))
            {
                var currentImageId = GetCurrentImageId();
                return Task.FromResult(currentImageId is null
                    ? Response(operation, HttpStatusCode.NotFound, """{"message":"not found"}""")
                    : Response(operation, HttpStatusCode.OK, $$"""{"Id":"{{currentImageId}}"}"""));
            }

            if (method == HttpMethod.Post && pathAndQuery.StartsWith("/images/create?", StringComparison.Ordinal))
            {
                if (failPull)
                {
                    throw new DockerEngineException("pull Host image", "registry unavailable");
                }

                pullCount++;
                return Task.FromResult(Response(operation, HttpStatusCode.OK, "{}"));
            }

            if (method == HttpMethod.Get && pathAndQuery == "/containers/docker-host/json")
            {
                if (!containerExists)
                {
                    return Task.FromResult(Response(operation, HttpStatusCode.NotFound, """{"message":"not found"}"""));
                }

                var status = containerRunning ? "running" : "exited";
                var bodyJson =
                    $$"""
                    {
                      "Id": "host",
                      "Name": "/docker-host",
                      "Image": "{{currentContainerImageId}}",
                      "Config": {
                        "Image": "{{HostImage}}"
                      },
                      "State": {
                        "Status": "{{status}}",
                        "Running": {{containerRunning.ToString().ToLowerInvariant()}},
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

            if (method == HttpMethod.Delete && pathAndQuery == "/containers/docker-host?force=true&v=false")
            {
                containerExists = false;
                containerRunning = false;
                return Task.FromResult(Response(operation, HttpStatusCode.NoContent, ""));
            }

            if (method == HttpMethod.Post && pathAndQuery == "/containers/create?name=docker-host")
            {
                containerExists = true;
                containerRunning = false;
                currentContainerImageId = GetCurrentImageId();
                return Task.FromResult(Response(operation, HttpStatusCode.Created, "{}"));
            }

            if (method == HttpMethod.Post && pathAndQuery == "/containers/docker-host/start")
            {
                containerRunning = true;
                return Task.FromResult(Response(operation, HttpStatusCode.NoContent, ""));
            }

            return Task.FromResult(Response(operation, HttpStatusCode.NotFound, """{"message":"not found"}"""));
        }

        public void Dispose()
        {
        }

        private string? GetCurrentImageId()
            => pullCount > 0 ? imageIdAfterPull : initialImageId;

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
