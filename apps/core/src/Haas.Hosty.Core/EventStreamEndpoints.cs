namespace Haas.Hosty.Core;

// The single live stream for session clients: domain events (app state, update checks) plus the
// user's notifications, delivered as named SSE events over ONE connection. Browsers cap concurrent
// HTTP/1.1 connections per origin at ~6, so a second dedicated stream would be a per-tab tax for no
// benefit — Shell is the only consumer and it wants both.
//
// Nothing here is durable. Clients resync through the Core API on connect and on every reconnect;
// see CoreEventHub for why that is the whole delivery guarantee.
internal static class EventStreamEndpoints
{
    // Keep-alive cadence well under Cloudflare's ~100s origin-response timeout. The stream is idle
    // most of the time; without periodic bytes an intermediary proxy closes the connection
    // (surfacing as a Cloudflare 524), so we send a comment even when there is nothing to deliver.
    private static readonly TimeSpan StreamHeartbeat = TimeSpan.FromSeconds(20);

    public static void Map(WebApplication app)
    {
        app.MapGet("/api/events", (
            HttpRequest request,
            HttpResponse response,
            UserDirectoryStore users,
            IClock clock,
            CoreEventHub events,
            IHostApplicationLifetime lifetime,
            CancellationToken cancellationToken) =>
            StreamForSessionAsync(
                request, response, users, clock, events, cancellationToken,
                applicationStopping: lifetime.ApplicationStopping));
    }

    public static Task<IResult> StreamForSessionAsync(
        HttpRequest request,
        HttpResponse response,
        UserDirectoryStore users,
        IClock clock,
        CoreEventHub events,
        CancellationToken cancellationToken,
        // Overridable only so tests can exercise the idle keep-alive without waiting the full cadence.
        TimeSpan? heartbeat = null,
        CancellationToken applicationStopping = default)
        => CoreSessionAuthorization.RequireSessionAsync(
            request,
            users,
            clock,
            async user =>
            {
                response.Headers.ContentType = "text/event-stream";
                response.Headers.CacheControl = "no-cache";
                response.Headers["X-Accel-Buffering"] = "no";

                // Every session gets its own notifications; only admins get domain events (see
                // CoreEventHub.PublishAppEvent).
                using var subscription = events.Subscribe(user.Id, AppAccessPolicy.IsAdmin(user));

                // End the stream on Core shutdown, not only on client disconnect. Kestrel's graceful
                // stop waits for in-flight requests and an SSE response never completes on its own —
                // one open stream would otherwise hold shutdown for the full
                // HostOptions.ShutdownTimeout and starve the runtime-app stop sweep behind it.
                using var streamCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, applicationStopping);
                var streamToken = streamCts.Token;

                try
                {
                    // Emit an initial comment so the whole proxy chain (cloudflared -> Cloudflare edge)
                    // forwards the response start with real body bytes. A header-only flush can be held
                    // back until the first byte and time out as a Cloudflare 524.
                    await response.WriteAsync(": connected\n\n", streamToken);
                    await response.Body.FlushAsync(streamToken);

                    while (true)
                    {
                        // Cancel only the read wait (not the request) when the heartbeat elapses, so an
                        // idle stream sends a keep-alive comment instead of stalling past the proxy timeout.
                        using var heartbeatCts = CancellationTokenSource.CreateLinkedTokenSource(streamToken);
                        heartbeatCts.CancelAfter(heartbeat ?? StreamHeartbeat);

                        bool dataAvailable;
                        try
                        {
                            dataAvailable = await subscription.Reader.WaitToReadAsync(heartbeatCts.Token);
                        }
                        catch (OperationCanceledException) when (!streamToken.IsCancellationRequested)
                        {
                            await response.WriteAsync(": ping\n\n", streamToken);
                            await response.Body.FlushAsync(streamToken);
                            continue;
                        }

                        if (!dataAvailable)
                        {
                            break; // Subscription completed (client disposed).
                        }

                        while (subscription.Reader.TryRead(out var envelope))
                        {
                            // Named events: a client subscribes to what it cares about with
                            // addEventListener, and new names are additive for older clients.
                            await response.WriteAsync($"event: {envelope.Name}\ndata: {envelope.Data}\n\n", streamToken);
                        }

                        await response.Body.FlushAsync(streamToken);
                    }
                }
                catch (OperationCanceledException)
                {
                    // Client disconnected or Core is shutting down; end the stream.
                }

                return Results.Empty;
            },
            cancellationToken: cancellationToken);
}
