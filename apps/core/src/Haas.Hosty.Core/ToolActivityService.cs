namespace Haas.Hosty.Core;

internal sealed record ToolActivityReport(string UserId, string InstallationId, string PanelId,
    string State, int? Count = null, string? Label = null, int? TtlSeconds = null);
internal sealed record ToolActivity(UiPanelRef Panel, string State, int? Count = null, string? Label = null,
    DateTimeOffset? ReportedAt = null, DateTimeOffset? ExpiresAt = null);
internal sealed record ToolActivityList(IReadOnlyList<ToolActivity> Activities);

/// <summary>Ephemeral presence and attention, keyed by actor and installed panel, never by frame.</summary>
internal sealed class ToolActivityService(IClock clock, CoreEventHub events,
    AppRegistryStore apps, UserDirectoryStore users, AppIdentityService identity,
    ILogger<ToolActivityService> logger) : BackgroundService
{
    private readonly object gate = new();
    private readonly Dictionary<(string UserId, UiPanelRef Panel), ToolActivity> reports = [];
    private const int Capacity = 10_000;

    public async Task<ToolActivity> ReportAsync(AppRecord app, ToolActivityReport input, CancellationToken ct)
    {
        if (input.State is not ("idle" or "working" or "needs-you" or "failed")
            || input.Count is < 0 or > 9999 || input.Label is { Length: > 120 }
            || input.Label?.Any(char.IsControl) == true || input.TtlSeconds is < 1 or > 300
            || string.IsNullOrWhiteSpace(input.UserId))
            throw new AppIdentityException("activity_invalid", "Invalid tool activity state, count, label or lifetime.");
        if (input.InstallationId != PanelIdentity.Installation(app))
            throw new AppIdentityException("installation_changed", "The reporting installation changed.");
        var (_, current) = await identity.RequireAccessibleUserAsync(app.Id, input.UserId, ct);
        if (PanelIdentity.Installation(current) != input.InstallationId)
            throw new AppIdentityException("installation_changed", "The reporting installation changed.");
        if (!AppSummary.From(current).PanelSurfaces.Any(p => p.PanelId == input.PanelId && p.Endpoint is not null))
            throw new AppIdentityException("destination_invalid", "Report only a declared panel.");
        var panel = new UiPanelRef(app.Id, input.InstallationId, input.PanelId);
        var now = clock.UtcNow;
        var value = new ToolActivity(panel, input.State, input.State == "idle" ? null : input.Count,
            input.State == "idle" ? null : input.Label, now,
            input.State == "working" ? now.AddSeconds(input.TtlSeconds ?? 60) : null);
        bool changed;
        lock (gate)
        {
            var key = (input.UserId, panel);
            if (!reports.TryGetValue(key, out var previous) && reports.Count >= Capacity)
                throw new AppIdentityException("activity_capacity", "Tool activity capacity reached. Retry later.");
            changed = previous is null || Effective(previous).State != value.State
                || previous.Count != value.Count || previous.Label != value.Label;
            reports[key] = value;
        }
        if (changed) events.PublishToolActivity(input.UserId);
        return value;
    }

    public ToolActivity Read(string userId, UiPanel panel)
    {
        lock (gate)
        {
            var report = reports.GetValueOrDefault((userId, panel.Panel)) ?? new ToolActivity(panel.Panel, "idle");
            return panel.Available ? Effective(report)
                : new(panel.Panel, "no-connection", ReportedAt: report.ReportedAt);
        }
    }

    private ToolActivity Effective(ToolActivity value)
        => value.State == "working" && value.ExpiresAt <= clock.UtcNow
            ? value with { State = "idle", Count = null, Label = null, ExpiresAt = null } : value;

    internal void Expire()
    {
        HashSet<string> changed = [];
        lock (gate)
        {
            foreach (var (key, value) in reports.ToArray())
            {
                var next = Effective(value);
                if (next == value) continue;
                reports[key] = next;
                changed.Add(key.UserId);
            }
        }
        foreach (var userId in changed) events.PublishToolActivity(userId);
    }

    internal async Task PruneAsync(CancellationToken ct)
    {
        var installed = (await apps.ListAppRecordsAsync(ct)).ToDictionary(a => a.Id);
        var directory = await users.ReadAsync(ct);
        HashSet<string> changed = [];
        lock (gate)
        {
            foreach (var key in reports.Keys.ToArray())
            {
                var user = directory.Users.FirstOrDefault(u => u.Id == key.UserId && !u.Disabled);
                if (installed.TryGetValue(key.Panel.AppId, out var app)
                    && PanelIdentity.Installation(app) == key.Panel.InstallationId
                    && AppSummary.From(app).PanelSurfaces.Any(p => p.PanelId == key.Panel.PanelId)
                    && user is not null && AppAccessPolicy.CanAccessApp(directory, user, app.Id, app.System)) continue;
                reports.Remove(key);
                changed.Add(key.UserId);
            }
        }
        foreach (var userId in changed) events.PublishToolActivity(userId);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        var ticks = 0;
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                Expire();
                if (++ticks % 30 != 0) continue;
                try { await PruneAsync(stoppingToken); }
                catch (Exception error) when (error is not OperationCanceledException)
                { logger.LogWarning(error, "Could not prune tool activity; retrying on the next maintenance tick"); }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }
}
