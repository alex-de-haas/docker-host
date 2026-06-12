using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using Haas.Hosty.Cli.Commands;
using Haas.Hosty.Cli.Configuration;
using Spectre.Console;

namespace Haas.Hosty.Cli.Tests.Commands;

public sealed class CoreControlClientTests : IDisposable
{
    private const string RootVariable = "HOSTY_HOME";
    private readonly string? previousRoot;
    private readonly string rootDirectory;

    public CoreControlClientTests()
    {
        previousRoot = Environment.GetEnvironmentVariable(RootVariable);
        rootDirectory = Path.Combine(Path.GetTempPath(), $"hosty-core-control-client-tests-{Guid.NewGuid():N}");
        Environment.SetEnvironmentVariable(RootVariable, rootDirectory);
    }

    [Fact]
    public async Task GetAsync_CoreDoesNotRespondWithinProbeTimeout_ThrowsCoreControlTimeoutException()
    {
        using var server = new SilentServer();
        WriteCoreDiscovery(server.ControlBaseUrl);

        using var client = await CoreControlClient.TryCreateAsync(
            CreateContext(),
            probeTimeout: TimeSpan.FromMilliseconds(250),
            operationTimeout: TimeSpan.FromMilliseconds(250));
        Assert.NotNull(client);

        var exception = await Assert.ThrowsAsync<CoreControlTimeoutException>(
            () => client!.GetAsync<object>("core/status"));

        Assert.Equal("GET", exception.Method);
        Assert.Contains("core/status", exception.Message);
        Assert.IsAssignableFrom<TaskCanceledException>(exception);
    }

    [Fact]
    public async Task GetAsync_CallerCancellation_DoesNotMapToTimeout()
    {
        using var server = new SilentServer();
        WriteCoreDiscovery(server.ControlBaseUrl);

        using var client = await CoreControlClient.TryCreateAsync(CreateContext());
        Assert.NotNull(client);
        using var cancellation = new CancellationTokenSource();
        await cancellation.CancelAsync();

        var exception = await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => client!.GetAsync<object>("core/status", cancellation.Token));

        Assert.IsNotType<CoreControlTimeoutException>(exception);
    }

    [Theory]
    [InlineData(10 * 60, "POST apps/com.haas.demo-app/start did not complete within 10 minutes.")]
    [InlineData(10, "POST apps/com.haas.demo-app/start did not complete within 10 seconds.")]
    public void CoreControlTimeoutException_FormatsTimeoutInMessage(int timeoutSeconds, string expectedMessage)
    {
        var exception = new CoreControlTimeoutException("POST", "apps/com.haas.demo-app/start", TimeSpan.FromSeconds(timeoutSeconds));

        Assert.Equal(expectedMessage, exception.Message);
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable(RootVariable, previousRoot);

        if (Directory.Exists(rootDirectory))
        {
            Directory.Delete(rootDirectory, recursive: true);
        }
    }

    private CommandContext CreateContext()
    {
        var console = AnsiConsole.Create(new AnsiConsoleSettings
        {
            Out = new AnsiConsoleOutput(new StringWriter()),
            Interactive = InteractionSupport.No,
        });
        var environment = HostyEnvironment.Current();
        return new CommandContext(console, environment, new LaunchSettingsStore(environment));
    }

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

    private sealed class SilentServer : IDisposable
    {
        private readonly TcpListener listener;

        public SilentServer()
        {
            listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            ControlBaseUrl = $"http://127.0.0.1:{port}/control/v1";
        }

        public string ControlBaseUrl { get; }

        public void Dispose()
        {
            listener.Stop();
        }
    }
}
