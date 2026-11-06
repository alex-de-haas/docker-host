using Haas.Hosty.Launch;
using Haas.Hosty.Releases;

namespace Haas.Hosty.Cli.Tests.Commands;

public sealed class PlatformUpdateTransactionTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "hosty-platform-update-" + Guid.NewGuid().ToString("N"));
    private readonly HttpClient client = new();
    private string Cli => Path.Combine(root, "bin", "hosty");
    private string Core => Path.Combine(root, "core", "bin", "hosty-core");
    private const string Hash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    public PlatformUpdateTransactionTests()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Cli)!);
        Directory.CreateDirectory(Path.GetDirectoryName(Core)!);
        File.WriteAllText(Cli, "old-cli"); File.WriteAllText(Core, "old-core");
    }
    public void Dispose() { client.Dispose(); Directory.Delete(root, recursive: true); }

    [Fact]
    public async Task BadSecondAssetLeavesBothExecutablesAndRunningCoreUntouched()
    {
        var selection = Selection();
        File.WriteAllText(selection.Release.Assets.Single(a => a.Role == "cli").Url, "corrupt-cli");
        var host = new Host();
        await Assert.ThrowsAsync<PlatformReleaseException>(() => Transaction(host).ExecuteAsync(root, Cli, Core, selection));
        Assert.Equal(0, host.Stops); Assert.Equal(0, host.Starts);
        Assert.Equal("old-cli", File.ReadAllText(Cli)); Assert.Equal("old-core", File.ReadAllText(Core));
        Assert.Equal("preparing", PlatformUpdateTransaction.Pending(root)!.Phase);
    }

    [Fact]
    public async Task FailedStopDoesNotReplaceEitherExecutableAndRetryUsesFrozenRelease()
    {
        var selection = Selection();
        var host = new Host { CanStop = false };
        await Assert.ThrowsAsync<PlatformReleaseException>(() => Transaction(host).ExecuteAsync(root, Cli, Core, selection));
        var id = PlatformUpdateTransaction.Pending(root)!.Id;
        Assert.Equal("old-cli", File.ReadAllText(Cli)); Assert.Equal("old-core", File.ReadAllText(Core));
        host.CanStop = true;
        var complete = await Transaction(host).ExecuteAsync(root, Cli, Core, null);
        Assert.Equal(id, complete.Id); Assert.Equal("completed", complete.Phase);
        Assert.Equal("new-cli", File.ReadAllText(Cli)); Assert.Equal("new-core", File.ReadAllText(Core));
        Assert.Equal(1, host.Starts);
    }

    [Theory]
    [InlineData(false)] [InlineData(true)]
    public async Task StoppedAndDevelopmentCoresStayInTheirOriginalState(bool dev)
    {
        var host = new Host { Live = dev ? Observation("dev", 42, "old") : null };
        await Transaction(host).ExecuteAsync(root, Cli, Core, Selection());
        Assert.Equal(0, host.Stops); Assert.Equal(0, host.Starts);
        Assert.Equal("new-core", File.ReadAllText(Core));
        Assert.Equal(dev, host.Live is not null);
    }

    [Fact]
    public async Task StartupFailureIsRetainedAndRecoveryDoesNotRefetchTheFeedOrRollBackData()
    {
        var host = new Host { CanStart = false };
        await Assert.ThrowsAsync<PlatformReleaseException>(() => Transaction(host).ExecuteAsync(root, Cli, Core, Selection()));
        var operation = PlatformUpdateTransaction.Pending(root)!;
        Assert.Equal("launching", operation.Phase);
        Assert.Equal("new-core", File.ReadAllText(Core)); Assert.Equal("new-cli", File.ReadAllText(Cli));
        host.CanStart = true;
        var completed = await Transaction(host).ExecuteAsync(root, Cli, Core, null);
        Assert.Equal(operation.Id, completed.Id); Assert.Equal("completed", completed.Phase);
        Assert.NotNull(completed.ReadyCore);
    }

    [Fact]
    public async Task SharedCliCannotBeUpdatedByAnotherDataRootDuringPendingOperation()
    {
        var host = new Host { CanStop = false };
        await Assert.ThrowsAsync<PlatformReleaseException>(() => Transaction(host).ExecuteAsync(root, Cli, Core, Selection()));
        var other = Path.Combine(root, "other");
        var error = await Assert.ThrowsAsync<PlatformReleaseException>(() => Transaction(new Host()).ExecuteAsync(other, Cli, Path.Combine(other, "core"), Selection()));
        Assert.Equal("platform_cli_update_pending", error.Code);
    }

    [Fact]
    public async Task OtherLifecycleCommandsAreBlockedWhileAnUpdateNeedsRecovery()
    {
        await Assert.ThrowsAsync<PlatformReleaseException>(() => Transaction(new Host { CanStop = false }).ExecuteAsync(root, Cli, Core, Selection()));
        Assert.Throws<InvalidOperationException>(() => CoreLaunchFiles.AssertNoPendingOperations(root));
        CoreLaunchFiles.AssertNoPendingOperations(root, ownPlatformUpdateId: PlatformUpdateTransaction.Pending(root)!.Id);
    }

    [Fact]
    public async Task RestartAndRecoveryPreserveTheObservedListenerAndPublicOrigins()
    {
        var observed = Observation("release", 42, "1.0.0") with { ListenUrl = "http://localhost:23456", CorePublicOrigin = "https://core.example.test", RuntimePublicHost = "apps.example.test" };
        var host = new Host { Live = observed, CanStart = false };
        await Assert.ThrowsAsync<PlatformReleaseException>(() => Transaction(host).ExecuteAsync(root, Cli, Core, Selection()));
        host.CanStart = true;
        await Transaction(host).ExecuteAsync(root, Cli, Core, null);
        Assert.Equal(observed, host.StartedFrom);
    }

    private PlatformUpdateTransaction Transaction(Host host) => new(new PlatformReleaseReader(client), host);
    private PlatformReleaseSelection Selection()
    {
        var assets = new List<PlatformReleaseAsset>();
        foreach (var role in new[] { "cli", "core" })
        {
            var path = Path.Combine(root, "published-" + role);
            File.WriteAllText(path, "new-" + role);
            var bytes = File.ReadAllBytes(path);
            assets.Add(new(role, PlatformFeedSource.CurrentRid, role, path, bytes.Length, PlatformReleaseReader.Hash(bytes), Hash, "build"));
        }
        var source = new PlatformUpdateSource("hosty-platform-update-source.0.1", Path.Combine(root, "feeds.json"), "publisher-custom", "revision");
        return new(source, new(source.FeedId, Path.Combine(root, "release.json"), Hash),
            new("hosty-platform-release.0.1", Hash, "2.0.0", new string('b', 40), assets), Hash, Hash);
    }
    private static PlatformCoreObservation Observation(string mode, int pid, string version)
        => new(new(mode, mode == "dev" ? "/project/core.csproj" : null, null, pid, DateTimeOffset.UtcNow), version);
    private sealed class Host : IPlatformUpdateHost
    {
        public PlatformCoreObservation? Live = Observation("release", 42, "1.0.0");
        public bool CanStop = true, CanStart = true;
        public int Stops, Starts;
        public Task<PlatformCoreObservation?> ObserveAsync(CancellationToken ct) => Task.FromResult(Live);
        public Task<bool> StopAsync(CancellationToken ct) { Stops++; if (CanStop) Live = null; return Task.FromResult(CanStop); }
        public PlatformCoreObservation? StartedFrom;
        public Task<bool> StartAsync(PlatformCoreObservation? previous, CancellationToken ct) { StartedFrom = previous; Starts++; if (CanStart) Live = Observation("release", 84, "2.0.0"); return Task.FromResult(CanStart); }
    }
}
