using System.Text.Json;
using System.Threading.Channels;

namespace Haas.Hosty.Core;

// The in-process event bus behind GET /api/events. Most events are refresh hints; opt-in resource
// frames carry data and a sequence for gap detection. A Core restart drops everything in flight and a
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
    public const string SandboxSnapshot = "sandbox.snapshot";
    public const string ToolActivityChanged = "tool.activity.changed";
    public const string WorkspaceChanged = "workspace.changed";
    public const string AppChanged = "app.changed";
    public const string AppRemoved = "app.removed";
    public const string AppUpdateCheckChanged = "app.update-check.changed";
    public const string FleetUpdateCheckChanged = "apps.update-check.changed";
    public const string ResourcesSample = "resources.sample";

    // Notifications ride the same stream so a client needs one connection, not two.
    public const string NotificationEvent = "notification";

    private readonly object gate = new();
    private readonly List<CoreEventSubscription> subscriptions = [];

    public CoreEventSubscription Subscribe(string userId, bool isAdmin, string? sessionId = null, bool resources = false, bool workspaces = false, bool toolActivity = false, bool sandboxes = false)
    {
        var subscription = new CoreEventSubscription(userId, isAdmin, this, sessionId, resources && isAdmin, workspaces, toolActivity, sandboxes && isAdmin);
        lock (gate)
        {
            subscriptions.Add(subscription);
        }

        return subscription;
    }

    internal void PublishSandboxChange(string userId)
    {
        CoreEventSubscription[] targets;
        lock (gate) targets = subscriptions.Where(s => s.Sandboxes && s.IsActive && s.UserId == userId).ToArray();
        foreach (var target in targets) target.SandboxesChanged();
    }

    internal void PublishWorkspaceChange(string id)
    {
        CoreEventSubscription[] targets;
        lock (gate) targets = subscriptions.Where(s => s.Workspaces && s.IsActive).ToArray();
        foreach (var target in targets) target.TryWrite(new(WorkspaceChanged, id));
    }

    internal bool HasWorkspaceSubscribers
    {
        get { lock (gate) return subscriptions.Any(s => s.Workspaces && s.IsActive); }
    }

    public bool HasResourceSubscribers
    {
        get { lock (gate) return subscriptions.Any(s => s.Resources && s.IsActive); }
    }

    public void PublishResources(ResourceUsageEvent sample)
    {
        CoreEventSubscription[] targets;
        lock (gate) targets = subscriptions.Where(s => s.Resources && s.IsActive).ToArray();
        if (targets.Length == 0) return;
        var envelope = new CoreEventEnvelope(ResourcesSample,
            JsonSerializer.Serialize(sample, CoreJsonSerializerContext.Default.ResourceUsageEvent));
        foreach (var subscription in targets) subscription.TryWrite(envelope);
    }

    // End the streams a credential currently holds open, so revoking it stops delivery now rather than
    // whenever the client next makes a request. Without this a revoked device keeps receiving
    // notifications over an already-established connection for as long as it stays connected — which is
    // the whole window a lost device is revoked to close.
    //
    // Completing the channel makes the reader's WaitToReadAsync return false, which is how the SSE loop
    // already ends a stream; it does not need a second exit path.
    public void CloseSession(string sessionId)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return;
        }

        CoreEventSubscription[] targets;
        lock (gate)
        {
            targets = subscriptions
                .Where(s => string.Equals(s.SessionId, sessionId, StringComparison.Ordinal))
                .ToArray();
        }

        foreach (var subscription in targets)
        {
            subscription.Complete();
        }
    }

    // Domain events describe host-wide app state, which is admin-only surface (GET /api/apps filters
    // itself per user, and only admins see the Installed Apps page). Fanning them out to every
    // session would leak the existence of apps a user was never assigned.
    public void PublishAppEvent(string name, string? appId = null)
    {
        if (name is AppChanged or AppRemoved)
        {
            PublishWorkspaceChange("*");
            PublishToolActivity();
        }
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

    // Empty hints disclose no panel, user or activity data; reads revalidate the actor's catalogue.
    public void PublishToolActivity(string? userId = null)
    {
        CoreEventSubscription[] targets;
        lock (gate) targets = subscriptions.Where(s => s.IsActive && s.ToolActivity && (userId is null || s.UserId == userId)).ToArray();
        foreach (var target in targets) target.TryWrite(new(ToolActivityChanged, "{}"));
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
    private readonly Channel<CoreEventEnvelope> channel;
    private long dropped;
    internal long Dropped => Interlocked.Read(ref dropped);
    private readonly CoreEventHub owner;
    private int completed;

    public CoreEventSubscription(string userId, bool isAdmin, CoreEventHub owner, string? sessionId = null, bool resources = false, bool workspaces = false, bool toolActivity = false, bool sandboxes = false)
    {
        UserId = userId;
        IsAdmin = isAdmin;
        SessionId = sessionId;
        Resources = resources;
        Workspaces = workspaces;
        ToolActivity = toolActivity;
        Sandboxes = sandboxes && isAdmin;
        this.owner = owner;
        channel = Channel.CreateBounded<CoreEventEnvelope>(
            new BoundedChannelOptions(64) { FullMode = BoundedChannelFullMode.DropOldest, SingleReader = true },
            _ => Interlocked.Increment(ref dropped));
    }

    public string UserId { get; }

    public bool IsAdmin { get; }
    public bool Resources { get; }
    internal bool Workspaces { get; }
    internal bool ToolActivity { get; }
    internal bool Sandboxes { get; }
    private long sandboxRevision = 1;
    internal long SandboxRevision => Interlocked.Read(ref sandboxRevision);
    internal void SandboxesChanged()
    {
        Interlocked.Increment(ref sandboxRevision);
        // The revision survives channel overflow. The endpoint projects current actor-owned data
        // once per drained batch (and checks the revision on keep-alive), never these internal hints.
        TryWrite(new(CoreEventHub.SandboxSnapshot, "{}"));
    }
    public bool IsActive => Volatile.Read(ref completed) == 0;

    // Which credential opened this stream, so revoking that credential can close it. Null when the
    // caller did not supply one; such a subscription is simply never closed this way.
    public string? SessionId { get; }

    public ChannelReader<CoreEventEnvelope> Reader => channel.Reader;

    public void TryWrite(CoreEventEnvelope envelope) => channel.Writer.TryWrite(envelope);

    // End the stream without unregistering: the reader still owns the subscription and disposes it on
    // its way out, which is what removes it from the hub.
    public void Complete()
    {
        Interlocked.Exchange(ref completed, 1);
        channel.Writer.TryComplete();
    }

    public void Dispose()
    {
        owner.Remove(this);
        Complete();
    }
}
