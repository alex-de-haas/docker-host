namespace Haas.Hosty.TelemetryBackend;

internal sealed partial class TelemetryIngestService
{
    private DateTimeOffset nextCoreTracePull;
    private int coreTraceFailures;
    internal async Task PullCoreTracesAsync(DateTimeOffset now, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(options.CoreTracesPullUrl)) return;
        var target = options.CoreTracesPullUrl;
        // At most 4 * 500 spans per tick. Catch-up cannot monopolize the ingest loop.
        for (var batch = 0; batch < 4; batch++)
        {
            var checkpoint = store.GetCoreTraceCheckpoint();
            var cursor = checkpoint?.Cursor ?? 0;
            var run = string.IsNullOrEmpty(checkpoint?.RunId) ? "" : "&runId=" + Uri.EscapeDataString(checkpoint.RunId);
            var (body, failure) = await FetchAsync($"{target}?after={cursor}&limit=500{run}", options.CoreServiceToken, cancellationToken);
            cancellationToken.ThrowIfCancellationRequested();
            var page = body is null ? null : CoreTracePullParser.Parse(body);
            if (page is null)
            {
                coreTraceFailures = Math.Min(coreTraceFailures + 1, 4);
                nextCoreTracePull = now.AddSeconds(Math.Min(60, 10 * Math.Pow(2, coreTraceFailures - 1)));
                store.RecordCoreTraceFailure(failure?.Contains("404", StringComparison.Ordinal) == true ? "unsupported" : "unavailable");
                if (failingScrapeUrls.Add(target)) logger.LogWarning("Core trace pull unavailable ({Failure}); request counters continue in Core.", failure ?? "invalid contract");
                return;
            }
            store.RecordCoreTracePage(page); // Atomic durable write before the next cursor is used.
            coreTraceFailures = 0;
            nextCoreTracePull = now + options.CoreTracesPullInterval;
            if (failingScrapeUrls.Remove(target)) logger.LogInformation("Core trace pull recovered.");
            if (!page.HasMore || (checkpoint?.RunId == page.RunId && page.NextCursor <= cursor)) break;
        }
    }
}
