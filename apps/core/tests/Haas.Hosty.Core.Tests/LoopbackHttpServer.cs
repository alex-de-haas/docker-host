using System.Net;
using System.Net.Sockets;

namespace Haas.Hosty.Core.Tests;

// A real HTTP server on loopback, for the cases a stubbed HttpMessageHandler cannot prove: redirect
// handling (a custom handler never auto-redirects) and health probes (they open their own socket).
//
// HttpListener cannot bind port 0, so a free port has to be probed and then bound — a race the whole
// suite shares, because test classes run in parallel and any of the `TcpListener(IPAddress.Loopback, 0)`
// helpers elsewhere can be handed that port in the window between the probe closing and the bind. Two
// rules keep the race from failing a test that is not about ports at all:
//
//   * Start is retried. Losing a probed port is expected, not a defect in the code under test.
//   * Teardown runs exactly once. Off Windows, HttpListener is the managed implementation, where both
//     Stop() and Dispose() run HttpEndPointManager.RemoveListener over the prefixes — which are never
//     cleared, so doing both runs it twice. The first pass unbinds the socket and drops the port from
//     the manager's static map; the second finds no entry there and *re-binds the port* to build one.
//     That throws "Address already in use" if another test has taken the port meanwhile, and when the
//     taker is another HttpListener it instead quietly removes that listener's prefix registration, so
//     an unrelated test starts seeing 404s from a server it just started.
internal sealed class LoopbackHttpServer : IAsyncDisposable
{
    private const int StartAttempts = 10;
    private static readonly TimeSpan DrainTimeout = TimeSpan.FromSeconds(10);

    private readonly HttpListener _listener;
    private readonly Task _serving;
    private int _stopped;

    private LoopbackHttpServer(HttpListener listener, int port, Func<HttpListenerContext, Task> handler)
    {
        _listener = listener;
        Port = port;
        _serving = ServeAsync(listener, handler);
    }

    public int Port { get; }

    // The handler owns the response body and status; the response is always closed for it.
    public static LoopbackHttpServer Start(Func<HttpListenerContext, Task> handler)
    {
        for (var attempt = 1; ; attempt++)
        {
            int port;
            using (var probe = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp))
            {
                probe.Bind(new IPEndPoint(IPAddress.Loopback, 0));
                port = ((IPEndPoint)probe.LocalEndPoint!).Port;
            }

            var listener = new HttpListener();
            listener.Prefixes.Add($"http://127.0.0.1:{port}/");
            try
            {
                listener.Start();
                return new LoopbackHttpServer(listener, port, handler);
            }
            catch (HttpListenerException) when (attempt < StartAttempts)
            {
                // Someone took the probed port first — release whatever this attempt holds and probe again.
                Teardown(listener);
            }
        }
    }

    // Stops serving and drains the loop. Idempotent, so a test can stop explicitly before its assertions
    // — draining the loop before reading state the handler wrote — and still dispose safely afterwards.
    public async Task StopAsync()
    {
        if (Interlocked.Exchange(ref _stopped, 1) == 0)
        {
            Teardown(_listener);
        }

        // Bounded: GetContextAsync registers its wait without holding the lock that teardown drains, so a
        // loop that calls it in that exact instant is never woken. Fail the test with a timeout rather
        // than hang a CI job on the framework's race.
        await _serving.WaitAsync(DrainTimeout);
    }

    public async ValueTask DisposeAsync() => await StopAsync();

    // Dispose, not Stop: one RemoveListener pass, and the listener is left marked disposed so nothing can
    // trigger a second one. It also faults the pending GetContextAsync, which ends the serving loop —
    // where a Stop()ped listener stays undisposed, so the loop's next GetContextAsync has no disposed
    // state to fail fast on and can instead wait on a socket that is already gone.
    private static void Teardown(HttpListener listener)
    {
        try
        {
            ((IDisposable)listener).Dispose();
        }
        catch (Exception ex) when (ex is HttpListenerException or ObjectDisposedException)
        {
            // Releasing a socket is never a reason for a test to fail.
        }
    }

    private static async Task ServeAsync(HttpListener listener, Func<HttpListenerContext, Task> handler)
    {
        while (true)
        {
            HttpListenerContext context;
            try
            {
                context = await listener.GetContextAsync();
            }
            // Teardown, in its three shapes: the wait aborted, the listener already disposed, or — when
            // this call lands between the listener going quiet and being marked disposed — "not listening".
            catch (Exception ex) when (ex is HttpListenerException or ObjectDisposedException or InvalidOperationException)
            {
                return;
            }

            try
            {
                await handler(context);
            }
            finally
            {
                context.Response.Close();
            }
        }
    }
}
