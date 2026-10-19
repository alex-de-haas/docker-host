namespace Haas.Hosty.Core;

internal static class WorkspaceInspectionStream
{
    internal static async Task<IResult> RunAsync(string appId, HttpRequest request, HttpResponse response,
        WorkspaceInspectionAuthorization auth, WorkspaceInspectionService inspection, CoreEventHub events,
        IHostApplicationLifetime lifetime, CancellationToken ct)
    {
        using var stopping = CancellationTokenSource.CreateLinkedTokenSource(ct, lifetime.ApplicationStopping);
        ct = stopping.Token;
        try
        {
            var user = await auth.RequireAsync(request, appId, ct);
            // Subscribe before the initial authorized snapshot, so a concurrent change stays queued.
            using var subscription = events.Subscribe(user, false, workspaces: true);
            async Task<HashSet<string>> AllowedAsync()
                => (await inspection.ListAsync(user, ct)).Workspaces.SelectMany(w => w.Worktrees).Select(w => w.Id).ToHashSet(StringComparer.Ordinal);
            var allowed = await AllowedAsync();
            response.ContentType = "text/event-stream";
            response.Headers.CacheControl = "no-store";
            response.Headers["X-Accel-Buffering"] = "no";
            await response.WriteAsync("event: stream.ready\ndata: {}\n\n", ct);
            await response.Body.FlushAsync(ct);
            long dropped = subscription.Dropped;
            while (!ct.IsCancellationRequested)
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeout.CancelAfter(TimeSpan.FromSeconds(20));
                var heartbeat = false;
                try { if (!await subscription.Reader.WaitToReadAsync(timeout.Token)) break; }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested) { heartbeat = true; }
                if (await auth.RequireAsync(request, appId, ct) != user) break;
                var current = await AllowedAsync();
                var changed = !current.SetEquals(allowed) || subscription.Dropped != dropped;
                dropped = subscription.Dropped;
                while (subscription.Reader.TryRead(out var envelope))
                    if (envelope.Name == CoreEventHub.WorkspaceChanged
                        && (envelope.Data == "*" || current.Contains(envelope.Data) || allowed.Contains(envelope.Data))) changed = true;
                allowed = current;
                // No workspace IDs/source payloads cross the stream. Every snapshot read revalidates access.
                if (changed) await response.WriteAsync("event: workspace.changed\ndata: {}\n\n", ct);
                else if (heartbeat) await response.WriteAsync("event: stream.ping\ndata: {}\n\n", ct);
                await response.Body.FlushAsync(ct);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (AppIdentityException ex)
        {
            if (!response.HasStarted) return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), AuthEndpoints.MapIdentityErrorStatus(ex.Code));
            await response.WriteAsync("event: stream.revoked\ndata: {}\n\n", ct);
        }
        catch (AppLifecycleException ex)
        {
            if (!response.HasStarted) return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), 403);
            await response.WriteAsync("event: stream.revoked\ndata: {}\n\n", ct);
        }
        return Results.Empty;
    }
}
