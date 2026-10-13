using Haas.Hosty.Core;
using Microsoft.Extensions.Logging;

namespace Haas.Hosty.Core.Tests;

public sealed class RuntimeResourceSamplerDockerTests
{
    [Fact]
    public async Task ReadDockerSamplesAsync_DeadlinePreservesFreshSamplesAndNextAttemptRecovers()
    {
        using var fixture = new Fixture();
        var first = Assert.Single(await fixture.Sampler.ReadDockerSamplesAsync(CancellationToken.None));
        fixture.Clock.UtcNow = fixture.Clock.UtcNow.AddSeconds(10);
        fixture.Runner.Stats = async token =>
        {
            try { await Task.Delay(Timeout.InfiniteTimeSpan, token); }
            finally { fixture.Clock.UtcNow += RuntimeResourceSampler.DockerTimeout; }
            throw new InvalidOperationException("The acquisition deadline must cancel the wait.");
        };

        // Exercise the actual sampler deadline, not a fabricated cancellation exception. The
        // clock follows the elapsed probe so the old observation is 18 seconds old on return.
        var retained = Assert.Single(await fixture.Sampler.ReadDockerSamplesAsync(CancellationToken.None)
            .WaitAsync(TimeSpan.FromSeconds(30)));

        Assert.Equal(first, retained);
        Assert.Equal(18, (fixture.Clock.UtcNow - retained.Timestamp).TotalSeconds);
        var warning = Assert.Single(fixture.Logger.Entries);
        Assert.Equal(LogLevel.Warning, warning.Level);
        Assert.Contains("timed out", warning.Message);
        Assert.Contains("limit 8 s", warning.Message);

        fixture.Clock.UtcNow = fixture.Clock.UtcNow.AddSeconds(10);
        fixture.Runner.Stats = _ => Task.FromResult(new DockerCommandResult(0, StatsOutput(9), ""));
        var recovered = Assert.Single(await fixture.Sampler.ReadDockerSamplesAsync(CancellationToken.None));

        Assert.Equal(9d, recovered.CpuPercent);
        Assert.Equal(fixture.Clock.UtcNow, recovered.Timestamp);
        Assert.Equal(3, fixture.Runner.StatsCalls);
        Assert.Contains(fixture.Logger.Entries, e => e.Level == LogLevel.Information && e.Message.Contains("recovered after 1 failed attempts"));
    }

    [Fact]
    public async Task ReadDockerSamplesAsync_RepeatedFailuresExpireSamplesWithoutRenewingTheirAge()
    {
        using var fixture = new Fixture();
        var first = Assert.Single(await fixture.Sampler.ReadDockerSamplesAsync(CancellationToken.None));
        fixture.Runner.Stats = _ => throw new DockerUnavailableException("Docker daemon unavailable");

        fixture.Clock.UtcNow = first.Timestamp.AddSeconds(10);
        Assert.Equal(first, Assert.Single(await fixture.Sampler.ReadDockerSamplesAsync(CancellationToken.None)));
        fixture.Clock.UtcNow = first.Timestamp.AddSeconds(20);
        var lastFresh = await fixture.Sampler.ReadDockerSamplesAsync(CancellationToken.None);
        Assert.Equal(first, Assert.Single(lastFresh));
        fixture.Sampler.Record(new(fixture.Clock.UtcNow,
            [.. lastFresh, new("hosty.core", "core", "localCommand", fixture.Clock.UtcNow, 2, 1024)]));
        Assert.Contains("container.cpu.percent", fixture.Sampler.CurrentPrometheusText);

        fixture.Clock.UtcNow = fixture.Clock.UtcNow.AddMilliseconds(1);
        var expired = await fixture.Sampler.ReadDockerSamplesAsync(CancellationToken.None);

        Assert.Empty(expired);
        Assert.Equal(3, fixture.Runner.StatsCalls); // No new attempt is needed to expire cached data.
        Assert.DoesNotContain("container.", fixture.Sampler.CurrentPrometheusText);
        Assert.Contains("process.cpu.percent", fixture.Sampler.CurrentPrometheusText);
        var reconciled = expired.ToList();
        RuntimeResourceSampler.ReconcileApp(reconciled, "app", "running", ["web"], fixture.Clock.UtcNow);
        var unknown = Assert.Single(reconciled);
        Assert.Null(unknown.CpuPercent);
        Assert.Null(unknown.MemoryBytes);

        fixture.Clock.UtcNow = fixture.Clock.UtcNow.AddSeconds(10);
        fixture.Runner.Stats = _ => Task.FromResult(new DockerCommandResult(0, StatsOutput(7), ""));
        var recovered = Assert.Single(await fixture.Sampler.ReadDockerSamplesAsync(CancellationToken.None));
        Assert.Equal(7d, recovered.CpuPercent);
        Assert.Equal(fixture.Clock.UtcNow, recovered.Timestamp);
    }

    [Fact]
    public async Task ReadDockerSamplesAsync_CommandFailureKeepsSamplesAndLogsBoundedDiagnostics()
    {
        using var fixture = new Fixture();
        var first = Assert.Single(await fixture.Sampler.ReadDockerSamplesAsync(CancellationToken.None));
        fixture.Clock.UtcNow = fixture.Clock.UtcNow.AddSeconds(10);
        fixture.Runner.Stats = _ => Task.FromResult(new DockerCommandResult(42, "", "daemon\nerror\r\n" + new string('x', 2000)));

        Assert.Equal(first, Assert.Single(await fixture.Sampler.ReadDockerSamplesAsync(CancellationToken.None)));

        var warning = Assert.Single(fixture.Logger.Entries);
        Assert.Equal(LogLevel.Warning, warning.Level);
        Assert.Contains("ms", warning.Message);
        var error = Assert.IsType<DockerUnavailableException>(warning.Exception);
        Assert.StartsWith("docker stats exited with code 42: daemon error", error.Message);
        Assert.DoesNotContain('\n', error.Message);
        Assert.DoesNotContain('\r', error.Message);
        Assert.True(error.Message.Length < 1100);
    }

    [Fact]
    public async Task ReadDockerSamplesAsync_FailuresAreThrottledAndRecoveryResetsWarnings()
    {
        using var fixture = new Fixture();
        fixture.Runner.Stats = _ => throw new DockerUnavailableException("Docker daemon unavailable");
        for (var attempt = 0; attempt < 7; attempt++)
        {
            Assert.Empty(await fixture.Sampler.ReadDockerSamplesAsync(CancellationToken.None));
            fixture.Clock.UtcNow = fixture.Clock.UtcNow.AddSeconds(10);
        }
        Assert.Equal(2, fixture.Logger.Entries.Count(e => e.Level == LogLevel.Warning));
        Assert.Contains("7 failed attempts", fixture.Logger.Entries[^1].Message);

        fixture.Runner.Stats = _ => Task.FromResult(new DockerCommandResult(0, StatsOutput(3), ""));
        Assert.Single(await fixture.Sampler.ReadDockerSamplesAsync(CancellationToken.None));
        Assert.Equal(LogLevel.Information, fixture.Logger.Entries[^1].Level);
        Assert.Contains("recovered after 7 failed attempts", fixture.Logger.Entries[^1].Message);

        fixture.Clock.UtcNow = fixture.Clock.UtcNow.AddSeconds(10);
        fixture.Runner.Stats = _ => throw new DockerUnavailableException("Docker daemon unavailable again");
        await fixture.Sampler.ReadDockerSamplesAsync(CancellationToken.None);
        Assert.Equal(3, fixture.Logger.Entries.Count(e => e.Level == LogLevel.Warning));
    }

    [Fact]
    public async Task ReadDockerSamplesAsync_ShutdownCancellationPropagatesWithoutWarning()
    {
        using var fixture = new Fixture();
        var first = Assert.Single(await fixture.Sampler.ReadDockerSamplesAsync(CancellationToken.None));
        fixture.Clock.UtcNow = fixture.Clock.UtcNow.AddSeconds(10);
        using var shutdown = new CancellationTokenSource();
        fixture.Runner.Stats = token =>
        {
            shutdown.Cancel();
            token.ThrowIfCancellationRequested();
            throw new InvalidOperationException("The shutdown token must propagate.");
        };

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => fixture.Sampler.ReadDockerSamplesAsync(shutdown.Token));

        Assert.Empty(fixture.Logger.Entries);
        Assert.Equal(first, Assert.Single(fixture.Exposition.Samples));
    }

    [Fact]
    public async Task ReadDockerSamplesAsync_SuccessfulEmptyResultClearsCacheImmediately()
    {
        using var fixture = new Fixture();
        Assert.Single(await fixture.Sampler.ReadDockerSamplesAsync(CancellationToken.None));
        fixture.Clock.UtcNow = fixture.Clock.UtcNow.AddSeconds(10);
        fixture.Runner.Stats = _ => Task.FromResult(new DockerCommandResult(0, "", ""));

        Assert.Empty(await fixture.Sampler.ReadDockerSamplesAsync(CancellationToken.None));
        Assert.Empty(fixture.Exposition.Samples);
        Assert.Empty(fixture.Logger.Entries);
    }

    [Fact]
    public async Task ReadDockerSamplesAsync_RetainedSamplesStillReconcileStoppedAppsToZero()
    {
        using var fixture = new Fixture();
        await fixture.Sampler.ReadDockerSamplesAsync(CancellationToken.None);
        fixture.Clock.UtcNow = fixture.Clock.UtcNow.AddSeconds(10);
        fixture.Runner.Stats = _ => throw new DockerUnavailableException("Docker daemon unavailable");
        var samples = (await fixture.Sampler.ReadDockerSamplesAsync(CancellationToken.None)).ToList();

        RuntimeResourceSampler.ReconcileApp(samples, "app", "stopped", ["web"], fixture.Clock.UtcNow);

        var stopped = Assert.Single(samples);
        Assert.Equal(0d, stopped.CpuPercent);
        Assert.Equal(0d, stopped.MemoryBytes);
    }

    [Fact]
    public async Task BuildSnapshotAsync_OwnerRefreshFailureDoesNotOverwritePreviousSnapshot()
    {
        using var fixture = new Fixture();
        await fixture.Exposition.BuildSnapshotAsync(CancellationToken.None);
        var first = Assert.Single(fixture.Exposition.Samples);
        fixture.Clock.UtcNow = fixture.Clock.UtcNow.AddMinutes(1);
        fixture.Runner.PsResult = new(1, "", "owner lookup failed");

        var error = await Assert.ThrowsAsync<DockerUnavailableException>(() => fixture.Exposition.BuildSnapshotAsync(CancellationToken.None));

        Assert.Contains("docker ps exited with code 1: owner lookup failed", error.Message);
        Assert.Equal(first, Assert.Single(fixture.Exposition.Samples));
        fixture.Runner.PsResult = new(0, "hosty-app-web\tapp\tweb\n", "");
        await fixture.Exposition.BuildSnapshotAsync(CancellationToken.None);
        Assert.Equal(fixture.Clock.UtcNow, Assert.Single(fixture.Exposition.Samples).Timestamp);
    }

    private static string StatsOutput(int cpu) => $"hosty-app-web\t{cpu}%\t10MiB / 100MiB\t10%\n";

    private sealed class Fixture : IDisposable
    {
        public FakeClock Clock { get; } = new();
        public StubDockerRunner Runner { get; } = new();
        public CapturingLogger Logger { get; } = new();
        public DockerStatsExposition Exposition { get; }
        public RuntimeResourceSampler Sampler { get; }

        public Fixture()
        {
            Exposition = new(Runner, Clock);
            Sampler = new(null!, Exposition, null!, new CoreEventHub(), Clock, Logger, new AppManifestService());
        }

        public void Dispose() => Sampler.Dispose();
    }

    private sealed class FakeClock : IClock
    {
        public DateTimeOffset UtcNow { get; set; } = DateTimeOffset.Parse("2026-10-13T10:00:00Z");
    }

    private sealed class StubDockerRunner : IDockerCommandRunner
    {
        public DockerCommandResult PsResult { get; set; } = new(0, "hosty-app-web\tapp\tweb\n", "");
        public Func<CancellationToken, Task<DockerCommandResult>> Stats { get; set; }
            = _ => Task.FromResult(new DockerCommandResult(0, StatsOutput(3), ""));
        public int StatsCalls { get; private set; }

        public Task<DockerCommandResult> RunAsync(IReadOnlyList<string> args,
            IReadOnlyDictionary<string, string>? environment = null, CancellationToken cancellationToken = default)
        {
            if (args[0] == "ps") return Task.FromResult(PsResult);
            Assert.Equal("stats", args[0]);
            StatsCalls++;
            return Stats(cancellationToken);
        }
    }

    private sealed record LogEntry(LogLevel Level, string Message, Exception? Exception);

    private sealed class CapturingLogger : ILogger<RuntimeResourceSampler>
    {
        public List<LogEntry> Entries { get; } = [];
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel level) => true;
        public void Log<TState>(LogLevel level, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter) => Entries.Add(new(level, formatter(state, exception), exception));
    }
}
