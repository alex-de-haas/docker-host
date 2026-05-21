using System.Net;
using System.Net.Http;
using System.Text;
using Haas.DockerHost.Cli.Commands;
using Haas.DockerHost.Cli.Configuration;
using Haas.DockerHost.Cli.Docker;
using Haas.DockerHost.Cli.HostApi;
using Spectre.Console;

namespace Haas.DockerHost.Cli.Tests.Commands;

public sealed class InstallCommandTests : IDisposable
{
    private const string RootVariable = "DOCKER_HOST_HOME";
    private readonly string? previousRoot;
    private readonly string rootDirectory;

    public InstallCommandTests()
    {
        previousRoot = Environment.GetEnvironmentVariable(RootVariable);
        rootDirectory = Path.Combine(Path.GetTempPath(), $"docker-host-install-tests-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable(RootVariable, rootDirectory);
    }

    [Fact]
    public async Task ExecuteAsync_PreparesLaunchConfigAndPullsHostImage()
    {
        var transport = new FakeDockerTransport();
        var environment = DockerHostEnvironment.Current();
        var context = new CommandContext(
            CreateConsole(),
            environment,
            new LaunchSettingsStore(environment),
            new FakeDockerEngineClientFactory(transport),
            new HostApiClientFactory());

        var exitCode = await new InstallCommand(context).ExecuteAsync([]);

        Assert.Equal(0, exitCode);
        Assert.Contains(
            transport.Requests,
            request => request.Method == HttpMethod.Post &&
                request.PathAndQuery == $"/images/create?fromImage={Uri.EscapeDataString("ghcr.io/alex-de-haas/docker-host:latest")}");
    }

    [Fact]
    public async Task ExecuteAsync_LocalHostImageExists_SkipsRegistryPull()
    {
        var transport = new FakeDockerTransport(["docker-host:dev"]);
        var environment = DockerHostEnvironment.Current();
        Directory.CreateDirectory(environment.ConfigDirectory);
        await File.WriteAllTextAsync(environment.LaunchConfigPath, "HOST_IMAGE=docker-host:dev");
        var context = new CommandContext(
            CreateConsole(),
            environment,
            new LaunchSettingsStore(environment),
            new FakeDockerEngineClientFactory(transport),
            new HostApiClientFactory());

        var exitCode = await new InstallCommand(context).ExecuteAsync([]);

        Assert.Equal(0, exitCode);
        Assert.DoesNotContain(
            transport.Requests,
            request => request.Method == HttpMethod.Post &&
                request.PathAndQuery.StartsWith("/images/create?", StringComparison.Ordinal));
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

    private sealed class FakeDockerEngineClientFactory(IDockerEngineTransport transport) : DockerEngineClientFactory
    {
        public override DockerEngineClient Create(string endpoint) => new(transport);
    }

    private sealed class FakeDockerTransport(IReadOnlyCollection<string>? existingImages = null) : IDockerEngineTransport
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

            if (method == HttpMethod.Get &&
                pathAndQuery.StartsWith("/images/", StringComparison.Ordinal) &&
                pathAndQuery.EndsWith("/json", StringComparison.Ordinal))
            {
                var encodedImage = pathAndQuery["/images/".Length..^"/json".Length];
                var image = Uri.UnescapeDataString(encodedImage);
                var exists = existingImages?.Contains(image) == true;
                return Task.FromResult(Response(
                    operation,
                    exists ? HttpStatusCode.OK : HttpStatusCode.NotFound,
                    exists ? "{}" : """{"message":"not found"}"""));
            }

            if (method == HttpMethod.Post && pathAndQuery.StartsWith("/images/create?", StringComparison.Ordinal))
            {
                return Task.FromResult(Response(operation, HttpStatusCode.OK, "{}"));
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
