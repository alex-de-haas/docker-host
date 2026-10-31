using System.Text.Json;
using HostySdk.App;

namespace Haas.Hosty.Core;

internal sealed record CoreHistorySubscriptionCreate(HostyConversationRef Conversation, string? Cursor = null);
internal sealed record CoreHistorySourceNotifications(HostyConversationRef Conversation, string? Cursor, int WaitSeconds);
internal sealed record CoreHistorySubscription(string Handle, DateTimeOffset ExpiresAt, HostyHistoryNotification Initial);
internal sealed class CoreHistorySubscriptionHandle(CoreCapabilityCaller caller, CoreHistorySubscription value)
{
    internal string UserId { get; } = caller.User.Id;
    internal string PrincipalId { get; } = caller.PrincipalId;
    internal CoreHistorySubscription Value { get; } = value;
    internal int Connected;
}

/** In-memory, short-lived handles bind a stream to one current user and client. They grant no access. */
internal sealed class CoreHistorySubscriptions(CoreHistoryAdapter history, IClock clock, CoreEventHub events)
{
    private readonly Lock gate = new();
    private readonly Dictionary<string, CoreHistorySubscriptionHandle> handles = new(StringComparer.Ordinal);
    internal async Task<CoreHistorySubscription> CreateAsync(CoreCapabilityCaller caller, CoreHistorySubscriptionCreate input, CancellationToken ct)
    {
        var initial = await history.NotificationsAsync(caller, input.Conversation, input.Cursor, 0, ct);
        lock (gate)
        {
            foreach (var key in handles.Where(p => p.Value.Value.ExpiresAt <= clock.UtcNow && p.Value.Connected == 0).Select(p => p.Key).ToArray()) handles.Remove(key);
            if (handles.Values.Count(h => h.UserId == caller.User.Id) >= 32)
                throw new CoreProviderException("budget_exceeded", "Too many current history subscriptions.", 429);
            var value = new CoreHistorySubscription(Guid.NewGuid().ToString("N"), clock.UtcNow.AddMinutes(5), initial);
            handles[value.Handle] = new(caller, value); return value;
        }
    }
    private CoreHistorySubscriptionHandle Get(CoreCapabilityCaller caller, string id)
    {
        lock (gate)
            return handles.TryGetValue(id, out var handle) && handle.UserId == caller.User.Id && handle.PrincipalId == caller.PrincipalId && handle.Value.ExpiresAt > clock.UtcNow
                ? handle : throw new CoreProviderException("cursor_expired", "Create a current subject-bound history subscription.", 410);
    }
    internal async Task<IResult> StreamAsync(string id, HttpContext context, CoreCapabilityAuthorization auth, IHostApplicationLifetime lifetime, CancellationToken ct)
    {
        using var stopping = CancellationTokenSource.CreateLinkedTokenSource(ct, lifetime.ApplicationStopping);
        ct = stopping.Token; CoreHistorySubscriptionHandle? handle = null; var acquired = false;
        try
        {
            var caller = await CoreProviderApi.Caller(context.Request, auth, "conversation-history", "notifications", ct);
            handle = Get(caller, id);
            if (Interlocked.CompareExchange(ref handle.Connected, 1, 0) != 0) throw new CoreProviderException("resource_in_use", "This subscription already has a connected consumer.", 409);
            acquired = true;
            var source = handle.Value.Initial.Conversation.Provider;
            var policy = CoreProviderPolicy.For("conversation-history", "notifications");
            await using var watch = new CoreProviderStreamWatch(events, context.Request, caller, stopping, async token =>
                policy.Require(await auth.RevalidateAsync(caller.Authority!, caller.User.Id, caller.PrincipalId,
                    policy.Kind, source.AppId, source.Key, policy.ToolName, token)));
            var cursor = context.Request.Headers["Last-Event-ID"].ToString();
            if (string.IsNullOrEmpty(cursor)) cursor = handle.Value.Initial.Cursor;
            var notification = await history.NotificationsAsync(caller, handle.Value.Initial.Conversation, cursor, 0, ct);
            context.Response.ContentType = "text/event-stream";
            context.Response.Headers.CacheControl = "no-store";
            context.Response.Headers["X-Accel-Buffering"] = "no";
            while (!ct.IsCancellationRequested)
            {
                Get(caller, id);
                // Each source response has already revalidated both the source ACL and originating grant.
                await context.Response.WriteAsync($"event: {(notification.RescanRequired ? "history.rescan_required" : "history.changed")}\nid: {notification.Cursor}\ndata: {CoreJson.Text(notification)}\n\n", ct);
                await context.Response.Body.FlushAsync(ct);
                caller = await CoreProviderApi.Caller(context.Request, auth, "conversation-history", "notifications", ct);
                Get(caller, id);
                notification = await history.NotificationsAsync(caller, notification.Conversation, notification.Cursor, 20, ct);
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
        app.MapPost("/api/history/v1/subscriptions", async (CoreHistorySubscriptionCreate input, HttpRequest request, CoreCapabilityAuthorization auth, CoreHistorySubscriptions subscriptions, CancellationToken ct) =>
            await CoreProviderApi.Handle(async () => await subscriptions.CreateAsync(await CoreProviderApi.Caller(request, auth, "conversation-history", "notifications", ct), input, ct)));
        app.MapGet("/api/history/v1/subscriptions/{handle}", async (string handle, HttpContext context, CoreCapabilityAuthorization auth, CoreHistorySubscriptions subscriptions, IHostApplicationLifetime lifetime, CancellationToken ct) =>
            await subscriptions.StreamAsync(handle, context, auth, lifetime, ct));
    }
}

internal sealed partial class CoreHistoryAdapter
{
    internal async Task<HostyHistoryNotification> NotificationsAsync(CoreCapabilityCaller caller, HostyConversationRef conversation, string? cursor, int waitSeconds, CancellationToken ct)
    {
        CoreHistoryValidation.Conversation(conversation); CoreHistoryValidation.Page(50, cursor);
        var result = await Send(caller, conversation.Provider, "notifications", "POST", "/notifications", new CoreHistorySourceNotifications(conversation, cursor, waitSeconds), [conversation.Id], null, ct);
        var value = result.Deserialize(CoreJson.TypeInfo<HostyHistoryNotification>()) ?? throw Invalid();
        if (value.Conversation != conversation || value.Changes is null || value.Changes.Length > 200 || string.IsNullOrEmpty(value.Cursor)
            || value.Cursor.Length > 4096 || value.Cursor.Any(c => c is '\r' or '\n' or '\0')) throw Invalid();
        CoreAgentSessionAdapter.Revision(value.Revision);
        foreach (var change in value.Changes)
        {
            if (change.Type is not ("upsert" or "delete")) throw Invalid();
            CoreProviderMediation.ValidateId(change.EntryId); CoreAgentSessionAdapter.Revision(change.Revision);
        }
        return value;
    }
}
