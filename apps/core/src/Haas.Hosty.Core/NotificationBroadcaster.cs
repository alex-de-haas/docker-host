using System.Threading.Channels;

namespace Haas.Hosty.Core;

// In-memory live fan-out for SSE consumers. Best-effort: a slow or full subscriber drops its
// oldest buffered events rather than blocking publishers. Durable history lives in NotificationStore,
// so a dropped live event is recoverable through GET /api/notifications.
internal sealed class NotificationBroadcaster
{
    private readonly object _gate = new();
    private readonly List<NotificationSubscription> _subscriptions = [];

    public NotificationSubscription Subscribe(string userId)
    {
        var subscription = new NotificationSubscription(userId, this);
        lock (_gate)
        {
            _subscriptions.Add(subscription);
        }

        return subscription;
    }

    public void Publish(NotificationRecord record)
    {
        var view = NotificationService.ToView(record);
        NotificationSubscription[] targets;
        lock (_gate)
        {
            targets = _subscriptions
                .Where(s => string.Equals(s.UserId, record.RecipientUserId, StringComparison.Ordinal))
                .ToArray();
        }

        foreach (var subscription in targets)
        {
            subscription.TryWrite(view);
        }
    }

    internal void Remove(NotificationSubscription subscription)
    {
        lock (_gate)
        {
            _subscriptions.Remove(subscription);
        }
    }
}

internal sealed class NotificationSubscription : IDisposable
{
    private readonly Channel<NotificationView> _channel = Channel.CreateBounded<NotificationView>(
        new BoundedChannelOptions(64) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true });
    private readonly NotificationBroadcaster _owner;

    public NotificationSubscription(string userId, NotificationBroadcaster owner)
    {
        UserId = userId;
        _owner = owner;
    }

    public string UserId { get; }

    public ChannelReader<NotificationView> Reader => _channel.Reader;

    public void TryWrite(NotificationView view) => _channel.Writer.TryWrite(view);

    public void Dispose()
    {
        _owner.Remove(this);
        _channel.Writer.TryComplete();
    }
}
