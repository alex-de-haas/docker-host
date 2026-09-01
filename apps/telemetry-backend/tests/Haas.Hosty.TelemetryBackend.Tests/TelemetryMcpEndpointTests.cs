using System.Text.Json;
using System.Text.Json.Nodes;
using Xunit;
using Haas.Hosty.TelemetryBackend.Query;

namespace Haas.Hosty.TelemetryBackend.Tests;

// The MCP surface, and above all what it says about its own limits. The store clamps range and row
// count silently; an agent that cannot see the clamp reports "no errors" when it means "none in the
// newest 500" — a false statement about the host rather than a report about the query.
public class TelemetryMcpEndpointTests
{
    [Fact]
    public void EveryToolDeclaresItselfReadOnly()
    {
        // Without this the Hosty connector's fail-closed filter exports nothing at all: it treats a
        // missing readOnlyHint as "this might mutate". The whole interface would be invisible.
        var tools = Tools();

        Assert.NotEmpty(tools);
        foreach (var tool in tools)
        {
            Assert.True(
                tool!["annotations"]!["readOnlyHint"]!.GetValue<bool>(),
                $"{tool["name"]} must declare readOnlyHint");
        }
    }

    [Fact]
    public void ToolsCoverLogsAndTracesAndMetricsAndAreNamedForWhatTheyDo()
    {
        var names = Tools().Select(tool => tool!["name"]!.GetValue<string>()).ToArray();

        Assert.Equal(["search_logs", "list_traces", "get_trace", "get_metrics"], names);
    }

    [Fact]
    public void TheDescriptionsSayWhenToPreferThisOverAConsoleTail()
    {
        // The reason this interface exists is that Core's tail cannot filter. If the model cannot tell
        // the two apart it will keep reaching for whichever it saw first.
        var search = Tools().Single(tool => tool!["name"]!.GetValue<string>() == "search_logs");

        Assert.Contains("console tail", search!["description"]!.GetValue<string>(), StringComparison.Ordinal);
    }

    [Fact]
    public void InitializeWarnsThatResultsAreClamped()
    {
        var result = Handle(@"{""jsonrpc"":""2.0"",""id"":1,""method"":""initialize""}");

        var instructions = result["result"]!["instructions"]!.GetValue<string>();
        Assert.Contains("truncated", instructions, StringComparison.Ordinal);
    }

    [Fact]
    public void AnUnknownToolFailsAsAResultRatherThanEndingTheTurn()
    {
        // isError on a normal result is the protocol's own signal: the model reads why and chooses
        // something else. A JSON-RPC error would end the turn instead.
        var result = Handle(
            @"{""jsonrpc"":""2.0"",""id"":2,""method"":""tools/call"",""params"":{""name"":""drop_everything""}}");

        Assert.True(result["result"]!["isError"]!.GetValue<bool>());
        Assert.Null(result["error"]);
    }

    [Fact]
    public void AnUnknownMethodIsAProtocolError()
    {
        // The other direction: a method the server does not implement is a protocol fault, not a tool
        // that failed, and conflating the two would teach a client the wrong recovery.
        var result = Handle(@"{""jsonrpc"":""2.0"",""id"":3,""method"":""resources/list""}");

        Assert.Equal(-32601, result["error"]!["code"]!.GetValue<int>());
    }

    [Fact]
    public void AFullPageSaysItMayBeTruncatedAndAPartialOneDoesNot()
    {
        // The deliverable this interface was gated on. A burst has already hidden real data behind
        // exactly this clamp: an app logging ~2k/h looked quiet through a 1-hour, newest-500 view. The
        // pair is the test — a result that always claimed truncation would be as useless as one that
        // never did.
        using var fixture = new StoreFixture();
        var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        for (var i = 0; i < 5; i++)
        {
            fixture.Store.RecordLogs([new ParsedOtlpLog("app", new OtlpLogRecord(
                nowMs - i, 9, "INFO", $"m{i}",
                new Dictionary<string, string>(StringComparer.Ordinal), null, null))]);
        }

        var full = Window(Call(fixture.Query, limit: 2));
        Assert.Equal(2, full["returned"]!.GetValue<int>());
        Assert.True(full["truncated"]!.GetValue<bool>());

        var partial = Window(Call(fixture.Query, limit: 50));
        Assert.Equal(5, partial["returned"]!.GetValue<int>());
        Assert.False(partial["truncated"]!.GetValue<bool>());
    }

    [Fact]
    public void AnOverLargeRequestReportsThatItWasClamped()
    {
        // Asking for a day of logs and silently getting an hour is the failure this reports. The window
        // says what actually ran, not what was asked for.
        using var fixture = new StoreFixture();

        var window = Window(Call(fixture.Query, limit: 999_999, rangeSeconds: 86_400));

        Assert.Equal(3600, window["rangeSeconds"]!.GetValue<int>());
        Assert.True(window["rangeClamped"]!.GetValue<bool>());
        Assert.Equal(2000, window["limit"]!.GetValue<int>());
        Assert.True(window["limitClamped"]!.GetValue<bool>());
    }

    [Fact]
    public void AnUnclampedRequestDoesNotClaimItWasClamped()
    {
        // Paired with the case above: a flag that is always true says nothing.
        using var fixture = new StoreFixture();

        var window = Window(Call(fixture.Query, limit: 10, rangeSeconds: 60));

        Assert.False(window["rangeClamped"]!.GetValue<bool>());
        Assert.False(window["limitClamped"]!.GetValue<bool>());
    }

    [Fact]
    public void AValueClampedUpFromBelowIsReportedToo()
    {
        // The schemas publish no minimum, so `range_seconds: 0` is a plausible model-generated input
        // that the store clamps to 1. Reporting that as honoured is the same lie as hiding a cap, just
        // at the other end — and the first cut only looked at the maximum.
        using var fixture = new StoreFixture();

        var window = Window(Call(fixture.Query, limit: 0, rangeSeconds: 0));

        Assert.Equal(1, window["rangeSeconds"]!.GetValue<int>());
        Assert.True(window["rangeClamped"]!.GetValue<bool>());
        Assert.Equal(1, window["limit"]!.GetValue<int>());
        Assert.True(window["limitClamped"]!.GetValue<bool>());
    }

    [Fact]
    public void TheReportedTraceDefaultIsTheOneTheStoreActuallyUses()
    {
        // It was 100 here against a store default of 50, so a full page of 50 reported limit:100 and
        // truncated:false — the silent truncation this contract exists to prevent, inside the contract.
        using var fixture = new StoreFixture();

        var result = Handle(
            @"{""jsonrpc"":""2.0"",""id"":8,""method"":""tools/call"",""params"":{""name"":""list_traces"",""arguments"":{}}}",
            fixture.Query);
        var window = JsonNode.Parse(result["result"]!["content"]![0]!["text"]!.GetValue<string>())!["window"]!;

        Assert.Equal(50, window["limit"]!.GetValue<int>());
    }

    [Fact]
    public void MetricsSummariseEachSeriesRatherThanReturningEverySample()
    {
        // The shape of the window is the answer to "how loaded was it"; a thousand raw points is the
        // same answer at a price no context window should pay.
        using var fixture = new StoreFixture();
        var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        fixture.Store.RecordMetrics([
            Sample("app", "container.cpu.percent", 10, nowMs - 20_000),
            Sample("app", "container.cpu.percent", 50, nowMs - 10_000),
            Sample("app", "container.cpu.percent", 30, nowMs),
        ]);

        var series = (JsonArray)Payload(CallMetrics(fixture.Query, "app"))["series"]!;

        var cpu = Assert.Single(series);
        Assert.Equal("container.cpu.percent", cpu!["name"]!.GetValue<string>());
        Assert.Equal(30, cpu["latest"]!.GetValue<double>());
        Assert.Equal(10, cpu["min"]!.GetValue<double>());
        Assert.Equal(50, cpu["max"]!.GetValue<double>());
        Assert.Equal(30, cpu["average"]!.GetValue<double>());
        Assert.Equal(3, cpu["points"]!.GetValue<int>());
    }

    [Fact]
    public void NoStoredMetricsSaysSoRatherThanReadingAsIdle()
    {
        // The failure this tool exists to prevent, and the one an empty array invites: an agent asked
        // about memory pressure reporting "no load" when the truth is "nothing was collected".
        using var fixture = new StoreFixture();

        var payload = Payload(CallMetrics(fixture.Query, "app"));

        Assert.Empty((JsonArray)payload["series"]!);
        var note = payload["note"]!.GetValue<string>();
        Assert.Contains("not that the app was idle", note, StringComparison.Ordinal);
    }

    [Fact]
    public void AnAppWithNoContainerIsToldWhyRatherThanShownAnAbsence()
    {
        // A localCommand app has no container, so `docker stats` never reports it and container.*
        // simply is not there. Without the note that reads as "this app uses no CPU".
        using var fixture = new StoreFixture();
        fixture.Store.RecordMetrics([Sample("app", "requests.total", 7, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())]);

        var payload = Payload(CallMetrics(fixture.Query, "app"));

        Assert.Single((JsonArray)payload["series"]!);
        Assert.Contains("localCommand", payload["note"]!.GetValue<string>(), StringComparison.Ordinal);
    }

    [Fact]
    public void AContainerisedAppGetsNoSuchNote()
    {
        // Paired with the case above: a note attached to every answer would train the model to skip it.
        using var fixture = new StoreFixture();
        fixture.Store.RecordMetrics([
            Sample("app", "container.memory.bytes", 1024, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()),
        ]);

        Assert.Null(Payload(CallMetrics(fixture.Query, "app"))["note"]);
    }

    [Fact]
    public void MetricsReportTheRangeTheStoreActuallyUsedRatherThanReClampingIt()
    {
        // Read back from the response, not recomputed here. The trace tool already shipped a window
        // whose reported default disagreed with the store's, which recreated the silent truncation
        // this contract exists to prevent — inside the contract itself.
        using var fixture = new StoreFixture();

        var window = Payload(CallMetrics(fixture.Query, "app", rangeSeconds: 86_400))["window"]!;

        Assert.Equal(3600, window["rangeSeconds"]!.GetValue<int>());
        Assert.True(window["rangeClamped"]!.GetValue<bool>());
    }

    [Fact]
    public void TooManySeriesAreCappedAndTheResultSaysSoExactly()
    {
        // An app with high-cardinality labels would otherwise hand the client every series it has.
        // Unlike the log and trace stores, this one returns everything in range, so the cap lives here
        // — and because it does, the count left behind is known rather than guessed at.
        using var fixture = new StoreFixture();
        var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        fixture.Store.RecordMetrics([.. Enumerable.Range(0, 6).Select(i => Sample("app", $"meter.{i}", i, nowMs))]);

        var capped = Payload(CallMetrics(fixture.Query, "app", limit: 2));
        Assert.Equal(2, ((JsonArray)capped["series"]!).Count);
        Assert.True(capped["window"]!["truncated"]!.GetValue<bool>());

        var whole = Payload(CallMetrics(fixture.Query, "app", limit: 50));
        Assert.Equal(6, ((JsonArray)whole["series"]!).Count);
        Assert.False(whole["window"]!["truncated"]!.GetValue<bool>());
    }

    [Fact]
    public void TheCapNeverHidesCpuAndMemoryBehindAnAppsOwnMeters()
    {
        // The failure a plain cap would introduce: a truncated result that honestly reports truncation
        // and still reads as "no container metrics". Docker stats sort first so the cap cannot reach
        // them — which is also why the note stays trustworthy under truncation.
        using var fixture = new StoreFixture();
        var nowMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        fixture.Store.RecordMetrics([
            .. Enumerable.Range(0, 20).Select(i => Sample("app", $"a.meter.{i}", i, nowMs)),
            Sample("app", "container.cpu.percent", 42, nowMs),
        ]);

        var payload = Payload(CallMetrics(fixture.Query, "app", limit: 3));

        var names = ((JsonArray)payload["series"]!).Select(row => row!["name"]!.GetValue<string>());
        Assert.Contains("container.cpu.percent", names);
        Assert.Null(payload["note"]);
    }

    [Fact]
    public void AskingForCpuAlongsideAnAppMeterAndGettingOnlyTheMeterIsStillTold()
    {
        // The gap in the first cut: the note was suppressed whenever anything came back, so a filter
        // naming CPU *and* an app meter answered half the question and stayed silent about the half
        // it could not answer — exactly the "no CPU pressure" misreading the note exists to stop.
        using var fixture = new StoreFixture();
        fixture.Store.RecordMetrics([
            Sample("app", "requests.total", 7, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()),
        ]);

        var payload = Payload(
            CallMetrics(fixture.Query, "app", names: "container.cpu.percent,requests.total"));

        Assert.Single((JsonArray)payload["series"]!);
        Assert.Contains("No docker stats", payload["note"]!.GetValue<string>(), StringComparison.Ordinal);
    }

    [Fact]
    public void AnAppsOwnContainerNamedMeterIsNotMistakenForDockerStats()
    {
        // A prefix test would accept this as evidence and drop the note. Core produces exactly three
        // names; anything else under `container.` is the app's own and says nothing about the runtime.
        using var fixture = new StoreFixture();
        fixture.Store.RecordMetrics([
            Sample("app", "container.queue.depth", 3, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()),
        ]);

        var payload = Payload(CallMetrics(fixture.Query, "app"));

        Assert.Single((JsonArray)payload["series"]!);
        Assert.Contains("localCommand", payload["note"]!.GetValue<string>(), StringComparison.Ordinal);
    }

    [Fact]
    public void AnUnclampedMetricsWindowDoesNotClaimItWasClamped()
    {
        using var fixture = new StoreFixture();

        var window = Payload(CallMetrics(fixture.Query, "app", rangeSeconds: 60))["window"]!;

        Assert.Equal(60, window["rangeSeconds"]!.GetValue<int>());
        Assert.False(window["rangeClamped"]!.GetValue<bool>());
    }

    [Fact]
    public void MetricsWithoutAnAppFailAsAResultTheModelCanCorrect()
    {
        // Metrics are stored per app, so there is no fleet-wide reading to fall back to. Reported as a
        // tool failure rather than an empty answer, which would look like "this host has no metrics".
        using var fixture = new StoreFixture();

        var result = Handle(
            @"{""jsonrpc"":""2.0"",""id"":10,""method"":""tools/call"",""params"":{""name"":""get_metrics"",""arguments"":{}}}",
            fixture.Query);

        Assert.True(result["result"]!["isError"]!.GetValue<bool>());
    }

    [Fact]
    public void AskingForNamesThatAreNotThereDoesNotBlameTheRuntime()
    {
        // The container note is for an unfiltered read. A caller who asked for one meter and got
        // nothing is owed "no series matched", not a theory about containers.
        using var fixture = new StoreFixture();
        fixture.Store.RecordMetrics([
            Sample("app", "container.cpu.percent", 5, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()),
        ]);

        var payload = Payload(CallMetrics(fixture.Query, "app", names: "requests.total"));

        Assert.Empty((JsonArray)payload["series"]!);
        var note = payload["note"]!.GetValue<string>();
        Assert.Contains("No stored series matched", note, StringComparison.Ordinal);
        Assert.DoesNotContain("localCommand", note, StringComparison.Ordinal);
    }

    private static MetricSample Sample(string appId, string name, double value, long timestampMs)
        => new(appId, name, new Dictionary<string, string>(StringComparer.Ordinal), value, timestampMs);

    private static JsonNode CallMetrics(
        TelemetryQueryService query, string app, int? rangeSeconds = null, string? names = null,
        int? limit = null)
    {
        var arguments = $@"""app"":""{app}"""
            + (rangeSeconds is int range ? $@",""range_seconds"":{range}" : string.Empty)
            + (limit is int cap ? $@",""limit"":{cap}" : string.Empty)
            + (names is not null ? $@",""names"":""{names}""" : string.Empty);
        return Handle(
            @"{""jsonrpc"":""2.0"",""id"":11,""method"":""tools/call"",""params"":{""name"":""get_metrics"","
            + "\"arguments\":{" + arguments + "}}}",
            query);
    }

    /// <summary>The whole tool payload, not just its window.</summary>
    private static JsonNode Payload(JsonNode result)
        => JsonNode.Parse(result["result"]!["content"]![0]!["text"]!.GetValue<string>())!;

    private static JsonNode Call(TelemetryQueryService query, int limit, int rangeSeconds = 300)
        => Handle(
            @"{""jsonrpc"":""2.0"",""id"":9,""method"":""tools/call"",""params"":{""name"":""search_logs"","
            + @"""arguments"":{""limit"":" + limit + @",""range_seconds"":" + rangeSeconds + "}}}",
            query);

    /// <summary>The tool's payload is a JSON string inside the text content, as MCP requires.</summary>
    private static JsonNode Window(JsonNode result)
    {
        var text = result["result"]!["content"]![0]!["text"]!.GetValue<string>();
        return JsonNode.Parse(text)!["window"]!;
    }

    private static JsonArray Tools()
    {
        var result = Handle(@"{""jsonrpc"":""2.0"",""id"":1,""method"":""tools/list""}");
        return (JsonArray)result["result"]!["tools"]!;
    }

    /// <summary>
    /// Drives the endpoint and reads the JSON it produced, through the real <c>IResult</c> so the shape
    /// asserted is the shape a client receives.
    /// </summary>
    private static JsonNode Handle(string request, TelemetryQueryService? query = null)
    {
        // `initialize` and `tools/list` never touch the store, which is why they can be driven without
        // one; the calls that do are given a real service.
        var result = TelemetryMcpEndpoint.Handle(JsonNode.Parse(request), query!);
        return JsonNode.Parse(JsonSerializer.Serialize(Unwrap(result)))!;
    }

    /// <summary>Reads the payload out of the <c>Results.Json</c> wrapper.</summary>
    private static object Unwrap(object result)
        => result.GetType().GetProperty("Value")?.GetValue(result) ?? result;

    private sealed class StoreFixture : IDisposable
    {
        private readonly string dbPath = Path.Combine(Path.GetTempPath(), $"hosty-mcp-{Guid.NewGuid():N}.db");

        public StoreFixture()
        {
            Store = new SqliteTelemetryStore(new TelemetryBackendOptions
            {
                DatabasePath = dbPath,
                LogsFilePath = string.Empty,
                TracesFilePath = string.Empty,
            });
            Query = new TelemetryQueryService(Store);
        }

        public SqliteTelemetryStore Store { get; }

        public TelemetryQueryService Query { get; }

        public void Dispose()
        {
            try
            {
                File.Delete(dbPath);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
            }
        }
    }
}
