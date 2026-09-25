using System.Text;

namespace Haas.Hosty.Core;

internal sealed record RuntimeResourceSample(string AppId, string Service, string Runtime,
    DateTimeOffset Timestamp, double? CpuPercent, double? MemoryBytes, double? MemoryPercent = null);
internal sealed record ResourceUsageFrame(DateTimeOffset Timestamp, IReadOnlyList<RuntimeResourceSample> Services);
internal sealed record ResourceUsageResponse(string RunId, DateTimeOffset Now, int LogicalProcessors,
    IReadOnlyList<ResourceUsageFrame> History);

// RAM only. A single producer serves both the live Dashboard and the slower telemetry scrape.
internal sealed class RuntimeResourceSampler(
    AppRegistryStore apps, DockerStatsExposition docker, LocalResourceReader local,
    CoreEventHub events, IClock clock, ILogger<RuntimeResourceSampler> logger) : BackgroundService
{
    private readonly object gate = new();
    private readonly Queue<ResourceUsageFrame> history = new();
    private readonly string runId = Guid.NewGuid().ToString("N");
    private DateTimeOffset viewedUntil;
    private DateTimeOffset lastSample;
    private DateTimeOffset lastDocker;
    private string dockerText = "";
    private volatile string exposition = "";
    internal static readonly TimeSpan Retention = TimeSpan.FromMinutes(5);
    internal const int MaxFrames = 110;

    public string CurrentPrometheusText => exposition;

    public ResourceUsageResponse Read(DateTimeOffset? after = null, string? previousRunId = null)
    {
        lock (gate)
        {
            // Renewed by visible Dashboard reads, never by telemetry. A disconnected client costs
            // at most this grace period; no per-browser sampling loop or unbounded lease dictionary.
            viewedUntil = clock.UtcNow.AddSeconds(20);
            Prune(clock.UtcNow);
            return new(runId, clock.UtcNow, Environment.ProcessorCount, history.Where(f => previousRunId != runId || after is null || f.Timestamp > after).ToArray());
        }
    }

    internal void Record(ResourceUsageFrame frame)
    {
        lock (gate)
        {
            history.Enqueue(frame);
            Prune(frame.Timestamp);
        }
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

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                var now = clock.UtcNow;
                bool viewed;
                lock (gate) { viewed = viewedUntil > now; Prune(now); }
                if (now - lastSample < TimeSpan.FromSeconds(viewed ? 3 : 10)) continue;
                var telemetry = await apps.GetAppAsync(CollectorBootstrap.AppId, stoppingToken);
                if (!viewed && !AppRuntimeStates.IsUp(telemetry?.RuntimeState))
                {
                    exposition = "";
                    local.Reset();
                    continue;
                }
                lastSample = now;
                // Docker --no-stream itself waits for a CPU delta. Never run it per client, and
                // bound daemon waits so an outage cannot stall acquisition indefinitely.
                if (now - lastDocker >= TimeSpan.FromSeconds(10))
                {
                    lastDocker = now;
                    using var deadline = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
                    deadline.CancelAfter(TimeSpan.FromSeconds(4));
                    try { dockerText = await docker.BuildSnapshotAsync(deadline.Token); }
                    catch (Exception ex) when (ex is not OperationCanceledException || !stoppingToken.IsCancellationRequested)
                    {
                        dockerText = "";
                        logger.LogDebug(ex, "Docker resource sample unavailable.");
                    }
                }
                var samples = (await local.ReadAsync(stoppingToken)).ToList();
                if (dockerText.Length > 0) samples.AddRange(docker.Samples);
                // During runtime switches both adapters can briefly report the same service.
                // Attribute it once, to the freshest observation.
                samples = samples.GroupBy(s => (s.AppId, s.Service))
                    .Select(g => g.MaxBy(s => s.Timestamp)!).ToList();
                var at = clock.UtcNow;
                var roster = await apps.ListAppsAsync(stoppingToken);
                var installed = roster.Select(a => a.Id).ToHashSet(StringComparer.Ordinal);
                samples.RemoveAll(s => s.AppId != "hosty.core" && !installed.Contains(s.AppId));
                foreach (var app in roster)
                    ReconcileApp(samples, app.Id, app.RuntimeState,
                        app.Health?.Services.Select(s => s.Service).ToArray() ?? [], at);
                Record(new(at, samples));
                var builder = new StringBuilder();
                foreach (var sample in samples.Where(s => s.Runtime != "unknown"))
                {
                    var prefix = sample.Runtime == "docker" ? "container" : "process";
                    if (sample.CpuPercent is { } cpu)
                        DockerStatsExposition.AppendSample(builder, prefix + ".cpu.percent", sample.AppId, sample.Service, cpu);
                    if (sample.MemoryBytes is { } memory)
                        DockerStatsExposition.AppendSample(builder, prefix + ".memory.bytes", sample.AppId, sample.Service, memory);
                    if (sample.Runtime == "docker" && sample.MemoryPercent is { } percent)
                        DockerStatsExposition.AppendSample(builder, "container.memory.percent", sample.AppId, sample.Service, percent);
                }
                exposition = builder.ToString();
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
            RuntimeResourceSampler sampler, DateTimeOffset? after, string? runId, CancellationToken cancellationToken) =>
            CoreSessionAuthorization.RequireAdminSessionAsync(request, users, clock,
                () => Task.FromResult(CoreJson.Json(sampler.Read(after, runId))), cancellationToken: cancellationToken));
    }
}
