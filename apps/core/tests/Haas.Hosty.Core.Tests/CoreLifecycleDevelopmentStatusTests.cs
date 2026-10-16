using System.Text.Json.Nodes;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task LinkedWorktreeManifest_AbsoluteRepository_PreservesSubpathAndTracksRestart(bool fileUri)
    {
        var adapter = new RecordingRuntimeAdapter("localCommand");
        var f = await LifecycleFixture.CreateAsync(localRuntimeAdapter: adapter, shortPaths: true);
        var repo = await CreateGitRepositoryAsync(f.Root);
        var directory = Path.Combine(repo, "apps", "demo"); Directory.CreateDirectory(directory);
        var manifest = Path.Combine(directory, "manifest.json");
        var json = JsonNode.Parse(await File.ReadAllTextAsync(await f.WriteLocalCommandManifestAsync()))!;
        json["runtimeProfiles"]![0]!["development"] = true;
        json["source"] = new JsonObject { ["type"] = "git", ["repository"] = fileUri ? new Uri(repo).AbsoluteUri : repo, ["branch"] = "main" };
        await File.WriteAllTextAsync(manifest, json.ToJsonString());
        await RunGitAsync(repo, ["add", "."]);
        await RunGitAsync(repo, ["-c", "user.name=Fixture", "-c", "user.email=fixture@hosty.test", "commit", "-m", "Test manifest"]);
        var tree = Path.Combine(f.Root, "tree");
        await RunGitAsync(repo, ["worktree", "add", "--detach", tree]);
        var treeManifest = Path.Combine(tree, "apps", "demo", "manifest.json");
        await f.Service.InstallAsync(new AppInstallRequest(treeManifest, SelectedRuntime: "dev"));
        Assert.Equal("apps/demo", (await f.Apps.GetAppAsync("com.example.local"))!.SourceState!.ManifestSubpath);
        await f.Sources.SetLocalOverrideAsync("com.example.local", new(tree));
        var started = (await f.Service.StartAsync("com.example.local")).App!;
        Assert.Null(started.ManifestError); Assert.Equal("current", started.Development!.ManifestState);
        Assert.Equal("ready", started.LaunchProgress!.Stage); Assert.False(started.RestartRequired);
        var stamp = File.GetLastWriteTimeUtc(treeManifest);
        var original = await File.ReadAllTextAsync(treeManifest);
        var changed = original.Replace("1.0.0", "1.0.1"); Assert.NotEqual(original, changed);
        await File.WriteAllTextAsync(treeManifest, changed); File.SetLastWriteTimeUtc(treeManifest, stamp);
        var observed = Assert.Single(await f.Service.ListAppsAsync());
        Assert.Equal("changed", observed.Development!.ManifestState); Assert.True(observed.RestartRequired);
        var restarted = (await f.Service.RestartAsync("com.example.local")).App!;
        Assert.Equal("current", restarted.Development!.ManifestState); Assert.False(restarted.RestartRequired);
        Assert.Null(restarted.ManifestError);
        File.Delete(treeManifest);
        Assert.Equal("unavailable", Assert.Single(await f.Service.ListAppsAsync()).Development!.ManifestState);
        await f.Service.StopAsync("com.example.local");
    }

    [Fact]
    public async Task LaunchProgress_ReportsBuildDuringStartAndFailureWithoutSuccess()
    {
        var f = await LifecycleFixture.CreateAsync();
        await f.Service.InstallAsync(new AppInstallRequest(await f.WriteManifestAsync("1.0.0")));
        var entered = new TaskCompletionSource(); var proceed = new TaskCompletionSource();
        f.Adapter.StartContextProbe = async (context, ct) =>
        {
            await context.ReportLaunchProgress!("building", "app"); entered.SetResult();
            await proceed.Task.WaitAsync(ct);
            throw new AppLifecycleException("docker_dev_build_failed", "Fixture build failed");
        };
        var start = f.Service.StartAsync("com.example.notes");
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
        var during = Assert.Single(await f.Service.ListAppsAsync());
        Assert.Equal("building", during.LaunchProgress!.BuildState); Assert.Equal("app", during.LaunchProgress.Service);
        proceed.SetResult(); await Assert.ThrowsAsync<AppLifecycleException>(() => start);
        var failed = Assert.Single(await f.Service.ListAppsAsync());
        Assert.Equal("failed", failed.LaunchProgress!.Stage); Assert.Equal("failed", failed.LaunchProgress.BuildState);
        Assert.Equal("stopped", failed.RuntimeState);
    }
}
