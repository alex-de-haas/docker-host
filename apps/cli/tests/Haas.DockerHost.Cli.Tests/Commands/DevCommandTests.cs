using System.Net;
using System.Net.Http;
using System.Text;
using Haas.DockerHost.Cli.Commands;
using Haas.DockerHost.Cli.Configuration;
using Haas.DockerHost.Cli.Docker;
using Haas.DockerHost.Cli.HostApi;
using Spectre.Console;

namespace Haas.DockerHost.Cli.Tests.Commands;

public sealed class DevCommandTests : IDisposable
{
    private const string RootVariable = "DOCKER_HOST_HOME";
    private readonly string? previousRoot;
    private readonly string rootDirectory;

    public DevCommandTests()
    {
        previousRoot = Environment.GetEnvironmentVariable(RootVariable);
        rootDirectory = Path.Combine(Path.GetTempPath(), $"docker-host-dev-tests-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable(RootVariable, rootDirectory);
    }

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

    [Fact]
    public async Task StatusAsync_ChecksLinuxEngineBeforeInspectingContainer()
    {
        var transport = new FakeDockerTransport();
        var context = CreateContext(transport);

        var exitCode = await new DevCommand(context).ExecuteAsync(["status", "--manifest", WriteManifest()]);

        Assert.Equal(1, exitCode);
        Assert.Equal(
            ["/version", "/containers/docker-host/json"],
            transport.Requests.Select(request => request.PathAndQuery).Take(2));
    }

    [Fact]
    public async Task ResetAsync_ChecksLinuxEngineBeforeInspectingContainer()
    {
        var transport = new FakeDockerTransport();
        var context = CreateContext(transport);

        var exitCode = await new DevCommand(context).ExecuteAsync(["reset", "--manifest", WriteManifest()]);

        Assert.Equal(1, exitCode);
        Assert.Equal(
            ["/version", "/containers/docker-host/json"],
            transport.Requests.Select(request => request.PathAndQuery).Take(2));
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable(RootVariable, previousRoot);

        if (Directory.Exists(rootDirectory))
        {
            Directory.Delete(rootDirectory, recursive: true);
        }
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

    private string WriteManifest()
    {
        var manifestPath = Path.Combine(rootDirectory, "dev.json");
        Directory.CreateDirectory(rootDirectory);
        File.WriteAllText(
            manifestPath,
            """
            {
              "metadataUrl": "http://example.test/module.json",
              "target": {
                "hostname": "dev.example.test",
                "portKey": "3000/tcp",
                "targetBaseUrl": "http://localhost:3100"
              }
            }
            """);
        return manifestPath;
    }

    private sealed class FakeDockerEngineClientFactory(IDockerEngineTransport transport) : DockerEngineClientFactory
    {
        public override DockerEngineClient Create(string endpoint) => new(transport);
    }

    private sealed class FakeDockerTransport : IDockerEngineTransport
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

            if (method == HttpMethod.Get && pathAndQuery == "/containers/docker-host/json")
            {
                return Task.FromResult(Response(operation, HttpStatusCode.NotFound, """{"message":"not found"}"""));
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
