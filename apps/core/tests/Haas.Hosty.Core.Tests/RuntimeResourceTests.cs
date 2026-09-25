using Haas.Hosty.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed class RuntimeResourceTests
{
    [Theory]
    [InlineData("starting")]
    [InlineData("stopping")]
    [InlineData("unknown")]
    [InlineData("running")]
    public void IncompleteAppsRetainObservedUsageAndDoNotInventZeroForMissingServices(string state)
    {
        var at = DateTimeOffset.UtcNow;
        var samples = new List<RuntimeResourceSample> { new("app", "backend", "localCommand", at, 25, 100) };
        RuntimeResourceSampler.ReconcileApp(samples, "app", state, ["backend", "frontend"], at);
        Assert.Equal(25d, samples.Single(s => s.Service == "backend").CpuPercent);
        Assert.Null(samples.Single(s => s.Service == "frontend").MemoryBytes);
        RuntimeResourceSampler.ReconcileApp(samples, "app", "stopped", ["backend", "frontend"], at);
        Assert.All(samples, sample => Assert.Equal(0d, sample.CpuPercent));
    }

    [Fact]
    public void TreeIncludesDescendantsAndReparentedGroupMembersButNotOtherApps()
    {
        var tree = LocalResourceReader.ParseTree("10 1 10\n11 10 10\n12 11 12\n13 1 10\n20 1 20\n21 20 20\n");
        Assert.Equal([10, 11, 12, 13], LocalResourceReader.SelectTree(tree, 10, true).Order());
        Assert.Equal([10, 11, 12], LocalResourceReader.SelectTree(tree, 10, false).Order());
        Assert.Empty(LocalResourceReader.SelectTree(tree, 99, true));
    }

    [Fact]
    public void CpuAddsEveryProcessDeltaAndCanExceedOneCore()
    {
        ProcessReading[] before = [new(10, 100, 2, 50), new(11, 200, 3, 60)];
        ProcessReading[] after = [new(10, 100, 3, 50), new(11, 200, 5, 60)];
        Assert.Equal(150d, LocalResourceReader.CpuPercent(after, before.ToDictionary(p => p.Pid), 2));
    }

    [Fact]
    public void CpuWarmsUpAndRejectsReusedPidsAndCounterResets()
    {
        var before = new Dictionary<int, ProcessReading> { [10] = new(10, 100, 2, 50) };
        Assert.Null(LocalResourceReader.CpuPercent([new(10, 101, 20, 50)], before, 2));
        Assert.Null(LocalResourceReader.CpuPercent([new(10, 100, 1, 50)], before, 2));
        Assert.Null(LocalResourceReader.CpuPercent([new(11, 100, 20, 50)], before, 2));
        Assert.Null(LocalResourceReader.CpuPercent([new(10, 100, 2, 50)], before, 0));
    }

    [Fact]
    public void HistoryIsBoundedExpiresAndResyncsAfterRestart()
    {
        var clock = new FakeClock(DateTimeOffset.UtcNow);
        var sampler = new RuntimeResourceSampler(null!, null!, null!, new CoreEventHub(), clock,
            NullLogger<RuntimeResourceSampler>.Instance);
        for (var i = 0; i < 200; i++) sampler.Record(new(clock.UtcNow.AddMilliseconds(i - 200), []));
        var first = sampler.Read();
        Assert.Equal(RuntimeResourceSampler.MaxFrames, first.History.Count);
        Assert.Empty(sampler.Read(first.History[^1].Timestamp, first.RunId).History);
        Assert.NotEmpty(sampler.Read(first.History[^1].Timestamp, "previous-core-run").History);
        sampler.Record(new(clock.UtcNow.AddMinutes(-10), []));
        clock.UtcNow = clock.UtcNow.AddMinutes(6);
        Assert.Empty(sampler.Read().History);
    }

    [Fact]
    public async Task LocalReaderMeasuresCoreWithoutRequiringAnyApps()
    {
        var reader = new LocalResourceReader(new LocalCommandProcessRegistry(), new FakeClock(DateTimeOffset.UtcNow));
        var first = Assert.Single(await reader.ReadAsync(CancellationToken.None));
        Assert.Equal("hosty.core", first.AppId);
        Assert.True(first.MemoryBytes > 0);
        Assert.Null(first.CpuPercent);
        var second = Assert.Single(await reader.ReadAsync(CancellationToken.None));
        Assert.True(second.CpuPercent >= 0);
        reader.Reset();
        Assert.Null(Assert.Single(await reader.ReadAsync(CancellationToken.None)).CpuPercent);
    }
    private sealed class FakeClock(DateTimeOffset now) : IClock { public DateTimeOffset UtcNow { get; set; } = now; }
}
