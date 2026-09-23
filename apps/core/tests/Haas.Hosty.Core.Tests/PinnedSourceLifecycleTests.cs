using System.Net;
using System.Text;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private const string PinnedAppId = "com.example.remote-local";

    [Theory]
    [InlineData("worktree", false, false)]
    [InlineData("worktree", false, true)]
    [InlineData("worktree", true, false)]
    [InlineData("worktree", true, true)]
    [InlineData("", false, false)]
    [InlineData("", false, true)]
    [InlineData("", true, false)]
    [InlineData("", true, true)]
    [InlineData("  ", false, false)]
    [InlineData("  ", false, true)]
    [InlineData("  ", true, false)]
    [InlineData("  ", true, true)]
    public async Task PinnedSourceLifecycle_AlternateCheckoutLayout_UsesSameRootForPreflightAndLaunch(
        string layout, bool dirty, bool update)
    {
        var version = "1.0.0";
        var (fixture, adapter, repository, checkout, originalCommit) = await CreatePinnedLocalFixtureAsync(() => version);
        var storedPath = layout;
        if (layout == "worktree")
        {
            checkout = Path.Combine(fixture.Root, "linked-checkout");
            await RunGitAsync(repository, ["worktree", "add", "--detach", checkout, originalCommit]);
            Assert.True(File.Exists(Path.Combine(checkout, ".git")));
            storedPath = checkout;
        }

        var nextCommit = await AdvancePinnedRepositoryAsync(repository);
        version = "1.1.0";
        await fixture.Apps.UpdateAppAsync(PinnedAppId, app => app with
        {
            SourceState = app.SourceState! with
            {
                ManagedCheckoutPath = storedPath,
                // Restart must prepare a reviewed pin ahead of HEAD; Update advances it itself.
                Commit = update ? originalCommit : nextCommit,
            },
        });
        if (dirty) await File.WriteAllTextAsync(Path.Combine(checkout, "package-lock.json"), "local work");
        var before = (await fixture.Apps.GetAppAsync(PinnedAppId))!;
        var manifestBefore = await File.ReadAllTextAsync(before.ManifestPath!);
        var plan = update ? await fixture.Service.CreateUpdatePlanAsync(PinnedAppId, new AppUpdatePlanRequest()) : null;
        adapter.StopProbe = async () => Assert.Equal(originalCommit, await RunGitAsync(checkout, ["rev-parse", "HEAD"]));
        adapter.StartContextProbe = async (context, _) =>
        {
            Assert.Equal(checkout, context.SourceRoot);
            Assert.Equal(checkout, context.App.SourceState!.ManagedCheckoutPath);
            Assert.Equal(nextCommit, await RunGitAsync(checkout, ["rev-parse", "HEAD"]));
        };
        Task<AppLifecycleResponse> Act() => update
            ? fixture.Service.ApplyUpdateAsync(PinnedAppId, new AppUpdateApplyRequest(plan!.PlanDigest))
            : fixture.Service.RestartAsync(PinnedAppId);

        if (dirty)
        {
            var error = await Assert.ThrowsAsync<AppLifecycleException>(Act);
            Assert.Equal("source_changes_present", error.Code);
            Assert.Contains(checkout, error.Message);
            Assert.Equal(0, adapter.StopCount);
            Assert.Equal(1, adapter.StartCount);
            var after = (await fixture.Apps.GetAppAsync(PinnedAppId))!;
            Assert.Equal("running", after.RuntimeState);
            Assert.Equal(before.Version, after.Version);
            Assert.Equal(before.SourceState!.Commit, after.SourceState!.Commit);
            Assert.Equal(manifestBefore, await File.ReadAllTextAsync(after.ManifestPath!));
            Assert.Equal(originalCommit, await RunGitAsync(checkout, ["rev-parse", "HEAD"]));
            Assert.Equal("local work", await File.ReadAllTextAsync(Path.Combine(checkout, "package-lock.json")));
        }
        else
        {
            await Act();
            Assert.Equal(1, adapter.StopCount);
            Assert.Equal(2, adapter.StartCount);
            Assert.Equal("running", (await fixture.Apps.GetAppAsync(PinnedAppId))!.RuntimeState);
        }
    }

    [Theory]
    [InlineData("unstaged", true)]
    [InlineData("staged", true)]
    [InlineData("untracked", true)]
    [InlineData("unstaged", false)]
    public async Task ApplyUpdateAsync_DirtyPinnedCheckout_PreservesInstallationAndRuntime(string change, bool running)
    {
        var version = "1.0.0";
        var (fixture, adapter, repository, checkout, originalCommit) = await CreatePinnedLocalFixtureAsync(() => version);
        if (!running) await fixture.Service.StopAsync(PinnedAppId);
        var before = (await fixture.Apps.GetAppAsync(PinnedAppId))!;
        var manifestBefore = await File.ReadAllTextAsync(before.ManifestPath!);
        var starts = adapter.StartCount;
        var stops = adapter.StopCount;
        var nextCommit = await AdvancePinnedRepositoryAsync(repository);
        version = "1.1.0";

        // The root lockfile is outside apps/remote-app, just like the Gateway's npm workspace lock.
        var dirtyPath = change == "untracked" ? "operator.txt" : "package-lock.json";
        await File.WriteAllTextAsync(Path.Combine(checkout, dirtyPath), "local work");
        if (change == "staged") await RunGitAsync(checkout, ["add", dirtyPath]);
        var statusBefore = await RunGitAsync(checkout, ["status", "--porcelain=v1"]);
        var plan = await fixture.Service.CreateUpdatePlanAsync(PinnedAppId, new AppUpdatePlanRequest());

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Service.ApplyUpdateAsync(PinnedAppId, new AppUpdateApplyRequest(plan.PlanDigest)));

        Assert.Equal("source_changes_present", error.Code);
        Assert.Contains(checkout, error.Message);
        Assert.Contains(dirtyPath, error.Message);
        var after = (await fixture.Apps.GetAppAsync(PinnedAppId))!;
        Assert.Equal(before.RuntimeState, after.RuntimeState);
        Assert.Equivalent(before.Health, after.Health);
        Assert.Equal("1.0.0", after.Version);
        Assert.Equal(originalCommit, after.SourceState!.Commit);
        Assert.Equal(manifestBefore, await File.ReadAllTextAsync(after.ManifestPath!));
        Assert.Equal(originalCommit, await RunGitAsync(checkout, ["rev-parse", "HEAD"]));
        Assert.Equal(statusBefore, await RunGitAsync(checkout, ["status", "--porcelain=v1"]));
        Assert.Equal("local work", await File.ReadAllTextAsync(Path.Combine(checkout, dirtyPath)));
        Assert.Equal(starts, adapter.StartCount);
        Assert.Equal(stops, adapter.StopCount);
        Assert.Empty(Directory.Exists(fixture.Paths.BackupsRoot) ? Directory.GetFiles(fixture.Paths.BackupsRoot, "*", SearchOption.AllDirectories) : []);
        Assert.Equal(plan.PlanDigest, (await fixture.Service.GetPendingUpdatePlanAsync(PinnedAppId)).Plan?.PlanDigest);
        Assert.NotEqual(originalCommit, nextCommit);

        if (change == "unstaged" && running)
        {
            // Once the operator restores their file, the same reviewed update remains retryable.
            await File.WriteAllTextAsync(Path.Combine(checkout, dirtyPath), "original lock");
            await fixture.Service.ApplyUpdateAsync(PinnedAppId, new AppUpdateApplyRequest(plan.PlanDigest));
            Assert.Equal(nextCommit, await RunGitAsync(checkout, ["rev-parse", "HEAD"]));
            Assert.Equal("1.1.0", (await fixture.Apps.GetAppAsync(PinnedAppId))!.Version);
        }
    }

    [Fact]
    public async Task ApplyUpdateAsync_CleanPinnedCheckout_StartsReviewedCodeAfterStoppingOldCode()
    {
        var version = "1.0.0";
        var (fixture, adapter, repository, checkout, originalCommit) = await CreatePinnedLocalFixtureAsync(() => version);
        var nextCommit = await AdvancePinnedRepositoryAsync(repository);
        version = "1.1.0";
        adapter.StopProbe = async () => Assert.Equal(originalCommit, await RunGitAsync(checkout, ["rev-parse", "HEAD"]));
        adapter.StartContextProbe = async (context, _) =>
        {
            Assert.Equal(nextCommit, await RunGitAsync(checkout, ["rev-parse", "HEAD"]));
            Assert.Equal(nextCommit, context.App.SourceState!.Commit);
            Assert.Equal(checkout, context.SourceRoot);
        };
        var plan = await fixture.Service.CreateUpdatePlanAsync(PinnedAppId, new AppUpdatePlanRequest());

        await fixture.Service.ApplyUpdateAsync(PinnedAppId, new AppUpdateApplyRequest(plan.PlanDigest));

        var after = (await fixture.Apps.GetAppAsync(PinnedAppId))!;
        Assert.Equal("1.1.0", after.Version);
        Assert.Equal("running", after.RuntimeState);
        Assert.Equal(nextCommit, after.SourceState!.Commit);
        Assert.Equal(2, adapter.StartCount);
        Assert.Equal(1, adapter.StopCount);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task RestartAsync_DirtyPinnedCheckout_RefusesWithoutTouchingRuntime(bool running)
    {
        var (fixture, adapter, _, checkout, originalCommit) = await CreatePinnedLocalFixtureAsync(() => "1.0.0");
        if (!running) await fixture.Service.StopAsync(PinnedAppId);
        var before = (await fixture.Apps.GetAppAsync(PinnedAppId))!;
        var starts = adapter.StartCount;
        var stops = adapter.StopCount;
        await File.WriteAllTextAsync(Path.Combine(checkout, "package-lock.json"), "local work");

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Service.RestartAsync(PinnedAppId));

        Assert.Equal("source_changes_present", error.Code);
        Assert.Equal(starts, adapter.StartCount);
        Assert.Equal(stops, adapter.StopCount);
        var after = (await fixture.Apps.GetAppAsync(PinnedAppId))!;
        Assert.Equal(before.RuntimeState, after.RuntimeState);
        Assert.Equivalent(before.Health, after.Health);
        Assert.Equal(originalCommit, await RunGitAsync(checkout, ["rev-parse", "HEAD"]));
        Assert.Equal("local work", await File.ReadAllTextAsync(Path.Combine(checkout, "package-lock.json")));
    }

    [Fact]
    public async Task RestartAsync_RecordedPinAheadOfCheckout_PreparesPinBeforeLaunching()
    {
        var (fixture, adapter, repository, checkout, originalCommit) = await CreatePinnedLocalFixtureAsync(() => "1.0.0");
        var nextCommit = await AdvancePinnedRepositoryAsync(repository);
        // Reproduce the persisted state after an older Core's failed update, without fetching the pin.
        await fixture.Apps.UpdateAppAsync(PinnedAppId, app => app with
        {
            SourceState = app.SourceState! with { Commit = nextCommit },
            Version = "1.1.0",
            OperationStatus = "failed",
            LastOperation = "update",
        });
        adapter.StopProbe = async () => Assert.Equal(originalCommit, await RunGitAsync(checkout, ["rev-parse", "HEAD"]));
        adapter.StartContextProbe = async (context, _) =>
        {
            Assert.Equal(nextCommit, await RunGitAsync(checkout, ["rev-parse", "HEAD"]));
            Assert.Equal(nextCommit, context.App.SourceState!.Commit);
            Assert.Equal(checkout, context.SourceRoot);
        };

        await fixture.Service.RestartAsync(PinnedAppId);

        Assert.Equal(2, adapter.StartCount);
        Assert.Equal(1, adapter.StopCount);
        Assert.Equal("restarted", (await fixture.Apps.GetAppAsync(PinnedAppId))!.OperationStatus);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PinnedSourceLaunch_EditDuringStop_IsStillProtected(bool update)
    {
        var version = "1.0.0";
        var (fixture, adapter, repository, checkout, originalCommit) = await CreatePinnedLocalFixtureAsync(() => version);
        await AdvancePinnedRepositoryAsync(repository);
        version = "1.1.0";
        adapter.StopProbe = () => File.WriteAllTextAsync(Path.Combine(checkout, "package-lock.json"), "concurrent work");
        var plan = await fixture.Service.CreateUpdatePlanAsync(PinnedAppId, new AppUpdatePlanRequest());

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => update
            ? fixture.Service.ApplyUpdateAsync(PinnedAppId, new AppUpdateApplyRequest(plan.PlanDigest))
            : fixture.Service.RestartAsync(PinnedAppId));

        Assert.Equal("source_changes_present", error.Code);
        Assert.Equal(1, adapter.StartCount);
        Assert.Equal(originalCommit, await RunGitAsync(checkout, ["rev-parse", "HEAD"]));
        Assert.Equal("concurrent work", await File.ReadAllTextAsync(Path.Combine(checkout, "package-lock.json")));
        Assert.Equal("stopped", (await fixture.Apps.GetAppAsync(PinnedAppId))!.RuntimeState);
    }

    [Fact]
    public async Task RestartAsync_DevelopmentCheckout_AllowsLocalEdits()
    {
        var (fixture, adapter, _, checkout, _) = await CreatePinnedLocalFixtureAsync(() => "1.0.0", development: true);
        await File.WriteAllTextAsync(Path.Combine(checkout, "package-lock.json"), "development work");

        await fixture.Service.RestartAsync(PinnedAppId);

        Assert.Equal(2, adapter.StartCount);
        Assert.Equal("development work", await File.ReadAllTextAsync(Path.Combine(checkout, "package-lock.json")));
    }

    private static async Task<(LifecycleFixture Fixture, RecordingRuntimeAdapter Adapter, string Repository, string Checkout, string Commit)>
        CreatePinnedLocalFixtureAsync(Func<string> version, bool development = false)
    {
        string? repository = null;
        var manifests = new AppManifestService(new HttpClient(new StubHttpMessageHandler(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(CreateRemoteLocalCommandManifestJson(repository!, version())
                .Replace("\"default\": true", $"\"default\": true, \"development\": {development.ToString().ToLowerInvariant()}", StringComparison.Ordinal), Encoding.UTF8, "application/json"),
        })));
        var adapter = new RecordingRuntimeAdapter("localCommand");
        var fixture = await LifecycleFixture.CreateAsync(manifests, localRuntimeAdapter: adapter);
        repository = await CreateLocalCommandGitRepositoryAsync(fixture.Root);
        await File.WriteAllTextAsync(Path.Combine(repository, "package-lock.json"), "original lock");
        await RunGitAsync(repository, ["add", "package-lock.json"]);
        await RunGitAsync(repository, ["-c", "user.name=Hosty Test", "-c", "user.email=hosty@example.test", "commit", "-m", "Add lockfile"]);
        var commit = await RunGitAsync(repository, ["rev-parse", "HEAD"]);
        await fixture.Service.InstallAsync(new AppInstallRequest("https://apps.example.test/remote-local/manifest.json"));
        await fixture.Service.StartAsync(PinnedAppId);
        var checkout = (await fixture.Apps.GetAppAsync(PinnedAppId))!.SourceState!.ManagedCheckoutPath!;
        return (fixture, adapter, repository, checkout, commit);
    }

    private static async Task<string> AdvancePinnedRepositoryAsync(string repository)
    {
        await File.WriteAllTextAsync(Path.Combine(repository, "apps", "remote-app", "README.md"), "new reviewed source");
        await RunGitAsync(repository, ["add", "apps/remote-app/README.md"]);
        await RunGitAsync(repository, ["-c", "user.name=Hosty Test", "-c", "user.email=hosty@example.test", "commit", "-m", "Update source"]);
        return await RunGitAsync(repository, ["rev-parse", "HEAD"]);
    }
}
