using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Haas.Hosty.Cli;
using Haas.Hosty.Cli.Commands;
using Haas.Hosty.Cli.Configuration;
using Spectre.Console;

namespace Haas.Hosty.Cli.Tests.Commands;

public sealed class CoreCommandTests : IDisposable
{
    private const string RootVariable = "HOSTY_HOME";
    private readonly string? previousRoot;
    private readonly string rootDirectory;

    public CoreCommandTests()
    {
        previousRoot = Environment.GetEnvironmentVariable(RootVariable);
        rootDirectory = Path.Combine(Path.GetTempPath(), $"hosty-core-command-tests-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable(RootVariable, rootDirectory);
    }

    [Fact]
    public async Task StopAsync_WhenControlSecretIsRejected_ReturnsFriendlyError()
    {
        using var server = new FakeCoreServer(
            HttpStatusCode.Unauthorized,
            """{"code":"control_unauthorized","message":"Local control secret is missing or invalid."}""");
        WriteCoreDiscovery(server);
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["stop"], console);
        await server.WaitForRequestAsync();

        Assert.Equal(1, exitCode);
        Assert.Equal("POST", server.Method);
        Assert.Equal("/control/v1/core/stop", server.PathAndQuery);
        Assert.Equal("test-secret", server.Headers["X-Hosty-Test-Control"]);
        Assert.Contains("local control secret was rejected", output.ToString());
        Assert.Contains("control discovery file is stale", output.ToString());
    }

    [Fact]
    public async Task StopAsync_WhenDiscoveryPointsToDeadProcess_ReportsNotRunningAndRemovesStaleFile()
    {
        // A hard-killed Core leaves control.json behind pointing at a PID that is no longer alive.
        var path = WriteCoreDiscovery("http://127.0.0.1:1/control/v1", processId: int.MaxValue - 1);
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["stop"], console);

        Assert.Equal(1, exitCode);
        Assert.Contains("not running", output.ToString());
        Assert.False(File.Exists(path));
    }

    [Fact]
    public async Task StartAsync_WhenCoreAlreadyHealthy_ReusesItWithoutSpawning()
    {
        using var server = new FakeCoreServer(HttpStatusCode.OK, """{"status":"ok"}""");
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["start", "--url", server.Endpoint], console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.Equal("GET", server.Method);
        Assert.Equal("/healthz", server.PathAndQuery);
        Assert.Contains("already running", output.ToString());
    }

    [Theory]
    [InlineData("")]
    [InlineData("https://raw.githubusercontent.com/example/marketplace/main/manifest.json")]
    public void BuildCoreEnvironment_MarketplaceManifestPath_PassesManagedValueIncludingEmpty(string manifestPath)
    {
        var environment = HostyEnvironment.Current();
        var settings = new LaunchSettingsStore(environment)
            .Load()
            .WithValue(LaunchSettingDefinitions.HostyMarketplaceManifestPath, manifestPath);
        var (console, _) = CreateConsole();
        var command = new CoreCommand(new CommandContext(console, environment, new LaunchSettingsStore(environment)));

        var coreEnvironment = command.BuildCoreEnvironment("http://localhost:7070", settings);

        Assert.Equal(manifestPath, coreEnvironment[LaunchSettingDefinitions.HostyMarketplaceManifestPath]);
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable(RootVariable, previousRoot);

        if (Directory.Exists(rootDirectory))
        {
            Directory.Delete(rootDirectory, recursive: true);
        }
    }

    private void WriteCoreDiscovery(FakeCoreServer server)
        => WriteCoreDiscovery(server.ControlBaseUrl);

    private string WriteCoreDiscovery(string controlBaseUrl, int? processId = null)
    {
        var runDirectory = Path.Combine(rootDirectory, "core", "run");
        Directory.CreateDirectory(runDirectory);
        var path = Path.Combine(runDirectory, "control.json");
        File.WriteAllText(
            path,
            JsonSerializer.Serialize(new
            {
                controlBaseUrl,
                requiredHeaders = new Dictionary<string, string>
                {
                    ["X-Hosty-Test-Control"] = "test-secret",
                },
                processId,
                nonce = "test-nonce",
            }));
        return path;
    }

    private static (IAnsiConsole Console, StringWriter Output) CreateConsole()
    {
        var output = new StringWriter();
        var console = AnsiConsole.Create(new AnsiConsoleSettings
        {
            Out = new AnsiConsoleOutput(output),
            Interactive = InteractionSupport.No,
        });
        return (console, output);
    }

    private sealed class FakeCoreServer : IDisposable
    {
        private readonly TcpListener listener;
        private readonly Task serverTask;
        private readonly HttpStatusCode statusCode;
        private readonly string responseBody;

        public FakeCoreServer(HttpStatusCode statusCode, string responseBody)
        {
            this.statusCode = statusCode;
            this.responseBody = responseBody;
            listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            Endpoint = $"http://127.0.0.1:{port}";
            ControlBaseUrl = $"{Endpoint}/control/v1";
            serverTask = Task.Run(HandleOneRequestAsync);
        }

        public string Endpoint { get; }

        public string ControlBaseUrl { get; }

        public string Method { get; private set; } = "";

        public string PathAndQuery { get; private set; } = "";

        public Dictionary<string, string> Headers { get; } = new(StringComparer.OrdinalIgnoreCase);

        public async Task WaitForRequestAsync()
        {
            var completed = await Task.WhenAny(serverTask, Task.Delay(TimeSpan.FromSeconds(5)));
            Assert.Same(serverTask, completed);
            await serverTask;
        }

        public void Dispose()
        {
            listener.Stop();
        }

        private async Task HandleOneRequestAsync()
        {
            try
            {
                using var client = await listener.AcceptTcpClientAsync();
                await using var stream = client.GetStream();
                using var reader = new StreamReader(
                    stream,
                    Encoding.UTF8,
                    detectEncodingFromByteOrderMarks: false,
                    bufferSize: 4096,
                    leaveOpen: true);
                var requestLine = await reader.ReadLineAsync() ?? "";
                var requestParts = requestLine.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                Method = requestParts.ElementAtOrDefault(0) ?? "";
                PathAndQuery = requestParts.ElementAtOrDefault(1) ?? "";

                string? line;
                while (!string.IsNullOrEmpty(line = await reader.ReadLineAsync()))
                {
                    var separator = line.IndexOf(':', StringComparison.Ordinal);
                    if (separator <= 0)
                    {
                        continue;
                    }

                    Headers[line[..separator].Trim()] = line[(separator + 1)..].Trim();
                }

                var payload = Encoding.UTF8.GetBytes(responseBody);
                var responseHeader = Encoding.ASCII.GetBytes(
                    $"HTTP/1.1 {(int)statusCode} {statusCode}\r\nContent-Type: application/json\r\nContent-Length: {payload.Length}\r\nConnection: close\r\n\r\n");
                await stream.WriteAsync(responseHeader);
                await stream.WriteAsync(payload);
            }
            catch (ObjectDisposedException)
            {
            }
        }
    }
}
