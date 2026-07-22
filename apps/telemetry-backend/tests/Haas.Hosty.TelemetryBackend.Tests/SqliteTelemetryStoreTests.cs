using Xunit;
using Haas.Hosty.TelemetryBackend;

namespace Haas.Hosty.TelemetryBackend.Tests;

// Exercises the SQLite store's record/query/prune behaviour against a real temp-file database.
public sealed class SqliteTelemetryStoreTests : IDisposable
{
    private readonly string dbPath = Path.Combine(Path.GetTempPath(), $"hosty-tel-{Guid.NewGuid():N}.db");
    private SqliteTelemetryStore? store;

    private SqliteTelemetryStore Store(
        TimeSpan? metricsRetention = null, TimeSpan? logsRetention = null,
        TimeSpan? tracesRetention = null, long? maxBytes = null)
    {
        store?.Dispose();
        store = new SqliteTelemetryStore(new TelemetryBackendOptions
        {
            DatabasePath = dbPath,
            LogsFilePath = string.Empty,
            TracesFilePath = string.Empty,
            MetricsRetention = metricsRetention ?? TimeSpan.FromHours(1),
            LogsRetention = logsRetention ?? TimeSpan.FromHours(1),
            TracesRetention = tracesRetention ?? TimeSpan.FromHours(1),
            MaxDatabaseBytes = maxBytes ?? (1L * 1024 * 1024 * 1024),
        });
        return store;
    }

    private static IReadOnlyDictionary<string, string> Labels(params (string Key, string Value)[] pairs)
    {
        var map = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var (key, value) in pairs)
        {
            map[key] = value;
        }

        return map;
    }

    [Fact]
    public void Metrics_GroupPointsIntoSeriesByNameAndLabels()
    {
        var s = Store();
        s.RecordMetrics(
        [
            new MetricSample("app", "cpu", Labels(("service", "web")), 1.0, 1000),
            new MetricSample("app", "cpu", Labels(("service", "web")), 2.0, 2000),
            new MetricSample("app", "cpu", Labels(("service", "db")), 3.0, 1500),
        ]);

        var series = s.QueryMetrics("app", 0);
        Assert.Equal(2, series.Count);
        var web = Assert.Single(series, x => x.Labels.TryGetValue("service", out var v) && v == "web");
        Assert.Equal(2, web.Points.Count);
        Assert.Equal([1.0, 2.0], web.Points.Select(p => p.Value));
    }

    [Fact]
    public void Metrics_SinceFiltersOldPoints()
    {
        var s = Store();
        s.RecordMetrics(
        [
            new MetricSample("app", "cpu", Labels(), 1.0, 1000),
            new MetricSample("app", "cpu", Labels(), 2.0, 5000),
        ]);

        var series = Assert.Single(s.QueryMetrics("app", 3000));
        var point = Assert.Single(series.Points);
        Assert.Equal(2.0, point.Value);
    }

    [Fact]
    public void Metrics_DropsNonFiniteValues()
    {
        var s = Store();
        s.RecordMetrics(
        [
            new MetricSample("app", "cpu", Labels(), double.NaN, 1000),
            new MetricSample("app", "cpu", Labels(), double.PositiveInfinity, 1000),
            new MetricSample("app", "cpu", Labels(), 7.0, 1000),
        ]);

        var series = Assert.Single(s.QueryMetrics("app", 0));
        Assert.Equal(7.0, Assert.Single(series.Points).Value);
    }

    [Fact]
    public void OtlpLogs_FilterBySeverityAndLimitNewestChronological()
    {
        var s = Store();
        s.RecordLogs(
        [
            Log("app", 1000, 9, "info one"),
            Log("app", 2000, 17, "error two"),
            Log("app", 3000, 5, "debug three"),
            Log("app", 4000, 17, "error four"),
        ]);

        // severity >= 9 keeps the three non-debug records; limit 2 keeps the newest two, chronological.
        var records = s.QueryOtlpLogs("app", 0, minSeverity: 9, limit: 2);
        Assert.Equal(["error two", "error four"], records.Select(r => r.Body));
    }

    [Fact]
    public void FleetLogs_AppFilterQuerySubstringAndCap()
    {
        var s = Store();
        s.RecordLogs(
        [
            Log("a", 1000, 9, "hello alpha"),
            Log("b", 2000, 9, "hello beta"),
            Log("c", 3000, 9, "goodbye gamma"),
        ]);

        // Filter to apps a,b; body contains "hello" (case-insensitive); newest-last order.
        var records = s.QueryFleetLogs(0, null, 10, new[] { "a", "b" }, "HELLO");
        Assert.Equal(["a", "b"], records.Select(r => r.AppId));
        Assert.Equal(["hello alpha", "hello beta"], records.Select(r => r.Record.Body));
    }

    [Fact]
    public void Traces_WindowAndByTraceIdAcrossApps()
    {
        var s = Store();
        s.RecordSpans(
        [
            Span("a", "trace1", "s1", null, 10_000, 20_000),
            Span("b", "trace1", "s2", "s1", 12_000, 15_000),
            Span("a", "trace2", "s3", null, 5_000, 6_000),
        ]);

        var windowed = s.QueryInWindowSpans(8_000, null, 100);
        Assert.Equal(2, windowed.Count); // trace2 (start 5000) excluded by the 8000 floor

        var trace1 = s.QueryTraceSpans("TRACE1"); // case-insensitive
        Assert.Equal(2, trace1.Count);
        Assert.Contains(trace1, x => x.AppId == "a");
        Assert.Contains(trace1, x => x.AppId == "b");
    }

    [Fact]
    public void TailOffset_PersistsAndDefaultsToZero()
    {
        var s = Store();
        Assert.Equal(0, s.GetTailOffset("logs"));
        s.SaveTailOffset("logs", 4242);
        s.SaveTailOffset("logs", 5000); // upsert overwrites
        Assert.Equal(5000, s.GetTailOffset("logs"));
        Assert.Equal(0, s.GetTailOffset("traces"));
    }

    [Fact]
    public void Traces_TraceIdNormalizedToLowercaseOnWrite()
    {
        var s = Store();
        s.RecordSpans([Span("a", "ABCDEF", "s1", null, 10_000, 20_000)]);

        // Stored lowercase, so both mixed- and lower-case lookups resolve via the binary index.
        Assert.Single(s.QueryTraceSpans("abcdef"));
        Assert.Single(s.QueryTraceSpans("AbCdEf"));
    }

    [Fact]
    public void Prune_EvictsDataPastAgeCap()
    {
        var s = Store(metricsRetention: TimeSpan.FromMinutes(30));
        var now = DateTimeOffset.UtcNow;
        var oldMs = now.AddHours(-2).ToUnixTimeMilliseconds();
        var freshMs = now.ToUnixTimeMilliseconds();
        s.RecordMetrics(
        [
            new MetricSample("app", "cpu", Labels(), 1.0, oldMs),
            new MetricSample("app", "cpu", Labels(), 2.0, freshMs),
        ]);

        s.Prune(now);

        var series = Assert.Single(s.QueryMetrics("app", 0));
        Assert.Equal(2.0, Assert.Single(series.Points).Value);
    }

    [Fact]
    public void SizeCeiling_EvictsTheBloatedSignalAndSparesScarceOnes()
    {
        // Ceiling far below the metrics flood but far above the handful of log/span rows: the trim
        // must land on metric_points only. (The regression this guards: trimming the oldest chunk from
        // EVERY table per iteration wiped the scarce signals' few rows while metrics pinned the file.)
        var s = Store(maxBytes: 4L * 1024 * 1024);
        var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var nowNano = nowMs * 1_000_000L;

        var pad = new string('x', 400);
        var samples = new List<MetricSample>(20_000);
        for (var i = 0; i < 20_000; i++)
        {
            samples.Add(new MetricSample("app", "cpu", Labels(("pad", pad)), i, nowMs - i));
        }

        s.RecordMetrics(samples);
        var logs = new List<ParsedOtlpLog>(20);
        for (var i = 0; i < 20; i++)
        {
            logs.Add(Log("app", nowMs - i, 9, $"log {i}"));
        }

        s.RecordLogs(logs);
        s.RecordSpans([Span("app", "trace1", "s1", null, nowNano - 1000, nowNano)]);

        s.Prune(DateTimeOffset.UtcNow);

        Assert.Equal(20, s.QueryOtlpLogs("app", 0, null, 100).Count);
        Assert.Single(s.QueryTraceSpans("trace1"));
        var metricPoints = s.QueryMetrics("app", 0).Sum(x => x.Points.Count);
        Assert.InRange(metricPoints, 1, 19_999); // trimmed, but not wiped: the ceiling was reached first
    }

    [Fact]
    public void TrimSelection_TargetsTheDominantTableOnly()
    {
        var targets = SqliteTelemetryStore.SelectTrimTargets(
        [
            new TableSizeEstimate("metric_points", Rows: 1_000_000, AvgRowBytes: 1000),
            new TableSizeEstimate("log_records", Rows: 100, AvgRowBytes: 200),
            new TableSizeEstimate("spans", Rows: 1000, AvgRowBytes: 500),
        ]);

        Assert.Equal(["metric_points"], targets.Select(t => t.Table));
    }

    [Fact]
    public void TrimSelection_TrimsEvenlyWhenSizesComparable()
    {
        // All within ComparableSizeFactor of the largest → no single signal is at fault.
        var targets = SqliteTelemetryStore.SelectTrimTargets(
        [
            new TableSizeEstimate("metric_points", Rows: 1000, AvgRowBytes: 400),
            new TableSizeEstimate("log_records", Rows: 1000, AvgRowBytes: 200),
            new TableSizeEstimate("spans", Rows: 1000, AvgRowBytes: 100),
        ]);

        Assert.Equal(["metric_points", "log_records", "spans"], targets.Select(t => t.Table));
    }

    [Fact]
    public void TrimSelection_SparesSmallAndEmptyTables()
    {
        var targets = SqliteTelemetryStore.SelectTrimTargets(
        [
            new TableSizeEstimate("metric_points", Rows: 10_000, AvgRowBytes: 400),
            new TableSizeEstimate("log_records", Rows: 4000, AvgRowBytes: 300), // within factor 4
            new TableSizeEstimate("spans", Rows: 0, AvgRowBytes: 0),
        ]);
        Assert.Equal(["metric_points", "log_records"], targets.Select(t => t.Table));

        Assert.Empty(SqliteTelemetryStore.SelectTrimTargets(
        [
            new TableSizeEstimate("metric_points", Rows: 0, AvgRowBytes: 0),
            new TableSizeEstimate("log_records", Rows: 0, AvgRowBytes: 0),
        ]));
    }

    [Fact]
    public void PruneStep_BoundedBudgetMakesIncrementalProgressAndCompletes()
    {
        var s = Store(metricsRetention: TimeSpan.FromMinutes(30));
        var now = DateTimeOffset.UtcNow;
        var oldMs = now.AddHours(-2).ToUnixTimeMilliseconds();
        var samples = new List<MetricSample>(12_000);
        for (var i = 0; i < 12_000; i++)
        {
            samples.Add(new MetricSample("app", "cpu", Labels(), i, oldMs - i));
        }

        s.RecordMetrics(samples);

        // Zero budget: one bounded chunk per call, so a caller interleaving ingest with steps gets the
        // store back promptly instead of waiting out the whole pass.
        Assert.False(s.PruneStep(now, TimeSpan.Zero));
        var afterFirstStep = s.QueryMetrics("app", 0).Sum(x => x.Points.Count);
        Assert.InRange(afterFirstStep, 1, 11_999);

        // Ingest keeps landing between steps of an in-progress pass.
        s.RecordLogs([Log("app", now.ToUnixTimeMilliseconds(), 9, "mid-prune")]);

        var steps = 0;
        while (!s.PruneStep(now, TimeSpan.Zero) && ++steps < 1000)
        {
        }

        Assert.True(steps < 1000, "prune pass never completed");
        Assert.Empty(s.QueryMetrics("app", 0)); // every sample was past the age cap
        Assert.Equal("mid-prune", Assert.Single(s.QueryOtlpLogs("app", 0, null, 10)).Body);
    }

    private static ParsedOtlpLog Log(string appId, long tsMs, int severity, string body)
        => new(appId, new OtlpLogRecord(tsMs, severity, "", body,
            new Dictionary<string, string>(StringComparer.Ordinal), null, null));

    private static ParsedOtlpSpan Span(string appId, string traceId, string spanId, string? parent, long startNano, long endNano)
        => new(appId, new OtlpSpan(traceId, spanId, parent, "op", "server", startNano, endNano, "unset", null,
            new Dictionary<string, string>(StringComparer.Ordinal)));

    public void Dispose()
    {
        store?.Dispose();
        foreach (var suffix in new[] { "", "-wal", "-shm" })
        {
            try { File.Delete(dbPath + suffix); } catch (IOException) { }
        }
    }
}
