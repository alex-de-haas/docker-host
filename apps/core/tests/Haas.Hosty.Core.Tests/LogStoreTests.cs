using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class LogStoreTests
{
    private static readonly DateTimeOffset T0 = new(2026, 1, 1, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Query_ReturnsRecordsForAppInArrivalOrder()
    {
        var store = new InMemoryLogStore();
        store.Record("app.a", Rec(T0, body: "first"));
        store.Record("app.a", Rec(T0.AddSeconds(1), body: "second"));

        var records = store.Query("app.a", T0.AddSeconds(-60), minSeverity: null, limit: 100);

        Assert.Equal(["first", "second"], records.Select(record => record.Body));
    }

    [Fact]
    public void Query_IsolatesAppsFromEachOther()
    {
        var store = new InMemoryLogStore();
        store.Record("app.a", Rec(T0, body: "a"));
        store.Record("app.b", Rec(T0, body: "b"));

        Assert.Equal("b", Assert.Single(store.Query("app.b", T0.AddSeconds(-60), null, 100)).Body);
        Assert.Empty(store.Query("app.unknown", T0.AddSeconds(-60), null, 100));
    }

    [Fact]
    public void Query_FiltersBelowMinimumSeverity()
    {
        var store = new InMemoryLogStore();
        store.Record("app.a", Rec(T0, sev: 9, body: "info"));     // INFO
        store.Record("app.a", Rec(T0.AddSeconds(1), sev: 17, body: "error")); // ERROR

        var records = store.Query("app.a", T0.AddSeconds(-60), minSeverity: 13, limit: 100);

        Assert.Equal("error", Assert.Single(records).Body);
    }

    [Fact]
    public void Query_ReturnsMostRecentUpToLimitInArrivalOrder()
    {
        var store = new InMemoryLogStore();
        for (var i = 0; i < 5; i++)
        {
            store.Record("app.a", Rec(T0.AddSeconds(i), body: i.ToString()));
        }

        var records = store.Query("app.a", T0.AddSeconds(-60), minSeverity: null, limit: 2);

        // The two newest, still oldest→newest.
        Assert.Equal(["3", "4"], records.Select(record => record.Body));
    }

    [Fact]
    public void Query_ExcludesRecordsBeforeSince()
    {
        var store = new InMemoryLogStore();
        store.Record("app.a", Rec(T0, body: "old"));
        store.Record("app.a", Rec(T0.AddSeconds(30), body: "new"));

        var records = store.Query("app.a", T0.AddSeconds(15), null, 100);

        Assert.Equal("new", Assert.Single(records).Body);
    }

    [Fact]
    public void Record_DropsNonPositiveTimestamp()
    {
        var store = new InMemoryLogStore();
        store.Record("app.a", new OtlpLogRecord(0, 9, "INFO", "x", Empty, null, null));

        Assert.Empty(store.Query("app.a", T0.AddSeconds(-3600), null, 100));
    }

    [Fact]
    public void Record_DropsRecordsOutsideRetentionWindowOnAppend()
    {
        var store = new InMemoryLogStore(TimeSpan.FromSeconds(60));
        store.Record("app.a", Rec(T0, body: "old"));
        // 90s later the first record is outside the 60s window and is evicted on append.
        store.Record("app.a", Rec(T0.AddSeconds(90), body: "new"));

        var records = store.Query("app.a", T0.AddSeconds(-3600), null, 100);

        Assert.Equal("new", Assert.Single(records).Body);
    }

    [Fact]
    public void Record_IgnoresBlankApp()
    {
        var store = new InMemoryLogStore();
        store.Record("", Rec(T0));
        store.Record("  ", Rec(T0));

        Assert.Empty(store.Query("app.a", T0.AddSeconds(-60), null, 100));
    }

    [Fact]
    public void Record_EnforcesPerAppRecordCap()
    {
        var store = new InMemoryLogStore();
        for (var i = 0; i < 2050; i++)
        {
            store.Record("app.a", Rec(T0.AddMilliseconds(i), body: i.ToString()));
        }

        var records = store.Query("app.a", T0.AddSeconds(-3600), minSeverity: null, limit: 5000);

        Assert.Equal(2000, records.Count);
        // Oldest were dropped; the newest survives.
        Assert.Equal("2049", records[^1].Body);
    }

    [Fact]
    public void Remove_DropsAllRecordsForApp()
    {
        var store = new InMemoryLogStore();
        store.Record("app.a", Rec(T0));
        store.Record("app.b", Rec(T0));

        store.Remove("app.a");

        Assert.Empty(store.Query("app.a", T0.AddSeconds(-60), null, 100));
        Assert.Single(store.Query("app.b", T0.AddSeconds(-60), null, 100));
    }

    [Fact]
    public void Prune_EvictsStaleRecordsAndEmptyApps()
    {
        var store = new InMemoryLogStore(TimeSpan.FromSeconds(60));
        store.Record("app.a", Rec(T0));

        store.Prune(T0.AddMinutes(10));

        Assert.Empty(store.Query("app.a", T0.AddSeconds(-3600), null, 100));
    }

    private static readonly IReadOnlyDictionary<string, string> Empty =
        new Dictionary<string, string>(StringComparer.Ordinal);

    private static OtlpLogRecord Rec(DateTimeOffset ts, int sev = 9, string body = "msg", string? trace = null)
        => new(ts.ToUnixTimeMilliseconds(), sev, "", body, Empty, trace, null);
}
