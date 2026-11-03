namespace Haas.Hosty.Core;

// Private invalidation hints only. Reads remain authoritative on entry, reconnect and each change.
internal static class CoreDecisionStream
{
    internal static async Task<IResult> RunAsync(HttpContext ctx, CoreEventHub events, IHostApplicationLifetime lifetime)
    {
        using var stopping = CancellationTokenSource.CreateLinkedTokenSource(ctx.RequestAborted, lifetime.ApplicationStopping);
        var ct = stopping.Token;
        var response = ctx.Response;
        try
        {
            var caller = await CoreDecisionEndpoints.Caller(ctx, CoreAppPermissions.DecisionsRead);
            using var subscription = events.Subscribe(caller.User.Id, false);
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
                try { if (!await subscription.Reader.WaitToReadAsync(timeout.Token)) break; }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested) { }
                var current = await CoreDecisionEndpoints.Caller(ctx, CoreAppPermissions.DecisionsRead);
                if (current.User.Id != caller.User.Id || current.PrincipalId != caller.PrincipalId) break;
                var changed = subscription.Dropped != dropped;
                dropped = subscription.Dropped;
                while (subscription.Reader.TryRead(out var message))
                    changed |= message.Name == "decisions.changed";
                await response.WriteAsync(changed ? "event: decisions.changed\ndata: {}\n\n" : ": keep-alive\n\n", ct);
                await response.Body.FlushAsync(ct);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (SandboxException error)
        {
            if (!response.HasStarted) return CoreJson.Json(new ErrorResponse(error.Code, error.Message), error.Status);
            await response.WriteAsync("event: stream.revoked\ndata: {}\n\n", ct);
        }
        catch (AppIdentityException error)
        {
            if (!response.HasStarted) return CoreJson.Json(new ErrorResponse(error.Code, error.Message), AuthEndpoints.MapIdentityErrorStatus(error.Code));
            await response.WriteAsync("event: stream.revoked\ndata: {}\n\n", ct);
        }
        catch (AppLifecycleException error)
        {
            if (!response.HasStarted) return CoreJson.Json(new ErrorResponse(error.Code, error.Message), 403);
            await response.WriteAsync("event: stream.revoked\ndata: {}\n\n", ct);
        }
        return Results.Empty;
    }
}
