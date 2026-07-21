using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Haas.Hosty.Cli;
using Spectre.Console;

namespace Haas.Hosty.Cli.Tests.Commands;

public sealed class StorageCommandTests : IDisposable
{
    private const string RootVariable = "HOSTY_HOME";
    private const string ListResponse = """
        {
          "mounts": [
            { "name": "media", "hostPath": "/srv/media", "mode": "ro", "description": "Catalog", "usedBy": 3 }
          ]
        }
        """;

    private const string MissingPathResponse = """
        {
          "mounts": [
            { "name": "media", "hostPath": "/srv/typo", "mode": "rw", "description": null, "usedBy": 0, "hostPathExists": false }
          ]
        }
        """;

    private readonly string? previousRoot;
    private readonly string rootDirectory;

    public StorageCommandTests()
    {
        previousRoot = Environment.GetEnvironmentVariable(RootVariable);
        rootDirectory = Path.Combine(Path.GetTempPath(), $"hosty-storage-command-tests-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable(RootVariable, rootDirectory);
    }

    [Fact]
    public async Task AddAsync_SendsUpsertRequest()
    {
        using var server = new FakeCoreServer(ListResponse);
        WriteCoreDiscovery(server);
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync([
            "storage",
            "add",
            "media",
            "/srv/media",
            "--mode",
            "ro",
            "--description",
            "Catalog",
        ], console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.Equal("POST", server.Method);
        Assert.Equal("/control/v1/global-mounts", server.PathAndQuery);
        using var body = JsonDocument.Parse(server.Body);
        Assert.Equal("media", body.RootElement.GetProperty("name").GetString());
        Assert.Equal("/srv/media", body.RootElement.GetProperty("hostPath").GetString());
        Assert.Equal("ro", body.RootElement.GetProperty("mode").GetString());
        Assert.Equal("Catalog", body.RootElement.GetProperty("description").GetString());
        Assert.Contains("media", output.ToString());
    }

    [Fact]
    public async Task ListAsync_RendersRegistry()
    {
        using var server = new FakeCoreServer(ListResponse);
        WriteCoreDiscovery(server);
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["storage", "list"], console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.Equal("GET", server.Method);
        Assert.Equal("/control/v1/global-mounts", server.PathAndQuery);
        var rendered = output.ToString();
        Assert.Contains("media", rendered);
        Assert.Contains("/srv/media", rendered);
    }

    [Fact]
    public async Task AddAsync_WarnsWhenCoreReportsTheHostPathIsMissing()
    {
        using var server = new FakeCoreServer(MissingPathResponse);
        WriteCoreDiscovery(server);
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["storage", "add", "media", "/srv/typo"], console);
        await server.WaitForRequestAsync();

        // Advisory only: the mount is saved (exit 0) because the drive may simply not be attached yet.
        Assert.Equal(0, exitCode);
        var rendered = output.ToString();
        Assert.Contains("saved:", rendered);
        Assert.Contains("warning:", rendered);
        Assert.Contains("/srv/typo", rendered);
    }

    [Fact]
    public async Task AddAsync_SurvivesAResponseWithoutAMountsCollection()
    {
        // The deserializer does not enforce the non-nullable contract on Mounts, so a response missing the
        // property must not crash the command after the mount was already saved.
        using var server = new FakeCoreServer("{ }");
        WriteCoreDiscovery(server);
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["storage", "add", "media", "/srv/media"], console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.Contains("saved:", output.ToString());
    }

    [Fact]
    public async Task ListAsync_MarksAMissingHostPath()
    {
        using var server = new FakeCoreServer(MissingPathResponse);
        WriteCoreDiscovery(server);
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["storage", "list"], console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.Contains("(missing)", output.ToString());
    }

    [Fact]
    public async Task ListAsync_DoesNotMarkPathsWhenCoreOmitsThePresenceField()
    {
        // ListResponse predates hostPathExists; an older Core must not make every path read as missing.
        using var server = new FakeCoreServer(ListResponse);
        WriteCoreDiscovery(server);
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["storage", "list"], console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.DoesNotContain("(missing)", output.ToString());
    }

    [Fact]
    public async Task RemoveAsync_SendsForceQuery()
    {
        using var server = new FakeCoreServer("""{ "mounts": [] }""");
        WriteCoreDiscovery(server);
        var (console, _) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["storage", "rm", "media", "--force"], console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.Equal("DELETE", server.Method);
        Assert.Equal("/control/v1/global-mounts/media?force=true", server.PathAndQuery);
    }

    [Fact]
    public async Task AddAsync_RejectsMissingHostPathBeforeCallingCore()
    {
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["storage", "add", "media"], console);

        Assert.Equal(2, exitCode);
        Assert.Contains("<name> and <host-path>", output.ToString());
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

        public string Body { get; private set; } = "";

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

                var contentLength = 0;
                string? line;
                while (!string.IsNullOrEmpty(line = await reader.ReadLineAsync()))
                {
                    var separator = line.IndexOf(':', StringComparison.Ordinal);
                    if (separator <= 0)
                    {
                        continue;
                    }

                    var key = line[..separator].Trim();
                    var value = line[(separator + 1)..].Trim();
                    if (string.Equals(key, "Content-Length", StringComparison.OrdinalIgnoreCase))
                    {
                        _ = int.TryParse(value, out contentLength);
                    }
                }

                if (contentLength > 0)
                {
                    var buffer = new char[contentLength];
                    var offset = 0;
                    while (offset < contentLength)
                    {
                        var read = await reader.ReadAsync(buffer.AsMemory(offset, contentLength - offset));
                        if (read == 0)
                        {
                            break;
                        }

                        offset += read;
                    }

                    Body = new string(buffer, 0, offset);
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
