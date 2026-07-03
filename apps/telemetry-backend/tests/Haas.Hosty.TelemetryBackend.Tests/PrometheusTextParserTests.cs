using Xunit;
using Haas.Hosty.TelemetryBackend;

namespace Haas.Hosty.TelemetryBackend.Tests;

public sealed class PrometheusTextParserTests
{
    [Fact]
    public void Parse_SkipsCommentsAndBlankLines()
    {
        const string text = """
            # HELP http_requests_total The total number of HTTP requests.
            # TYPE http_requests_total counter

            http_requests_total 42
            """;

        var sample = Assert.Single(PrometheusTextParser.Parse(text));

        Assert.Equal("http_requests_total", sample.Name);
        Assert.Empty(sample.Labels);
        Assert.Equal(42d, sample.Value);
    }

    [Fact]
    public void Parse_ReadsLabelsAndValue()
    {
        const string text = "http_requests_total{method=\"GET\",code=\"200\"} 1027 1700000000000";

        var sample = Assert.Single(PrometheusTextParser.Parse(text));

        Assert.Equal("http_requests_total", sample.Name);
        Assert.Equal("GET", sample.Labels["method"]);
        Assert.Equal("200", sample.Labels["code"]);
        Assert.Equal(1027d, sample.Value);
    }

    [Fact]
    public void Parse_PromotesHostyResourceLabels()
    {
        const string text = "process_cpu_seconds_total{hosty_app_id=\"com.acme.app\",service_name=\"web\"} 3.5";

        var sample = Assert.Single(PrometheusTextParser.Parse(text));

        Assert.Equal("com.acme.app", sample.Labels["hosty_app_id"]);
        Assert.Equal("web", sample.Labels["service_name"]);
    }

    [Fact]
    public void Parse_HonorsLabelValueEscapes()
    {
        const string text = "metric{path=\"/a\\\"b\",note=\"line1\\nline2\",win=\"c:\\\\d\"} 1";

        var sample = Assert.Single(PrometheusTextParser.Parse(text));

        Assert.Equal("/a\"b", sample.Labels["path"]);
        Assert.Equal("line1\nline2", sample.Labels["note"]);
        Assert.Equal("c:\\d", sample.Labels["win"]);
    }

    [Theory]
    [InlineData("metric +Inf", double.PositiveInfinity)]
    [InlineData("metric -Inf", double.NegativeInfinity)]
    [InlineData("metric 1.5e3", 1500d)]
    public void Parse_HandlesFloatForms(string line, double expected)
        => Assert.Equal(expected, Assert.Single(PrometheusTextParser.Parse(line)).Value);

    [Theory]
    [InlineData("metric inf", double.PositiveInfinity)]
    [InlineData("metric +inf", double.PositiveInfinity)]
    [InlineData("metric Infinity", double.PositiveInfinity)]
    [InlineData("metric -INF", double.NegativeInfinity)]
    [InlineData("metric -infinity", double.NegativeInfinity)]
    public void Parse_HandlesSpecialFloatsCaseInsensitively(string line, double expected)
        => Assert.Equal(expected, Assert.Single(PrometheusTextParser.Parse(line)).Value);

    [Theory]
    [InlineData("metric NaN")]
    [InlineData("metric nan")]
    [InlineData("metric NAN")]
    public void Parse_NaNValueParsesAsNaN(string line)
        => Assert.True(double.IsNaN(Assert.Single(PrometheusTextParser.Parse(line)).Value));

    [Fact]
    public void Parse_SkipsMalformedLinesButKeepsValidOnes()
    {
        const string text = """
            good_metric 1
            this_is_missing_a_value
            broken{unterminated="x 2
            another_good{a="b"} 3
            """;

        var samples = PrometheusTextParser.Parse(text);

        Assert.Equal(2, samples.Count);
        Assert.Contains(samples, s => s.Name == "good_metric" && s.Value == 1d);
        Assert.Contains(samples, s => s.Name == "another_good" && s.Labels["a"] == "b");
    }

    [Fact]
    public void Parse_EmptyLabelSet()
    {
        var sample = Assert.Single(PrometheusTextParser.Parse("metric{} 7"));

        Assert.Empty(sample.Labels);
        Assert.Equal(7d, sample.Value);
    }

    [Fact]
    public void Parse_EmptyInputYieldsNoSamples()
        => Assert.Empty(PrometheusTextParser.Parse("   "));
}
