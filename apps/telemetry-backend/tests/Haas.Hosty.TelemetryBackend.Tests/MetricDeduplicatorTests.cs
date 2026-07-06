using Xunit;
using Haas.Hosty.TelemetryBackend;

namespace Haas.Hosty.TelemetryBackend.Tests;

// Exercises the unchanged-sample skip that keeps a 1 Hz-style scrape from inserting one row per series
// per scrape when values are flat (T-H2).
public sealed class MetricDeduplicatorTests
{
    private static readonly IReadOnlyDictionary<string, string> NoLabels =
        new Dictionary<string, string>(StringComparer.Ordinal);

    private static MetricSample Sample(string name, double value, long tsMs, params (string Key, string Value)[] labels)
        => new("app.one", name, labels.Length == 0 ? NoLabels : labels.ToDictionary(l => l.Key, l => l.Value, StringComparer.Ordinal), value, tsMs);

    [Fact]
    public void Filter_RecordsFirstSampleThenSkipsUnchanged()
    {
        var dedup = new MetricDeduplicator();

        Assert.Single(dedup.Filter([Sample("cpu", 1.0, 0)], nowMs: 0, heartbeatMs: 60_000));
        // Same value 1 s later, within the heartbeat window → skipped.
        Assert.Empty(dedup.Filter([Sample("cpu", 1.0, 1_000)], nowMs: 1_000, heartbeatMs: 60_000));
    }

    [Fact]
    public void Filter_RecordsWhenValueChanges()
    {
        var dedup = new MetricDeduplicator();
        dedup.Filter([Sample("cpu", 1.0, 0)], nowMs: 0, heartbeatMs: 60_000);

        var recorded = dedup.Filter([Sample("cpu", 2.0, 1_000)], nowMs: 1_000, heartbeatMs: 60_000);

        Assert.Single(recorded);
        Assert.Equal(2.0, recorded[0].Value);
    }

    [Fact]
    public void Filter_ReRecordsFlatSeriesAfterHeartbeat()
    {
        var dedup = new MetricDeduplicator();
        dedup.Filter([Sample("cpu", 1.0, 0)], nowMs: 0, heartbeatMs: 60_000);

        // Unchanged but past the heartbeat window → re-recorded so the series stays legible.
        Assert.Empty(dedup.Filter([Sample("cpu", 1.0, 30_000)], nowMs: 30_000, heartbeatMs: 60_000));
        Assert.Single(dedup.Filter([Sample("cpu", 1.0, 60_000)], nowMs: 60_000, heartbeatMs: 60_000));
    }

    [Fact]
    public void Filter_ZeroHeartbeat_RecordsEveryScrape()
    {
        var dedup = new MetricDeduplicator();
        dedup.Filter([Sample("cpu", 1.0, 0)], nowMs: 0, heartbeatMs: 0);

        Assert.Single(dedup.Filter([Sample("cpu", 1.0, 1_000)], nowMs: 1_000, heartbeatMs: 0));
    }

    [Fact]
    public void Filter_DistinguishesSeriesByLabels()
    {
        var dedup = new MetricDeduplicator();

        // Same name + value, different label sets → two distinct series, both recorded, neither skips
        // the other via a key collision.
        var recorded = dedup.Filter(
            [Sample("http", 1.0, 0, ("path", "/a")), Sample("http", 1.0, 0, ("path", "/b"))],
            nowMs: 0,
            heartbeatMs: 60_000);

        Assert.Equal(2, recorded.Count);
    }
}
