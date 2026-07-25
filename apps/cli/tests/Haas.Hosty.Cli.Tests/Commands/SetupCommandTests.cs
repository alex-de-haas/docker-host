using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Haas.Hosty.Cli;
using Spectre.Console;

namespace Haas.Hosty.Cli.Tests.Commands;

// `hosty setup` performs real installs and uninstalls against a running Core, so every test here
// drives a stub control plane and asserts on the requests the command actually made.
public sealed class SetupCommandTests : IDisposable
{
    private const string RootVariable = "HOSTY_HOME";
    private readonly string? previousRoot;
    private readonly string rootDirectory;

    // Shell and marketplace installed, telemetry not — the shape every test starts from.
    private const string CatalogState = """
        {
          "source": "test catalog",
          "problems": [],
          "seeded": true,
          "apps": [
            { "id": "hosty.shell", "title": "Hosty Shell", "defaultEnabled": true, "installed": true, "runtimeState": "running" },
            { "id": "hosty.telemetry", "title": "Telemetry", "defaultEnabled": false, "installed": false },
            { "id": "hosty.marketplace", "title": "Marketplace", "defaultEnabled": true, "installed": true, "runtimeState": "running" }
          ]
        }
        """;

    public SetupCommandTests()
    {
        previousRoot = Environment.GetEnvironmentVariable(RootVariable);
        rootDirectory = Path.Combine(Path.GetTempPath(), $"hosty-setup-tests-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable(RootVariable, rootDirectory);
    }

    [Fact]
    public async Task Setup_List_ShowsTheCatalogWithoutChangingAnything()
    {
        using var server = StartServer();
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["setup", "--list"], console);

        Assert.Equal(0, exitCode);
        Assert.Contains("hosty.telemetry", output.ToString());
        Assert.All(server.Requests, request => Assert.Equal("GET", request.Method));
    }

    [Fact]
    public async Task Setup_With_InstallsTheMissingApp()
    {
        using var server = StartServer();
        var (console, _) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["setup", "--with", "hosty.telemetry"], console);

        Assert.Equal(0, exitCode);
        Assert.Contains(
            server.Requests,
            request => request is { Method: "POST", Path: "/control/v1/core/bootstrap/hosty.telemetry/install" });
    }

    [Fact]
    public async Task Setup_Without_UninstallsThroughTheOrdinaryRemoveRoute()
    {
        using var server = StartServer();
        var (console, _) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["setup", "--without", "hosty.marketplace"], console);

        Assert.Equal(0, exitCode);
        var remove = Assert.Single(server.Requests, request => request.Path == "/control/v1/apps/hosty.marketplace/remove");
        Assert.Equal("POST", remove.Method);
        Assert.Contains("\"deleteData\":false", remove.Body.Replace(" ", "", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Setup_DeleteData_PassesTheFlagThrough()
    {
        using var server = StartServer();
        var (console, _) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(
            ["setup", "--without", "hosty.marketplace", "--delete-data"], console);

        Assert.Equal(0, exitCode);
        var remove = Assert.Single(server.Requests, request => request.Path == "/control/v1/apps/hosty.marketplace/remove");
        Assert.Contains("\"deleteData\":true", remove.Body.Replace(" ", "", StringComparison.Ordinal));
    }

    [Fact]
    public async Task Setup_Yes_WithNoDifference_ChangesNothing()
    {
        using var server = StartServer();
        var (console, _) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["setup", "--yes"], console);

        Assert.Equal(0, exitCode);
        // Confirming the state a host is already in is not a reason to reinstall or remove anything.
        Assert.All(server.Requests, request => Assert.Equal("GET", request.Method));
    }

    [Fact]
    public async Task Setup_FailedInstall_ReportsAndExitsNonZero()
    {
        using var server = StartServer((method, path) => method == "POST"
            ? (HttpStatusCode.BadRequest, """{"code":"bootstrap_install_failed","message":"manifest unreachable"}""")
            : (HttpStatusCode.OK, CatalogState));
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["setup", "--with", "hosty.telemetry"], console);

        Assert.Equal(1, exitCode);
        Assert.Contains("hosty.telemetry", output.ToString());
    }

    [Fact]
    public async Task Setup_UnknownAppId_FailsListingKnownIds()
    {
        using var server = StartServer();
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["setup", "--with", "hosty.unknown"], console);

        Assert.Equal(2, exitCode);
        Assert.Contains("Unknown app id 'hosty.unknown'", output.ToString());
        Assert.Contains("hosty.shell", output.ToString());
    }

    [Fact]
    public async Task Setup_ConflictingWithAndWithout_FailsWithUsage()
    {
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(
            ["setup", "--with", "hosty.telemetry", "--without", "hosty.telemetry"], console);

        Assert.Equal(2, exitCode);
        Assert.Contains("appears in both", output.ToString());
    }

    [Fact]
    public async Task Setup_WithoutRunningCore_AsksForCoreStart()
    {
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["setup", "--yes"], console);

        Assert.Equal(1, exitCode);
        Assert.Contains("hosty core start", output.ToString());
    }

    [Fact]
    public async Task Setup_WithoutFlagsOnNonInteractiveConsole_FailsWithUsage()
    {
        using var server = StartServer();
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["setup"], console);

        Assert.Equal(2, exitCode);
        Assert.Contains("Interactive setup needs a terminal", output.ToString());
    }

    private FakeCoreServer StartServer(Func<string, string, (HttpStatusCode Status, string Body)>? handler = null)
    {
        var server = new FakeCoreServer(handler ?? ((_, _) => (HttpStatusCode.OK, CatalogState)));
        var runDirectory = Path.Combine(rootDirectory, "core", "run");
        Directory.CreateDirectory(runDirectory);
        File.WriteAllText(
            Path.Combine(runDirectory, "control.json"),
            JsonSerializer.Serialize(new { controlBaseUrl = server.ControlBaseUrl }));
        return server;
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

    public void Dispose()
    {
        Environment.SetEnvironmentVariable(RootVariable, previousRoot);

        if (Directory.Exists(rootDirectory))
        {
            Directory.Delete(rootDirectory, recursive: true);
        }
    }

    internal sealed record RecordedRequest(string Method, string Path, string Body);

    // Serves requests until disposed: setup issues several per run (load state, act, reload state).
    private sealed class FakeCoreServer : IDisposable
    {
        private readonly TcpListener listener;
        private readonly Func<string, string, (HttpStatusCode Status, string Body)> handler;
        private readonly List<RecordedRequest> requests = [];
        private readonly Lock gate = new();
        private volatile bool stopped;

        public FakeCoreServer(Func<string, string, (HttpStatusCode Status, string Body)> handler)
        {
            this.handler = handler;
            listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            ControlBaseUrl = $"http://127.0.0.1:{port}/control/v1";
            _ = Task.Run(ServeAsync);
        }

        public string ControlBaseUrl { get; }

        public IReadOnlyList<RecordedRequest> Requests
        {
            get
            {
                lock (gate)
                {
                    return requests.ToArray();
                }
            }
        }

        public void Dispose()
        {
            stopped = true;
            listener.Stop();
        }

        private async Task ServeAsync()
        {
            while (!stopped)
            {
                try
                {
                    using var client = await listener.AcceptTcpClientAsync();
                    await HandleAsync(client);
                }
                catch (Exception ex) when (ex is ObjectDisposedException or InvalidOperationException or SocketException or IOException)
                {
                    return;
                }
            }
        }

        private async Task HandleAsync(TcpClient client)
        {
            await using var stream = client.GetStream();
            using var reader = new StreamReader(stream, Encoding.UTF8, detectEncodingFromByteOrderMarks: false, bufferSize: 4096, leaveOpen: true);
            var requestLine = await reader.ReadLineAsync() ?? "";
            var requestParts = requestLine.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            var method = requestParts.ElementAtOrDefault(0) ?? "";
            var path = requestParts.ElementAtOrDefault(1) ?? "";

            var contentLength = 0;
            string? line;
            while (!string.IsNullOrEmpty(line = await reader.ReadLineAsync()))
            {
                var separator = line.IndexOf(':', StringComparison.Ordinal);
                if (separator > 0 &&
                    line[..separator].Trim().Equals("Content-Length", StringComparison.OrdinalIgnoreCase))
                {
                    _ = int.TryParse(line[(separator + 1)..].Trim(), out contentLength);
                }
            }

            var body = "";
            if (contentLength > 0)
            {
                var buffer = new char[contentLength];
                var read = 0;
                while (read < contentLength)
                {
                    var chunk = await reader.ReadAsync(buffer.AsMemory(read, contentLength - read));
                    if (chunk == 0)
                    {
                        break;
                    }

                    read += chunk;
                }

                body = new string(buffer, 0, read);
            }

            lock (gate)
            {
                requests.Add(new RecordedRequest(method, path, body));
            }

            var (status, responseBody) = handler(method, path);
            var payload = Encoding.UTF8.GetBytes(responseBody);
            var header = Encoding.ASCII.GetBytes(
                $"HTTP/1.1 {(int)status} {status}\r\nContent-Type: application/json\r\nContent-Length: {payload.Length}\r\nConnection: close\r\n\r\n");
            await stream.WriteAsync(header);
            await stream.WriteAsync(payload);
        }
    }
}
