using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class MetricStoreTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 1, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Query_ReturnsRecordedPointsForApp()
    {
        var store = new InMemoryMetricStore();
        store.Record("app.a", "cpu", null, 1.0, T0);
        store.Record("app.a", "cpu", null, 2.0, T0.AddSeconds(10));

        var series = Assert.Single(store.Query("app.a", T0.AddSeconds(-60)));

        Assert.Equal("cpu", series.Name);
        Assert.Empty(series.Labels);
        Assert.Equal([1.0, 2.0], series.Points.Select(point => point.Value));
        Assert.Equal(T0.AddSeconds(10).ToUnixTimeMilliseconds(), series.Points[^1].TimestampUnixMs);
    }

    [Fact]
    public void Query_IsolatesAppsFromEachOther()
    {
        var store = new InMemoryMetricStore();
        store.Record("app.a", "cpu", null, 1.0, T0);
        store.Record("app.b", "cpu", null, 9.0, T0);

        Assert.Equal(9.0, Assert.Single(store.Query("app.b", T0.AddSeconds(-60))).Points[0].Value);
        Assert.Empty(store.Query("app.unknown", T0.AddSeconds(-60)));
    }

    [Fact]
    public void Record_DistinctLabelSetsBecomeDistinctSeries()
    {
        var store = new InMemoryMetricStore();
        store.Record("app.a", "mem", Labels(("service", "web")), 1.0, T0);
        store.Record("app.a", "mem", Labels(("service", "db")), 2.0, T0);

        var series = store.Query("app.a", T0.AddSeconds(-60));

        Assert.Equal(2, series.Count);
        Assert.Contains(series, s => s.Labels["service"] == "web" && s.Points[0].Value == 1.0);
        Assert.Contains(series, s => s.Labels["service"] == "db" && s.Points[0].Value == 2.0);
    }

    [Fact]
    public void Record_SameLabelSetInDifferentOrderIsOneSeries()
    {
        var store = new InMemoryMetricStore();
        store.Record("app.a", "http", Labels(("method", "GET"), ("code", "200")), 1.0, T0);
        store.Record("app.a", "http", Labels(("code", "200"), ("method", "GET")), 2.0, T0.AddSeconds(5));

        var series = Assert.Single(store.Query("app.a", T0.AddSeconds(-60)));
        Assert.Equal(2, series.Points.Count);
    }

    [Fact]
    public void Query_ExcludesPointsBeforeSince()
    {
        var store = new InMemoryMetricStore();
        store.Record("app.a", "cpu", null, 1.0, T0);
        store.Record("app.a", "cpu", null, 2.0, T0.AddSeconds(30));

        var series = Assert.Single(store.Query("app.a", T0.AddSeconds(15)));

        Assert.Equal([2.0], series.Points.Select(point => point.Value));
    }

    [Fact]
    public void Record_DropsPointsOutsideRetentionWindow()
    {
        var store = new InMemoryMetricStore(TimeSpan.FromSeconds(60));
        store.Record("app.a", "cpu", null, 1.0, T0);
        // 90s later the first point is outside the 60s window and must be evicted on append.
        store.Record("app.a", "cpu", null, 2.0, T0.AddSeconds(90));

        var series = Assert.Single(store.Query("app.a", T0.AddSeconds(-3600)));

        Assert.Equal([2.0], series.Points.Select(point => point.Value));
    }

    [Fact]
    public void Record_DropsNonFiniteValues()
    {
        var store = new InMemoryMetricStore();
        store.Record("app.a", "cpu", null, double.NaN, T0);
        store.Record("app.a", "cpu", null, double.PositiveInfinity, T0);

        Assert.Empty(store.Query("app.a", T0.AddSeconds(-60)));
    }

    [Fact]
    public void Record_IgnoresBlankAppOrMetricName()
    {
        var store = new InMemoryMetricStore();
        store.Record("", "cpu", null, 1.0, T0);
        store.Record("app.a", " ", null, 1.0, T0);

        Assert.Empty(store.Query("app.a", T0.AddSeconds(-60)));
    }

    [Fact]
    public void Record_SeriesKeyIsCollisionFreeEvenWithSeparatorLikeValues()
    {
        // Under a separator-character key scheme these two label sets collide; a length-prefixed key
        // keeps them distinct. Set A: two labels; Set B: one label whose value embeds the would-be
        // separators between A's segments.
        var store = new InMemoryMetricStore();
        store.Record("app.a", "m", Labels(("a", "b"), ("c", "d")), 1.0, T0);
        store.Record("app.a", "m", Labels(("a", "bcd")), 2.0, T0);

        var series = store.Query("app.a", T0.AddSeconds(-60));

        Assert.Equal(2, series.Count);
    }

    [Fact]
    public void Remove_DropsAllSeriesForApp()
    {
        var store = new InMemoryMetricStore();
        store.Record("app.a", "cpu", null, 1.0, T0);
        store.Record("app.b", "cpu", null, 2.0, T0);

        store.Remove("app.a");

        Assert.Empty(store.Query("app.a", T0.AddSeconds(-60)));
        Assert.Single(store.Query("app.b", T0.AddSeconds(-60)));
    }

    [Fact]
    public void Prune_EvictsStalePointsAndEmptySeries()
    {
        var store = new InMemoryMetricStore(TimeSpan.FromSeconds(60));
        store.Record("app.a", "cpu", null, 1.0, T0);

        // 10 minutes later every point for the (now silent) series is outside the 60s window; a prune
        // at that time reclaims the series even though no further Record arrived to trim it.
        store.Prune(T0.AddMinutes(10));

        Assert.Empty(store.Query("app.a", T0.AddSeconds(-3600)));
    }

    [Fact]
    public void Prune_KeepsPointsInsideTheWindow()
    {
        var store = new InMemoryMetricStore(TimeSpan.FromSeconds(60));
        store.Record("app.a", "cpu", null, 1.0, T0.AddSeconds(30));

        store.Prune(T0.AddSeconds(40));

        Assert.Equal([1.0], Assert.Single(store.Query("app.a", T0.AddSeconds(-60))).Points.Select(p => p.Value));
    }

    private static Dictionary<string, string> Labels(params (string Key, string Value)[] pairs)
        => pairs.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
}
