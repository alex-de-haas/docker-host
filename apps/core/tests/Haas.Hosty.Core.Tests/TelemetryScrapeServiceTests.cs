using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class TelemetryScrapeServiceTests
{
    private static readonly DateTimeOffset Now = new(2026, 1, 1, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void IngestPrometheusSamples_AttributesByHostyAppIdAndStripsTheLabel()
    {
        var store = new InMemoryMetricStore();
        var samples = new[]
        {
            new PrometheusSample("http_requests_total",
                Labels(("hosty_app_id", "com.acme.web"), ("method", "GET")), 5.0),
        };

        TelemetryScrapeService.IngestPrometheusSamples(store, samples, Now);

        var series = Assert.Single(store.Query("com.acme.web", Now.AddSeconds(-60)));
        Assert.Equal("http_requests_total", series.Name);
        Assert.Equal(5.0, series.Points[0].Value);
        Assert.False(series.Labels.ContainsKey("hosty_app_id"));
        Assert.Equal("GET", series.Labels["method"]);
    }

    [Fact]
    public void IngestPrometheusSamples_SkipsSamplesWithoutAttributionLabel()
    {
        var store = new InMemoryMetricStore();
        var samples = new[] { new PrometheusSample("orphan", Labels(("foo", "bar")), 1.0) };

        TelemetryScrapeService.IngestPrometheusSamples(store, samples, Now);

        Assert.Empty(store.Query("com.acme.web", Now.AddSeconds(-60)));
    }

    [Fact]
    public void IngestPrometheusSamples_UnlabelledAppSeriesHasNoLeftoverLabels()
    {
        var store = new InMemoryMetricStore();
        var samples = new[] { new PrometheusSample("uptime", Labels(("hosty_app_id", "com.acme.web")), 1.0) };

        TelemetryScrapeService.IngestPrometheusSamples(store, samples, Now);

        Assert.Empty(Assert.Single(store.Query("com.acme.web", Now.AddSeconds(-60))).Labels);
    }

    [Fact]
    public void ParseContainerOwners_MapsNameToAppAndService()
    {
        const string output = "hosty-acme-web\tcom.acme.web\tweb\n" +
                              "hosty-acme-db\tcom.acme.web\tdb";

        var owners = TelemetryScrapeService.ParseContainerOwners(output);

        Assert.Equal(2, owners.Count);
        Assert.Equal(new ContainerOwner("com.acme.web", "web"), owners["hosty-acme-web"]);
        Assert.Equal(new ContainerOwner("com.acme.web", "db"), owners["hosty-acme-db"]);
    }

    [Fact]
    public void ParseContainerOwners_FallsBackToAppIdWhenServiceLabelMissing()
    {
        var owners = TelemetryScrapeService.ParseContainerOwners("hosty-acme-web\tcom.acme.web\t");

        Assert.Equal("com.acme.web", owners["hosty-acme-web"].Service);
    }

    [Fact]
    public void ParseContainerOwners_SkipsLinesMissingAppId()
        => Assert.Empty(TelemetryScrapeService.ParseContainerOwners("somecontainer\t\tweb"));

    [Fact]
    public void IngestContainerStats_RecordsCpuAndMemoryUnderOwningApp()
    {
        var store = new InMemoryMetricStore();
        var owners = new Dictionary<string, ContainerOwner>(StringComparer.Ordinal)
        {
            ["hosty-acme-web"] = new("com.acme.web", "web"),
        };
        var stats = new[] { new DockerContainerStat("hosty-acme-web", 12.5, 1048576, 3.2) };

        TelemetryScrapeService.IngestContainerStats(store, stats, owners, Now);

        var series = store.Query("com.acme.web", Now.AddSeconds(-60));
        Assert.Equal(3, series.Count);
        Assert.Equal(12.5, Series(series, TelemetryScrapeService.ContainerCpuPercentMetric).Points[0].Value);
        Assert.Equal(1048576, Series(series, TelemetryScrapeService.ContainerMemoryBytesMetric).Points[0].Value);
        Assert.Equal(3.2, Series(series, TelemetryScrapeService.ContainerMemoryPercentMetric).Points[0].Value);
        Assert.All(series, s => Assert.Equal("web", s.Labels["service"]));
    }

    [Fact]
    public void IngestContainerStats_IgnoresUnownedContainers()
    {
        var store = new InMemoryMetricStore();
        var stats = new[] { new DockerContainerStat("not-a-hosty-container", 1.0, 1.0, 1.0) };

        TelemetryScrapeService.IngestContainerStats(
            store, stats, new Dictionary<string, ContainerOwner>(StringComparer.Ordinal), Now);

        Assert.Empty(store.Query("com.acme.web", Now.AddSeconds(-60)));
    }

    [Fact]
    public void IngestContainerStats_SkipsMissingMetricValues()
    {
        var store = new InMemoryMetricStore();
        var owners = new Dictionary<string, ContainerOwner>(StringComparer.Ordinal)
        {
            ["hosty-acme-web"] = new("com.acme.web", "web"),
        };
        var stats = new[] { new DockerContainerStat("hosty-acme-web", null, 2048, null) };

        TelemetryScrapeService.IngestContainerStats(store, stats, owners, Now);

        var series = Assert.Single(store.Query("com.acme.web", Now.AddSeconds(-60)));
        Assert.Equal(TelemetryScrapeService.ContainerMemoryBytesMetric, series.Name);
    }

    [Fact]
    public void EndToEnd_RealDockerOutputFlowsThroughToStore()
    {
        // The exact tab-separated lines emitted by the `docker ps` / `docker stats` commands the
        // scrape loop issues, captured from a live `hosty.shell` container — a regression guard that
        // the real Docker output format stays compatible with the parsers and attribution.
        const string psOutput = "hosty-hosty-shell-web\thosty.shell\tweb";
        const string statsOutput = "hosty-hosty-shell-web\t0.00%\t46.71MiB / 7.652GiB\t0.60%";

        var store = new InMemoryMetricStore();
        var owners = TelemetryScrapeService.ParseContainerOwners(psOutput);
        TelemetryScrapeService.IngestContainerStats(store, DockerStatsParser.Parse(statsOutput), owners, Now);

        var series = store.Query("hosty.shell", Now.AddSeconds(-60));
        Assert.Equal(3, series.Count);
        Assert.Equal(0.0, Series(series, TelemetryScrapeService.ContainerCpuPercentMetric).Points[0].Value);
        Assert.Equal(46.71 * 1024 * 1024, Series(series, TelemetryScrapeService.ContainerMemoryBytesMetric).Points[0].Value);
        Assert.Equal(0.60, Series(series, TelemetryScrapeService.ContainerMemoryPercentMetric).Points[0].Value);
        Assert.All(series, s => Assert.Equal("web", s.Labels["service"]));
    }

    private static MetricSeriesSnapshot Series(IReadOnlyList<MetricSeriesSnapshot> series, string name)
        => series.Single(s => s.Name == name);

    private static Dictionary<string, string> Labels(params (string Key, string Value)[] pairs)
        => pairs.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
}
