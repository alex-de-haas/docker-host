using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Haas.Hosty.Cli;
using Spectre.Console;

namespace Haas.Hosty.Cli.Tests.Commands;

public sealed class UsersCommandTests : IDisposable
{
    private const string RootVariable = "HOSTY_HOME";
    private readonly string? previousRoot;
    private readonly string rootDirectory;

    public UsersCommandTests()
    {
        previousRoot = Environment.GetEnvironmentVariable(RootVariable);
        rootDirectory = Path.Combine(Path.GetTempPath(), $"hosty-users-command-tests-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable(RootVariable, rootDirectory);
    }

    [Fact]
    public async Task RunAsync_UsersList_CallsCoreSummariesRoute()
    {
        using var server = new FakeCoreServer(
            HttpStatusCode.OK,
            """
            {
              "users": [
                {
                  "id": "user-1",
                  "email": "admin@example.com",
                  "displayName": "Admin",
                  "role": "host.admin",
                  "disabled": false
                }
              ]
            }
            """);
        WriteCoreDiscovery(server);
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["users", "list"], console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.Equal("GET", server.Method);
        Assert.Equal("/control/v1/users/summaries", server.PathAndQuery);
        Assert.Equal("test-secret", server.Headers["X-Hosty-Test-Control"]);
        Assert.Contains("admin@example.com", output.ToString());
    }

    [Fact]
    public async Task RunAsync_UsersList_WhenCoreApiFails_ReturnsFriendlyError()
    {
        using var server = new FakeCoreServer(
            HttpStatusCode.InternalServerError,
            """{"code":"users_unavailable","message":"User store is unavailable."}""");
        WriteCoreDiscovery(server);
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["users", "list"], console);
        await server.WaitForRequestAsync();

        Assert.Equal(1, exitCode);
        Assert.Contains("Hosty Core API failed", output.ToString());
        Assert.Contains("users_unavailable", output.ToString());
    }

    [Fact]
    public async Task RunAsync_UsersList_WhenCoreIsUnreachable_ReturnsFriendlyError()
    {
        WriteCoreDiscovery(ReserveClosedPortBaseUrl());
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["users", "list"], console);

        Assert.Equal(1, exitCode);
        Assert.Contains("Unable to reach Hosty Core", output.ToString());
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable(RootVariable, previousRoot);

        if (Directory.Exists(rootDirectory))
        {
            Directory.Delete(rootDirectory, recursive: true);
        }
    }

    private static string ReserveClosedPortBaseUrl()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        return $"http://127.0.0.1:{port}/control/v1";
    }

    private void WriteCoreDiscovery(FakeCoreServer server)
        => WriteCoreDiscovery(server.ControlBaseUrl);

    private void WriteCoreDiscovery(string controlBaseUrl)
    {
        var runDirectory = Path.Combine(rootDirectory, "core", "run");
        Directory.CreateDirectory(runDirectory);
        File.WriteAllText(
            Path.Combine(runDirectory, "control.json"),
            JsonSerializer.Serialize(new
            {
                controlBaseUrl,
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
        private readonly HttpStatusCode statusCode;
        private readonly string responseBody;

        public FakeCoreServer(HttpStatusCode statusCode, string responseBody)
        {
            this.statusCode = statusCode;
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
