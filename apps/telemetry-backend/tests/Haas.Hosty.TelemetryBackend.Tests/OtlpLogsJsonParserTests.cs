using Xunit;
using Haas.Hosty.TelemetryBackend;

namespace Haas.Hosty.TelemetryBackend.Tests;

public sealed class OtlpLogsJsonParserTests
{
    private static readonly DateTimeOffset Fallback = new(2026, 1, 1, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Parse_ReadsFullRecordAndAttributesToApp()
    {
        const string line = """
            {"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"com.acme.app"}},{"key":"hosty.app.id","value":{"stringValue":"com.acme.app"}}]},"scopeLogs":[{"scope":{"name":"my.logger"},"logRecords":[{"timeUnixNano":"1767182400000000000","severityNumber":9,"severityText":"INFO","body":{"stringValue":"hello world"},"attributes":[{"key":"http.method","value":{"stringValue":"GET"}}],"traceId":"0123456789abcdef0123456789abcdef","spanId":"0123456789abcdef"}]}]}]}
            """;

        var parsed = Assert.Single(OtlpLogsJsonParser.Parse(line, Fallback));

        Assert.Equal("com.acme.app", parsed.AppId);
        Assert.Equal(1767182400000, parsed.Record.TimestampUnixMs);
        Assert.Equal(9, parsed.Record.SeverityNumber);
        Assert.Equal("INFO", parsed.Record.SeverityText);
        Assert.Equal("hello world", parsed.Record.Body);
        Assert.Equal("GET", parsed.Record.Attributes["http.method"]);
        Assert.Equal("0123456789abcdef0123456789abcdef", parsed.Record.TraceId);
        Assert.Equal("0123456789abcdef", parsed.Record.SpanId);
    }

    [Fact]
    public void Parse_DropsRecordsWithoutAppAttribution()
    {
        const string line = """
            {"resourceLogs":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"mystery"}}]},"scopeLogs":[{"logRecords":[{"body":{"stringValue":"orphan"}}]}]}]}
            """;

        Assert.Empty(OtlpLogsJsonParser.Parse(line, Fallback));
    }

    [Fact]
    public void Parse_SkipsMalformedLinesButKeepsValidOnes()
    {
        const string ndjson = """
            not json at all
            {"resourceLogs":[{"resource":{"attributes":[{"key":"hosty.app.id","value":{"stringValue":"app.a"}}]},"scopeLogs":[{"logRecords":[{"timeUnixNano":"1767182400000000000","body":{"stringValue":"ok"}}]}]}]}
            {"resourceLogs":[{"resource":{"attributes":[
            """;

        var parsed = Assert.Single(OtlpLogsJsonParser.Parse(ndjson, Fallback));

        Assert.Equal("app.a", parsed.AppId);
        Assert.Equal("ok", parsed.Record.Body);
    }

    [Fact]
    public void Parse_FallsBackToScrapeClockWhenTimestampMissing()
    {
        const string line = """
            {"resourceLogs":[{"resource":{"attributes":[{"key":"hosty.app.id","value":{"stringValue":"app.a"}}]},"scopeLogs":[{"logRecords":[{"body":{"stringValue":"no timestamp"}}]}]}]}
            """;

        var parsed = Assert.Single(OtlpLogsJsonParser.Parse(line, Fallback));

        Assert.Equal(Fallback.ToUnixTimeMilliseconds(), parsed.Record.TimestampUnixMs);
    }

    [Fact]
    public void Parse_MapsSeverityEnumNameAndDerivesText()
    {
        const string line = """
            {"resourceLogs":[{"resource":{"attributes":[{"key":"hosty.app.id","value":{"stringValue":"app.a"}}]},"scopeLogs":[{"logRecords":[{"timeUnixNano":"1767182400000000000","severityNumber":"SEVERITY_NUMBER_WARN","body":{"stringValue":"careful"}}]}]}]}
            """;

        var parsed = Assert.Single(OtlpLogsJsonParser.Parse(line, Fallback));

        Assert.Equal(13, parsed.Record.SeverityNumber);
        Assert.Equal("WARN", parsed.Record.SeverityText);
    }

    [Fact]
    public void Parse_TreatsAllZeroTraceIdAsAbsent()
    {
        const string line = """
            {"resourceLogs":[{"resource":{"attributes":[{"key":"hosty.app.id","value":{"stringValue":"app.a"}}]},"scopeLogs":[{"logRecords":[{"timeUnixNano":"1767182400000000000","body":{"stringValue":"x"},"traceId":"00000000000000000000000000000000","spanId":"0000000000000000"}]}]}]}
            """;

        var parsed = Assert.Single(OtlpLogsJsonParser.Parse(line, Fallback));

        Assert.Null(parsed.Record.TraceId);
        Assert.Null(parsed.Record.SpanId);
    }

    [Fact]
    public void Parse_StringifiesNonStringBodyAndAttributeValues()
    {
        const string line = """
            {"resourceLogs":[{"resource":{"attributes":[{"key":"hosty.app.id","value":{"stringValue":"app.a"}}]},"scopeLogs":[{"logRecords":[{"timeUnixNano":"1767182400000000000","body":{"intValue":"42"},"attributes":[{"key":"ok","value":{"boolValue":true}},{"key":"ratio","value":{"doubleValue":0.5}}]}]}]}]}
            """;

        var parsed = Assert.Single(OtlpLogsJsonParser.Parse(line, Fallback));

        Assert.Equal("42", parsed.Record.Body);
        Assert.Equal("true", parsed.Record.Attributes["ok"]);
        Assert.Equal("0.5", parsed.Record.Attributes["ratio"]);
    }

    [Fact]
    public void Parse_ReadsMultipleRecordsAcrossResourceAndScopeLogs()
    {
        const string line = """
            {"resourceLogs":[{"resource":{"attributes":[{"key":"hosty.app.id","value":{"stringValue":"app.a"}}]},"scopeLogs":[{"logRecords":[{"timeUnixNano":"1767182400000000000","body":{"stringValue":"a1"}},{"timeUnixNano":"1767182401000000000","body":{"stringValue":"a2"}}]}]},{"resource":{"attributes":[{"key":"hosty.app.id","value":{"stringValue":"app.b"}}]},"scopeLogs":[{"logRecords":[{"timeUnixNano":"1767182402000000000","body":{"stringValue":"b1"}}]}]}]}
            """;

        var parsed = OtlpLogsJsonParser.Parse(line, Fallback);

        Assert.Equal(3, parsed.Count);
        Assert.Equal(["app.a", "app.a", "app.b"], parsed.Select(record => record.AppId));
        Assert.Equal(["a1", "a2", "b1"], parsed.Select(record => record.Record.Body));
    }

    [Fact]
    public void Parse_ReturnsEmptyForNullOrBlank()
    {
        Assert.Empty(OtlpLogsJsonParser.Parse(null, Fallback));
        Assert.Empty(OtlpLogsJsonParser.Parse("   ", Fallback));
    }
}
