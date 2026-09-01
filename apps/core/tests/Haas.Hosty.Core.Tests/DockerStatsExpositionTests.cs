using System.Text;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class DockerStatsExpositionTests
{
    [Fact]
    public void AppendSample_RendersPrometheusLineWithAttributionAndService()
    {
        var builder = new StringBuilder();
        DockerStatsExposition.AppendSample(builder, "container.cpu.percent", "com.acme.app", "web", 1.5);

        Assert.Equal("container.cpu.percent{hosty_app_id=\"com.acme.app\",service=\"web\"} 1.5\n", builder.ToString());
    }

    [Fact]
    public void AppendSample_EscapesLabelValues()
    {
        var builder = new StringBuilder();
        DockerStatsExposition.AppendSample(builder, "m", "a\"b", "c\\d", 2);

        Assert.Equal("m{hosty_app_id=\"a\\\"b\",service=\"c\\\\d\"} 2\n", builder.ToString());
    }

    [Fact]
    public void ParseContainerOwners_ReadsLabelsAndFallsBackToAppIdForService()
    {
        var owners = DockerStatsExposition.ParseContainerOwners(
            "cont-a\tcom.acme.app\tweb\ncont-b\tcom.acme.other\t\n");

        Assert.Equal(2, owners.Count);
        Assert.Equal(new ContainerStatOwner("com.acme.app", "web"), owners["cont-a"]);
        // No service label → falls back to the app id.
        Assert.Equal(new ContainerStatOwner("com.acme.other", "com.acme.other"), owners["cont-b"]);
    }

    [Fact]
    public void ParseContainerOwners_SkipsMalformedLines()
    {
        // Blank lines and a name-only line (no app id) carry no owner.
        var owners = DockerStatsExposition.ParseContainerOwners("\nonlyname\ngood\tapp\tsvc\n");
        var owner = Assert.Single(owners);
        Assert.Equal("good", owner.Key);
    }

    [Fact]
    public void ParseContainerOwners_DropsRowsOfOtherInstances()
    {
        // The 4th field is the hosty.instance label; absent (pre-label containers, and every default
        // instance container) reads as the default's empty id. A secondary-root Core must not
        // attribute — and double-report — the default root's containers, and vice versa.
        const string output = "cont-a\tcom.acme.app\tweb\t\ncont-b\tcom.acme.other\tapi\tbbbb\n";

        var defaultOwners = DockerStatsExposition.ParseContainerOwners(output);
        Assert.Equal("cont-a", Assert.Single(defaultOwners).Key);

        var scopedOwners = DockerStatsExposition.ParseContainerOwners(output, "bbbb");
        Assert.Equal("cont-b", Assert.Single(scopedOwners).Key);
    }

    [Fact]
    public async Task BuildSnapshotAsync_ReadsContainerOwnersOnceAcrossTicks()
    {
        // `docker ps` answers a question that changes when an app starts or stops, not every ten
        // seconds, so re-running it per tick was a process spawn spent on an unchanged answer.
        var runner = new RecordingDockerRunner
        {
            PsOutput = "hosty-com-acme-app-web\tcom.acme.app\tweb\n",
            StatsOutput = "hosty-com-acme-app-web\t1.5%\t10MiB / 100MiB\t10%\n",
        };
        var exposition = CreateExposition(runner);

        var first = await exposition.BuildSnapshotAsync(CancellationToken.None);
        var second = await exposition.BuildSnapshotAsync(CancellationToken.None);

        Assert.Equal(first, second);
        Assert.Contains("com.acme.app", first);
        Assert.Equal(1, runner.PsCalls);
        Assert.Equal(2, runner.StatsCalls);
    }

    [Fact]
    public async Task BuildSnapshotAsync_IgnoresContainersThatAreNotHostys()
    {
        // A shared host runs the operator's own containers, and the unscoped `docker stats` reports
        // all of them. Treating any unattributed name as "the map is behind" would re-read `docker ps`
        // every tick on every such host — which is most of them — and cache nothing.
        var runner = new RecordingDockerRunner
        {
            PsOutput = "hosty-com-acme-app-web\tcom.acme.app\tweb\n",
            StatsOutput = "hosty-com-acme-app-web\t1.5%\t10MiB / 100MiB\t10%\npostgres\t9%\t80MiB / 100MiB\t80%\n",
        };
        var exposition = CreateExposition(runner);

        var snapshot = await exposition.BuildSnapshotAsync(CancellationToken.None);
        await exposition.BuildSnapshotAsync(CancellationToken.None);
        await exposition.BuildSnapshotAsync(CancellationToken.None);

        Assert.Equal(1, runner.PsCalls);
        Assert.Contains("com.acme.app", snapshot);
        // A foreign container is sampled but never attributed, so it contributes no series.
        Assert.DoesNotContain("postgres", snapshot);
    }

    [Fact]
    public async Task BuildSnapshotAsync_RereadsOwnersOnceTheMapReachesItsMaxAge()
    {
        // Container names are derived and the derivation is not injective, so a name can outlive the
        // app that owned it (`foo.bar` and `foo-bar` normalize alike). Nothing in a sample would
        // reveal that, so the map is re-read on age alone rather than trusted indefinitely.
        var clock = new FakeClock(DateTimeOffset.Parse("2026-08-28T10:00:00Z"));
        var runner = new RecordingDockerRunner
        {
            PsOutput = "hosty-foo-bar-web\tfoo.bar\tweb\n",
            StatsOutput = "hosty-foo-bar-web\t1.5%\t10MiB / 100MiB\t10%\n",
        };
        var exposition = CreateExposition(runner, clock);
        await exposition.BuildSnapshotAsync(CancellationToken.None);

        // The colliding app takes the name over: same container name, different owner.
        runner.PsOutput = "hosty-foo-bar-web\tfoo-bar\tweb\n";
        await exposition.BuildSnapshotAsync(CancellationToken.None);
        Assert.Equal(1, runner.PsCalls);

        clock.UtcNow = clock.UtcNow.AddMinutes(2);
        var afterExpiry = await exposition.BuildSnapshotAsync(CancellationToken.None);

        Assert.Equal(2, runner.PsCalls);
        Assert.Contains("foo-bar", afterExpiry);
    }

    [Fact]
    public async Task BuildSnapshotAsync_RefreshesOwnersWhenASampleNamesAnUnknownContainer()
    {
        // A container appearing in the samples that the map has no owner for is the signal that an app
        // started since the last refresh — the one thing that has to re-read `docker ps`.
        var runner = new RecordingDockerRunner
        {
            PsOutput = "hosty-com-acme-app-web\tcom.acme.app\tweb\n",
            StatsOutput = "hosty-com-acme-app-web\t1.5%\t10MiB / 100MiB\t10%\n",
        };
        var exposition = CreateExposition(runner);
        await exposition.BuildSnapshotAsync(CancellationToken.None);
        Assert.Equal(1, runner.PsCalls);

        runner.PsOutput = "hosty-com-acme-app-web\tcom.acme.app\tweb\nhosty-com-acme-other-api\tcom.acme.other\tapi\n";
        runner.StatsOutput = "hosty-com-acme-app-web\t1.5%\t10MiB / 100MiB\t10%\nhosty-com-acme-other-api\t2.5%\t20MiB / 100MiB\t20%\n";

        // The refresh lands before the render, so the newly started app is attributed in the very tick
        // that first sees it rather than the one after.
        var afterRefresh = await exposition.BuildSnapshotAsync(CancellationToken.None);

        Assert.Equal(2, runner.PsCalls);
        Assert.Contains("com.acme.other", afterRefresh);
    }

    [Fact]
    public async Task BuildSnapshotAsync_KeepsAskingWhileNothingIsRunning()
    {
        // An empty map is not a cached answer: it is the state that a starting app changes, so it must
        // never latch a host into reporting nothing.
        var runner = new RecordingDockerRunner { PsOutput = string.Empty, StatsOutput = string.Empty };
        var exposition = CreateExposition(runner);

        Assert.Empty(await exposition.BuildSnapshotAsync(CancellationToken.None));
        Assert.Empty(await exposition.BuildSnapshotAsync(CancellationToken.None));

        Assert.Equal(2, runner.PsCalls);
        // Nothing owned means nothing to sample, so the expensive call is skipped entirely.
        Assert.Equal(0, runner.StatsCalls);
    }

    [Fact]
    public async Task BuildSnapshotAsync_StopsSamplingOnceEverythingHasStopped()
    {
        // The cached map must not outlive what it describes: with nothing left to sample, a stale
        // non-empty map would keep the expensive call running every tick and never fall back to the
        // cheap `docker ps` that can skip it — turning the idle host into the costly case.
        var runner = new RecordingDockerRunner
        {
            PsOutput = "cont-a\tcom.acme.app\tweb\n",
            StatsOutput = "cont-a\t1.5%\t10MiB / 100MiB\t10%\n",
        };
        var exposition = CreateExposition(runner);
        await exposition.BuildSnapshotAsync(CancellationToken.None);

        runner.PsOutput = string.Empty;
        runner.StatsOutput = string.Empty;

        // The tick that finds nothing to sample drops the map; the next one is back to asking cheaply.
        Assert.Empty(await exposition.BuildSnapshotAsync(CancellationToken.None));
        Assert.Empty(await exposition.BuildSnapshotAsync(CancellationToken.None));

        Assert.Equal(2, runner.PsCalls);
        Assert.Equal(2, runner.StatsCalls);
    }

    private sealed class FakeClock(DateTimeOffset now) : IClock
    {
        public DateTimeOffset UtcNow { get; set; } = now;
    }

    private static DockerStatsExposition CreateExposition(IDockerCommandRunner runner, IClock? clock = null)
    {
        var root = Path.Combine(Path.GetTempPath(), $"hosty-core-stats-tests-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        var paths = new CoreDataPaths(
            DataRoot: root,
            CoreRoot: Path.Combine(root, "core"),
            AppsRoot: Path.Combine(root, "apps"),
            BackupsRoot: Path.Combine(root, "backups"),
            SourcesRoot: Path.Combine(root, "sources"),
            AuthRoot: Path.Combine(root, "core", "auth"),
            AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));
        return new DockerStatsExposition(
            new AppRegistryStore(paths),
            runner,
            clock ?? new FakeClock(DateTimeOffset.Parse("2026-08-28T10:00:00Z")),
            Microsoft.Extensions.Logging.Abstractions.NullLogger<DockerStatsExposition>.Instance);
    }

    private sealed class RecordingDockerRunner : IDockerCommandRunner
    {
        public string PsOutput { get; set; } = string.Empty;

        public string StatsOutput { get; set; } = string.Empty;

        public int PsCalls { get; private set; }

        public int StatsCalls { get; private set; }

        public Task<DockerCommandResult> RunAsync(
            IReadOnlyList<string> args,
            IReadOnlyDictionary<string, string>? environment = null,
            CancellationToken cancellationToken = default)
        {
            if (args[0] == "ps")
            {
                PsCalls += 1;
                return Task.FromResult(new DockerCommandResult(0, PsOutput, ""));
            }

            StatsCalls += 1;
            return Task.FromResult(new DockerCommandResult(0, StatsOutput, ""));
        }
    }
}
