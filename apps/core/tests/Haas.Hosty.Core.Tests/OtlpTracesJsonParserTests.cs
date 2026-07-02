using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class OtlpTracesJsonParserTests
{
    [Fact]
    public void Parse_ReadsSpanFieldsAndAttributesFromCollectorShapedLine()
    {
        // The protojson shape the collector `file` exporter writes: nanos as strings, kind as an
        // integer enum value, status code as an integer.
        const string line = """
            {"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"web"}},{"key":"hosty.app.id","value":{"stringValue":"com.acme.web"}}]},"scopeSpans":[{"scope":{"name":"acme.http"},"spans":[{"traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"b7ad6b7169203331","parentSpanId":"","name":"GET /orders","kind":2,"startTimeUnixNano":"1767225600000000000","endTimeUnixNano":"1767225600250000000","attributes":[{"key":"http.status_code","value":{"intValue":"200"}}],"status":{"code":0}}]}]}]}
            """;

        var parsed = Assert.Single(OtlpTracesJsonParser.Parse(line));

        Assert.Equal("com.acme.web", parsed.AppId);
        var span = parsed.Span;
        Assert.Equal("0af7651916cd43dd8448eb211c80319c", span.TraceId);
        Assert.Equal("b7ad6b7169203331", span.SpanId);
        Assert.Null(span.ParentSpanId);
        Assert.Equal("GET /orders", span.Name);
        Assert.Equal("server", span.Kind);
        Assert.Equal(1767225600000000000, span.StartUnixNano);
        Assert.Equal(1767225600250000000, span.EndUnixNano);
        Assert.Equal("unset", span.StatusCode);
        Assert.Null(span.StatusMessage);
        Assert.Equal("200", span.Attributes["http.status_code"]);
    }

    [Fact]
    public void Parse_ReadsParentSpanIdAndErrorStatus()
    {
        const string line = """
            {"resourceSpans":[{"resource":{"attributes":[{"key":"hosty.app.id","value":{"stringValue":"com.acme.web"}}]},"scopeSpans":[{"spans":[{"traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"c000000000000001","parentSpanId":"b7ad6b7169203331","name":"SELECT orders","kind":3,"startTimeUnixNano":"1767225600010000000","endTimeUnixNano":"1767225600020000000","status":{"code":2,"message":"connection refused"}}]}]}]}
            """;

        var span = Assert.Single(OtlpTracesJsonParser.Parse(line)).Span;

        Assert.Equal("b7ad6b7169203331", span.ParentSpanId);
        Assert.Equal("client", span.Kind);
        Assert.Equal("error", span.StatusCode);
        Assert.Equal("connection refused", span.StatusMessage);
    }

    [Fact]
    public void Parse_ToleratesEnumNamesForKindAndStatus()
    {
        const string line = """
            {"resourceSpans":[{"resource":{"attributes":[{"key":"hosty.app.id","value":{"stringValue":"com.acme.web"}}]},"scopeSpans":[{"spans":[{"traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"c000000000000002","name":"publish","kind":"SPAN_KIND_PRODUCER","startTimeUnixNano":"1767225600010000000","endTimeUnixNano":"1767225600020000000","status":{"code":"STATUS_CODE_OK"}}]}]}]}
            """;

        var span = Assert.Single(OtlpTracesJsonParser.Parse(line)).Span;

        Assert.Equal("producer", span.Kind);
        Assert.Equal("ok", span.StatusCode);
    }

    [Fact]
    public void Parse_DropsSpansWithoutAppAttribution()
    {
        const string line = """
            {"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"anonymous"}}]},"scopeSpans":[{"spans":[{"traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"c000000000000003","name":"orphan","startTimeUnixNano":"1767225600010000000","endTimeUnixNano":"1767225600020000000"}]}]}]}
            """;

        Assert.Empty(OtlpTracesJsonParser.Parse(line));
    }

    [Fact]
    public void Parse_DropsSpansMissingIdsOrStartTimestamp()
    {
        const string missingStart = """
            {"resourceSpans":[{"resource":{"attributes":[{"key":"hosty.app.id","value":{"stringValue":"com.acme.web"}}]},"scopeSpans":[{"spans":[{"traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"c000000000000004","name":"no-start"}]}]}]}
            """;
        const string zeroTraceId = """
            {"resourceSpans":[{"resource":{"attributes":[{"key":"hosty.app.id","value":{"stringValue":"com.acme.web"}}]},"scopeSpans":[{"spans":[{"traceId":"00000000000000000000000000000000","spanId":"c000000000000005","name":"zero-trace","startTimeUnixNano":"1767225600010000000"}]}]}]}
            """;

        Assert.Empty(OtlpTracesJsonParser.Parse(missingStart));
        Assert.Empty(OtlpTracesJsonParser.Parse(zeroTraceId));
    }

    [Fact]
    public void Parse_MissingOrBackwardsEndYieldsZeroDurationSpan()
    {
        const string line = """
            {"resourceSpans":[{"resource":{"attributes":[{"key":"hosty.app.id","value":{"stringValue":"com.acme.web"}}]},"scopeSpans":[{"spans":[{"traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"c000000000000006","name":"in-flight","startTimeUnixNano":"1767225600010000000","endTimeUnixNano":"1767225600000000000"}]}]}]}
            """;

        var span = Assert.Single(OtlpTracesJsonParser.Parse(line)).Span;

        Assert.Equal(span.StartUnixNano, span.EndUnixNano);
    }

    [Fact]
    public void Parse_SkipsMalformedLinesAndKeepsGoodOnes()
    {
        const string good = """{"resourceSpans":[{"resource":{"attributes":[{"key":"hosty.app.id","value":{"stringValue":"com.acme.web"}}]},"scopeSpans":[{"spans":[{"traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"c000000000000007","name":"survivor","startTimeUnixNano":"1767225600010000000","endTimeUnixNano":"1767225600020000000"}]}]}]}""";
        var ndjson = "{\"resourceSpans\":[{\"resource\"\nnot-json\n" + good + "\n";

        var span = Assert.Single(OtlpTracesJsonParser.Parse(ndjson)).Span;

        Assert.Equal("survivor", span.Name);
    }

    [Fact]
    public void Parse_MultipleResourceSpansAttributeToTheirOwnApps()
    {
        const string line = """
            {"resourceSpans":[{"resource":{"attributes":[{"key":"hosty.app.id","value":{"stringValue":"com.acme.web"}}]},"scopeSpans":[{"spans":[{"traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"c000000000000008","name":"web-span","startTimeUnixNano":"1767225600010000000","endTimeUnixNano":"1767225600020000000"}]}]},{"resource":{"attributes":[{"key":"hosty.app.id","value":{"stringValue":"com.acme.worker"}}]},"scopeSpans":[{"spans":[{"traceId":"0af7651916cd43dd8448eb211c80319c","spanId":"c000000000000009","name":"worker-span","startTimeUnixNano":"1767225600015000000","endTimeUnixNano":"1767225600018000000"}]}]}]}
            """;

        var parsed = OtlpTracesJsonParser.Parse(line);

        Assert.Equal(2, parsed.Count);
        Assert.Equal("com.acme.web", parsed[0].AppId);
        Assert.Equal("web-span", parsed[0].Span.Name);
        Assert.Equal("com.acme.worker", parsed[1].AppId);
        Assert.Equal("worker-span", parsed[1].Span.Name);
    }
}
