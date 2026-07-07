using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Haas.Hosty.Cli;
using Spectre.Console;

namespace Haas.Hosty.Cli.Tests.Commands;

public sealed class CatalogCommandTests : IDisposable
{
    private const string RootVariable = "HOSTY_HOME";
    private const string AppsResponse = """
        {
          "apps": [
            { "id": "com.example.notes", "name": "Notes", "summary": "Take notes", "category": "Productivity",
              "tags": ["a"], "icon": null, "publisher": { "name": "Example Co", "url": null, "email": null },
              "sourceName": "catalog.example", "installed": true, "installedVersion": "1.2.0" }
          ]
        }
        """;
    private const string DetailResponse = """
        {
          "id": "com.example.notes", "name": "Notes", "summary": "Take notes", "category": "Productivity",
          "tags": ["a"], "icon": null, "screenshots": [], "publisher": { "name": "Example Co", "url": null, "email": null },
          "sourceName": "catalog.example", "signerIdentity": null, "releasesUrl": "https://feeds.example/notes.json",
          "versions": [ { "version": "1.2.0", "manifestRef": "https://a/1.2.0/manifest.json", "artifact": { "kind": "image", "imageDigest": "sha256:aaa", "commit": null, "ref": null, "bundleHash": null } } ],
          "stableVersion": "1.2.0", "betaVersion": null, "installed": false, "installedVersion": null, "updateAvailable": false
        }
        """;
    private const string SourcesResponse = """
        { "sources": [ { "url": "https://catalog.example/catalog.json", "name": "catalog.example" } ], "managed": true }
        """;

    private readonly string? previousRoot;
    private readonly string rootDirectory;

    public CatalogCommandTests()
    {
        previousRoot = Environment.GetEnvironmentVariable(RootVariable);
        rootDirectory = Path.Combine(Path.GetTempPath(), $"hosty-catalog-command-tests-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable(RootVariable, rootDirectory);
    }

    [Fact]
    public async Task ListAsync_RendersCatalog()
    {
        using var server = new FakeCoreServer(AppsResponse);
        WriteCoreDiscovery(server);
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["catalog", "list"], console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.Equal("GET", server.Method);
        Assert.Equal("/control/v1/catalog/apps", server.PathAndQuery);
        var rendered = output.ToString();
        Assert.Contains("Notes", rendered);
        Assert.Contains("catalog.example", rendered);
    }

    [Fact]
    public async Task ShowAsync_RendersDetailAndVersions()
    {
        using var server = new FakeCoreServer(DetailResponse);
        WriteCoreDiscovery(server);
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["catalog", "show", "com.example.notes"], console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.Equal("GET", server.Method);
        Assert.Equal("/control/v1/catalog/apps/com.example.notes", server.PathAndQuery);
        var rendered = output.ToString();
        Assert.Contains("1.2.0", rendered);
        Assert.Contains("image", rendered);
    }

    [Fact]
    public async Task SourcesListAsync_RendersSources()
    {
        using var server = new FakeCoreServer(SourcesResponse);
        WriteCoreDiscovery(server);
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["catalog", "sources"], console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.Equal("GET", server.Method);
        Assert.Equal("/control/v1/catalog/sources", server.PathAndQuery);
        Assert.Contains("catalog.example", output.ToString());
    }

    [Fact]
    public async Task SourcesAddAsync_SendsUpsertRequest()
    {
        using var server = new FakeCoreServer(SourcesResponse);
        WriteCoreDiscovery(server);
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(
            ["catalog", "sources", "add", "https://catalog.example/catalog.json"],
            console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.Equal("POST", server.Method);
        Assert.Equal("/control/v1/catalog/sources", server.PathAndQuery);
        using var body = JsonDocument.Parse(server.Body);
        Assert.Equal("https://catalog.example/catalog.json", body.RootElement.GetProperty("url").GetString());
        Assert.Contains("added", output.ToString());
    }

    [Fact]
    public async Task SourcesRemoveAsync_SendsUrlQuery()
    {
        using var server = new FakeCoreServer("""{ "sources": [], "managed": true }""");
        WriteCoreDiscovery(server);
        var (console, _) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(
            ["catalog", "sources", "rm", "https://catalog.example/catalog.json"],
            console);
        await server.WaitForRequestAsync();

        Assert.Equal(0, exitCode);
        Assert.Equal("DELETE", server.Method);
        Assert.Equal(
            "/control/v1/catalog/sources?url=https%3A%2F%2Fcatalog.example%2Fcatalog.json",
            server.PathAndQuery);
    }

    [Fact]
    public async Task InstallAsync_RequiresIdBeforeCallingCore()
    {
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["catalog", "install"], console);

        Assert.Equal(2, exitCode);
        Assert.Contains("requires an app id", output.ToString());
    }

    [Fact]
    public async Task ShowAsync_RequiresIdBeforeCallingCore()
    {
        var (console, output) = CreateConsole();

        var exitCode = await CommandLine.RunAsync(["catalog", "show"], console);

        Assert.Equal(2, exitCode);
        Assert.Contains("exactly one argument", output.ToString());
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
