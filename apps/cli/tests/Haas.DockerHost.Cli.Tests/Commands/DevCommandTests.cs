using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text;
using System.Globalization;
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
    public async Task StatusAsync_WithoutConfiguredDevRepository_ThrowsUsageException()
    {
        var transport = new FakeDockerTransport();
        var context = CreateContext(transport);

        await Assert.ThrowsAsync<CommandUsageException>(
            () => new DevCommand(context).ExecuteAsync(["status", "--manifest", WriteManifest()]));

        Assert.Empty(transport.Requests);
    }

    [Fact]
    public async Task ResetAsync_WithoutConfiguredDevRepository_ThrowsUsageException()
    {
        var transport = new FakeDockerTransport();
        var context = CreateContext(transport);

        await Assert.ThrowsAsync<CommandUsageException>(
            () => new DevCommand(context).ExecuteAsync(["reset", "--manifest", WriteManifest()]));

        Assert.Empty(transport.Requests);
    }

    [Fact]
    public async Task UpAsync_WithoutConfiguredDevRepository_ThrowsUsageExceptionBeforeReadingMetadata()
    {
        var transport = new FakeDockerTransport();
        var context = CreateContext(transport);
        var missingManifestPath = Path.Combine(rootDirectory, "missing", "metadata.dev.json");

        await Assert.ThrowsAsync<CommandUsageException>(
            () => new DevCommand(context).ExecuteAsync(["up", "--manifest", missingManifestPath]));

        Assert.Empty(transport.Requests);
    }

    [Fact]
    public async Task StatusAsync_WithHostUrl_UsesTrustedControlOnly()
    {
        using var hostApi = FakeHostApiServer.Start();
        WriteControlDiscovery();
        var transport = new FakeDockerTransport();
        var context = CreateContext(transport);

        var exitCode = await new DevCommand(context).ExecuteAsync(["status", "--manifest", WriteManifest(), "--host-url", hostApi.BaseUrl]);

        Assert.Equal(1, exitCode);
        Assert.Empty(transport.Requests);
        Assert.Contains(hostApi.Requests, request => request.Path == "/control/v1/host/status");
    }

    [Fact]
    public async Task StatusAsync_WithConfiguredHostDevRepository_UsesTrustedControlOnly()
    {
        using var hostApi = FakeHostApiServer.Start();
        WriteControlDiscovery();
        var transport = new FakeDockerTransport();
        var context = CreateContext(transport);
        context.SettingsStore.Set(LaunchSettingDefinitions.HostDevRepositoryPath, rootDirectory);
        context.SettingsStore.Set(
            LaunchSettingDefinitions.HostDevPort,
            new Uri(hostApi.BaseUrl).Port.ToString(CultureInfo.InvariantCulture));

        var exitCode = await new DevCommand(context).ExecuteAsync(["status", "--manifest", WriteManifest()]);

        Assert.Equal(1, exitCode);
        Assert.Empty(transport.Requests);
        Assert.Contains(hostApi.Requests, request => request.Path == "/control/v1/host/status");
    }

    [Fact]
    public async Task ResetAsync_WithHostUrl_UsesTrustedControlOnly()
    {
        using var hostApi = FakeHostApiServer.Start();
        WriteControlDiscovery();
        var transport = new FakeDockerTransport();
        var context = CreateContext(transport);

        var exitCode = await new DevCommand(context).ExecuteAsync(["reset", "--manifest", WriteManifest(), "--host-url", hostApi.BaseUrl]);

        Assert.Equal(0, exitCode);
        Assert.Empty(transport.Requests);
        Assert.Contains(hostApi.Requests, request => request.Path == "/control/v1/modules/dev/targets");
    }

    [Theory]
    [InlineData("status")]
    [InlineData("reset")]
    public async Task ExecuteAsync_InvalidHostUrl_ThrowsUsageException(string command)
    {
        var transport = new FakeDockerTransport();
        var context = CreateContext(transport);

        await Assert.ThrowsAsync<CommandUsageException>(
            () => new DevCommand(context).ExecuteAsync([command, "--manifest", WriteManifest(), "--host-url", "ftp://example.test"]));

        Assert.Empty(transport.Requests);
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
            new HostControlClientFactory());
    }

    private string WriteManifest()
    {
        var manifestPath = Path.Combine(rootDirectory, "metadata.dev.json");
        Directory.CreateDirectory(rootDirectory);
        File.WriteAllText(
            manifestPath,
            """
            {
              "schemaVersion": "0.3",
              "id": "com.example.dev",
              "name": "Dev Module",
              "version": "1.0.0",
              "services": [
                {
                  "key": "app",
                  "source": {
                    "type": "process",
                    "command": "npm run dev"
                  },
                  "runtime": {
                    "ports": [
                      { "key": "http", "containerPort": 3000, "localPort": 3100, "protocol": "http" }
                    ]
                  }
                }
              ],
              "endpoints": [
                { "key": "http", "service": "app", "port": "http", "public": true }
              ]
            }
            """);
        return manifestPath;
    }

    private void WriteControlDiscovery()
    {
        var runDirectory = Path.Combine(rootDirectory, "run");
        Directory.CreateDirectory(runDirectory);
        File.WriteAllText(
            Path.Combine(runDirectory, "control.json"),
            """
            {
              "schemaVersion": "0.1",
              "controlContractVersion": "0.1",
              "endpoint": { "url": "http://127.0.0.1/control/v1" },
              "secret": "test-control-secret"
            }
            """);
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

    private sealed class FakeHostApiServer : IDisposable
    {
        private readonly HttpListener listener;
        private readonly Task requestLoop;

        private FakeHostApiServer(HttpListener listener, int port)
        {
            this.listener = listener;
            BaseUrl = $"http://127.0.0.1:{port}/";
            requestLoop = Task.Run(ProcessRequestsAsync);
        }

        public string BaseUrl { get; }

        public List<(string Method, string Path)> Requests { get; } = [];

        public static FakeHostApiServer Start()
        {
            var port = GetAvailablePort();
            var listener = new HttpListener();
            listener.Prefixes.Add($"http://127.0.0.1:{port}/");
            listener.Prefixes.Add($"http://localhost:{port}/");
            listener.Start();
            return new FakeHostApiServer(listener, port);
        }

        public void Dispose()
        {
            listener.Close();
            requestLoop.Wait(TimeSpan.FromSeconds(2));
        }

        private async Task ProcessRequestsAsync()
        {
            while (listener.IsListening)
            {
                HttpListenerContext requestContext;
                try
                {
                    requestContext = await listener.GetContextAsync();
                }
                catch (HttpListenerException)
                {
                    return;
                }
                catch (ObjectDisposedException)
                {
                    return;
                }

                var path = requestContext.Request.Url?.AbsolutePath ?? "";
                Requests.Add((requestContext.Request.HttpMethod, path));

                var body = path switch
                {
                    "/control/v1/host/status" => "{}",
                    "/control/v1/modules/dev/targets" => """{"developerModeEnabled":true,"targets":[]}""",
                    "/control/v1/apps" => """{"apps":[]}""",
                    _ => """{"message":"not found"}""",
                };
                requestContext.Response.StatusCode = path is "/control/v1/host/status" or "/control/v1/modules/dev/targets" or "/control/v1/apps"
                    ? (int)HttpStatusCode.OK
                    : (int)HttpStatusCode.NotFound;
                requestContext.Response.ContentType = "application/json";
                var bytes = Encoding.UTF8.GetBytes(body);
                requestContext.Response.ContentLength64 = bytes.Length;
                await requestContext.Response.OutputStream.WriteAsync(bytes);
                requestContext.Response.Close();
            }
        }

        private static int GetAvailablePort()
        {
            using var socket = new TcpListener(IPAddress.Loopback, 0);
            socket.Start();
            return ((IPEndPoint)socket.LocalEndpoint).Port;
        }
    }
}
