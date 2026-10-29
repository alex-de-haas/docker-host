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
            NullLogger<RuntimeResourceSampler>.Instance, new AppManifestService());
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
    public void StreamSnapshotsDoNotRenewLegacyLeaseAndViewersShareDemand()
    {
        var clock = new FakeClock(DateTimeOffset.UtcNow);
        var hub = new CoreEventHub();
        var sampler = new RuntimeResourceSampler(null!, null!, null!, hub, clock,
            NullLogger<RuntimeResourceSampler>.Instance, new AppManifestService());
        using var generic = hub.Subscribe("admin", true);
        sampler.Read(stream: true);
        Assert.False(sampler.HasViewers);
        var first = hub.Subscribe("admin", true, "one", resources: true);
        using var second = hub.Subscribe("admin", true, "two", resources: true);
        Assert.True(sampler.HasViewers);
        first.Dispose();
        Assert.True(sampler.HasViewers);
        hub.CloseSession("two");
        Assert.False(sampler.HasViewers);
        sampler.Read();
        Assert.True(sampler.HasViewers);
        clock.UtcNow = clock.UtcNow.AddSeconds(21);
        sampler.Read(stream: true);
        Assert.False(sampler.HasViewers);
    }

    [Fact]
    public void StreamAndHistoryShareResourceSequenceDespiteOtherEventsAndQueueDrops()
    {
        var clock = new FakeClock(DateTimeOffset.UtcNow);
        var hub = new CoreEventHub();
        using var subscriber = hub.Subscribe("admin", true, resources: true);
        using var generic = hub.Subscribe("admin", true);
        using var user = hub.Subscribe("user", false, resources: true);
        var sampler = new RuntimeResourceSampler(null!, null!, null!, hub, clock,
            NullLogger<RuntimeResourceSampler>.Instance, new AppManifestService());
        for (var i = 0; i < 100; i++)
        {
            hub.PublishAppEvent(CoreEventHub.AppChanged);
            sampler.Record(new(clock.UtcNow, []));
        }
        var snapshot = sampler.Read(stream: true);
        Assert.Equal(100, snapshot.Sequence);
        Assert.Equal(Enumerable.Range(1, 100).Select(i => (long)i), snapshot.History.Select(f => f.Sequence));
        var sequences = new List<long>();
        while (subscriber.Reader.TryRead(out var envelope))
            if (envelope.Name == CoreEventHub.ResourcesSample)
            {
                var sample = System.Text.Json.JsonSerializer.Deserialize(envelope.Data, CoreJsonSerializerContext.Default.ResourceUsageEvent)!;
                Assert.Equal(snapshot.RunId, sample.RunId);
                Assert.Equal(sample.Sequence, sample.Frame.Sequence);
                sequences.Add(sample.Sequence);
            }
        Assert.Equal(Enumerable.Range(69, 32).Select(i => (long)i), sequences);
        while (generic.Reader.TryRead(out var envelope)) Assert.NotEqual(CoreEventHub.ResourcesSample, envelope.Name);
        Assert.False(user.Reader.TryRead(out _));
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
    [Fact]
    public void ChildHistoryRequiresOwnerAndPermissionAndResetsForAReplacementOrMissingProcess()
    {
        var clock = new FakeClock(DateTimeOffset.UtcNow);
        var hub = new CoreEventHub();
        var sampler = new RuntimeResourceSampler(null!, null!, null!, hub, clock,
            NullLogger<RuntimeResourceSampler>.Instance, new AppManifestService());
        using var owner = hub.Subscribe("owner", true, resources: true, sandboxes: true);
        using var foreign = hub.Subscribe("other", true, resources: true, sandboxes: true);
        using var unscoped = hub.Subscribe("owner", true, resources: true);
        var child = new RuntimeResourceSample("core-environment:child", "core", "core", clock.UtcNow,
            12, 100, EnvironmentId: "child", ProcessIdentity: "12:123", OwnerUserId: "owner");
        sampler.Record(new(clock.UtcNow, [child]));
        Assert.Single(sampler.Read(userId: "owner", environments: true).History[0].Services);
        Assert.Empty(sampler.Read(userId: "other", environments: true).History[0].Services);
        Assert.Empty(sampler.Read(userId: "owner").History[0].Services);
        Assert.True(owner.Reader.TryRead(out var owned));
        Assert.Contains("core-environment:child", owned.Data);
        Assert.DoesNotContain("ownerUserId", owned.Data);
        foreach (var subscriber in new[] { foreign, unscoped })
        {
            Assert.True(subscriber.Reader.TryRead(out var hidden));
            Assert.DoesNotContain("core-environment:child", hidden.Data);
        }
        sampler.Record(new(clock.UtcNow.AddSeconds(3), [child with { ProcessIdentity = "12:456", CpuPercent = null }]));
        var restarted = sampler.Read(userId: "owner", environments: true);
        Assert.Empty(restarted.History[0].Services);
        Assert.Null(Assert.Single(restarted.History[1].Services).CpuPercent);
        sampler.Record(new(clock.UtcNow.AddSeconds(6), []));
        Assert.All(sampler.Read(userId: "owner", environments: true).History, frame => Assert.Empty(frame.Services));
    }

    [Fact]
    public async Task ChildProcessReadingsRequireTheRecordedStartIdentityAndAnActiveEnvironment()
    {
        var root = Path.Combine(Path.GetTempPath(), "hosty-resource-" + Guid.NewGuid().ToString("N"));
        try
        {
            var paths = CoreDataPaths.FromConfig(new(root, root, "", 7070, "http://localhost:7070", null, "localhost", null, false));
            var store = new CoreEnvironmentStore(paths);
            var clock = new FakeClock(DateTimeOffset.UtcNow);
            using var process = System.Diagnostics.Process.GetCurrentProcess();
            var child = new CoreEnvironmentRecord(Guid.NewGuid().ToString("N"), new("owner"),
                new(Guid.NewGuid().ToString(), "Test"), "hash", 7071, 1, "running", clock.UtcNow,
                Process: new(process.Id, process.StartTime.ToUniversalTime()));
            await store.WriteAsync(child, default);
            var reader = new LocalResourceReader(new LocalCommandProcessRegistry(), clock, store);
            var sample = Assert.Single((await reader.ReadAsync(default)).Where(s => s.EnvironmentId == child.Id));
            Assert.True(sample.MemoryBytes > 0); Assert.Null(sample.CpuPercent);
            Assert.Equal("owner", sample.OwnerUserId);
            await store.WriteAsync(child with { Process = child.Process! with { StartedAt = clock.UtcNow.AddDays(-1) } }, default);
            Assert.DoesNotContain(await reader.ReadAsync(default), s => s.EnvironmentId is not null);
            await store.WriteAsync(child with { State = "finished" }, default);
            Assert.DoesNotContain(await reader.ReadAsync(default), s => s.EnvironmentId is not null);
        }
        finally { if (Directory.Exists(root)) Directory.Delete(root, true); }
    }
    private sealed class FakeClock(DateTimeOffset now) : IClock { public DateTimeOffset UtcNow { get; set; } = now; }
}
