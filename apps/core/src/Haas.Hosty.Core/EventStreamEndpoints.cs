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
                var topics = request.Query["topics"].ToString().Split(',');
                var sandboxes = topics.Contains("sandboxes", StringComparer.Ordinal);
                var resources = topics.Contains("resources", StringComparer.Ordinal);
                var toolActivity = topics.Contains("tool-activity", StringComparer.Ordinal);
                var workspaces = topics.Contains("workspaces", StringComparer.Ordinal);
                if ((resources || workspaces || sandboxes) && !AppAccessPolicy.IsAdmin(user))
                    return CoreJson.Json(new ErrorResponse("admin_required", "Resource, workspace and sandbox subscriptions require a Host administrator."), 403);
                if (workspaces && AppManagementAuthorization.RequireAdditional(request, CoreAppPermissions.WorkspacesRead) is { } denied)
                    return denied;
                if (sandboxes)
                    foreach (var permission in new[] { CoreAppPermissions.CoreEnvironmentsInspect })
                        if (AppManagementAuthorization.RequireAdditional(request, permission) is { } sandboxDenied) return sandboxDenied;
                // The /api/events delegated policy already requires core.read + apps.read (and
                // notifications), a superset of /api/core/resources. Resolve it again during delivery.
                response.Headers.ContentType = "text/event-stream";
                response.Headers.CacheControl = "no-cache";
                response.Headers["X-Accel-Buffering"] = "no";

                // Every session gets its own notifications; only admins get domain events (see
                // CoreEventHub.PublishAppEvent). The session id rides along so revoking the credential
                // ends this stream immediately instead of at the client's next request.
                using var subscription = events.Subscribe(
                    user.Id,
                    AppAccessPolicy.IsAdmin(user),
                    CoreSessionAuthorization.ReadSessionId(request), resources, workspaces, toolActivity, sandboxes);
                using var streamCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, applicationStopping);
                var streamToken = streamCts.Token;
                var inspection = workspaces ? request.HttpContext.RequestServices.GetRequiredService<WorkspaceInspectionService>() : null;
                async Task<HashSet<string>> AllowedWorkspacesAsync()
                    => (await inspection!.ListAsync(user.Id, streamToken)).Workspaces.SelectMany(w => w.Worktrees)
                        .Select(w => w.Id).ToHashSet(StringComparer.Ordinal);
                var allowedWorkspaces = workspaces ? await AllowedWorkspacesAsync() : [];

                // End the stream on Core shutdown, not only on client disconnect. Kestrel's graceful
                // stop waits for in-flight requests and an SSE response never completes on its own —
                // one open stream would otherwise hold shutdown for the full
                // HostOptions.ShutdownTimeout and starve the runtime-app stop sweep behind it.
                async Task<bool> IsStillAuthorizedAsync()
                {
                    if (!subscription.IsActive) return false;
                    if (AppManagementAuthorization.Caller(request) is null)
                    {
                        var currentUser = await CoreSessionAuthorization.RevalidateSessionAsync(request, users, clock, streamToken);
                        return currentUser?.Id == user.Id && currentUser.Role == user.Role;
                    }
                    var current = await AppManagementAuthorization.ResolveAsync(request, streamToken);
                    // A subscription captures its audience at creation. End it when the role changes,
                    // even if the user can still access the calling app, before delivering queued data.
                    return current.Error is null && current.Caller?.User.Role == user.Role &&
                        (!workspaces || current.Caller is { } caller && AppManagementAuthorization.HasPermission(caller.App, CoreAppPermissions.WorkspacesRead)) &&
                        (!sandboxes || current.Caller is { } sandboxCaller &&
                            AppManagementAuthorization.HasPermission(sandboxCaller.App, CoreAppPermissions.CoreEnvironmentsInspect));
                }

                long sandboxRevision = 0;
                string? lastSandboxData = null;
                async Task WriteSandboxesAsync()
                {
                    if (!sandboxes || sandboxRevision == subscription.SandboxRevision) return;
                    var revision = subscription.SandboxRevision;
                    var snapshot = await SandboxStreamSnapshot.ReadAsync(request.HttpContext.RequestServices, user.Id, streamToken);
                    // Projection may await storage/source checks: revalidate before releasing its data.
                    if (!await IsStillAuthorizedAsync()) { subscription.Complete(); return; }
                    var data = CoreJson.Text(snapshot);
                    if (data != lastSandboxData)
                        await response.WriteAsync($"event: sandbox.snapshot\ndata: {data}\n\n", streamToken);
                    lastSandboxData = data;
                    // Retry failed inventories on the normal heartbeat without a browser polling loop.
                    sandboxRevision = snapshot.CoreError is null ? revision : 0;
                }

                try
                {
                    // Emit an initial comment so the whole proxy chain (cloudflared -> Cloudflare edge)
                    // forwards the response start with real body bytes. A header-only flush can be held
                    // back until the first byte and time out as a Cloudflare 524.
                    await response.WriteAsync(": connected\n\n", streamToken);
                    // Older Core ignores the topic query and sends no acknowledgement. New clients
                    // must see this before retiring their legacy hint/GET path.
                    if (resources || workspaces || toolActivity || sandboxes)
                    {
                        var capabilities = new List<string>();
                        if (resources) capabilities.Add("\"resources\":1");
                        if (workspaces) capabilities.Add("\"workspaces\":1");
                        if (toolActivity) capabilities.Add("\"toolActivity\":1");
                        if (sandboxes) capabilities.Add("\"sandboxes\":1");
                        await response.WriteAsync($"event: stream.ready\ndata: {{{string.Join(",", capabilities)}}}\n\n", streamToken);
                    }
                    await WriteSandboxesAsync();
                    await response.Body.FlushAsync(streamToken);

                    while (true)
                    {
                        if (!await IsStillAuthorizedAsync())
                            break;

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
                            await WriteSandboxesAsync();
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
                            if (!await IsStillAuthorizedAsync())
                                return Results.Empty;

                            if (envelope.Name == CoreEventHub.SandboxSnapshot) continue;
                            if (envelope.Name == CoreEventHub.WorkspaceChanged)
                            {
                                if (!workspaces) continue;
                                // Metadata interest does not grant private source access. Recheck the
                                // authorized inventory and emit only a hint, never internal worktree IDs.
                                var currentAllowed = await AllowedWorkspacesAsync();
                                var changed = envelope.Data == "*" || currentAllowed.Contains(envelope.Data) || allowedWorkspaces.Contains(envelope.Data);
                                allowedWorkspaces = currentAllowed;
                                if (changed) await response.WriteAsync("event: workspace.changed\ndata: {}\n\n", streamToken);
                            }
                            else
                            {
                                // Named events stay additive for older clients.
                                await response.WriteAsync($"event: {envelope.Name}\ndata: {envelope.Data}\n\n", streamToken);
                            }
                        }

                        await WriteSandboxesAsync();
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
