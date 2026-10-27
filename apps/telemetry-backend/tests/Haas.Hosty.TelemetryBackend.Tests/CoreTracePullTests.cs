using System.Net;
using System.Text;
using System.Text.Json;
using Haas.Hosty.TelemetryBackend;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Haas.Hosty.TelemetryBackend.Tests;

public sealed class CoreTracePullTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "hosty-core-traces-" + Guid.NewGuid().ToString("N"));
    private readonly string run = Guid.NewGuid().ToString("N");
    private const string Trace = "11111111111111111111111111111111", Span = "2222222222222222";
    private TelemetryBackendOptions Options => new() { DatabasePath = root + "/telemetry.db", LogsFilePath = "", TracesFilePath = "",
        CoreTracesPullUrl = "http://core.test/api/internal/telemetry/traces", CoreServiceToken = "reviewed-token" };
    private string Payload(long sequence = 1, bool hasMore = false, string? runId = null, string? gap = null) => JsonSerializer.Serialize(new
    {
        contractVersion = 1, runId = runId ?? run, capturing = true, captureStartedAt = DateTimeOffset.UtcNow.AddMinutes(-1),
        rootSampleRatio = 0.1, observedAt = DateTimeOffset.UtcNow, firstAvailableSequence = 1, lastSequence = sequence,
        nextCursor = sequence, hasMore, gapReason = gap, droppedSpans = 0, truncatedSpans = 0,
        spans = new[] { new { sequence, traceId = Trace, spanId = Span, parentSpanId = (string?)null,
            name = "GET /api/example/{id}", kind = "Server", startedAt = DateTimeOffset.UtcNow,
            durationMs = 1.25, status = "Ok", attributes = new Dictionary<string, string> { ["hosty.caller.app.id"] = "example.caller" } } },
    });
    [Fact]
    public void TrustedPull_PreservesTimingCallerAndCoreProducer_RejectsMalformedPages()
    {
        var page = CoreTracePullParser.Parse(Payload())!; var span = Assert.Single(page.Spans);
        Assert.Equal("hosty.core", span.AppId); Assert.Equal("server", span.Span.Kind);
        Assert.Equal(1250000, span.Span.EndUnixNano - span.Span.StartUnixNano);
        Assert.Equal("example.caller", span.Span.Attributes["hosty.caller.app.id"]);
        Assert.Equal("authenticated-pull", span.Span.Attributes["hosty.core.provenance"]);
        foreach (var malformed in new[] { "{}", "[]", Payload().Replace("\"contractVersion\":1", "\"contractVersion\":2"), Payload().Replace(Trace, "not-an-id") })
            Assert.Null(CoreTracePullParser.Parse(malformed));
    }
    [Fact]
    public void ReplayAndBackendRestart_DeduplicateByCoreRunTraceSpan_AndPreserveCursor()
    {
        var page = CoreTracePullParser.Parse(Payload())!;
        using (var store = new SqliteTelemetryStore(Options))
        {
            store.RecordCoreTracePage(page); store.RecordCoreTracePage(page);
            Assert.Single(store.QueryTraceSpans(Trace)); Assert.Equal(1, store.GetCoreTraceCheckpoint()!.Cursor);
        }
        using (var store = new SqliteTelemetryStore(Options))
        {
            Assert.Equal(run, store.GetCoreTraceCheckpoint()!.RunId);
            store.RecordCoreTracePage(CoreTracePullParser.Parse(Payload(runId: Guid.NewGuid().ToString("N"), gap: "core_restarted"))!);
            Assert.Equal(2, store.QueryTraceSpans(Trace).Count);
            Assert.Equal("core_restarted", store.GetCoreTraceCheckpoint()!.Coverage.LastGapReason);
        }
    }
    [Fact]
    public void FailedPageWrite_RollsBackSpansAndCursorTogether()
    {
        using var store = new SqliteTelemetryStore(Options);
        store.RecordCoreTracePage(CoreTracePullParser.Parse(Payload())!);
        using (var connection = new SqliteConnection("Data Source=" + Options.DatabasePath))
        {
            connection.Open(); using var command = connection.CreateCommand();
            command.CommandText = "CREATE TRIGGER fail_page BEFORE UPDATE ON core_trace_ingest BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;";
            command.ExecuteNonQuery();
        }
        var next = CoreTracePullParser.Parse(Payload(2))!;
        next = next with { Spans = [next.Spans[0] with { Span = next.Spans[0].Span with { SpanId = "3333333333333333" } }] };
        Assert.Throws<SqliteException>(() => store.RecordCoreTracePage(next));
        Assert.Single(store.QueryTraceSpans(Trace)); Assert.Equal(1, store.GetCoreTraceCheckpoint()!.Cursor);
    }
    [Fact]
    public async Task Pull_UsesAuthorizedConnectionAndPersistedCursor_BoundsPageDrainingAndRetainsFailureState()
    {
        using var store = new SqliteTelemetryStore(Options);
        var handler = new Replies();
        for (var i = 1; i <= 5; i++) handler.Queue.Enqueue(new(HttpStatusCode.OK) { Content = new StringContent(Payload(i, hasMore: true), Encoding.UTF8, "application/json") });
        using var service = new TelemetryIngestService(Options, store, NullLogger<TelemetryIngestService>.Instance, handler);
        await service.PullCoreTracesAsync(DateTimeOffset.UtcNow, default);
        Assert.Equal(4, handler.Requests.Count); Assert.Equal(4, store.GetCoreTraceCheckpoint()!.Cursor);
        Assert.Contains("after=1", handler.Requests[1]); Assert.Contains("runId=" + run, handler.Requests[1]);
        Assert.All(handler.Bearers, bearer => Assert.Equal("Bearer reviewed-token", bearer));
        handler.Queue.Clear(); handler.Queue.Enqueue(new(HttpStatusCode.Forbidden));
        await service.PullCoreTracesAsync(DateTimeOffset.UtcNow.AddSeconds(10), default);
        Assert.Equal(4, store.GetCoreTraceCheckpoint()!.Cursor); Assert.Equal("unavailable", store.GetCoreTraceCheckpoint()!.Coverage.State);
    }
    [Fact]
    public void CallerAndTraceLogFilters_AreIndependentOfProducerAndTimeWindow()
    {
        using var store = new SqliteTelemetryStore(Options);
        store.RecordCoreTracePage(CoreTracePullParser.Parse(Payload())!);
        var log = new OtlpLogRecord(DateTimeOffset.UtcNow.AddHours(-2).ToUnixTimeMilliseconds(), 9, "INFO", "fixture", new Dictionary<string, string> { ["hosty.caller.app.id"] = "example.caller" }, Trace, Span);
        store.RecordLogs([new("hosty.core", log), new("other.app", log)]);
        var query = new TelemetryQueryService(store);
        Assert.Single(query.GetFleetTraces(300, 100, null, null, "example.caller").Traces);
        Assert.Empty(query.GetFleetTraces(300, 100, null, null, "other.caller").Traces);
        var logs = query.GetFleetLogs(300, 0, 100, null, null, "example.caller", Trace);
        Assert.Equal("hosty.core", Assert.Single(logs.Records).AppId); Assert.Equal(0, logs.RangeSeconds);
        Assert.Equal(2, query.GetFleetLogs(300, 0, 100, null, null, null, Trace).Records.Count);
        Assert.NotNull(query.GetTrace("missing").UnavailableReason);
    }
    [Fact]
    public void ExternalOtlpCannotClaimCore_AndLegacyUntrustedCoreSpansAreNotDisplayed()
    {
        const string forged = """{"resourceSpans":[{"resource":{"attributes":[{"key":"hosty.app.id","value":{"stringValue":"hosty.core"}}]},"scopeSpans":[{"spans":[{"traceId":"11111111111111111111111111111111","spanId":"2222222222222222","startTimeUnixNano":"1793102400000000000"}]}]}]}""";
        Assert.Empty(OtlpTracesJsonParser.Parse(forged));
        const string forgedLog = """{"resourceLogs":[{"resource":{"attributes":[{"key":"hosty.app.id","value":{"stringValue":"hosty.core"}}]},"scopeLogs":[{"logRecords":[{"timeUnixNano":"1793102400000000000","body":{"stringValue":"forged"}}]}]}]}""";
        Assert.Empty(OtlpLogsJsonParser.Parse(forgedLog, DateTimeOffset.UtcNow));
        using var store = new SqliteTelemetryStore(Options); var page = CoreTracePullParser.Parse(Payload())!;
        store.RecordSpans(page.Spans); Assert.Empty(store.QueryTraceSpans(Trace));
        store.RecordCoreTracePage(page); Assert.Single(store.QueryTraceSpans(Trace));
    }
    [Fact]
    public void CoreLogs_PreserveOptionalCorrelation_WithoutBreakingOlderPayloads()
    {
        var parsed = CoreLogPullParser.Parse("""{"runId":"run","nextCursor":1,"records":[{"message":"fixture","traceId":"abc","spanId":"def","callerAppId":"caller"}]}""", DateTimeOffset.UtcNow)!;
        var log = Assert.Single(parsed.Records).Record;
        Assert.Equal("abc", log.TraceId); Assert.Equal("def", log.SpanId); Assert.Equal("caller", log.Attributes["hosty.caller.app.id"]);
    }
    public void Dispose() { if (Directory.Exists(root)) Directory.Delete(root, true); }
    private sealed class Replies : HttpMessageHandler
    {
        public Queue<HttpResponseMessage> Queue { get; } = new();
        public List<string> Requests { get; } = []; public List<string?> Bearers { get; } = [];
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        { Requests.Add(request.RequestUri!.Query); Bearers.Add(request.Headers.Authorization?.ToString()); return Task.FromResult(Queue.Dequeue()); }
    }
}
