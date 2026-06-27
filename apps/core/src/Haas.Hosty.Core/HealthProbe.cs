using System.Net.Http;
using System.Net.Sockets;

namespace Haas.Hosty.Core;

// Active health probe target resolved from a service's healthcheck and its assigned host port.
// `Type` is "http" or "tcp"; `Path` is only meaningful for http.
internal sealed record HealthProbeTarget(string Type, string Host, int Port, string Path, TimeSpan Timeout);

// Performs an active health probe (Phase 1c-ii). Used by runtimes without a container HEALTHCHECK
// mechanism (localCommand) to turn a declared http/tcp check into a healthy/unhealthy signal.
internal interface IHealthProbe
{
    Task<bool> ProbeAsync(HealthProbeTarget target, CancellationToken cancellationToken = default);
}

// HTTP GET (2xx/3xx = healthy) / TCP connect (connected = healthy) probe. Every failure — refused
// connection, timeout, non-success status — reads as unhealthy; the probe never throws, since a
// failed probe is itself the signal. AOT-safe: plain HttpClient/TcpClient, no reflection.
internal sealed class NetworkHealthProbe : IHealthProbe
{
    private readonly HttpClient httpClient = new(new SocketsHttpHandler
    {
        AllowAutoRedirect = false,
        ConnectTimeout = TimeSpan.FromSeconds(5),
    });

    public async Task<bool> ProbeAsync(HealthProbeTarget target, CancellationToken cancellationToken = default)
    {
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(target.Timeout);
        try
        {
            return target.Type switch
            {
                "http" => await ProbeHttpAsync(target, timeoutCts.Token),
                "tcp" => await ProbeTcpAsync(target, timeoutCts.Token),
                _ => false,
            };
        }
        // A failed probe is itself the unhealthy signal, so swallow everything a malformed target or a
        // transport failure can throw — bad host/path (UriFormatException), bad port
        // (ArgumentException/ArgumentOutOfRangeException), HttpClient misuse (InvalidOperationException),
        // and the usual network/timeout faults — rather than letting it escape into the supervisor tick.
        catch (Exception ex) when (ex is HttpRequestException or SocketException or IOException
            or OperationCanceledException or UriFormatException or InvalidOperationException or ArgumentException)
        {
            return false;
        }
    }

    private async Task<bool> ProbeHttpAsync(HealthProbeTarget target, CancellationToken cancellationToken)
    {
        var uri = new UriBuilder("http", target.Host, target.Port, target.Path).Uri;
        using var response = await httpClient.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        return (int)response.StatusCode is >= 200 and < 400;
    }

    private static async Task<bool> ProbeTcpAsync(HealthProbeTarget target, CancellationToken cancellationToken)
    {
        using var client = new TcpClient();
        await client.ConnectAsync(target.Host, target.Port, cancellationToken);
        return client.Connected;
    }
}
