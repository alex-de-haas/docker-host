namespace Haas.Hosty.TelemetryBackend;

// Background poller that fills the SQLite store from the otelcol collector, then prunes. Each tick it:
//   1. scrapes the collector's Prometheus /metrics (app-exported OTLP metrics re-exposed by the
//      collector) and attributes each series to its app via the promoted `hosty_app_id` label,
//   2. tails the collector's OTLP-logs file, parsing newly-appended OTLP/JSON into the store, and
//   3. tails the collector's OTLP-traces file the same way,
//   4. prunes past-retention / over-ceiling data.
// This is the producer→store half that used to live in Core's TelemetryScrapeService, moved into the
// backend (Phase 2). It does NOT collect docker stats or docker logs — those need host Docker access
// and stay in Core, which pushes them to the collector as a producer. Best-effort throughout: an
// unreachable collector or absent file yields no data for that tick and is skipped silently.
internal sealed class TelemetryIngestService(
    TelemetryBackendOptions options,
    SqliteTelemetryStore store,
    ILogger<TelemetryIngestService> logger) : BackgroundService
{
    // Prometheus label the collector promotes from the `hosty.app.id` resource attribute (dots become
    // underscores). It attributes a scraped series to its app and is then dropped from the stored set.
    private const string AppAttributionLabel = "hosty_app_id";

    // Persisted-offset keys in the store's ingest_state table.
    private const string LogsTailKey = "logs";
    private const string TracesTailKey = "traces";

    // Pruning (DELETE + size check + vacuum + checkpoint) is expensive, so it runs on its own cadence
    // rather than every ingest tick; retention is coarse-grained so once a minute is ample.
    private static readonly TimeSpan PruneInterval = TimeSpan.FromMinutes(1);

    private readonly FileTailReader tailReader = new();
    private readonly HttpClient httpClient = new() { Timeout = TimeSpan.FromSeconds(5) };

    // Byte offsets into the collector's OTLP-logs/-traces files the tail loops resume from each tick.
    // Loaded from the store at startup so a restart resumes instead of replaying the whole file.
    private long logTailOffset;
    private long traceTailOffset;
    private DateTimeOffset lastPruneUtc = DateTimeOffset.MinValue;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await Task.Yield();

        // Resume from where the last run left off so a restart does not re-read (and re-insert) the
        // whole otelcol file-sink history.
        logTailOffset = store.GetTailOffset(LogsTailKey);
        traceTailOffset = store.GetTailOffset(TracesTailKey);

        using var timer = new PeriodicTimer(options.IngestInterval);
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                await IngestTickAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Telemetry ingest tick failed.");
            }
        }
    }

    private async Task IngestTickAsync(CancellationToken cancellationToken)
    {
        var now = DateTimeOffset.UtcNow;
        await ScrapeMetricsAsync(now, cancellationToken);
        await TailLogsAsync(now, cancellationToken);
        await TailTracesAsync(cancellationToken);

        // Prune on its own cadence, not every tick — the deletes/vacuum/checkpoint are far heavier than
        // an ingest tick and retention is coarse.
        if (now - lastPruneUtc >= PruneInterval)
        {
            store.Prune(now);
            lastPruneUtc = now;
        }
    }

    private async Task ScrapeMetricsAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        var nowMs = now.ToUnixTimeMilliseconds();
        var samples = new List<MetricSample>();
        // Two Prometheus targets: the collector (app OTLP metrics) and Core (host-privileged docker
        // stats). Both promote the app id to a `hosty_app_id` label, so attribution is identical.
        await ScrapeIntoAsync(samples, options.MetricsScrapeUrl, nowMs, cancellationToken);
        await ScrapeIntoAsync(samples, options.DockerMetricsScrapeUrl, nowMs, cancellationToken);
        store.RecordMetrics(samples);
    }

    private async Task ScrapeIntoAsync(List<MetricSample> samples, string? url, long nowMs, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(url))
        {
            return;
        }

        var text = await FetchAsync(url, cancellationToken);
        if (text is null)
        {
            return;
        }

        foreach (var sample in PrometheusTextParser.Parse(text))
        {
            if (!sample.Labels.TryGetValue(AppAttributionLabel, out var appId) || string.IsNullOrWhiteSpace(appId))
            {
                continue;
            }

            IReadOnlyDictionary<string, string> labels = EmptyLabels;
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

            samples.Add(new MetricSample(appId, sample.Name, labels, sample.Value, nowMs));
        }
    }

    private async Task TailLogsAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        var read = await tailReader.ReadAsync(options.LogsFilePath, logTailOffset, cancellationToken);
        if (read is not { } chunk)
        {
            return;
        }

        // Record first; only advance (and persist) the offset once the write succeeds, so a transient
        // store failure re-reads the chunk next tick instead of silently dropping it.
        if (!string.IsNullOrEmpty(chunk.Content))
        {
            store.RecordLogs(OtlpLogsJsonParser.Parse(chunk.Content, now));
        }

        if (chunk.NextOffset != logTailOffset)
        {
            logTailOffset = chunk.NextOffset;
            store.SaveTailOffset(LogsTailKey, logTailOffset);
        }
    }

    private async Task TailTracesAsync(CancellationToken cancellationToken)
    {
        var read = await tailReader.ReadAsync(options.TracesFilePath, traceTailOffset, cancellationToken);
        if (read is not { } chunk)
        {
            return;
        }

        // Record first, then advance/persist the offset — see TailLogsAsync.
        if (!string.IsNullOrEmpty(chunk.Content))
        {
            store.RecordSpans(OtlpTracesJsonParser.Parse(chunk.Content));
        }

        if (chunk.NextOffset != traceTailOffset)
        {
            traceTailOffset = chunk.NextOffset;
            store.SaveTailOffset(TracesTailKey, traceTailOffset);
        }
    }

    // GETs the scrape endpoint, returning null on any transport/timeout/non-success so the loop treats
    // an unreachable collector as "no data", never an error. Ported from Core's HttpMetricsScrapeClient.
    private async Task<string?> FetchAsync(string url, CancellationToken cancellationToken)
    {
        try
        {
            using var response = await httpClient.GetAsync(url, cancellationToken);
            return response.IsSuccessStatusCode
                ? await response.Content.ReadAsStringAsync(cancellationToken)
                : null;
        }
        catch (Exception ex) when (
            ex is HttpRequestException or IOException or UriFormatException or InvalidOperationException ||
            (ex is TaskCanceledException && !cancellationToken.IsCancellationRequested))
        {
            return null;
        }
    }

    public override void Dispose()
    {
        httpClient.Dispose();
        base.Dispose();
    }

    private static readonly IReadOnlyDictionary<string, string> EmptyLabels =
        new Dictionary<string, string>(StringComparer.Ordinal);
}
