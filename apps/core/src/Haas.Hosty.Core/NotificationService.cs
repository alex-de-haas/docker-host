namespace Haas.Hosty.Core;

// User-targeted notification capability owned by Core. Producers publish (apps via service token,
// scoped to their directory; Core in-process for host-admin/platform messages); consumers read the
// per-user inbox. Fan-out happens on write: a broadcast is expanded into one record per recipient.
internal sealed class NotificationService(
    NotificationStore store,
    UserDirectoryStore users,
    CoreEventHub events,
    IClock clock)
{
    public const string AudienceUser = "user";
    public const string AudienceHostAdmin = "host-admin";
    public const string HostAdminRole = "host.admin";
    public const string BroadcastTarget = "broadcast";

    public const int MaxPerUser = 100;
    private static readonly TimeSpan ReadRetention = TimeSpan.FromDays(30);

    private static readonly HashSet<string> ValidLevels = new(StringComparer.Ordinal) { "info", "success", "warning", "error" };

    public static bool IsValidLevel(string level) => ValidLevels.Contains(level);

    public async Task<AppNotificationCreateResponse> PublishAsync(
        NotificationScope scope,
        string target,
        string audience,
        string level,
        string title,
        string? body,
        string? link,
        string? dedupeKey,
        CancellationToken cancellationToken = default)
    {
        var source = scope switch
        {
            AppScope app => new NotificationSource("app", app.AppId),
            _ => new NotificationSource("core", null),
        };

        var recipientIds = await ResolveRecipientsAsync(scope, target, audience, cancellationToken);
        var now = clock.UtcNow;
        var candidates = recipientIds
            .Select(userId => new NotificationRecord(
                Id: $"ntf_{Guid.NewGuid():N}",
                RecipientUserId: userId,
                Source: source,
                Audience: audience,
                Level: level,
                Title: title,
                Body: body,
                Link: link,
                DedupeKey: dedupeKey,
                CreatedAt: now,
                ReadAt: null))
            .ToArray();

        var created = await store.UpdateAsync<List<NotificationRecord>>(state =>
        {
            var made = new List<NotificationRecord>();
            if (candidates.Length == 0)
            {
                return (state, made);
            }

            var list = state.Notifications.ToList();
            foreach (var candidate in candidates)
            {
                if (dedupeKey is not null && list.Any(existing =>
                        existing.ReadAt is null &&
                        string.Equals(existing.RecipientUserId, candidate.RecipientUserId, StringComparison.Ordinal) &&
                        string.Equals(existing.Source.Kind, candidate.Source.Kind, StringComparison.Ordinal) &&
                        string.Equals(existing.Source.AppId, candidate.Source.AppId, StringComparison.Ordinal) &&
                        string.Equals(existing.DedupeKey, dedupeKey, StringComparison.Ordinal)))
                {
                    continue;
                }

                list.Add(candidate);
                made.Add(candidate);
            }

            return made.Count == 0
                ? (state, made)
                : (state with { Notifications = list }, made);
        }, cancellationToken);

        foreach (var record in created)
        {
            events.PublishNotification(record);
        }

        var status = candidates.Length == 0
            ? "no_recipients"
            : created.Count == 0
                ? "deduplicated"
                : "created";

        return new AppNotificationCreateResponse(status, created.Count, created.Select(record => record.Id).ToArray());
    }

    public async Task<NotificationsResponse> QueryAsync(
        string userId,
        bool includeHostAdmin,
        bool unreadOnly,
        int limit,
        int offset,
        CancellationToken cancellationToken = default)
    {
        var state = await store.ReadAsync(cancellationToken);
        var mine = state.Notifications
            .Where(n => string.Equals(n.RecipientUserId, userId, StringComparison.Ordinal))
            .Where(n => includeHostAdmin || !string.Equals(n.Audience, AudienceHostAdmin, StringComparison.Ordinal))
            .OrderByDescending(n => n.CreatedAt)
            .ToArray();

        var unreadCount = mine.Count(n => n.ReadAt is null);
        var filtered = unreadOnly ? mine.Where(n => n.ReadAt is null).ToArray() : mine;
        var page = filtered
            .Skip(offset)
            .Take(limit)
            .Select(ToView)
            .ToArray();

        return new NotificationsResponse(
            page,
            unreadCount,
            new NotificationPagination(limit, offset, filtered.Length),
            clock.UtcNow);
    }

    public async Task<NotificationMarkReadResponse> MarkReadAsync(
        string userId,
        IReadOnlyList<string>? ids,
        CancellationToken cancellationToken = default)
    {
        var idSet = ids is { Count: > 0 } ? ids.ToHashSet(StringComparer.Ordinal) : null;
        return await store.UpdateAsync(state =>
        {
            var now = clock.UtcNow;
            var updated = 0;
            var list = state.Notifications
                .Select(n =>
                {
                    if (string.Equals(n.RecipientUserId, userId, StringComparison.Ordinal) &&
                        n.ReadAt is null &&
                        (idSet is null || idSet.Contains(n.Id)))
                    {
                        updated++;
                        return n with { ReadAt = now };
                    }

                    return n;
                })
                .ToList();

            var unread = list.Count(n =>
                string.Equals(n.RecipientUserId, userId, StringComparison.Ordinal) && n.ReadAt is null);

            return updated == 0
                ? (state, new NotificationMarkReadResponse(0, unread))
                : (state with { Notifications = list }, new NotificationMarkReadResponse(updated, unread));
        }, cancellationToken);
    }

    // Per recipient: keep all unread; among read, drop those older than the retention window and cap
    // the remainder at MaxPerUser. Unread records are never pruned.
    public async Task<int> ApplyRetentionAsync(CancellationToken cancellationToken = default)
    {
        return await store.UpdateAsync(state =>
        {
            var cutoff = clock.UtcNow - ReadRetention;
            var kept = new List<NotificationRecord>(state.Notifications.Count);
            foreach (var group in state.Notifications.GroupBy(n => n.RecipientUserId, StringComparer.Ordinal))
            {
                var unread = group.Where(n => n.ReadAt is null).ToList();
                kept.AddRange(unread);

                var readSlots = Math.Max(0, MaxPerUser - unread.Count);
                var read = group
                    .Where(n => n.ReadAt is not null && n.ReadAt.Value >= cutoff)
                    .OrderByDescending(n => n.CreatedAt)
                    .Take(readSlots);
                kept.AddRange(read);
            }

            var pruned = state.Notifications.Count - kept.Count;
            return pruned == 0
                ? (state, 0)
                : (state with { Notifications = kept }, pruned);
        }, cancellationToken);
    }

    private async Task<IReadOnlyList<string>> ResolveRecipientsAsync(
        NotificationScope scope,
        string target,
        string audience,
        CancellationToken cancellationToken)
    {
        var directory = await users.ReadAsync(cancellationToken);
        IEnumerable<HostUserRecord> candidates = directory.Users.Where(u => !u.Disabled);

        if (scope is AppScope app)
        {
            var assigned = directory.Assignments
                .Where(a => string.Equals(a.AppId, app.AppId, StringComparison.Ordinal))
                .Select(a => a.UserId)
                .ToHashSet(StringComparer.Ordinal);
            candidates = candidates.Where(u => assigned.Contains(u.Id));
        }

        if (string.Equals(audience, AudienceHostAdmin, StringComparison.Ordinal))
        {
            candidates = candidates.Where(u => string.Equals(u.Role, HostAdminRole, StringComparison.Ordinal));
        }

        if (!string.Equals(target, BroadcastTarget, StringComparison.Ordinal))
        {
            candidates = candidates.Where(u => string.Equals(u.Id, target, StringComparison.Ordinal));
        }

        return candidates.Select(u => u.Id).Distinct(StringComparer.Ordinal).ToArray();
    }

    internal static NotificationView ToView(NotificationRecord n)
        => new(n.Id, n.Source, n.Audience, n.Level, n.Title, n.Body, n.Link, n.CreatedAt, n.ReadAt is not null, n.ReadAt);
}

// Producer scope: AppScope restricts recipients to the app's assigned users (audience forced to
// "user" by the producer endpoint); CoreScope is the privileged in-process producer (any user,
// may target the host-admin audience).
internal abstract record NotificationScope;

internal sealed record AppScope(string AppId) : NotificationScope;

internal sealed record CoreScope : NotificationScope;

internal sealed record NotificationView(
    string Id,
    NotificationSource Source,
    string Audience,
    string Level,
    string Title,
    string? Body,
    string? Link,
    DateTimeOffset CreatedAt,
    bool Read,
    DateTimeOffset? ReadAt);

internal sealed record NotificationPagination(int Limit, int Offset, int Total);

internal sealed record AppNotificationCreateResponse(
    string Status,
    int RecipientCount,
    IReadOnlyList<string> NotificationIds);

internal sealed record NotificationsResponse(
    IReadOnlyList<NotificationView> Notifications,
    int UnreadCount,
    NotificationPagination Pagination,
    DateTimeOffset UpdatedAt);

internal sealed record NotificationMarkReadResponse(
    int Updated,
    int UnreadCount);

// Background retention pass: prunes read/old notifications and caps per-user volume after startup
// and then periodically. Mirrors AppBackupRetentionScheduler.
internal sealed class NotificationRetentionScheduler(
    NotificationService notifications,
    AuditStore audit,
    IClock clock,
    ILogger<NotificationRetentionScheduler> logger) : BackgroundService
{
    private static readonly TimeSpan CleanupInterval = TimeSpan.FromHours(6);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await Task.Yield();
        try
        {
            await RunCleanupAsync(stoppingToken);

            using var timer = new PeriodicTimer(CleanupInterval);
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                await RunCleanupAsync(stoppingToken);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Host is shutting down; exit quietly so we don't trip StopHost crit logging.
        }
    }

    internal async Task RunCleanupAsync(CancellationToken cancellationToken)
    {
        try
        {
            var pruned = await notifications.ApplyRetentionAsync(cancellationToken);
            if (pruned == 0)
            {
                logger.LogDebug("Hosty notification retention found no candidates.");
                return;
            }

            await audit.AppendAsync(
                new AuditRecord(
                    Id: $"audit_{Guid.NewGuid():N}",
                    Action: "notification.retention.cleanup",
                    ResourceType: "notification.retention",
                    ResourceId: null,
                    Outcome: "succeeded",
                    ActorUserId: null,
                    CreatedAt: clock.UtcNow,
                    Details: new Dictionary<string, string>(StringComparer.Ordinal)
                    {
                        ["pruned"] = pruned.ToString(System.Globalization.CultureInfo.InvariantCulture),
                    }),
                cancellationToken);
            logger.LogInformation("Hosty notification retention pruned {PrunedCount} notifications.", pruned);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or System.Text.Json.JsonException)
        {
            // A transient storage error must not crash the host: an unhandled exception in a
            // BackgroundService loop tears down the application in .NET 6+.
            logger.LogWarning(ex, "Hosty notification retention cleanup did not complete.");
        }
        catch (Exception ex)
        {
            // Same reason, for the failures the filter above did not anticipate.
            logger.LogError(ex, "Hosty notification retention cleanup failed unexpectedly; retrying next cycle.");
        }
    }
}
