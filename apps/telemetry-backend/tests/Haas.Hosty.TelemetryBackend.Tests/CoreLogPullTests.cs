using System.Net;
using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;
using Haas.Hosty.TelemetryBackend;

namespace Haas.Hosty.TelemetryBackend.Tests;

// Core's own records reach the store by a pull, not a push: Core is an AOT binary with one package
// reference that starts before the collector it would export to, and OTLP ingest is unauthenticated so
// a pushed record could be forged. These cover the parse and the two cursor invariants — resume where
// we left off, and start over when a different Core is answering.
public sealed class CoreLogPullParserTests
{
    private static readonly DateTimeOffset Fallback = new(2026, 8, 31, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Parse_AttributesRecordsToTheReservedCoreId()
    {
        var parsed = CoreLogPullParser.Parse(
            """{"runId":"run-1","nextCursor":7,"records":[{"sequence":7,"timestamp":"2026-08-31T10:00:00+00:00","level":"Warning","category":"Haas.Hosty.Core.Stats","message":"tick failed","count":1,"lastSeen":"2026-08-31T10:00:00+00:00"}]}""",
            Fallback);

        Assert.NotNull(parsed);
        Assert.Equal("run-1", parsed.RunId);
        Assert.Equal(7, parsed.NextCursor);
        var record = Assert.Single(parsed.Records);
        Assert.Equal("hosty.core", record.AppId);
        Assert.Equal("tick failed", record.Record.Body);
        Assert.Equal(13, record.Record.SeverityNumber);
        Assert.Equal("Haas.Hosty.Core.Stats", record.Record.Attributes["hosty.core.category"]);
    }

    [Fact]
    public void Parse_CarriesAFoldedRepeatAsACount()
    {
        var parsed = CoreLogPullParser.Parse(
            """{"runId":"run-1","nextCursor":1,"records":[{"sequence":1,"timestamp":"2026-08-31T10:00:00+00:00","level":"Warning","category":"C","message":"repeat","count":360,"lastSeen":"2026-08-31T11:00:00+00:00"}]}""",
            Fallback);

        var record = Assert.Single(parsed!.Records);
        Assert.Equal("360", record.Record.Attributes["hosty.core.repeat_count"]);
        Assert.Equal("2026-08-31T11:00:00+00:00", record.Record.Attributes["hosty.core.last_seen"]);
    }

    // A cursor without a run to anchor it cannot be trusted across a Core restart, which is the whole
    // point of the field.
    [Fact]
    public void Parse_RejectsAPayloadWithNoRunId()
        => Assert.Null(CoreLogPullParser.Parse("""{"nextCursor":3,"records":[]}""", Fallback));

    [Theory]
    [InlineData("")]
    [InlineData("not json")]
    [InlineData("[]")]
    public void Parse_IsQuietOnRubbish(string body)
        => Assert.Null(CoreLogPullParser.Parse(body, Fallback));

    [Fact]
    public void Parse_FallsBackToTheTailClockForAnUnstampedRecord()
    {
        var parsed = CoreLogPullParser.Parse(
            """{"runId":"r","nextCursor":1,"records":[{"sequence":1,"level":"Error","message":"boom","count":1}]}""",
            Fallback);

        Assert.Equal(Fallback.ToUnixTimeMilliseconds(), Assert.Single(parsed!.Records).Record.TimestampUnixMs);
    }
}

public sealed class CoreLogPullLoopTests : IDisposable
{
    private readonly string dbPath = Path.Combine(Path.GetTempPath(), $"hosty-corelogs-{Guid.NewGuid():N}.db");
    private SqliteTelemetryStore? store;

    public void Dispose()
    {
        store?.Dispose();
        try
        {
            File.Delete(dbPath);
        }
        catch (IOException)
        {
        }
    }

    [Fact]
    public async Task ThePullResumesFromTheCursorItPersisted()
    {
        var transport = new ScriptedTransport();
        transport.Reply("""{"runId":"run-1","nextCursor":2,"records":[{"sequence":1,"level":"Information","category":"Haas.Hosty.Core.A","message":"one","count":1},{"sequence":2,"level":"Information","category":"Haas.Hosty.Core.A","message":"two","count":1}]}""");
        transport.Reply("""{"runId":"run-1","nextCursor":3,"records":[{"sequence":3,"level":"Information","category":"Haas.Hosty.Core.A","message":"three","count":1}]}""");
        var service = CreateService(transport);

        await service.PullCoreLogsAsync(DateTimeOffset.UtcNow, CancellationToken.None);
        await service.PullCoreLogsAsync(DateTimeOffset.UtcNow, CancellationToken.None);

        // The second call asked for what follows the first page, rather than replaying it.
        Assert.Equal(["after=0", "after=2"], transport.Queries);
        Assert.Equal(3, CountStoredCoreLogs());
    }

    // Core's rings are in memory. A restarted Core numbers from 1 again, so a cursor from the previous
    // run points past records that no longer exist and would silently swallow the whole new run.
    [Fact]
    public async Task ADifferentCoreRunResetsTheCursorAndKeepsTheRecords()
    {
        var transport = new ScriptedTransport();
        transport.Reply("""{"runId":"run-1","nextCursor":9,"records":[{"sequence":9,"level":"Information","category":"Haas.Hosty.Core.A","message":"old run","count":1}]}""");
        // Same endpoint, new process: the reply carries a different run id and low sequences.
        transport.Reply("""{"runId":"run-2","nextCursor":1,"records":[]}""");
        transport.Reply("""{"runId":"run-2","nextCursor":1,"records":[{"sequence":1,"level":"Information","category":"Haas.Hosty.Core.A","message":"new run","count":1}]}""");
        var service = CreateService(transport);

        await service.PullCoreLogsAsync(DateTimeOffset.UtcNow, CancellationToken.None);
        await service.PullCoreLogsAsync(DateTimeOffset.UtcNow, CancellationToken.None);

        // Third query re-asked from zero rather than trusting the dead run's cursor.
        Assert.Equal(["after=0", "after=9", "after=0"], transport.Queries);
        Assert.Equal(2, CountStoredCoreLogs());
    }

    [Fact]
    public async Task AnUnreachableCoreContributesNothingAndKeepsTheCursor()
    {
        var transport = new ScriptedTransport();
        transport.Fail();
        var service = CreateService(transport);

        await service.PullCoreLogsAsync(DateTimeOffset.UtcNow, CancellationToken.None);

        Assert.Equal(0, CountStoredCoreLogs());
    }

    private int CountStoredCoreLogs()
        => store!.QueryOtlpLogs(
            CoreLogPullParser.CoreAppId,
            DateTimeOffset.UtcNow.AddHours(-1).ToUnixTimeMilliseconds(),
            minSeverity: null,
            limit: 100).Count;

    private TelemetryIngestService CreateService(HttpMessageHandler transport)
    {
        var options = new TelemetryBackendOptions
        {
            DatabasePath = dbPath,
            LogsFilePath = string.Empty,
            TracesFilePath = string.Empty,
            CoreLogsPullUrl = "http://core.test/api/internal/telemetry/logs",
            CoreServiceToken = "token",
        };
        store = new SqliteTelemetryStore(options);
        var service = new TelemetryIngestService(options, store, NullLogger<TelemetryIngestService>.Instance, transport);
        service.ResumeCoreLogCursor();
        return service;
    }

    private sealed class ScriptedTransport : HttpMessageHandler
    {
        private readonly Queue<string?> replies = new();

        public List<string> Queries { get; } = [];

        public void Reply(string body) => replies.Enqueue(body);

        public void Fail() => replies.Enqueue(null);

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Queries.Add(request.RequestUri?.Query.TrimStart('?') ?? string.Empty);
            var body = replies.Count > 0 ? replies.Dequeue() : null;
            return Task.FromResult(body is null
                ? new HttpResponseMessage(HttpStatusCode.ServiceUnavailable)
                : new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body, Encoding.UTF8, "application/json") });
        }
    }
}

// The fleet responses report a count of *apps*, which is also what the UI renders. Core rides the same
// appId column but is the host kernel, so it must not inflate that number.
public sealed class CoreSourceAppCountTests : IDisposable
{
    private readonly string dbPath = Path.Combine(Path.GetTempPath(), $"hosty-corecount-{Guid.NewGuid():N}.db");
    private readonly SqliteTelemetryStore store;
    private readonly TelemetryQueryService query;
    private readonly long nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    public CoreSourceAppCountTests()
    {
        store = new SqliteTelemetryStore(new TelemetryBackendOptions
        {
            DatabasePath = dbPath,
            LogsFilePath = string.Empty,
            TracesFilePath = string.Empty,
        });
        query = new TelemetryQueryService(store);
    }

    public void Dispose()
    {
        store.Dispose();
        try
        {
            File.Delete(dbPath);
        }
        catch (IOException)
        {
        }
    }

    [Fact]
    public void CoreIsNotCountedAmongTheApps()
    {
        store.RecordLogs([
            new ParsedOtlpLog("com.haas.demo-app", Record("from an app")),
            new ParsedOtlpLog(CoreLogPullParser.CoreAppId, Record("from the host")),
        ]);

        var response = query.GetFleetLogs(rangeSeconds: 900, minSeverity: null, limit: 100, appIds: null, query: null);

        Assert.Equal(2, response.Records.Count);
        Assert.Equal(1, response.AppCount);
    }

    private OtlpLogRecord Record(string body)
        => new(nowMs, 9, "INFORMATION", body, new Dictionary<string, string>(), null, null);
}
