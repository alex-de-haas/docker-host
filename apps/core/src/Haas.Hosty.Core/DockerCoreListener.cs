using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using Microsoft.Extensions.Configuration;

namespace Haas.Hosty.Core;

// Only the native Linux entry point enables this service. Browser origins remain based on the
// original loopback URL; the extra endpoint is a transport for authenticated container requests.
internal sealed class DockerCoreListener(
    IDockerCommandRunner runner,
    DockerListenerConfiguration endpoints,
    ILogger<DockerCoreListener> logger) : IDisposable
{
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly HttpClient http = new(new SocketsHttpHandler { UseProxy = false }) { Timeout = TimeSpan.FromSeconds(2) };
    private string? diagnostic;
    private bool desktop;
    public string? Gateway { get; private set; }

    public static void Configure(WebApplicationBuilder builder, HostyCoreRuntimeConfig config)
    {
        if (!OperatingSystem.IsLinux() || !SupportsAutomaticListener(config.ListenUrl)) return;
        // Do not replace an operator's explicit Kestrel endpoint configuration.
        if (builder.Configuration.GetSection("Kestrel:Endpoints").GetChildren().Any()) return;
        var endpoints = new DockerListenerConfiguration(config.ListenUrl);
        var configuration = new ConfigurationBuilder().Add(endpoints).Build();
        builder.WebHost.ConfigureKestrel(options => options.Configure(configuration, reloadOnChange: true));
        builder.Services.AddSingleton(endpoints);
        builder.Services.AddSingleton<DockerCoreListener>();
    }

    internal static bool SupportsAutomaticListener(string url)
        => Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme == "http" && uri.IsLoopback;

    public async Task RefreshAsync(CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken);
        try
        {
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            deadline.CancelAfter(TimeSpan.FromSeconds(5));
            DockerBridgeDiscovery result;
            try
            {
                result = await DiscoverAsync(runner, LocalBridgeAddresses(),
                    Environment.GetEnvironmentVariable("DOCKER_HOST"),
                    Environment.GetEnvironmentVariable("DOCKER_CONTEXT"), deadline.Token);
            }
            catch (Exception ex) when (ex is DockerUnavailableException or NetworkInformationException or OperationCanceledException)
            {
                cancellationToken.ThrowIfCancellationRequested();
                result = new(null, false, "Docker is unavailable; Core remains accessible locally. Retry when Docker is running.");
            }
            desktop = result.Desktop;
            if (Gateway != result.Gateway)
            {
                Gateway = result.Gateway;
                endpoints.SetGateway(Gateway);
                logger.LogInformation("Core Docker transport listener: {Address}", Gateway ?? "disabled");
            }
            if (diagnostic != result.Diagnostic)
            {
                diagnostic = result.Diagnostic;
                if (diagnostic is not null) logger.LogWarning("{Diagnostic}", diagnostic);
            }
        }
        finally { gate.Release(); }
    }

    public async Task EnsureReadyAsync(CancellationToken cancellationToken)
    {
        await RefreshAsync(cancellationToken);
        if (desktop) return; // Desktop owns its host relay; no Linux host bridge should be bound.
        if (Gateway is not { } gateway)
            throw new AppLifecycleException("docker_core_transport_unavailable", diagnostic ?? "Core's Docker transport is unavailable.");
        // Kestrel reload is asynchronous. Wait for the new endpoint before launching an app that
        // immediately exchanges credentials; do not confuse a scheduled reload with readiness.
        for (var attempt = 0; attempt < 25; attempt++)
        {
            try
            {
                using var response = await http.GetAsync($"http://{gateway}:{endpoints.Port}/healthz", cancellationToken);
                if (response.IsSuccessStatusCode) return;
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
            { cancellationToken.ThrowIfCancellationRequested(); }
            await Task.Delay(200, cancellationToken);
        }
        throw new AppLifecycleException("docker_core_transport_unavailable",
            "Core could not accept requests on the Docker bridge. Check Core logs for the listener error.");
    }

    public void Dispose() { http.Dispose(); gate.Dispose(); }

    // Runs before forwarded headers: containers cannot present a loopback X-Forwarded-For to
    // reach the local CLI interface, even if they somehow obtain a control credential.
    internal static async Task GuardControlAsync(HttpContext context, RequestDelegate next)
    {
        if (context.Connection.LocalIpAddress is { } local && !IPAddress.IsLoopback(local)
            && context.Request.Path.StartsWithSegments("/control", StringComparison.OrdinalIgnoreCase))
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }
        await next(context);
    }

    internal static IReadOnlyDictionary<string, IReadOnlyList<IPAddress>> LocalBridgeAddresses()
        => NetworkInterface.GetAllNetworkInterfaces()
            .Where(n => Directory.Exists($"/sys/class/net/{n.Name}/bridge"))
            .ToDictionary(n => n.Name, n => (IReadOnlyList<IPAddress>)n.GetIPProperties().UnicastAddresses
                .Select(a => a.Address).ToArray(), StringComparer.Ordinal);

    internal static async Task<DockerBridgeDiscovery> DiscoverAsync(IDockerCommandRunner runner,
        IReadOnlyDictionary<string, IReadOnlyList<IPAddress>> localBridges, string? dockerHost,
        string? dockerContext, CancellationToken cancellationToken)
    {
        var endpoint = dockerHost;
        // DOCKER_CONTEXT takes precedence over DOCKER_HOST, just like the Docker CLI.
        if (string.IsNullOrWhiteSpace(endpoint) || !string.IsNullOrWhiteSpace(dockerContext))
        {
            var context = await runner.RunAsync(["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], cancellationToken: cancellationToken);
            if (context.ExitCode != 0) return new(null, false, "Docker context could not be inspected. Start Docker and retry.");
            endpoint = context.StandardOutput.Trim();
        }
        if (!endpoint.StartsWith("unix://", StringComparison.Ordinal))
            return new(null, false, "Automatic local Core transport requires a local Docker daemon. The selected Docker endpoint is remote or uses TCP.");
        var info = await runner.RunAsync(["info", "--format", "{{.OperatingSystem}}|{{json .SecurityOptions}}"], cancellationToken: cancellationToken);
        if (info.ExitCode != 0) return new(null, false, "Docker is unavailable; start Docker and retry.");
        if (info.StandardOutput.Contains("Docker Desktop", StringComparison.OrdinalIgnoreCase)) return new(null, true, null);
        if (info.StandardOutput.Contains("rootless", StringComparison.OrdinalIgnoreCase))
            return new(null, false, "Automatic Core bridge access is not available with rootless Docker. Use a local Docker Engine or Docker Desktop.");
        var network = await runner.RunAsync(["network", "inspect", "bridge", "--format",
            "{{.Driver}}|{{index .Options \"com.docker.network.bridge.name\"}}|{{range .IPAM.Config}}{{.Gateway}} {{end}}"], cancellationToken: cancellationToken);
        if (network.ExitCode != 0) return new(null, false, "Docker's default bridge is unavailable. Retry after Docker has initialized its network.");
        var parts = network.StandardOutput.Trim().Split('|');
        if (parts.Length == 3 && parts[0] == "bridge")
        {
            var name = string.IsNullOrWhiteSpace(parts[1]) || parts[1] == "<no value>" ? "docker0" : parts[1];
            if (localBridges.TryGetValue(name, out var addresses))
                foreach (var value in parts[2].Split(' ', StringSplitOptions.RemoveEmptyEntries))
                    if (IPAddress.TryParse(value, out var address) && address.AddressFamily == AddressFamily.InterNetwork
                        && !IPAddress.IsLoopback(address) && !address.Equals(IPAddress.Any) && addresses.Contains(address))
                        return new(address.ToString(), false, null);
        }
        return new(null, false, "Docker's bridge gateway is not assigned to a local bridge. Core has not opened an additional listener.");
    }
}

internal sealed record DockerBridgeDiscovery(string? Gateway, bool Desktop, string? Diagnostic);

// Replace the complete endpoint dictionary so removing a bridge removes the endpoint rather than
// leaving an empty Url key. Reload leaves the unchanged loopback listener and sessions intact.
internal sealed class DockerListenerConfiguration(string listenUrl) : ConfigurationProvider, IConfigurationSource
{
    public int Port { get; } = new Uri(listenUrl).Port;
    public IConfigurationProvider Build(IConfigurationBuilder builder) { SetGateway(null, notify: false); return this; }
    public void SetGateway(string? gateway, bool notify = true)
    {
        var values = new Dictionary<string, string?>(StringComparer.OrdinalIgnoreCase)
        { ["Endpoints:Local:Url"] = listenUrl };
        if (gateway is not null) values["Endpoints:Docker:Url"] = $"http://{gateway}:{Port}";
        Data = values;
        if (notify) OnReload();
    }
}
