using System.Net;
using System.Text;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private const string PinnedAppId = "com.example.remote-local";

    [Fact]
    public async Task UpdateCheck_StopDuringManifestProbe_DoesNotReportCheckoutDrift()
    {
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var block = false;
        var (fixture, _, repository, _, _) = await CreatePinnedLocalFixtureAsync(() => "1.0.0", manifestProbe: async () =>
        {
            if (!block) return;
            entered.TrySetResult();
            await release.Task;
        });
        var nextCommit = await AdvancePinnedRepositoryAsync(repository);
        await fixture.Apps.UpdateAppAsync(PinnedAppId, app => app with
        {
            SourceState = app.SourceState! with { Commit = nextCommit },
            Endpoints = [],
        });
        block = true;
        var check = fixture.Service.CreateUpdatePlanAsync(PinnedAppId, new AppUpdatePlanRequest());
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await fixture.Service.StopAsync(PinnedAppId);
        }
        finally { release.TrySetResult(); }
        var plan = await check;
        Assert.Null(plan.Error);
        var app = Assert.Single(await fixture.Service.ListAppsAsync());
        Assert.Equal("stopped", app.RuntimeState);
        Assert.Null(app.UpdateCheck!.Error);
    }

    [Fact]
    public async Task PinnedCheckoutError_StatusFails_PreservesConfirmedDrift()
    {
        var (fixture, _, repository, checkout, originalCommit) = await CreatePinnedLocalFixtureAsync(() => "1.0.0");
        var nextCommit = await AdvancePinnedRepositoryAsync(repository);
        var app = (await fixture.Apps.GetAppAsync(PinnedAppId))!;
        app = app with { SourceState = app.SourceState! with { Commit = nextCommit } };
        // A corrupt index breaks git status while rev-parse HEAD still succeeds.
        await File.WriteAllTextAsync(Path.Combine(checkout, ".git", "index"), "invalid index");
        var error = await fixture.Sources.GetPinnedCheckoutErrorAsync(app);
        Assert.Contains("Source update is incomplete", error);
        Assert.Contains(originalCommit, error);
        Assert.Contains(nextCommit, error);
        Assert.Contains("Restart", error);
        Assert.Contains("Could not check restart blockers", error);
    }

    [Theory]
    [InlineData(true, true)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public async Task UpdateCheck_RecordedPinAheadOfRunningCheckout_ReportsIncompleteSourceUpdate(bool running, bool dirty)
    {
        var (fixture, adapter, repository, checkout, originalCommit) = await CreatePinnedLocalFixtureAsync(() => "1.0.0");
        var nextCommit = await AdvancePinnedRepositoryAsync(repository);
        if (!running) await fixture.Service.StopAsync(PinnedAppId);
        // A failed older update persisted the new pin, then Restart launched the old checkout.
        await fixture.Apps.UpdateAppAsync(PinnedAppId, app => app with
        {
            SourceState = app.SourceState! with { Commit = nextCommit },
            // The generic recording adapter returns an endpoint this portless fixture never declares.
            Endpoints = [],
        });
        if (dirty) await File.WriteAllTextAsync(Path.Combine(checkout, "package-lock.json"), "setup changed the lock");
        var starts = adapter.StartCount;
        var stops = adapter.StopCount;

        var plan = await fixture.Service.CreateUpdatePlanAsync(PinnedAppId, new AppUpdatePlanRequest());
        Assert.Empty(plan.Changes);
        var verdict = Assert.Single(await fixture.Service.ListAppsAsync()).UpdateCheck!;
        Assert.Equal(verdict.Error, plan.Error);
        Assert.Equal(plan.Error, (await fixture.Service.GetPendingUpdatePlanAsync(PinnedAppId)).Plan!.Error);
        if (running)
        {
            Assert.Contains(originalCommit, verdict.Error);
            Assert.Contains(nextCommit, verdict.Error);
            Assert.Contains(checkout, verdict.Error);
            Assert.Contains("Restart", verdict.Error);
            if (dirty) Assert.Contains("package-lock.json", verdict.Error);
            Assert.Null(verdict.PlanDigest);
            Assert.Null(verdict.LastSuccessfulCheckAt);
        }
        else Assert.Null(verdict.Error); // A stopped app materializes its pin on next start.
        Assert.Equal(originalCommit, await RunGitAsync(checkout, ["rev-parse", "HEAD"]));
        Assert.Equal(starts, adapter.StartCount);
        Assert.Equal(stops, adapter.StopCount);

        if (running && !dirty)
        {
            await fixture.Service.RestartAsync(PinnedAppId);
            await fixture.Apps.UpdateAppAsync(PinnedAppId, app => app with { Endpoints = [] });
            await fixture.Service.CreateUpdatePlanAsync(PinnedAppId, new AppUpdatePlanRequest());
            var recovered = Assert.Single(await fixture.Service.ListAppsAsync()).UpdateCheck!;
            Assert.Null(recovered.Error);
            Assert.False(recovered.UpdateAvailable);
            Assert.Equal(nextCommit, await RunGitAsync(checkout, ["rev-parse", "HEAD"]));
        }
    }

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
        CreatePinnedLocalFixtureAsync(Func<string> version, bool development = false, Func<Task>? manifestProbe = null)
    {
        string? repository = null;
        var manifests = new AppManifestService(new HttpClient(new PinnedManifestHandler(async () =>
        {
            if (manifestProbe is not null) await manifestProbe();
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(CreateRemoteLocalCommandManifestJson(repository!, version())
                    .Replace("\"default\": true", $"\"default\": true, \"development\": {development.ToString().ToLowerInvariant()}", StringComparison.Ordinal), Encoding.UTF8, "application/json"),
            };
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

    private sealed class PinnedManifestHandler(Func<Task<HttpResponseMessage>> handler) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => handler();
    }

    private static async Task<string> AdvancePinnedRepositoryAsync(string repository)
    {
        await File.WriteAllTextAsync(Path.Combine(repository, "apps", "remote-app", "README.md"), "new reviewed source");
        await RunGitAsync(repository, ["add", "apps/remote-app/README.md"]);
        await RunGitAsync(repository, ["-c", "user.name=Hosty Test", "-c", "user.email=hosty@example.test", "commit", "-m", "Update source"]);
        return await RunGitAsync(repository, ["rev-parse", "HEAD"]);
    }
}
