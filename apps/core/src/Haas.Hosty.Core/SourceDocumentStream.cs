namespace Haas.Hosty.Core;

internal static class SourceDocumentStream
{
    internal static async Task<IResult> RunAsync(string appId, HttpRequest request, HttpResponse response,
        SourceDocumentAuthorization auth, SourceDocumentService documents, CoreEventHub events,
        IHostApplicationLifetime lifetime, CancellationToken ct)
    {
        using var stopping = CancellationTokenSource.CreateLinkedTokenSource(ct, lifetime.ApplicationStopping);
        ct = stopping.Token;
        try
        {
            var user = await auth.RequireAsync(request, appId, ct);
            // Subscribe before the initial authorized snapshot, so a concurrent change stays queued.
            using var subscription = events.Subscribe(user, false, workspaces: true);
            var scope = request.Query["repositoryId"].ToString();
            var repositoryId = string.IsNullOrEmpty(scope) ? null : scope;
            var targets = await documents.ObserveTargetsAsync(user, repositoryId, ct);
            var allowed = await documents.AuthorizedWorkspaceRepositoriesAsync(user, repositoryId, ct);
            response.ContentType = "text/event-stream";
            response.Headers.CacheControl = "no-store";
            response.Headers["X-Accel-Buffering"] = "no";
            await response.WriteAsync("event: stream.ready\ndata: {}\n\n", ct);
            await response.Body.FlushAsync(ct);
            long dropped = subscription.Dropped;
            var lastTargetObservation = System.Diagnostics.Stopwatch.GetTimestamp();
            while (!ct.IsCancellationRequested)
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                var remaining = TimeSpan.FromSeconds(30) - System.Diagnostics.Stopwatch.GetElapsedTime(lastTargetObservation);
                timeout.CancelAfter(remaining > TimeSpan.Zero ? remaining : TimeSpan.FromMilliseconds(1));
                var heartbeat = false;
                try { if (!await subscription.Reader.WaitToReadAsync(timeout.Token)) break; }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested) { heartbeat = true; }
                if (await auth.RequireAsync(request, appId, ct) != user) break;
                heartbeat |= System.Diagnostics.Stopwatch.GetElapsedTime(lastTargetObservation) >= TimeSpan.FromSeconds(30);
                var current = await documents.AuthorizedWorkspaceRepositoriesAsync(user, repositoryId, ct);
                var currentTargets = heartbeat ? await documents.ObserveTargetsAsync(user, repositoryId, ct) : targets;
                if (heartbeat) lastTargetObservation = System.Diagnostics.Stopwatch.GetTimestamp();
                var changed = !current.OrderBy(p => p.Key, StringComparer.Ordinal).SequenceEqual(allowed.OrderBy(p => p.Key, StringComparer.Ordinal))
                    || subscription.Dropped != dropped || currentTargets != targets;
                var repositories = new HashSet<string>(StringComparer.Ordinal);
                targets = currentTargets;
                dropped = subscription.Dropped;
                while (subscription.Reader.TryRead(out var envelope))
                {
                    if (envelope.Name != CoreEventHub.WorkspaceChanged) continue;
                    if (envelope.Data == "*") changed = true;
                    else if (current.TryGetValue(envelope.Data, out var repository)) repositories.Add(repository);
                }
                allowed = current;
                // Scoped hints contain only currently authorized repository IDs, never workspace IDs
                // or source bytes. Older clients can still treat any hint as a full invalidation.
                if (changed) await response.WriteAsync("event: source.changed\ndata: {}\n\n", ct);
                else if (repositories.Count > 0)
                {
                    var ids = System.Text.Json.JsonSerializer.Serialize(repositories.Order(StringComparer.Ordinal).ToArray(), CoreJsonSerializerContext.Default.StringArray);
                    await response.WriteAsync("event: source.changed\ndata: {\"repositories\":" + ids + "}\n\n", ct);
                }
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
