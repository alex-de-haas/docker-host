using Xunit;
using Haas.Hosty.TelemetryBackend;

namespace Haas.Hosty.TelemetryBackend.Tests;

// Exercises the query service's fleet aggregation + clamping over a real temp-file store.
public sealed class TelemetryQueryServiceTests : IDisposable
{
    private readonly string dbPath = Path.Combine(Path.GetTempPath(), $"hosty-telq-{Guid.NewGuid():N}.db");
    private readonly SqliteTelemetryStore store;
    private readonly TelemetryQueryService query;

    // Spans/logs must fall inside the query window, so anchor timestamps at "now".
    private readonly long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    public TelemetryQueryServiceTests()
    {
        store = new SqliteTelemetryStore(new TelemetryBackendOptions
        {
            DatabasePath = dbPath,
            LogsFilePath = string.Empty,
            TracesFilePath = string.Empty,
        });
        query = new TelemetryQueryService(store);
    }

    [Fact]
    public void GetFleetTraces_SummarizesRootDurationErrorsAndApps()
    {
        var baseNano = nowMs * 1_000_000L;
        store.RecordSpans(
        [
            Span("a", "t1", "root", null, "GET /", "server", baseNano, baseNano + 4_000_000, "ok"),
            Span("b", "t1", "child", "root", "db.query", "client", baseNano + 1_000_000, baseNano + 2_000_000, "error"),
        ]);

        var response = query.GetFleetTraces(rangeSeconds: 300, limit: 50, appIds: null, query: null);
        var summary = Assert.Single(response.Traces);

        Assert.Equal("t1", summary.TraceId);
        Assert.Equal("GET /", summary.RootName);
        Assert.True(summary.HasRootSpan);
        Assert.Equal("a", summary.RootAppId);
        Assert.Equal(2, summary.SpanCount);
        Assert.Equal(1, summary.ErrorCount);
        Assert.Equal(4.0, summary.DurationMs, precision: 3); // (baseNano+4ms − baseNano)
        // Both apps contribute; first-seen order follows scan order (newest span first), not asserted.
        Assert.Equal(2, summary.AppIds.Count);
        Assert.Contains("a", summary.AppIds);
        Assert.Contains("b", summary.AppIds);
        Assert.Equal(2, response.AppCount);
    }

    [Fact]
    public void GetFleetTraces_FallsBackToEarliestSpanWhenNoRoot()
    {
        var baseNano = nowMs * 1_000_000L;
        store.RecordSpans(
        [
            Span("a", "t2", "s2", "missing-parent", "later", "internal", baseNano + 2_000_000, baseNano + 3_000_000, "unset"),
            Span("a", "t2", "s1", "missing-parent", "earliest", "internal", baseNano, baseNano + 1_000_000, "unset"),
        ]);

        var summary = Assert.Single(query.GetFleetTraces(300, 50, null, null).Traces);
        Assert.False(summary.HasRootSpan);
        Assert.Equal("earliest", summary.RootName);
    }

    [Fact]
    public void GetFleetTraces_QueryFiltersByRootNameOrTraceId()
    {
        var baseNano = nowMs * 1_000_000L;
        store.RecordSpans(
        [
            Span("a", "trace-alpha", "r1", null, "GET /alpha", "server", baseNano, baseNano + 1_000_000, "ok"),
            Span("a", "trace-beta", "r2", null, "GET /beta", "server", baseNano, baseNano + 1_000_000, "ok"),
        ]);

        Assert.Equal("trace-alpha", Assert.Single(query.GetFleetTraces(300, 50, null, "alpha").Traces).TraceId);
        Assert.Equal("trace-beta", Assert.Single(query.GetFleetTraces(300, 50, null, "/beta").Traces).TraceId);
    }

    [Fact]
    public void GetTrace_OrdersByStartAndComputesEnvelope()
    {
        var baseNano = nowMs * 1_000_000L;
        store.RecordSpans(
        [
            Span("a", "t3", "child", "root", "child", "client", baseNano + 1_000_000, baseNano + 2_000_000, "ok"),
            Span("a", "t3", "root", null, "root", "server", baseNano, baseNano + 5_000_000, "ok"),
        ]);

        var detail = query.GetTrace("t3");
        Assert.Equal(["root", "child"], detail.Spans.Select(s => s.Name)); // ordered by start
        Assert.Equal(5.0, detail.DurationMs, precision: 3);
    }

    [Fact]
    public void GetTrace_UnknownTraceIsEmptyNotError()
    {
        var detail = query.GetTrace("nope");
        Assert.Empty(detail.Spans);
        Assert.Equal(0.0, detail.DurationMs);
    }

    [Fact]
    public void GetMetrics_ClampsRangeToMax()
    {
        var response = query.GetMetrics("app", rangeSeconds: 999_999);
        Assert.Equal(3600, response.RangeSeconds);
    }

    [Fact]
    public void GetOtlpLogs_ClampsLimitAndEchoesRange()
    {
        for (var i = 0; i < 10; i++)
        {
            store.RecordLogs([new ParsedOtlpLog("app", new OtlpLogRecord(nowMs - i, 9, "", $"m{i}",
                new Dictionary<string, string>(StringComparer.Ordinal), null, null))]);
        }

        var response = query.GetOtlpLogs("app", rangeSeconds: 999_999, minSeverity: null, limit: 999_999);
        Assert.Equal(3600, response.RangeSeconds);
        Assert.Equal(10, response.Records.Count);
    }

    private static ParsedOtlpSpan Span(
        string appId, string traceId, string spanId, string? parent, string name, string kind,
        long startNano, long endNano, string status)
        => new(appId, new OtlpSpan(traceId, spanId, parent, name, kind, startNano, endNano, status, null,
            new Dictionary<string, string>(StringComparer.Ordinal)));

    public void Dispose()
    {
        store.Dispose();
        foreach (var suffix in new[] { "", "-wal", "-shm" })
        {
            try { File.Delete(dbPath + suffix); } catch (IOException) { }
        }
    }
}
