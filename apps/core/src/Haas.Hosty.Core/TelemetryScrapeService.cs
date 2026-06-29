namespace Haas.Hosty.Core;

// Fetches a metrics endpoint's text body. Abstracted so the scrape loop is testable without a live
// HTTP server and so the production HttpClient is owned in one place.
internal interface IMetricsScrapeClient
{
    Task<string?> FetchAsync(string url, CancellationToken cancellationToken = default);
}

// Default scrape client: one reused HttpClient with a short timeout (a scrape that does not answer
// quickly is skipped this tick, not awaited). Returns null on any transport failure or non-success
// status so the loop treats an unreachable collector as "no data", never an error.
internal sealed class HttpMetricsScrapeClient : IMetricsScrapeClient, IDisposable
{
    private readonly HttpClient client = new() { Timeout = TimeSpan.FromSeconds(5) };

    public async Task<string?> FetchAsync(string url, CancellationToken cancellationToken = default)
    {
        try
        {
            using var response = await client.GetAsync(url, cancellationToken);
            return response.IsSuccessStatusCode
                ? await response.Content.ReadAsStringAsync(cancellationToken)
                : null;
        }
        // Any transport, timeout, or malformed-URL failure means "no data this tick", never a crash:
        // HttpRequestException/IOException (transport), TaskCanceledException (timeout, when not our
        // own cancellation), and UriFormatException/InvalidOperationException (a bad endpoint URL).
        catch (Exception ex) when (
            ex is HttpRequestException or System.IO.IOException or UriFormatException or InvalidOperationException ||
            (ex is TaskCanceledException && !cancellationToken.IsCancellationRequested))
        {
            return null;
        }
    }

    public void Dispose() => client.Dispose();
}

// A chunk of newly-appended log file bytes, decoded to text, plus the byte offset to resume from on
// the next tick. Content is aligned to whole lines (any trailing partial line is left for next time).
internal readonly record struct LogTailRead(string Content, long NextOffset);

// Reads newly-appended content from the collector's OTLP-logs file. Abstracted so the scrape loop can
// be tested without real file I/O, and so the offset/rotation handling lives in one place.
internal interface ILogTailReader
{
    Task<LogTailRead?> ReadAsync(string path, long fromOffset, CancellationToken cancellationToken = default);
}

// Default tail reader: opens the file shared-read (the collector is appending to it), resumes from the
// caller's offset, and aligns to whole lines so a half-flushed final line is re-read next tick rather
// than parsed incomplete. Resets to the start when the file is shorter than the offset (the file
// exporter rotated/truncated). Caps the per-tick read so a large backlog cannot spike memory. Returns
// null when the file is absent or unreadable this tick — the collector simply produced nothing yet.
internal sealed class FileLogTailReader : ILogTailReader
{
    private const long MaxBytesPerRead = 4 * 1024 * 1024;

    public async Task<LogTailRead?> ReadAsync(string path, long fromOffset, CancellationToken cancellationToken = default)
    {
        try
        {
            if (!File.Exists(path))
            {
                return null;
            }

            await using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            var length = stream.Length;
            // A file shorter than where we left off means it rotated/truncated: start over from 0.
            var start = fromOffset < 0 || fromOffset > length ? 0 : fromOffset;
            var available = length - start;
            if (available <= 0)
            {
                return new LogTailRead(string.Empty, length);
            }

            // Skip ahead past a large backlog (e.g. after a long Core stall) to bound this tick's read.
            if (available > MaxBytesPerRead)
            {
                start = length - MaxBytesPerRead;
                available = MaxBytesPerRead;
            }

            stream.Seek(start, SeekOrigin.Begin);
            // available is now capped to MaxBytesPerRead, so it fits an int; cast makes the bound explicit.
            var buffer = new byte[(int)available];
            var total = 0;
            while (total < buffer.Length)
            {
                var read = await stream.ReadAsync(buffer.AsMemory(total), cancellationToken);
                if (read == 0)
                {
                    break;
                }

                total += read;
            }

            if (total <= 0)
            {
                return new LogTailRead(string.Empty, start);
            }

            // Consume only through the last complete line; the trailing partial waits for next tick.
            var lastNewline = Array.LastIndexOf(buffer, (byte)'\n', total - 1, total);
            if (lastNewline < 0)
            {
                return new LogTailRead(string.Empty, start);
            }

            var consume = lastNewline + 1;
            var content = System.Text.Encoding.UTF8.GetString(buffer, 0, consume);
            return new LogTailRead(content, start + consume);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }
}

// Which app/service a hosty container belongs to, read back from its `hosty.app.*` docker labels.
internal sealed record ContainerOwner(string AppId, string Service);

// Background poller that fills the in-memory telemetry stores (observability v1, P3+P4). Each tick it:
//   1. scrapes the collector's Prometheus /metrics (app-exported OTLP metrics, re-exposed by the
//      collector) and attributes each series to its app via the promoted `hosty_app_id` label,
//   2. collects container infra metrics itself with `docker stats` — keeping the collector container
//      unprivileged — attributing each container to its app/service via the `hosty.app.*` labels Core
//      already stamps at run, and
//   3. tails the collector's OTLP-logs file (P4), parsing the newly-appended OTLP/JSON into the log
//      store, attributing each record to its app via its `hosty.app.id` resource attribute.
// See docs/features/observability.md. Gated behind ObservabilityEnabled: when observability is off the
// collector is never installed and this loop does nothing. Best-effort throughout — an unreachable
// collector or docker yields no data for that tick and is skipped silently (no per-tick log spam);
// only an unexpected tick-level failure is logged. Each tick also prunes the stores so series and
// records that stop emitting are reclaimed.
internal sealed class TelemetryScrapeService(
    HostyCoreRuntimeConfig config,
    CoreDataPaths paths,
    AppRegistryStore apps,
    IMetricStore store,
    ILogStore logStore,
    IClock clock,
    IMetricsScrapeClient scrapeClient,
    ILogTailReader logTailReader,
    IDockerCommandRunner dockerRunner,
    ILogger<TelemetryScrapeService> logger) : BackgroundService
{
    private static readonly TimeSpan ScrapeInterval = TimeSpan.FromSeconds(10);

    // Byte offset into the collector's OTLP-logs file the tail loop resumes from each tick.
    private long logTailOffset;

    // Prometheus label the collector promotes from the `hosty.app.id` resource attribute (dots become
    // underscores). It attributes a scraped series to its app, so it is consumed for routing and then
    // dropped from the stored label set (the series is already keyed by app).
    internal const string AppAttributionLabel = "hosty_app_id";

    // Core-collected container infra metric names. Labelled with the originating `service`.
    internal const string ContainerCpuPercentMetric = "container.cpu.percent";
    internal const string ContainerMemoryBytesMetric = "container.memory.bytes";
    internal const string ContainerMemoryPercentMetric = "container.memory.percent";

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!config.ObservabilityEnabled)
        {
            return;
        }

        await Task.Yield();
        using var timer = new PeriodicTimer(ScrapeInterval);
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                await ScrapeTickAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Telemetry scrape tick failed.");
            }
        }
    }

    private async Task ScrapeTickAsync(CancellationToken cancellationToken)
    {
        var now = clock.UtcNow;
        await ScrapeCollectorMetricsAsync(now, cancellationToken);
        await ScrapeContainerStatsAsync(now, cancellationToken);
        await TailOtlpLogsAsync(now, cancellationToken);
        // Reclaim points/series/records that aged out of the window even if their producer stopped.
        store.Prune(now);
        logStore.Prune(now);
    }

    // Reads the OTLP-logs file the collector appends to (P4), parses the newly-appended OTLP/JSON, and
    // records each line into the log store under its attributed app. Best-effort: an absent or
    // unreadable file (collector off, nothing logged yet) yields no records this tick.
    private async Task TailOtlpLogsAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        var path = CollectorBootstrap.ResolveHostLogsFilePath(paths.AppsRoot);
        var read = await logTailReader.ReadAsync(path, logTailOffset, cancellationToken);
        if (read is not { } chunk)
        {
            return;
        }

        logTailOffset = chunk.NextOffset;
        if (string.IsNullOrEmpty(chunk.Content))
        {
            return;
        }

        foreach (var parsed in OtlpLogsJsonParser.Parse(chunk.Content, now))
        {
            logStore.Record(parsed.AppId, parsed.Record);
        }
    }

    private async Task ScrapeCollectorMetricsAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        var endpoint = await ResolveCollectorMetricsUrlAsync(cancellationToken);
        if (endpoint is null)
        {
            return;
        }

        var text = await scrapeClient.FetchAsync(endpoint, cancellationToken);
        IngestPrometheusSamples(store, PrometheusTextParser.Parse(text), now);
    }

    // The collector's loopback `metrics` endpoint URL (resolved at its last start), with the
    // Prometheus exporter's `/metrics` path appended. Null when the collector is absent or has not
    // published the endpoint yet.
    private async Task<string?> ResolveCollectorMetricsUrlAsync(CancellationToken cancellationToken)
    {
        var collector = await apps.GetAppAsync(CollectorBootstrap.AppId, cancellationToken);
        var endpoint = (collector?.Endpoints ?? []).FirstOrDefault(candidate =>
            string.Equals(candidate.Key, CollectorBootstrap.MetricsEndpointKey, StringComparison.Ordinal));
        if (string.IsNullOrWhiteSpace(endpoint?.Url))
        {
            return null;
        }

        return $"{endpoint.Url.TrimEnd('/')}/metrics";
    }

    // Attributes each scraped sample to its app via the promoted `hosty_app_id` label and records it
    // under the remaining labels. Samples without that label cannot be attributed and are skipped.
    internal static void IngestPrometheusSamples(IMetricStore store, IReadOnlyList<PrometheusSample> samples, DateTimeOffset now)
    {
        foreach (var sample in samples)
        {
            if (!sample.Labels.TryGetValue(AppAttributionLabel, out var appId) || string.IsNullOrWhiteSpace(appId))
            {
                continue;
            }

            IReadOnlyDictionary<string, string>? labels = null;
            if (sample.Labels.Count > 1)
            {
                var copy = new Dictionary<string, string>(StringComparer.Ordinal);
                foreach (var label in sample.Labels)
                {
                    if (!string.Equals(label.Key, AppAttributionLabel, StringComparison.Ordinal))
                    {
                        copy[label.Key] = label.Value;
                    }
                }

                labels = copy;
            }

            store.Record(appId, sample.Name, labels, sample.Value, now);
        }
    }

    private async Task ScrapeContainerStatsAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        var index = ParseContainerOwners(await RunDockerOrEmptyAsync(
            ["ps", "--no-trunc", "--filter", "label=hosty.app.id", "--format",
                "{{.Names}}\t{{.Label \"hosty.app.id\"}}\t{{.Label \"hosty.app.service\"}}"],
            cancellationToken));
        if (index.Count == 0)
        {
            return;
        }

        var stats = DockerStatsParser.Parse(await RunDockerOrEmptyAsync(
            ["stats", "--no-stream", "--format", "{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}"],
            cancellationToken));
        IngestContainerStats(store, stats, index, now);
    }

    // Parses the `docker ps` label projection into a container-name → owner map.
    internal static IReadOnlyDictionary<string, ContainerOwner> ParseContainerOwners(string? output)
    {
        var owners = new Dictionary<string, ContainerOwner>(StringComparer.Ordinal);
        if (string.IsNullOrWhiteSpace(output))
        {
            return owners;
        }

        foreach (var rawLine in output.Split('\n'))
        {
            var fields = rawLine.Trim().Split('\t');
            if (fields.Length < 2 || string.IsNullOrWhiteSpace(fields[0]) || string.IsNullOrWhiteSpace(fields[1]))
            {
                continue;
            }

            var service = fields.Length > 2 && !string.IsNullOrWhiteSpace(fields[2]) ? fields[2].Trim() : fields[1].Trim();
            owners[fields[0].Trim()] = new ContainerOwner(fields[1].Trim(), service);
        }

        return owners;
    }

    // Records each running container's cpu/memory usage under its owning app, labelled with the
    // service. A stat line for a container Core does not own (no `hosty.app.*` labels) is ignored.
    internal static void IngestContainerStats(
        IMetricStore store,
        IReadOnlyList<DockerContainerStat> stats,
        IReadOnlyDictionary<string, ContainerOwner> owners,
        DateTimeOffset now)
    {
        foreach (var stat in stats)
        {
            if (!owners.TryGetValue(stat.ContainerName, out var owner))
            {
                continue;
            }

            var labels = new Dictionary<string, string>(StringComparer.Ordinal) { ["service"] = owner.Service };
            if (stat.CpuPercent is { } cpu)
            {
                store.Record(owner.AppId, ContainerCpuPercentMetric, labels, cpu, now);
            }

            if (stat.MemoryBytes is { } memBytes)
            {
                store.Record(owner.AppId, ContainerMemoryBytesMetric, labels, memBytes, now);
            }

            if (stat.MemoryPercent is { } memPercent)
            {
                store.Record(owner.AppId, ContainerMemoryPercentMetric, labels, memPercent, now);
            }
        }
    }

    // Runs a read-only docker command for its stdout, returning empty when docker is unavailable or
    // exits non-zero — infra metrics are best-effort and a docker-less host simply gets none.
    private async Task<string> RunDockerOrEmptyAsync(IReadOnlyList<string> args, CancellationToken cancellationToken)
    {
        try
        {
            var result = await dockerRunner.RunAsync(args, cancellationToken);
            return result.ExitCode == 0 ? result.StandardOutput : string.Empty;
        }
        catch (DockerUnavailableException)
        {
            return string.Empty;
        }
    }
}
