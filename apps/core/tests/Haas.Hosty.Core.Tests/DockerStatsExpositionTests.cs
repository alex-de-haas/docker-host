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
    public async Task BuildSnapshotAsync_ReadsContainerOwnersOnceAcrossTicks()
    {
        // `docker ps` answers a question that changes when an app starts or stops, not every ten
        // seconds, so re-running it per tick was a process spawn spent on an unchanged answer.
        var runner = new RecordingDockerRunner
        {
            PsOutput = "cont-a\tcom.acme.app\tweb\n",
            StatsOutput = "cont-a\t1.5%\t10MiB / 100MiB\t10%\n",
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
    public async Task BuildSnapshotAsync_RefreshesOwnersWhenASampleNamesAnUnknownContainer()
    {
        // A container appearing in the samples that the map has no owner for is the signal that an app
        // started since the last refresh — the one thing that has to re-read `docker ps`.
        var runner = new RecordingDockerRunner
        {
            PsOutput = "cont-a\tcom.acme.app\tweb\n",
            StatsOutput = "cont-a\t1.5%\t10MiB / 100MiB\t10%\n",
        };
        var exposition = CreateExposition(runner);
        await exposition.BuildSnapshotAsync(CancellationToken.None);
        Assert.Equal(1, runner.PsCalls);

        runner.PsOutput = "cont-a\tcom.acme.app\tweb\ncont-b\tcom.acme.other\tapi\n";
        runner.StatsOutput = "cont-a\t1.5%\t10MiB / 100MiB\t10%\ncont-b\t2.5%\t20MiB / 100MiB\t20%\n";

        // The tick that first sees the unknown container refreshes the map; the next one renders it.
        await exposition.BuildSnapshotAsync(CancellationToken.None);
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

    private static DockerStatsExposition CreateExposition(IDockerCommandRunner runner)
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
