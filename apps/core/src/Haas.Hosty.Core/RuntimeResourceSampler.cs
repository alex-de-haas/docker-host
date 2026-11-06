using System.Diagnostics;
using System.Text;

namespace Haas.Hosty.Core;

internal sealed record RuntimeResourceSample(string AppId, string Service, string Runtime,
    DateTimeOffset Timestamp, double? CpuPercent, double? MemoryBytes, double? MemoryPercent = null,
    string? EnvironmentId = null, string? ProcessIdentity = null,
    [property: System.Text.Json.Serialization.JsonIgnore] string? OwnerUserId = null);
internal sealed record ResourceUsageFrame(DateTimeOffset Timestamp, IReadOnlyList<RuntimeResourceSample> Services, long Sequence = 0, ApiActivitySnapshot? ApiActivity = null)
{
    internal ResourceUsageFrame ForUser(string? userId, bool environments) => this with
    { Services = Services.Where(s => s.EnvironmentId is null || environments && userId is not null && s.OwnerUserId == userId).ToArray() };
}
internal sealed record ResourceUsageResponse(string RunId, DateTimeOffset Now, int LogicalProcessors,
    IReadOnlyList<ResourceUsageFrame> History, long Sequence = 0, ApiActivitySnapshot? ApiActivity = null);
internal sealed record ResourceUsageEvent(string RunId, long Sequence, DateTimeOffset Timestamp,
    int LogicalProcessors, ResourceUsageFrame Frame);

// RAM only. A single producer serves both the live Dashboard and the slower telemetry scrape.
internal sealed class RuntimeResourceSampler(
    AppRegistryStore apps, DockerStatsExposition docker, LocalResourceReader local,
    CoreEventHub events, IClock clock, ILogger<RuntimeResourceSampler> logger, AppManifestService manifests, CoreApiActivity? apiActivity = null) : BackgroundService
{
    private readonly object gate = new();
    private readonly Queue<ResourceUsageFrame> history = new();
    private readonly string runId = Guid.NewGuid().ToString("N");
    private long sequence;
    private DateTimeOffset viewedUntil;
    private DateTimeOffset lastSample;
    private DateTimeOffset lastDocker;
    private volatile ResourceUsageFrame? latestFrame;
    private volatile IReadOnlyList<RuntimeResourceSample> latestSamples = [];
    private int dockerFailures;
    private DateTimeOffset? lastDockerWarning;
    internal static readonly TimeSpan Retention = TimeSpan.FromMinutes(5);
    internal static readonly TimeSpan DockerTimeout = TimeSpan.FromSeconds(8);
    internal static readonly TimeSpan DockerMaxAge = TimeSpan.FromSeconds(20);
    internal const int MaxFrames = 110;

    public string CurrentPrometheusText
    {
        get
        {
            var frame = latestFrame;
            if (frame is null) return apiActivity?.PrometheusText() ?? "";
            var now = clock.UtcNow;
            var builder = new StringBuilder();
            // Check freshness at scrape time too: an in-flight probe can outlive a cached sample.
            foreach (var sample in frame.Services.Where(s => s.Runtime != "unknown" && IsFresh(s, now)))
            {
                var prefix = sample.Runtime == "docker" ? "container" : "process";
                if (sample.CpuPercent is { } cpu)
                    DockerStatsExposition.AppendSample(builder, prefix + ".cpu.percent", sample.AppId, sample.Service, cpu);
                if (sample.MemoryBytes is { } memory)
                    DockerStatsExposition.AppendSample(builder, prefix + ".memory.bytes", sample.AppId, sample.Service, memory);
                if (sample.Runtime == "docker" && sample.MemoryPercent is { } percent)
                    DockerStatsExposition.AppendSample(builder, "container.memory.percent", sample.AppId, sample.Service, percent);
            }
            builder.Append(apiActivity?.PrometheusText());
            return builder.ToString();
        }
    }

    private static bool IsFresh(RuntimeResourceSample sample, DateTimeOffset now)
        => sample.Runtime != "docker" || now - sample.Timestamp <= DockerMaxAge;

    public ResourceUsageResponse Read(DateTimeOffset? after = null, string? previousRunId = null, bool stream = false,
        string? userId = null, bool environments = false)
    {
        lock (gate)
        {
            // Renewed by visible Dashboard reads, never by telemetry. A disconnected client costs
            // at most this grace period; no per-browser sampling loop or unbounded lease dictionary.
            if (!stream) viewedUntil = clock.UtcNow.AddSeconds(20);
            Prune(clock.UtcNow);
            return new(runId, clock.UtcNow, Environment.ProcessorCount, history.Where(f => previousRunId != runId || after is null || f.Timestamp > after)
                .Select(f => f.ForUser(userId, environments)).ToArray(), sequence, apiActivity?.Read());
        }
    }

    internal void Record(ResourceUsageFrame frame)
    {
        lock (gate)
        {
            // A child process replacement starts a new series. Finished, stopped and
            // unobserved children leave no retained process readings in a later snapshot.
            var identities = frame.Services.Where(s => s.EnvironmentId is not null)
                .ToDictionary(s => s.EnvironmentId!, s => s.ProcessIdentity);
            var retained = history.Select(previous => previous with
            {
                Services = previous.Services.Where(s => s.EnvironmentId is null ||
                    identities.TryGetValue(s.EnvironmentId, out var identity) && identity == s.ProcessIdentity).ToArray()
            }).ToArray();
            history.Clear();
            foreach (var previous in retained) history.Enqueue(previous);
            frame = frame with { Sequence = ++sequence, ApiActivity = frame.ApiActivity ?? apiActivity?.Read() };
            history.Enqueue(frame);
            Prune(frame.Timestamp);
            latestFrame = frame;
            events.PublishResources(new(runId, sequence, frame.Timestamp, Environment.ProcessorCount, frame));
        }
    }

    // CPU/RAM keep their original measurement timestamps while API activity remains live.
    internal void PublishActivity()
    {
        if (apiActivity is null || !HasViewers) return;
        lock (gate)
        {
            if (latestFrame is { } previous && clock.UtcNow - previous.Timestamp < TimeSpan.FromSeconds(3)) return;
            Record(new(clock.UtcNow, latestSamples, ApiActivity: apiActivity.Read()));
        }
    }

    private void PublishMeasurements(DateTimeOffset at, IReadOnlyList<RuntimeResourceSample> samples)
    {
        latestSamples = samples;
        lock (gate)
        {
            if (apiActivity is not null && latestFrame is { } previous && at - previous.Timestamp < TimeSpan.FromSeconds(3)) return;
            Record(new(at, samples));
        }
    }

    internal bool HasViewers
    {
        get { lock (gate) return viewedUntil > clock.UtcNow || events.HasResourceSubscribers; }
    }

    private void Prune(DateTimeOffset now)
    {
        while (history.TryPeek(out var first) && (history.Count > MaxFrames || now - first.Timestamp > Retention))
            history.Dequeue();
    }

    internal static void ReconcileApp(List<RuntimeResourceSample> samples, string appId, string state,
        IReadOnlyList<string> expectedServices, DateTimeOffset at)
    {
        // Starting, stopping and partial outages can still consume resources. Only a confirmed
        // stopped app has a known zero; a missing observation otherwise stays unknown.
        var stopped = AppRuntimeStates.IsIdle(state);
        if (stopped) samples.RemoveAll(s => s.AppId == appId);
        var expected = expectedServices.Count == 0 && !samples.Any(s => s.AppId == appId)
            ? ["app"] : expectedServices;
        foreach (var service in expected)
            if (!samples.Any(s => s.AppId == appId && s.Service == service))
                samples.Add(new(appId, service, "unknown", at, stopped ? 0 : null, stopped ? 0 : null));
    }

    internal async Task ReconcileAppAsync(List<RuntimeResourceSample> samples, AppRecord app,
        DateTimeOffset at, CancellationToken cancellationToken)
    {
        IReadOnlyList<string> services = app.Health?.Services.Select(s => s.Service).ToArray() ?? [];
        if (!string.IsNullOrWhiteSpace(app.ManifestPath))
        {
            try
            {
                // Health is cleared by Stop. The reviewed manifest retains the complete roster,
                // including workers without endpoints; AppManifestService caches local file reads.
                var selection = await manifests.LoadAsync(app.ManifestPath, app.SelectedRuntime, cancellationToken);
                services = selection.Services.Select(s => s.Key).ToArray();
            }
            catch (Exception ex) when (ex is AppManifestException or IOException or UnauthorizedAccessException)
            {
                logger.LogDebug(ex, "Resource service roster unavailable for {AppId}.", app.Id);
            }
        }
        ReconcileApp(samples, app.Id, app.RuntimeState, services, at);
    }

    internal async Task<IReadOnlyList<RuntimeResourceSample>> ReadDockerSamplesAsync(CancellationToken stoppingToken)
    {
        var now = clock.UtcNow;
        if (now - lastDocker >= TimeSpan.FromSeconds(10))
        {
            lastDocker = now;
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
            deadline.CancelAfter(DockerTimeout);
            var timer = Stopwatch.StartNew();
            try
            {
                await docker.BuildSnapshotAsync(deadline.Token);
                if (dockerFailures > 0)
                    logger.LogInformation("Docker resource acquisition recovered after {FailureCount} failed attempts in {ElapsedMilliseconds} ms.",
                        dockerFailures, timer.Elapsed.TotalMilliseconds);
                dockerFailures = 0;
                lastDockerWarning = null;
            }
            catch (Exception ex) when (!stoppingToken.IsCancellationRequested)
            {
                dockerFailures++;
                now = clock.UtcNow;
                if (lastDockerWarning is null || now - lastDockerWarning.Value >= TimeSpan.FromMinutes(1))
                {
                    lastDockerWarning = now;
                    if (ex is OperationCanceledException && deadline.IsCancellationRequested)
                        logger.LogWarning("Docker resource acquisition timed out after {ElapsedMilliseconds} ms (limit {TimeoutSeconds} s, {FailureCount} failed attempts). Cached observations expire after {MaxAgeSeconds} s.",
                            timer.Elapsed.TotalMilliseconds, DockerTimeout.TotalSeconds, dockerFailures, DockerMaxAge.TotalSeconds);
                    else
                        logger.LogWarning(ex, "Docker resource acquisition failed after {ElapsedMilliseconds} ms ({FailureCount} failed attempts). Cached observations expire after {MaxAgeSeconds} s.",
                            timer.Elapsed.TotalMilliseconds, dockerFailures, DockerMaxAge.TotalSeconds);
                }
            }
        }
        now = clock.UtcNow;
        return docker.Samples.Where(s => IsFresh(s, now)).ToArray();
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                var now = clock.UtcNow;
                var viewed = HasViewers;
                lock (gate) Prune(now);
                if (now - lastSample < TimeSpan.FromSeconds(viewed ? 3 : 10)) continue;
                var telemetry = await apps.GetAppAsync(CollectorBootstrap.AppId, stoppingToken);
                if (!viewed && !AppRuntimeStates.IsUp(telemetry?.RuntimeState))
                {
                    latestFrame = null;
                    latestSamples = [];
                    local.Reset();
                    continue;
                }
                lastSample = now;
                // Docker --no-stream waits for a CPU delta. Share acquisition across clients and
                // retain successful observations across transient failures until their age limit.
                var dockerSamples = await ReadDockerSamplesAsync(stoppingToken);
                var samples = (await local.ReadAsync(stoppingToken)).ToList();
                samples.AddRange(dockerSamples.Where(s => IsFresh(s, clock.UtcNow)));
                // During runtime switches both adapters can briefly report the same service.
                // Attribute it once, to the freshest observation.
                samples = samples.GroupBy(s => (s.AppId, s.Service))
                    .Select(g => g.MaxBy(s => s.Timestamp)!).ToList();
                var at = clock.UtcNow;
                var roster = await apps.ListAppRecordsAsync(stoppingToken);
                var installed = roster.Select(a => a.Id).ToHashSet(StringComparer.Ordinal);
                samples.RemoveAll(s => s.EnvironmentId is null && s.AppId != "hosty.core" && !installed.Contains(s.AppId));
                foreach (var app in roster)
                    await ReconcileAppAsync(samples, app, at, stoppingToken);
                PublishMeasurements(at, samples);
                if (viewed) events.PublishAppEvent("resources.changed");
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception ex) { logger.LogWarning(ex, "Runtime resource sample failed."); }
        }
    }
}

internal static class RuntimeResourceEndpoints
{
    public static void Map(WebApplication app)
    {
        app.MapGet("/api/core/resources", (HttpRequest request, UserDirectoryStore users, IClock clock,
            RuntimeResourceSampler sampler, DateTimeOffset? after, string? runId, bool? stream, CancellationToken cancellationToken) =>
            CoreSessionAuthorization.RequireSessionAsync(request, users, clock, user =>
            {
                if (!AppAccessPolicy.IsAdmin(user)) return Task.FromResult<IResult>(CoreJson.Json(new ErrorResponse("admin_required", "Host administrator required."), 403));
                var caller = AppManagementAuthorization.Caller(request);
                var environments = caller is null || AppManagementAuthorization.HasPermission(caller.App, CoreAppPermissions.CoreEnvironmentsInspect);
                return Task.FromResult(CoreJson.Json(sampler.Read(after, runId, stream == true, user.Id, environments)));
            }, cancellationToken: cancellationToken));
    }
}
