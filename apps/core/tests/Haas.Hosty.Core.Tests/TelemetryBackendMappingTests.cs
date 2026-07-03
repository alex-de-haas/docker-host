using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class TelemetryBackendMappingTests
{
    private static readonly IReadOnlyDictionary<string, string> Names = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["com.acme.web"] = "Acme Web",
        ["com.acme.api"] = "Acme API",
    };

    private static readonly IReadOnlyDictionary<string, string> EmptyAttrs =
        new Dictionary<string, string>(StringComparer.Ordinal);

    [Fact]
    public void MapFleetLogs_EnrichesAppNameAndFallsBackToId()
    {
        var backend = new BackendFleetLogsResponse(300, 2,
        [
            new BackendFleetLogRecord("com.acme.web", 1000, 9, "INFO", "hello", EmptyAttrs, "t1", "s1"),
            new BackendFleetLogRecord("com.acme.unknown", 2000, 17, "ERROR", "boom", EmptyAttrs, null, null),
        ]);

        var mapped = TelemetryBackendMapping.MapFleetLogs(backend, Names);

        Assert.Equal(300, mapped.RangeSeconds);
        Assert.Equal(2, mapped.AppCount);
        Assert.Equal("Acme Web", mapped.Records[0].AppName);
        Assert.Equal("hello", mapped.Records[0].Body);
        Assert.Equal("t1", mapped.Records[0].TraceId);
        // Unknown app id falls back to the id itself.
        Assert.Equal("com.acme.unknown", mapped.Records[1].AppName);
    }

    [Fact]
    public void MapFleetTraces_EnrichesRootAndContributingApps()
    {
        var backend = new BackendTracesResponse(300, 2,
        [
            new BackendTraceSummary("trace1", "GET /", "server", "com.acme.web", HasRootSpan: true,
                StartUnixMs: 10.0, DurationMs: 5.0, SpanCount: 3, ErrorCount: 1,
                AppIds: ["com.acme.web", "com.acme.api"]),
        ]);

        var summary = Assert.Single(TelemetryBackendMapping.MapFleetTraces(backend, Names).Traces);

        Assert.Equal("Acme Web", summary.RootAppName);
        Assert.Equal(2, summary.Apps.Count);
        Assert.Equal(new TraceAppRef("com.acme.web", "Acme Web"), summary.Apps[0]);
        Assert.Equal(new TraceAppRef("com.acme.api", "Acme API"), summary.Apps[1]);
        Assert.Equal(1, summary.ErrorCount);
    }

    [Fact]
    public void MapTraceDetail_EnrichesEachSpanAppName()
    {
        var backend = new BackendTraceDetailResponse("trace1", 10.0, 5.0,
        [
            new BackendTraceDetailSpan("com.acme.web", "root", null, "GET /", "server", 10.0, 5.0, "ok", null, EmptyAttrs),
            new BackendTraceDetailSpan("com.acme.api", "child", "root", "db", "client", 11.0, 1.0, "error", "boom", EmptyAttrs),
        ]);

        var mapped = TelemetryBackendMapping.MapTraceDetail(backend, Names);

        Assert.Equal("trace1", mapped.TraceId);
        Assert.Equal("Acme Web", mapped.Spans[0].AppName);
        Assert.Equal("Acme API", mapped.Spans[1].AppName);
        Assert.Equal("boom", mapped.Spans[1].StatusMessage);
    }
}
