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
    public void ToolsCoverLogsAndTracesAndAreNamedForWhatTheyDo()
    {
        var names = Tools().Select(tool => tool!["name"]!.GetValue<string>()).ToArray();

        Assert.Equal(["search_logs", "list_traces", "get_trace"], names);
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
