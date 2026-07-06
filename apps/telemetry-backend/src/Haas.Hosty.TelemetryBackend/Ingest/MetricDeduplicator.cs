using System.Text;

namespace Haas.Hosty.TelemetryBackend;

// Drops metric samples whose value is unchanged since the series was last recorded — the dominant source
// of store bloat, since the Prometheus exporter re-serves the last value every scrape and most series are
// flat most of the time. A flat series is still re-recorded once it has gone `heartbeatMs` without a
// write, so it stays legible as "live" and range queries keep an anchor point; a zero heartbeat disables
// the skip entirely (records every scrape). Stateful across scrapes and not thread-safe — the single
// ingest loop owns one instance. See docs/features/observability-phase-2-backend.md (T-H2).
internal sealed class MetricDeduplicator
{
    private readonly Dictionary<string, (double Value, long RecordedMs)> lastBySeries = new(StringComparer.Ordinal);

    public List<MetricSample> Filter(IReadOnlyList<MetricSample> samples, long nowMs, long heartbeatMs)
    {
        var recorded = new List<MetricSample>(samples.Count);
        foreach (var sample in samples)
        {
            var key = SeriesKey(sample);
            if (lastBySeries.TryGetValue(key, out var last) &&
                last.Value.Equals(sample.Value) &&
                heartbeatMs > 0 &&
                nowMs - last.RecordedMs < heartbeatMs)
            {
                continue;
            }

            lastBySeries[key] = (sample.Value, nowMs);
            recorded.Add(sample);
        }

        return recorded;
    }

    // Stable identity for a metric series: a unit-separator between every field, labels ordered, so two
    // distinct series can never collide via string concatenation regardless of scrape order.
    private static string SeriesKey(MetricSample sample)
    {
        const char separator = '\u001f';
        var builder = new StringBuilder();
        builder.Append(sample.AppId).Append(separator).Append(sample.Name);
        foreach (var label in sample.Labels.OrderBy(label => label.Key, StringComparer.Ordinal))
        {
            builder.Append(separator).Append(label.Key).Append('=').Append(label.Value);
        }

        return builder.ToString();
    }
}
