using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class TraceStoreTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 1, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Query_ReturnsSpansForAppInArrivalOrder()
    {
        var store = new InMemoryTraceStore();
        store.Record("app.a", Span("trace-1", "first", T0));
        store.Record("app.a", Span("trace-1", "second", T0.AddSeconds(1)));

        var spans = store.Query("app.a", T0.AddSeconds(-60), limit: 100);

        Assert.Equal(["first", "second"], spans.Select(span => span.SpanId));
    }

    [Fact]
    public void Query_IsolatesAppsFromEachOther()
    {
        var store = new InMemoryTraceStore();
        store.Record("app.a", Span("trace-1", "a", T0));
        store.Record("app.b", Span("trace-1", "b", T0));

        Assert.Equal("b", Assert.Single(store.Query("app.b", T0.AddSeconds(-60), 100)).SpanId);
        Assert.Empty(store.Query("app.unknown", T0.AddSeconds(-60), 100));
    }

    [Fact]
    public void Query_ReturnsMostRecentUpToLimitInArrivalOrder()
    {
        var store = new InMemoryTraceStore();
        for (var i = 0; i < 5; i++)
        {
            store.Record("app.a", Span("trace-1", i.ToString(), T0.AddSeconds(i)));
        }

        var spans = store.Query("app.a", T0.AddSeconds(-60), limit: 2);

        // The two newest, still oldest→newest.
        Assert.Equal(["3", "4"], spans.Select(span => span.SpanId));
    }

    [Fact]
    public void Query_ExcludesSpansBeforeSince()
    {
        var store = new InMemoryTraceStore();
        store.Record("app.a", Span("trace-1", "old", T0));
        store.Record("app.a", Span("trace-1", "new", T0.AddSeconds(30)));

        var spans = store.Query("app.a", T0.AddSeconds(15), 100);

        Assert.Equal("new", Assert.Single(spans).SpanId);
    }

    [Fact]
    public void QueryTrace_ReturnsOnlyThatTraceMatchingCaseInsensitively()
    {
        var store = new InMemoryTraceStore();
        store.Record("app.a", Span("ABCDEF", "span-1", T0));
        store.Record("app.a", Span("abcdef", "span-2", T0.AddSeconds(1)));
        store.Record("app.a", Span("other", "span-3", T0.AddSeconds(2)));

        var spans = store.QueryTrace("app.a", "abcdef");

        Assert.Equal(["span-1", "span-2"], spans.Select(span => span.SpanId));
    }

    [Fact]
    public void Record_DropsSpansMissingIdsOrStartTimestamp()
    {
        var store = new InMemoryTraceStore();
        store.Record("app.a", Span("trace-1", "no-start", T0) with { StartUnixNano = 0 });
        store.Record("app.a", Span("", "no-trace", T0));
        store.Record("app.a", Span("trace-1", "", T0));

        Assert.Empty(store.Query("app.a", T0.AddSeconds(-3600), 100));
    }

    [Fact]
    public void Record_DoesNotEvictInWindowSpansWhenSkewedFutureSpanArrives()
    {
        // Age eviction is Prune's job (host clock), not Record's: a single span stamped far in the
        // future (client clock skew) must not evict the app's existing in-window spans on append.
        var store = new InMemoryTraceStore(TimeSpan.FromSeconds(60));
        store.Record("app.a", Span("trace-1", "real", T0));
        store.Record("app.a", Span("trace-1", "skewed-future", T0.AddHours(2)));

        var spans = store.Query("app.a", T0.AddSeconds(-3600), 100);

        Assert.Equal(["real", "skewed-future"], spans.Select(span => span.SpanId));
    }

    [Fact]
    public void Record_EnforcesPerAppSpanCap()
    {
        var store = new InMemoryTraceStore();
        for (var i = 0; i < 2050; i++)
        {
            store.Record("app.a", Span("trace-1", i.ToString(), T0.AddMilliseconds(i)));
        }

        var spans = store.Query("app.a", T0.AddSeconds(-3600), limit: 5000);

        Assert.Equal(2000, spans.Count);
        // Oldest were dropped; the newest survives.
        Assert.Equal("2049", spans[^1].SpanId);
    }

    [Fact]
    public void Remove_DropsAllSpansForApp()
    {
        var store = new InMemoryTraceStore();
        store.Record("app.a", Span("trace-1", "a", T0));
        store.Record("app.b", Span("trace-1", "b", T0));

        store.Remove("app.a");

        Assert.Empty(store.Query("app.a", T0.AddSeconds(-60), 100));
        Assert.Single(store.Query("app.b", T0.AddSeconds(-60), 100));
    }

    [Fact]
    public void Prune_EvictsStaleSpansAndEmptyApps()
    {
        var store = new InMemoryTraceStore(TimeSpan.FromSeconds(60));
        store.Record("app.a", Span("trace-1", "stale", T0));

        store.Prune(T0.AddMinutes(10));

        Assert.Empty(store.Query("app.a", T0.AddSeconds(-3600), 100));
        Assert.Empty(store.QueryTrace("app.a", "trace-1"));
    }

    private static readonly IReadOnlyDictionary<string, string> Empty =
        new Dictionary<string, string>(StringComparer.Ordinal);

    private static OtlpSpan Span(string traceId, string spanId, DateTimeOffset start)
        => new(
            traceId,
            spanId,
            ParentSpanId: null,
            Name: "op",
            Kind: "internal",
            StartUnixNano: start.ToUnixTimeMilliseconds() * 1_000_000,
            EndUnixNano: start.ToUnixTimeMilliseconds() * 1_000_000 + 1_000_000,
            StatusCode: "unset",
            StatusMessage: null,
            Attributes: Empty);
}
