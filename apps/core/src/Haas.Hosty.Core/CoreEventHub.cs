using System.Text.Json;
using System.Threading.Channels;

namespace Haas.Hosty.Core;

// The in-process event bus behind GET /api/events. Deliberately stores NOTHING: events are hints
// ("re-read this"), never records of what happened. A Core restart drops everything in flight and a
// disconnected subscriber simply misses events until it reconnects — both are harmless because the
// subscriber contract is "connect -> resync through the Core API -> react", repeated on every
// reconnect. That is why there is no durable log, no cursor and no Last-Event-ID here; durability
// belongs to the data (the app registry, NotificationStore, AuditStore), not to the transport.
// See docs/features/core-event-bus/feature.md.
//
// Best-effort per subscriber: a slow reader drops its oldest buffered events rather than blocking a
// publisher, because publishers call in while holding locks (the AppRegistryStore per-app mutex).
internal sealed class CoreEventHub
{
    // Domain events. Names are the wire contract for the SSE `event:` field.
    public const string AppChanged = "app.changed";
    public const string AppRemoved = "app.removed";
    public const string AppUpdateCheckChanged = "app.update-check.changed";
    public const string FleetUpdateCheckChanged = "apps.update-check.changed";

    // Notifications ride the same stream so a client needs one connection, not two.
    public const string NotificationEvent = "notification";

    private readonly object gate = new();
    private readonly List<CoreEventSubscription> subscriptions = [];

    public CoreEventSubscription Subscribe(string userId, bool isAdmin)
    {
        var subscription = new CoreEventSubscription(userId, isAdmin, this);
        lock (gate)
        {
            subscriptions.Add(subscription);
        }

        return subscription;
    }

    // Domain events describe host-wide app state, which is admin-only surface (GET /api/apps filters
    // itself per user, and only admins see the Installed Apps page). Fanning them out to every
    // session would leak the existence of apps a user was never assigned.
    public void PublishAppEvent(string name, string? appId = null)
    {
        CoreEventSubscription[] targets;
        lock (gate)
        {
            targets = subscriptions.Where(s => s.IsAdmin).ToArray();
        }

        if (targets.Length == 0)
        {
            return; // Nobody is listening — skip the serialization entirely.
        }

        var view = new AppEventView(name, appId, DateTimeOffset.UtcNow);
        var envelope = new CoreEventEnvelope(
            name,
            JsonSerializer.Serialize(view, CoreJsonSerializerContext.Default.AppEventView));
        foreach (var subscription in targets)
        {
            subscription.TryWrite(envelope);
        }
    }

    public void PublishNotification(NotificationRecord record)
    {
        CoreEventSubscription[] targets;
        lock (gate)
        {
            targets = subscriptions
                .Where(s => string.Equals(s.UserId, record.RecipientUserId, StringComparison.Ordinal))
                .ToArray();
        }

        if (targets.Length == 0)
        {
            return;
        }

        var view = NotificationService.ToView(record);
        var envelope = new CoreEventEnvelope(
            NotificationEvent,
            JsonSerializer.Serialize(view, CoreJsonSerializerContext.Default.NotificationView));
        foreach (var subscription in targets)
        {
            subscription.TryWrite(envelope);
        }
    }

    internal void Remove(CoreEventSubscription subscription)
    {
        lock (gate)
        {
            subscriptions.Remove(subscription);
        }
    }
}

// One SSE frame, serialized once per publish rather than once per subscriber.
internal sealed record CoreEventEnvelope(string Name, string Data);

// Wire shape of a domain event. No payload beyond the app it concerns: clients re-read state
// through the API, so adding fields here is an optimization, never a requirement.
internal sealed record AppEventView(string Name, string? AppId, DateTimeOffset OccurredAt);

internal sealed class CoreEventSubscription : IDisposable
{
    private readonly Channel<CoreEventEnvelope> channel = Channel.CreateBounded<CoreEventEnvelope>(
        new BoundedChannelOptions(64) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true });
    private readonly CoreEventHub owner;

    public CoreEventSubscription(string userId, bool isAdmin, CoreEventHub owner)
    {
        UserId = userId;
        IsAdmin = isAdmin;
        this.owner = owner;
    }

    public string UserId { get; }

    public bool IsAdmin { get; }

    public ChannelReader<CoreEventEnvelope> Reader => channel.Reader;

    public void TryWrite(CoreEventEnvelope envelope) => channel.Writer.TryWrite(envelope);

    public void Dispose()
    {
        owner.Remove(this);
        channel.Writer.TryComplete();
    }
}
