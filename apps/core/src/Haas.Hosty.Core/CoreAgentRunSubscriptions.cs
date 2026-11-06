using System.Text.Json;
using HostySdk.App;

namespace Haas.Hosty.Core;

internal sealed record CoreAgentRunSubscriptionCreate(HostyRunRef Run, string? Cursor = null);
internal sealed record CoreAgentRunSourceNotifications(HostyRunRef Run, string? Cursor, int WaitSeconds);
internal sealed record CoreAgentRunSubscription(string Handle, DateTimeOffset ExpiresAt, HostyAgentRunNotification Initial);
internal sealed class CoreAgentRunSubscriptionHandle(CoreCapabilityCaller caller, CoreAgentRunSubscription value)
{
    internal string UserId { get; } = caller.User.Id;
    internal string PrincipalId { get; } = caller.PrincipalId;
    internal CoreAgentRunSubscription Value { get; } = value;
    internal int Connected;
}

/** In-memory, short-lived handles bind a stream to one current user and client. They grant no access. */
internal sealed class CoreAgentRunSubscriptions(CoreAgentSessionAdapter sessions, IClock clock, CoreEventHub events)
{
    private readonly Lock gate = new();
    private readonly Dictionary<string, CoreAgentRunSubscriptionHandle> handles = new(StringComparer.Ordinal);
    internal async Task<CoreAgentRunSubscription> CreateAsync(CoreCapabilityCaller caller, CoreAgentRunSubscriptionCreate input, CancellationToken ct)
    {
        var initial = await sessions.NotificationsAsync(caller, input.Run, input.Cursor, 0, ct);
        lock (gate)
        {
            foreach (var key in handles.Where(p => p.Value.Value.ExpiresAt <= clock.UtcNow && p.Value.Connected == 0).Select(p => p.Key).ToArray()) handles.Remove(key);
            if (handles.Values.Count(h => h.UserId == caller.User.Id) >= 32)
                throw new CoreProviderException("budget_exceeded", "Too many current execution subscriptions.", 429);
            var value = new CoreAgentRunSubscription(Guid.NewGuid().ToString("N"), clock.UtcNow.AddMinutes(5), initial);
            handles[value.Handle] = new(caller, value); return value;
        }
    }
    private CoreAgentRunSubscriptionHandle Get(CoreCapabilityCaller caller, string id)
    {
        lock (gate)
            return handles.TryGetValue(id, out var handle) && handle.UserId == caller.User.Id && handle.PrincipalId == caller.PrincipalId && handle.Value.ExpiresAt > clock.UtcNow
                ? handle : throw new CoreProviderException("cursor_expired", "Create a current subject-bound execution subscription.", 410);
    }
    internal async Task<IResult> StreamAsync(string id, HttpContext context, CoreCapabilityAuthorization auth, IHostApplicationLifetime lifetime, CancellationToken ct)
    {
        using var stopping = CancellationTokenSource.CreateLinkedTokenSource(ct, lifetime.ApplicationStopping);
        ct = stopping.Token; CoreAgentRunSubscriptionHandle? handle = null; var acquired = false;
        try
        {
            var caller = await CoreProviderApi.Caller(context.Request, auth, "agent-sessions", "runs.notifications", ct);
            handle = Get(caller, id);
            if (Interlocked.CompareExchange(ref handle.Connected, 1, 0) != 0) throw new CoreProviderException("resource_in_use", "This subscription already has a connected consumer.", 409);
            acquired = true;
            var source = handle.Value.Initial.Run.Ref.Provider;
            var policy = CoreProviderPolicy.For("agent-sessions", "runs.notifications");
            await using var watch = new CoreProviderStreamWatch(events, context.Request, caller, stopping, async token =>
                policy.Require(await auth.RevalidateAsync(caller.Authority!, caller.User.Id, caller.PrincipalId,
                    policy.Kind, source.AppId, source.Key, policy.ToolName, token)));
            var cursor = context.Request.Headers["Last-Event-ID"].ToString();
            if (string.IsNullOrEmpty(cursor)) cursor = handle.Value.Initial.Cursor;
            var notification = await sessions.NotificationsAsync(caller, handle.Value.Initial.Run.Ref, cursor, 0, ct);
            context.Response.ContentType = "text/event-stream";
            context.Response.Headers.CacheControl = "no-store";
            context.Response.Headers["X-Accel-Buffering"] = "no";
            while (!ct.IsCancellationRequested)
            {
                Get(caller, id);
                // Each source response has already revalidated both the source ACL and originating grant.
                await context.Response.WriteAsync($"event: {(notification.RescanRequired ? "run.rescan_required" : "run.changed")}\nid: {notification.Cursor}\ndata: {CoreJson.Text(notification)}\n\n", ct);
                await context.Response.Body.FlushAsync(ct);
                caller = await CoreProviderApi.Caller(context.Request, auth, "agent-sessions", "runs.notifications", ct);
                Get(caller, id);
                notification = await sessions.NotificationsAsync(caller, notification.Run.Ref, notification.Cursor, 20, ct);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (Exception ex) when (ex is CoreProviderException or AppIdentityException or SandboxException)
        {
            var error = ex switch { CoreProviderException provider => provider.Error,
                SandboxException denied => new CoreProviderError(denied.Code, denied.Message, false),
                AppIdentityException identity => new CoreProviderError(identity.Code, identity.Message, false),
                _ => throw new InvalidOperationException() };
            var status = ex switch { CoreProviderException failure => failure.Status, SandboxException denied => denied.Status,
                _ => AuthEndpoints.MapIdentityErrorStatus(error.Code) };
            if (!context.Response.HasStarted) return CoreJson.Json(new CoreProviderFailure(error), status);
            if (!ct.IsCancellationRequested) await context.Response.WriteAsync($"event: stream.closed\ndata: {CoreJson.Text(new CoreProviderFailure(error))}\n\n", ct);
        }
        finally { if (acquired) Interlocked.Exchange(ref handle!.Connected, 0); }
        return Results.Empty;
    }
    internal static void Map(WebApplication app)
    {
        app.MapPost("/api/agent-sessions/v1/runs/subscriptions", async (CoreAgentRunSubscriptionCreate input, HttpRequest request, CoreCapabilityAuthorization auth, CoreAgentRunSubscriptions subscriptions, CancellationToken ct) =>
            await CoreProviderApi.Handle(async () => await subscriptions.CreateAsync(await CoreProviderApi.Caller(request, auth, "agent-sessions", "runs.notifications", ct), input, ct)));
        app.MapGet("/api/agent-sessions/v1/runs/subscriptions/{handle}", async (string handle, HttpContext context, CoreCapabilityAuthorization auth, CoreAgentRunSubscriptions subscriptions, IHostApplicationLifetime lifetime, CancellationToken ct) =>
            await subscriptions.StreamAsync(handle, context, auth, lifetime, ct));
    }
}

internal sealed partial class CoreAgentSessionAdapter
{
    internal async Task<HostyAgentRunNotification> NotificationsAsync(CoreCapabilityCaller caller, HostyRunRef run, string? cursor, int waitSeconds, CancellationToken ct)
    {
        if (run is null) throw new CoreProviderException("invalid_reference", "Select a qualified run.", 400);
        CoreProviderMediation.ValidateId(run.Id); CoreHistoryValidation.Page(50, cursor);
        var result = await providers.SendAsync(caller, run.Provider, CoreProviderPolicy.For("agent-sessions", "runs.notifications"), "POST", "/runs/notifications",
            new CoreAgentRunSourceNotifications(run, cursor, waitSeconds), [run.Id], null, ct);
        var value = result.Deserialize(CoreJson.TypeInfo<HostyAgentRunNotification>()) ?? throw Invalid();
        Check(value.Run, run);
        if (string.IsNullOrEmpty(value.Cursor) || value.Cursor.Length > 4096 || value.Cursor.Any(c => c is '\r' or '\n' or '\0')) throw Invalid();
        return value;
    }
}
