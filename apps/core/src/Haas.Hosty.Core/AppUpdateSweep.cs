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
    string? Error,
    // What the operator would actually get, projected from the same plan build that set the verdict so
    // the apps list can name the update instead of only asserting one exists. `TargetVersion` is the
    // candidate manifest's version — equal to the installed one whenever the update advances the build
    // rather than the version, which is why the revisions below travel with it: for a source app the
    // target commit, for compiled services the candidate image digest per service key. All null on a
    // failed check or a verdict with nothing available. Additive — older clients ignore them.
    string? TargetVersion = null,
    string? TargetSourceCommit = null,
    IReadOnlyDictionary<string, string>? TargetArtifactDigests = null);

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
    CoreEventHub? events = null,
    // Overridable only so tests can hit the per-app deadline without waiting it out.
    TimeSpan? appCheckTimeout = null)
{
    // Bounded fan-out over apps. This used to be 3, to keep an image-heavy fleet from burst-spawning
    // docker CLI processes — but the per-app probe gate it was compensating for is now host-wide
    // (CoreLifecycleService.artifactProbeGate), so the registry pressure is already bounded where it
    // actually arises. Throttling apps on top of that only serialized the cheap half of a check: an
    // app with no compiled services waited behind one with five, and an 8-app fleet took three waves
    // to do work that is almost entirely network wait. What is left here is a guard against a very
    // large fleet opening every feed/manifest connection at once.
    private const int MaxConcurrentAppChecks = 16;

    // Per-app ceiling for one check. The underlying operations carry deadlines tuned for their heavy
    // cousins — the docker runner's for `pull`, git's for `clone` — so a dark registry or an
    // unreachable git host could hold a sweep slot for many minutes while every client's "Check
    // updates" spinner kept turning. A check that has not answered in this long is not going to.
    private readonly TimeSpan perAppCheckTimeout = appCheckTimeout ?? TimeSpan.FromSeconds(90);

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
                running = StartSweep(token);
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

            var run = StartSweep(cancellationToken);
            running = run;
            return run;
        }
    }

    // Both entry points start a sweep through here so the finish event is announced exactly once, and
    // only once the sweep task has actually completed. Announcing from inside SweepAsync would be
    // wrong twice over: Status derives "running" from this very task, so a client re-reading
    // GET /api/apps on the event would still see running: true and keep spinning; and clearing the
    // task from inside itself (the first attempt at fixing that) would open a window where Trigger
    // sees no active run and starts a second concurrent sweep, breaking single-flight.
    private Task StartSweep(CancellationToken cancellationToken)
    {
        var task = Task.Run(() => SweepAsync(cancellationToken), CancellationToken.None);
        _ = task.ContinueWith(
            _ => events?.PublishAppEvent(CoreEventHub.FleetUpdateCheckChanged),
            CancellationToken.None,
            TaskContinuationOptions.None,
            TaskScheduler.Default);
        return task;
    }

    private async Task SweepAsync(CancellationToken cancellationToken)
    {
        // Run-state transitions drive the "Check updates" spinner in every open client, not just the
        // one that clicked. The start is safe to announce from inside the task (Status already
        // reports running); the finish rides a continuation — see StartSweep.
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
                using var appTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                appTimeout.CancelAfter(perAppCheckTimeout);
                try
                {
                    // Success writes the availability projection inside the plan build itself.
                    _ = await lifecycle.CreateUpdatePlanAsync(target.Id, new AppUpdatePlanRequest(), appTimeout.Token);
                }
                // Only this app's own deadline: a cancelled sweep (shutdown) falls through to the
                // rethrow below, so a stopping host is never recorded as eight failed checks, and a
                // cancellation from anywhere else is not relabelled a timeout it never hit.
                catch (OperationCanceledException) when (appTimeout.IsCancellationRequested && !cancellationToken.IsCancellationRequested)
                {
                    Interlocked.Increment(ref failures);
                    var message = $"Update check timed out after {perAppCheckTimeout.TotalSeconds:0}s.";
                    lifecycle.RecordUpdateCheckFailure(target.Id, message);
                    logger.LogWarning("Update check for app {AppId} timed out after {Timeout}s.", target.Id, perAppCheckTimeout.TotalSeconds);
                }
                // Real shutdown is the only cancellation that ends the sweep. Rethrowing every
                // OperationCanceledException was too broad: SweepAsync treats one as a stopping host
                // and exits quietly, so a stray cancellation from anywhere inside a single app's check
                // silently ended the whole fleet run with the remaining apps unverdicted — which is
                // exactly what an HttpClient timeout (a TaskCanceledException, no deadline of ours
                // fired) did until it was fixed at the source. One app's misbehaviour belongs in one
                // app's verdict, so anything else falls through to the handler below.
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
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
