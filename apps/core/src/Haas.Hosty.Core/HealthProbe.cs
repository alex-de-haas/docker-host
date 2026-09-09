using System.Net.Http;
using System.Net.Security;
using System.Net.Sockets;

namespace Haas.Hosty.Core;

// Active health probe target resolved from a service's healthcheck and its assigned host port.
// `Type` is "http", "https" or "tcp"; `Path` is only meaningful for http(s). `AnyResponse` turns an http probe
// into a readiness probe: any HTTP response at all passes, a 401 or a 404 included, because those
// are a server that is up — the 2xx/3xx rule is a *health* rule. Readiness uses it for a docker
// service with no HEALTHCHECK (app-readiness): a tcp connect through docker's userland proxy succeeds
// the moment the port is published, six seconds before the container listens on this host, so only
// a request the container itself has to answer says anything.
internal sealed record HealthProbeTarget(string Type, string Host, int Port, string Path, TimeSpan Timeout, bool AnyResponse = false);

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

    // For an https target. The certificate is not validated: this is a loopback readiness probe of
    // the app's own listener, which is as likely as not to present a self-signed certificate, and the
    // question is "does it answer", not "do I trust it" — nothing is sent and nothing read is used.
    private readonly HttpClient insecureHttpsClient = new(new SocketsHttpHandler
    {
        AllowAutoRedirect = false,
        ConnectTimeout = TimeSpan.FromSeconds(5),
        SslOptions = new SslClientAuthenticationOptions
        {
            RemoteCertificateValidationCallback = static (_, _, _, _) => true,
        },
    });

    public async Task<bool> ProbeAsync(HealthProbeTarget target, CancellationToken cancellationToken = default)
    {
        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeoutCts.CancelAfter(target.Timeout);
        try
        {
            return target.Type switch
            {
                "http" or "https" => await ProbeHttpAsync(target, timeoutCts.Token),
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
        var uri = new UriBuilder(target.Type, target.Host, target.Port, target.Path).Uri;
        var client = string.Equals(target.Type, "https", StringComparison.Ordinal) ? insecureHttpsClient : httpClient;
        using var response = await client.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        return target.AnyResponse || (int)response.StatusCode is >= 200 and < 400;
    }

    private static async Task<bool> ProbeTcpAsync(HealthProbeTarget target, CancellationToken cancellationToken)
    {
        using var client = new TcpClient();
        await client.ConnectAsync(target.Host, target.Port, cancellationToken);
        return client.Connected;
    }
}
