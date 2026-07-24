using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Haas.Hosty.Core;

// Last-known update-availability verdict for one app, projected into its list summary (plan-first
// updates phase 2). `PlanDigest` names the cached pending plan a one-click apply would consume;
// `Error` is set when the latest check failed for this app (the row shows "check failed" instead of
// a stale verdict). Additive on AppSummary — older clients ignore it.
internal sealed record AppUpdateAvailability(
    bool UpdateAvailable,
    bool RequiresReview,
    string? PlanDigest,
    DateTimeOffset CheckedAt,
    string? Error);

// Fleet update-check state for the apps list: whether a sweep is running right now (drives the
// "Check updates" spinner from server state) and when one last finished.
internal sealed record AppUpdateCheckStatus(bool Running, DateTimeOffset? LastCompletedAt);

// Response of POST /api/apps/update-check: whether this call started a sweep (false = it joined one
// already in flight) plus the resulting status block.
internal sealed record AppUpdateCheckTriggerResponse(bool Started, AppUpdateCheckStatus Status);

// The fleet update sweep: one pass that builds (and caches) the reviewed-update plan for every
// installed app with a reviewed-update path, giving each app a fresh availability verdict and a
// ready-to-apply pending plan. Single-flight — a trigger while a sweep is running joins it — and
// detached from the triggering request: manual triggers run on the host lifetime token, so a closed
// tab never aborts a sweep. Per-app failures are captured as that app's verdict, never the sweep's.
// See docs/planning/plan-first-app-updates.md.
internal sealed class AppUpdateSweepService(
    CoreLifecycleService lifecycle,
    IClock clock,
    ILogger<AppUpdateSweepService> logger,
    IHostApplicationLifetime? hostLifetime = null,
    // Live-event hub for the fleet run-state transitions that drive the "Check updates" spinner.
    // Optional only for unit fixtures; production DI always supplies it.
    CoreEventHub? events = null)
{
    // Bounded fan-out: each app check is feed/manifest fetches plus registry probes (which are
    // themselves capped per app), so a handful in parallel saturates the useful concurrency without
    // burst-spawning docker CLI processes on an image-heavy fleet.
    private const int MaxConcurrentAppChecks = 3;

    private readonly object gate = new();
    private Task? running;
    private DateTimeOffset? lastCompletedAt;

    public AppUpdateCheckStatus Status
    {
        get
        {
            lock (gate)
            {
                return new AppUpdateCheckStatus(running is { IsCompleted: false }, lastCompletedAt);
            }
        }
    }

    // Starts a sweep, or joins the one already in flight; returns immediately either way. The sweep
    // itself runs on the application lifetime token, not the caller's — reload-safety is the point.
    public AppUpdateCheckTriggerResponse Trigger()
    {
        lock (gate)
        {
            var started = running is not { IsCompleted: false };
            if (started)
            {
                var token = hostLifetime?.ApplicationStopping ?? CancellationToken.None;
                running = Task.Run(() => SweepAsync(token), CancellationToken.None);
            }

            return new AppUpdateCheckTriggerResponse(started, new AppUpdateCheckStatus(Running: true, lastCompletedAt));
        }
    }

    // Scheduler path: awaits the sweep, joining a manual one if it is already in flight.
    public Task RunAsync(CancellationToken cancellationToken)
    {
        lock (gate)
        {
            if (running is { IsCompleted: false } current)
            {
                return current;
            }

            var run = Task.Run(() => SweepAsync(cancellationToken), CancellationToken.None);
            running = run;
            return run;
        }
    }

    private async Task SweepAsync(CancellationToken cancellationToken)
    {
        // Run-state transitions drive the "Check updates" spinner in every open client, not just the
        // one that clicked. Published from here (rather than from Trigger/RunAsync) so both entry
        // points are covered once.
        events?.PublishAppEvent(CoreEventHub.FleetUpdateCheckChanged);
        try
        {
            var apps = await lifecycle.ListAppsAsync(cancellationToken);
            // Reviewed-update targets only: runtime-kind apps (system apps included — they update
            // through the same plan/apply flow) minus live-source ones, whose manifest is adopted on
            // restart rather than advanced through a plan. Mirrors Shell's appSupportsReviewedUpdate.
            var targets = apps
                .Where(app => string.Equals(app.Kind, "runtime", StringComparison.Ordinal) && !app.Live)
                .ToList();
            lifecycle.PruneUpdateAvailability(targets.Select(target => target.Id).ToHashSet(StringComparer.Ordinal));

            // No cross-app fetch dedupe is needed here: app-feeds.0.1 documents are per-app (a single
            // appId that must match the installed app), so each app's feed and manifest URLs are its
            // own — one plan build per app is already the minimal network pass.
            var failures = 0;
            using var slots = new SemaphoreSlim(MaxConcurrentAppChecks);
            await Task.WhenAll(targets.Select(async target =>
            {
                await slots.WaitAsync(cancellationToken);
                try
                {
                    // Success writes the availability projection inside the plan build itself.
                    _ = await lifecycle.CreateUpdatePlanAsync(target.Id, new AppUpdatePlanRequest(), cancellationToken);
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    Interlocked.Increment(ref failures);
                    lifecycle.RecordUpdateCheckFailure(target.Id, ex.Message);
                    logger.LogWarning(ex, "Update check failed for app {AppId}.", target.Id);
                }
                finally
                {
                    slots.Release();
                }
            }));

            lock (gate)
            {
                lastCompletedAt = clock.UtcNow;
            }

            logger.LogInformation(
                "Fleet update check finished: {Checked} apps checked, {Failed} failed.",
                targets.Count,
                failures);
        }
        catch (OperationCanceledException)
        {
            // Shutdown (or the scheduler's stopping token): exit quietly, verdicts stay as they are.
        }
        catch (Exception ex)
        {
            // A sweep-level failure (the app list itself could not be read) — log and leave the
            // per-app verdicts untouched; the next trigger or scheduled run retries from scratch.
            logger.LogError(ex, "Fleet update check failed before reaching per-app checks.");
        }
        finally
        {
            // Retire the run BEFORE announcing it, and do it explicitly rather than leaving Status to
            // notice: this code runs inside the sweep task, which is not yet completed, so a client
            // that re-read GET /api/apps on the event would still see Running: true and keep
            // spinning. Clearing under the same gate that Trigger/RunAsync use makes the status the
            // event points at already correct. Unconditional clear is safe because neither entry
            // point starts a second sweep while this task is incomplete — they join this one.
            lock (gate)
            {
                running = null;
            }

            events?.PublishAppEvent(CoreEventHub.FleetUpdateCheckChanged);
        }
    }
}

// Runs the fleet update sweep on the operator-configured cadence (Core settings,
// HOSTY_UPDATE_CHECK_INTERVAL_MINUTES; 0 disables). The interval is re-read every cycle so a save
// applies without a restart — at worst one stale interval late. The first sweep waits out a startup
// delay so autostart reconciliation settles before Core starts hitting feeds and registries.
internal sealed class AppUpdateSweepScheduler(
    AppUpdateSweepService sweep,
    CoreSettingsService settings,
    ILogger<AppUpdateSweepScheduler> logger) : BackgroundService
{
    private static readonly TimeSpan StartupDelay = TimeSpan.FromMinutes(2);

    // How often to re-check the setting while the scheduler is disabled, so enabling it from the
    // Shell panel takes effect promptly without a dedicated wake-up channel.
    private static readonly TimeSpan DisabledRecheckInterval = TimeSpan.FromMinutes(5);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await Task.Delay(StartupDelay, stoppingToken);
            while (!stoppingToken.IsCancellationRequested)
            {
                var cadence = settings.UpdateCheck;
                if (!cadence.Enabled)
                {
                    await Task.Delay(DisabledRecheckInterval, stoppingToken);
                    continue;
                }

                try
                {
                    await sweep.RunAsync(stoppingToken);
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    // RunAsync may surface a joined manual sweep's failure; the sweep itself already
                    // logged the cause. Never let one bad cycle kill the scheduler.
                    logger.LogWarning(ex, "Scheduled fleet update check failed; retrying next cycle.");
                }

                await Task.Delay(cadence.Interval, stoppingToken);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Host is shutting down; exit quietly so we don't trip StopHost crit logging.
        }
    }
}
