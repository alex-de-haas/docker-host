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
    ILogger<TelemetryIngestService> logger,
    HttpMessageHandler? transport = null) : BackgroundService
{
    // Prometheus label the collector promotes from the `hosty.app.id` resource attribute (dots become
    // underscores). It attributes a scraped series to its app and is then dropped from the stored set.
    private const string AppAttributionLabel = "hosty_app_id";

    // Persisted-offset keys in the store's ingest_state table.
    private const string LogsTailKey = "logs";
    private const string TracesTailKey = "traces";

    // Core's log cursor, plus a fingerprint of the Core run it belongs to. The run id is a string and
    // ingest_state stores longs, so what is persisted is the first 8 bytes of its SHA-256 — enough to
    // notice "a different Core is answering now", without a schema change this backend has no
    // migration mechanism to perform.
    private const string CoreLogsCursorKey = "core-logs";
    private const string CoreLogsRunKey = "core-logs-run";

    // Pruning (DELETE + size check + vacuum + checkpoint) is expensive, so it runs on its own cadence
    // rather than every ingest tick; retention is coarse-grained so once a minute is ample.
    private static readonly TimeSpan PruneInterval = TimeSpan.FromMinutes(1);

    // Most a tick may spend pruning. The prune shares the ingest loop (and the store's lock) with the
    // log/trace tails, so an unbounded pass starves them: on a ceiling-pinned ~1 GiB database one
    // inline prune ran for minutes and the observed effect was logs/traces arriving in 3–4 minute
    // bursts. A quarter-second slice per one-second tick keeps tailing near-real-time while giving an
    // in-progress pass a ~25% duty cycle until it completes.
    private static readonly TimeSpan PruneStepBudget = TimeSpan.FromMilliseconds(250);

    private readonly FileTailReader tailReader = new();
    // `transport` is null in production (DI passes three arguments); tests hand in a stub so the pull
    // loop's cursor and restart handling can be exercised without a live Core.
    private readonly HttpClient httpClient = (transport is null ? new HttpClient() : new HttpClient(transport))
        .WithTimeout(TimeSpan.FromSeconds(5));

    // Byte offsets into the collector's OTLP-logs/-traces files the tail loops resume from each tick.
    // Loaded from the store at startup so a restart resumes instead of replaying the whole file.
    private long logTailOffset;
    private long traceTailOffset;

    // Where Core's own records were read up to, and which Core run that cursor belongs to.
    private long coreLogsCursor;
    private long coreLogsRunFingerprint;
    private DateTimeOffset lastPruneUtc = DateTimeOffset.MinValue;
    private DateTimeOffset lastMetricsScrapeUtc = DateTimeOffset.MinValue;
    private DateTimeOffset lastCoreLogsPullUtc = DateTimeOffset.MinValue;

    // True while a prune pass has used up its per-tick budget and still has work left; the next ticks
    // keep resuming it (after tailing) until the store reports the pass complete.
    private bool prunePassInProgress;

    // Skips re-inserting unchanged metric samples (the exporter re-serves last values every scrape).
    private readonly MetricDeduplicator metricDeduplicator = new();

    // Scrape targets currently failing, so each outage is logged on its edges (once when it starts, once
    // when it recovers) rather than on every scrape tick.
    private readonly HashSet<string> failingScrapeUrls = new(StringComparer.Ordinal);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await Task.Yield();

        // Resume from where the last run left off so a restart does not re-read (and re-insert) the
        // whole otelcol file-sink history.
        logTailOffset = store.GetTailOffset(LogsTailKey);
        traceTailOffset = store.GetTailOffset(TracesTailKey);
        ResumeCoreLogCursor();

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

        // Tail logs/traces every tick for near-real-time freshness, but scrape metrics on their own
        // slower cadence — the exporter re-serves last values, so tail-rate scraping just inflates the
        // store with duplicate rows (T-H2).
        if (now - lastMetricsScrapeUtc >= options.MetricsScrapeInterval)
        {
            await ScrapeMetricsAsync(now, cancellationToken);
            lastMetricsScrapeUtc = now;
        }

        await TailLogsAsync(now, cancellationToken);
        await TailTracesAsync(cancellationToken);

        if (now - lastCoreLogsPullUtc >= options.CoreLogsPullInterval)
        {
            await PullCoreLogsAsync(now, cancellationToken);
            lastCoreLogsPullUtc = now;
        }

        // Prune on its own cadence, not every tick — and in bounded slices, never as one blocking
        // pass: each tick spends at most PruneStepBudget, and an unfinished pass resumes next tick
        // (tailing above always runs first, so a heavy pass cannot stall the tail).
        if (prunePassInProgress || now - lastPruneUtc >= PruneInterval)
        {
            prunePassInProgress = !store.PruneStep(now, PruneStepBudget);
            if (!prunePassInProgress)
            {
                lastPruneUtc = now;
            }
        }
    }

    private async Task ScrapeMetricsAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        var nowMs = now.ToUnixTimeMilliseconds();
        var samples = new List<MetricSample>();
        // Two Prometheus targets: the collector (app OTLP metrics) and Core (host-privileged docker
        // stats). Both promote the app id to a `hosty_app_id` label, so attribution is identical.
        //
        // Only the Core target carries our service token. The collector is a third-party image on the
        // per-app network: sending it a Hosty credential would hand our identity to something we do not
        // control, for a scrape it does not authenticate anyway.
        await ScrapeIntoAsync(samples, options.MetricsScrapeUrl, nowMs, bearerToken: null, cancellationToken);
        await ScrapeIntoAsync(samples, options.DockerMetricsScrapeUrl, nowMs, options.CoreServiceToken, cancellationToken);
        store.RecordMetrics(metricDeduplicator.Filter(samples, nowMs, (long)options.MetricsHeartbeat.TotalMilliseconds));
    }

    private async Task ScrapeIntoAsync(
        List<MetricSample> samples,
        string? url,
        long nowMs,
        string? bearerToken,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(url))
        {
            return;
        }

        var (text, failure) = await FetchAsync(url, bearerToken, cancellationToken);
        if (text is null)
        {
            // Log the transition, not every tick: a misconfigured or down target fails on the scrape
            // cadence forever, and a warning every 15 s would drown the log it is meant to surface in.
            // Silence here is what hid a target pointed at the wrong port — the whole signal was simply
            // missing from the UI with nothing anywhere to say why.
            if (failingScrapeUrls.Add(url))
            {
                logger.LogWarning("Metrics scrape of {Url} failed ({Failure}); this target contributes no metrics until it recovers.", url, failure);
            }

            return;
        }

        if (failingScrapeUrls.Remove(url))
        {
            logger.LogInformation("Metrics scrape of {Url} recovered.", url);
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

    // GETs the scrape endpoint. A null body on any transport/timeout/non-success keeps the loop treating
    // an unreachable collector as "no data", never an error — but the paired reason string lets the
    // caller say *why* once, which distinguishes the two failures that look identical from the UI:
    // a target that is down (connection refused) and one pointed at the wrong port (404).
    // Loaded at startup so a backend restart resumes Core's stream instead of replaying or skipping it.
    internal void ResumeCoreLogCursor()
    {
        coreLogsCursor = store.GetTailOffset(CoreLogsCursorKey);
        coreLogsRunFingerprint = store.GetTailOffset(CoreLogsRunKey);
    }

    // Core's own log records, the one stream whose producer is the host kernel. Core keeps them in
    // memory and we ask for them; it deliberately runs no OpenTelemetry SDK and pushes nothing (see
    // docs/features/observability/feature.md).
    internal async Task PullCoreLogsAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(options.CoreLogsPullUrl))
        {
            return;
        }

        var requestedCursor = coreLogsCursor;
        var page = await FetchCoreLogsAsync(requestedCursor, now, cancellationToken);
        if (page is null)
        {
            return;
        }

        // A different Core is answering: its rings restarted at sequence 1, so a cursor carried over
        // from the previous run points past records that no longer exist and would silently swallow the
        // whole new run. Adopt the new run, and re-ask from its start — the same reset the file tails
        // perform on rotation.
        var fingerprint = RunFingerprint(page.RunId);
        if (fingerprint != coreLogsRunFingerprint)
        {
            coreLogsRunFingerprint = fingerprint;
            store.SaveTailOffset(CoreLogsRunKey, fingerprint);

            // Only when the cursor we just used belonged to that older run. A zero cursor already asked
            // from the beginning, so the page in hand is complete — re-asking would just fetch it twice,
            // which is what a first pull against a fresh store used to do.
            if (requestedCursor > 0)
            {
                coreLogsCursor = 0;
                store.SaveTailOffset(CoreLogsCursorKey, 0);

                page = await FetchCoreLogsAsync(0, now, cancellationToken);
                if (page is null)
                {
                    return;
                }
            }
        }

        // Record first, advance the cursor only once the write succeeded — a transient store failure
        // re-reads the page next tick rather than dropping it, exactly like the file tails.
        if (page.Records.Count > 0)
        {
            store.RecordLogs(page.Records);
        }

        if (page.NextCursor != coreLogsCursor)
        {
            coreLogsCursor = page.NextCursor;
            store.SaveTailOffset(CoreLogsCursorKey, coreLogsCursor);
        }
    }

    private async Task<ParsedCoreLogPull?> FetchCoreLogsAsync(long after, DateTimeOffset now, CancellationToken cancellationToken)
    {
        // `failingScrapeUrls` is keyed by target URL, so this tracks by the pull URL like every other
        // target — but by the base URL, not the request: the cursor in the query string changes on
        // every call, so keying by the request would report a fresh outage each pull and never clear.
        var target = options.CoreLogsPullUrl ?? string.Empty;
        var (body, failure) = await FetchAsync($"{target}?after={after}", options.CoreServiceToken, cancellationToken);
        if (body is null)
        {
            // Edges only, like the metrics targets: Core being down is already loud elsewhere, and a
            // warning every pull would bury the records this exists to surface.
            if (failingScrapeUrls.Add(target))
            {
                logger.LogWarning("Core log pull from {Url} failed ({Failure}); Core's own logs stop until it recovers.", target, failure);
            }

            return null;
        }

        if (failingScrapeUrls.Remove(target))
        {
            logger.LogInformation("Core log pull from {Url} recovered.", target);
        }

        return CoreLogPullParser.Parse(body, now);
    }

    // Stable 64-bit fingerprint of Core's run id, so a string identity survives in a long-valued column.
    private static long RunFingerprint(string runId)
        => BitConverter.ToInt64(System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(runId)), 0);

    private async Task<(string? Body, string? Failure)> FetchAsync(string url, string? bearerToken, CancellationToken cancellationToken)
    {
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            if (!string.IsNullOrWhiteSpace(bearerToken))
            {
                request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", bearerToken);
            }

            using var response = await httpClient.SendAsync(request, cancellationToken);
            return response.IsSuccessStatusCode
                ? (await response.Content.ReadAsStringAsync(cancellationToken), null)
                : (null, $"HTTP {(int)response.StatusCode}");
        }
        catch (Exception ex) when (
            ex is HttpRequestException or IOException or UriFormatException or InvalidOperationException ||
            (ex is TaskCanceledException && !cancellationToken.IsCancellationRequested))
        {
            return (null, ex.Message);
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

internal static class HttpClientTimeoutExtensions
{
    public static HttpClient WithTimeout(this HttpClient client, TimeSpan timeout)
    {
        client.Timeout = timeout;
        return client;
    }
}
