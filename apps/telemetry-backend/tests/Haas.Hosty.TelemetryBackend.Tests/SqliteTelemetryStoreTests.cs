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
