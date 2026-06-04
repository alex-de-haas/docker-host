using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Haas.DockerHost.Cli;
using Spectre.Console;

namespace Haas.DockerHost.Cli.Tests.Commands;

public sealed class AuthCommandTests : IDisposable
{
    private const string RootVariable = "HOSTY_HOME";
    private const string LegacyRootVariable = "DOCKER_HOST_HOME";
    private readonly string? previousRoot;
    private readonly string? previousLegacyRoot;
    private readonly string rootDirectory;

    public AuthCommandTests()
    {
        previousRoot = Environment.GetEnvironmentVariable(RootVariable);
        previousLegacyRoot = Environment.GetEnvironmentVariable(LegacyRootVariable);
        rootDirectory = Path.Combine(Path.GetTempPath(), $"hosty-auth-command-tests-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable(RootVariable, rootDirectory);
        Environment.SetEnvironmentVariable(LegacyRootVariable, null);
    }

    [Theory]
    [InlineData("setup-token")]
    [InlineData("recovery-token")]
    public async Task RunAsync_TokenCommandWithoutCore_DoesNotWriteLegacyAuthState(string command)
    {
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["auth", command], console);

        Assert.Equal(1, exitCode);
        Assert.Contains("Hosty Core is not running", output.ToString());
        Assert.False(File.Exists(Path.Combine(rootDirectory, "auth", "state.json")));
        Assert.False(File.Exists(Path.Combine(rootDirectory, "auth", "audit.ndjson")));
        Assert.False(File.Exists(Path.Combine(rootDirectory, "core", "auth", "state.json")));
    }

    [Fact]
    public async Task RunAsync_SetupToken_CallsCoreControlApi()
    {
        using var server = new FakeCoreServer("""
            {
              "token": "dhstp_test",
              "setupUrl": "http://127.0.0.1:3001/setup?setupToken=dhstp_test",
              "expiresAt": "2026-06-04T10:15:00Z"
            }
            """);
        WriteCoreDiscovery(server);
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["auth", "setup-token"], console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.Equal("POST", server.Method);
        Assert.Equal("/control/v1/auth/setup-token", server.PathAndQuery);
        Assert.Equal("test-secret", server.Headers["X-Hosty-Test-Control"]);
        Assert.Contains("dhstp_test", output.ToString());
        Assert.Contains("/setup?setupToken=dhstp_test", output.ToString());
    }

    [Fact]
    public async Task RunAsync_RecoveryToken_CallsCoreControlApi()
    {
        using var server = new FakeCoreServer("""
            {
              "token": "dhrec_test",
              "recoveryUrl": "http://127.0.0.1:3001/recovery?recoveryToken=dhrec_test",
              "expiresAt": "2026-06-04T10:15:00Z"
            }
            """);
        WriteCoreDiscovery(server);
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["auth", "recovery-token"], console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.Equal("POST", server.Method);
        Assert.Equal("/control/v1/auth/recovery-token", server.PathAndQuery);
        Assert.Equal("test-secret", server.Headers["X-Hosty-Test-Control"]);
        Assert.Contains("dhrec_test", output.ToString());
        Assert.Contains("/recovery?recoveryToken=dhrec_test", output.ToString());
    }

    [Fact]
    public async Task RunAsync_TokenCommand_WithArguments_ReturnsUsageError()
    {
        var (console, _) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["auth", "setup-token", "extra"], console);

        Assert.Equal(2, exitCode);
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable(RootVariable, previousRoot);
        Environment.SetEnvironmentVariable(LegacyRootVariable, previousLegacyRoot);

        if (Directory.Exists(rootDirectory))
        {
            Directory.Delete(rootDirectory, recursive: true);
        }
    }

    private void WriteCoreDiscovery(FakeCoreServer server)
    {
        var runDirectory = Path.Combine(rootDirectory, "core", "run");
        Directory.CreateDirectory(runDirectory);
        File.WriteAllText(
            Path.Combine(runDirectory, "control.json"),
            JsonSerializer.Serialize(new
            {
                controlBaseUrl = server.ControlBaseUrl,
                requiredHeaders = new Dictionary<string, string>
                {
                    ["X-Hosty-Test-Control"] = "test-secret",
                },
            }));
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
        private readonly string responseBody;

        public FakeCoreServer(string responseBody)
        {
            this.responseBody = responseBody;
            listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            ControlBaseUrl = $"http://127.0.0.1:{port}/control/v1";
            serverTask = Task.Run(HandleOneRequestAsync);
        }

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
                    $"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {payload.Length}\r\nConnection: close\r\n\r\n");
                await stream.WriteAsync(responseHeader);
                await stream.WriteAsync(payload);
            }
            catch (ObjectDisposedException)
            {
            }
        }
    }
}
