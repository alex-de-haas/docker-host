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

    [Fact]
    public async Task StartAsync_LiveRootWithDifferentPort_IsRefusedNamingTheLiveInstance()
    {
        // The root's discovery names a live Core (this test process's PID) on port 7070; a second
        // start asking for another port is a second instance on the same root and must be refused
        // by NAMING the live instance — not by binding, and not with a bare bind error.
        WriteCoreDiscovery("http://127.0.0.1:7070/control/v1", processId: Environment.ProcessId);
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["core", "start", "--port", "9999"], console);

        Assert.Equal(1, exitCode);
        var text = output.ToString();
        Assert.Contains("already running for data root", text);
        Assert.Contains($"PID {Environment.ProcessId}", text);
        Assert.Contains("http://127.0.0.1:7070", text);
        Assert.Contains("refused", text);
    }

    [Fact]
    public async Task StartAsync_LiveRootWithSamePortDifferentUrl_IsRefusedNotReusedIdempotently()
    {
        // The requested binding differs from the live one in host, not port; reporting an
        // idempotent reuse would silently drop the request.
        WriteCoreDiscovery("http://127.0.0.1:7070/control/v1", processId: Environment.ProcessId);
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["core", "start", "--url", "http://0.0.0.0:7070"], console);

        Assert.Equal(1, exitCode);
        var text = output.ToString();
        Assert.Contains("already running for data root", text);
        Assert.Contains("refused", text);
        Assert.Contains("http://0.0.0.0:7070", text);
    }

    [Fact]
    public async Task StartAsync_ContradictoryPortAndUrl_IsAUsageError()
    {
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["core", "start", "--port", "7070", "--url", "http://localhost:9999"], console);

        Assert.Equal(2, exitCode);
        Assert.Contains("contradicts", output.ToString());
    }

    [Fact]
    public async Task StartAsync_LiveRootWithoutConflictingIntent_ReportsAlreadyRunning()
    {
        using var server = new FakeCoreServer(
            HttpStatusCode.OK,
            """{"status":"running","component":"hosty-core","dataRoot":"/tmp/hosty","listenUrl":"http://127.0.0.1:7070","corePort":7070,"warnings":[]}""");
        WriteCoreDiscovery(server.ControlBaseUrl, processId: Environment.ProcessId);
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["core", "start"], console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.Equal("GET", server.Method);
        Assert.Equal("/control/v1/core/status", server.PathAndQuery);
        Assert.Contains("already running", output.ToString());
    }

    private const string SettingsResponse =
        """
        {"settings":[{"key":"HOSTY_CORE_PORT","type":"number","value":"7171","default":"7070","group":"Core process","label":"Listen port","description":"The port.","overridden":true}]}
        """;

    [Fact]
    public async Task CoreSettingsGet_ReadsTheRowOverTheControlPlane()
    {
        using var server = new FakeCoreServer(HttpStatusCode.OK, SettingsResponse);
        WriteCoreDiscovery(server.ControlBaseUrl, processId: Environment.ProcessId);
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["core", "settings", "get", "HOSTY_CORE_PORT"], console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.Equal("GET", server.Method);
        Assert.Equal("/control/v1/settings", server.PathAndQuery);
        Assert.Equal("test-secret", server.Headers["X-Hosty-Test-Control"]);
        Assert.Contains("7171", output.ToString());
    }

    [Fact]
    public async Task CoreSettingsSet_PutsTheUpdateOverTheControlPlane()
    {
        using var server = new FakeCoreServer(HttpStatusCode.OK, SettingsResponse);
        WriteCoreDiscovery(server.ControlBaseUrl, processId: Environment.ProcessId);
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["core", "settings", "set", "HOSTY_CORE_PORT", "7171"], console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.Equal("PUT", server.Method);
        Assert.Equal("/control/v1/settings", server.PathAndQuery);
        Assert.Contains("\"HOSTY_CORE_PORT\":\"7171\"", server.Body);
        // The port note: the change applies on the next start, and the operator should know.
        Assert.Contains("next Core start", output.ToString());
    }

    [Fact]
    public async Task CoreSettingsReset_SendsANullValueToClearTheOverride()
    {
        using var server = new FakeCoreServer(HttpStatusCode.OK, SettingsResponse);
        WriteCoreDiscovery(server.ControlBaseUrl, processId: Environment.ProcessId);
        var (console, _) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["core", "settings", "reset", "HOSTY_CORE_PORT"], console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.Equal("PUT", server.Method);
        Assert.Contains("\"HOSTY_CORE_PORT\":null", server.Body);
    }

    [Fact]
    public async Task CoreSettings_WithoutARunningCore_FailsWithTheCoreDownMessage()
    {
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["core", "settings", "list"], console);

        // The settings live in the addressed instance, so a down Core is an environment state
        // (exit 1), not a usage error.
        Assert.Equal(1, exitCode);
        Assert.Contains("not running", output.ToString());
    }

    [Fact]
    public void BuildCoreEnvironment_PassesOnlyTheDataRootByDefault()
    {
        // The CLI stops computing or owning the port and stops injecting the public origin: Core
        // resolves the port itself (flag/env → the root's stored value → 7070) and reads
        // HOSTY_CORE_PUBLIC_ORIGIN as a plain ambient env var. Only the resolved data root is pinned
        // so the spawned Core lands on the environment this CLI addresses.
        var environment = HostyEnvironment.Current();
        var (console, _) = CreateConsole();
        var command = new CoreCommand(new CommandContext(console, environment));

        var coreEnvironment = command.BuildCoreEnvironment(new CoreCommand.StartOptions(null, null, false));

        Assert.Equal(environment.RootDirectory, coreEnvironment["HOSTY_DATA_ROOT"]);
        Assert.DoesNotContain("HOSTY_CORE_PORT", coreEnvironment.Keys);
        Assert.DoesNotContain("HOSTY_CORE_URL", coreEnvironment.Keys);
        Assert.DoesNotContain("HOSTY_CORE_PUBLIC_ORIGIN", coreEnvironment.Keys);
        Assert.DoesNotContain("HOSTY_SHELL_MANIFEST_PATH", coreEnvironment.Keys);
        Assert.DoesNotContain("HOSTY_COLLECTOR_MANIFEST_PATH", coreEnvironment.Keys);
        Assert.DoesNotContain("HOSTY_MARKETPLACE_MANIFEST_PATH", coreEnvironment.Keys);
        Assert.DoesNotContain("HOSTY_SHELL_BOOTSTRAP_RUNTIME", coreEnvironment.Keys);
    }

    [Fact]
    public void BuildCoreEnvironment_ForwardsPortAndUrlAsThisRunOverrides()
    {
        var environment = HostyEnvironment.Current();
        var (console, _) = CreateConsole();
        var command = new CoreCommand(new CommandContext(console, environment));

        var coreEnvironment = command.BuildCoreEnvironment(
            new CoreCommand.StartOptions(null, "http://localhost:7171", false, Port: 7171));

        Assert.Equal("7171", coreEnvironment["HOSTY_CORE_PORT"]);
        Assert.Equal("http://localhost:7171", coreEnvironment["HOSTY_CORE_URL"]);
        Assert.Equal("http://localhost:7171", coreEnvironment["ASPNETCORE_URLS"]);
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

        public string Body { get; private set; } = "";

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

                if (Headers.TryGetValue("Content-Length", out var rawLength) &&
                    int.TryParse(rawLength, out var contentLength) &&
                    contentLength > 0)
                {
                    // Chars == bytes for the ASCII JSON these tests send; enough to assert on the payload.
                    var buffer = new char[contentLength];
                    var read = 0;
                    while (read < contentLength)
                    {
                        var chunk = await reader.ReadAsync(buffer.AsMemory(read, contentLength - read));
                        if (chunk <= 0)
                        {
                            break;
                        }

                        read += chunk;
                    }

                    Body = new string(buffer, 0, read);
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
