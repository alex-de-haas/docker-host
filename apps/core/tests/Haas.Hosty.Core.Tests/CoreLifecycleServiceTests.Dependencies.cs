using System.Collections.Concurrent;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static async Task InstallDependencyFixtureAsync(LifecycleFixture fixture, string id,
        string? provider = null, bool required = true, bool autostart = true, bool system = false)
    {
        var path = await fixture.WriteManifestAsync("1.0.0", id: id);
        if (provider is not null)
        {
            var manifest = JsonNode.Parse(await File.ReadAllTextAsync(path))!;
            manifest["dependencies"] = new JsonArray(new JsonObject
            {
                ["id"] = provider, ["required"] = required,
                ["endpoints"] = new JsonArray(new JsonObject { ["key"] = "app.http", ["as"] = "provider" }),
            });
            await File.WriteAllTextAsync(path, manifest.ToJsonString());
        }
        await fixture.Service.InstallAsync(new AppInstallRequest(path, System: system, Autostart: autostart));
        fixture.Adapter.Health = _ => new("healthy", [new("app", "running", null, null, null, null, null, Health: "healthy")]);
    }

    private static async Task AddDevDependencyAsync(LifecycleFixture fixture, string? worktree = null)
    {
        var app = (await fixture.Apps.GetAppAsync("test.created"))!;
        var paths = new[] { app.ManifestPath!, Path.Combine(app.SourceState!.LocalOverridePath!, "manifest.json"),
            Path.Combine(worktree ?? app.SourceState.LocalOverridePath!, "manifest.json") };
        foreach (var path in paths.Distinct())
        {
            var manifest = JsonNode.Parse(await File.ReadAllTextAsync(path))!;
            manifest["dependencies"] = new JsonArray(new JsonObject { ["id"] = "org.example.provider", ["required"] = true });
            await File.WriteAllTextAsync(path, manifest.ToJsonString());
        }
        await fixture.Apps.UpdateAppAsync(app.Id, value => value with
        { Dependencies = [new("org.example.provider", null, true, [])] });
        await InstallDependencyFixtureAsync(fixture, "org.example.provider");
    }

    [Theory]
    [InlineData(false, "enter", "ready")]
    [InlineData(true, "enter", "ready")]
    [InlineData(false, "restart", "ready")]
    [InlineData(true, "restart", "ready")]
    [InlineData(false, "restart", "revoked")]
    [InlineData(true, "restart", "revoked")]
    [InlineData(false, "restart", "cancelled")]
    [InlineData(true, "restart", "cancelled")]
    public async Task ResumeWaitingAppsAsync_PrivateDevelopmentRevalidatesOriginatingAuthority(
        bool privateManifest, string action, string outcome)
    {
        var (f, service, users, privateSources) = await PrivateDevFixture(privateManifest);
        await AddDevDependencyAsync(f);
        var actor = new AppDevActor("admin", "manual");
        if (action == "restart")
        {
            await f.Apps.UpdateAppAsync("org.example.provider", app => app with { RuntimeState = "running", Health = new("healthy", [], f.Clock.UtcNow) });
            await ApplyReviewedDev(service, DevRequest("enter"), actor);
            await f.Apps.UpdateAppAsync("org.example.provider", app => app with { RuntimeState = "stopped" });
        }
        var waiting = await ApplyReviewedDev(service, DevRequest(action), actor);
        Assert.Equal("active", waiting.Phase);
        Assert.Equal("waiting", waiting.App.RuntimeState);
        Assert.Equal("dev_source_authority_required", (await Assert.ThrowsAsync<AppLifecycleException>(() => service.StartAsync("test.created"))).Code);
        var starts = f.Adapter.StartCount;
        if (outcome == "revoked") await users.UpdateAsync(state => state with { ProviderConnections = [] });
        if (outcome == "cancelled") await service.StopAsync("test.created");
        await f.Apps.UpdateAppAsync("org.example.provider", app => app with { RuntimeState = "running", Health = new("healthy", [], f.Clock.UtcNow) });

        // Recovery must use persisted authority, not the service instance or the original request.
        var resumed = f.RecreateService(privateSources: privateSources);
        await resumed.ResumeWaitingAppsAsync();
        var result = (await f.Apps.GetAppAsync("test.created"))!;
        Assert.Equal(outcome == "ready" ? "running" : "stopped", result.RuntimeState);
        Assert.Equal(starts + (outcome == "ready" ? 1 : 0), f.Adapter.StartCount);
        Assert.Equal(waiting.OperationId, result.DevModeId);
        if (outcome == "revoked") Assert.NotNull(result.LastError);
        await resumed.ResumeWaitingAppsAsync();
        Assert.Equal(starts + (outcome == "ready" ? 1 : 0), f.Adapter.StartCount);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ResumeWaitingAppsAsync_DevelopmentRevalidatesWorkspaceBinding(bool changed)
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        await AddDevDependencyAsync(f, tree.Path);
        var waiting = await ApplyReviewedDev(f.Service, DevRequest("enter", tree.Id), DevActor(owner));
        Assert.Equal("waiting", waiting.App.RuntimeState);
        if (changed)
            await JsonStorage.WriteAsync(Path.Combine(f.Paths.CoreRoot, "development/workspaces", tree.Id + ".json"),
                tree with { State = "released" });
        await f.Apps.UpdateAppAsync("org.example.provider", app => app with { RuntimeState = "running", Health = new("healthy", [], f.Clock.UtcNow) });
        var starts = f.Adapter.StartCount;
        await f.RecreateService().ResumeWaitingAppsAsync();
        Assert.Equal(changed ? "stopped" : "running", (await f.Apps.GetAppAsync("test.created"))!.RuntimeState);
        Assert.Equal(starts + (changed ? 0 : 1), f.Adapter.StartCount);
    }

    [Theory]
    [InlineData(true, "waiting", 0)]
    [InlineData(false, "running", 1)]
    public async Task StartAsync_MissingDependency_OnlyRequiredProviderGates(bool required, string state, int starts)
    {
        var f = await LifecycleFixture.CreateAsync();
        await InstallDependencyFixtureAsync(f, "org.example.consumer", "org.example.missing", required);
        var result = await f.Service.StartAsync("org.example.consumer");
        Assert.Equal(state, result.App!.RuntimeState);
        Assert.Equal(starts, f.Adapter.StartCount);
        Assert.Null(await f.Apps.GetAppAsync("org.example.missing"));
        if (required) Assert.Equal("waiting", result.Status);
    }

    [Theory]
    [InlineData("stopped", "healthy", true)]
    [InlineData("running", "degraded", true)]
    [InlineData("running", "healthy", false)]
    public async Task StartAsync_RequiresProviderReadinessAndResolvedEndpoint(string state, string health, bool resolved)
    {
        var f = await LifecycleFixture.CreateAsync();
        await InstallDependencyFixtureAsync(f, "org.example.consumer", "org.example.provider");
        await InstallDependencyFixtureAsync(f, "org.example.provider");
        await f.Apps.UpdateAppAsync("org.example.provider", app => app with
        {
            RuntimeState = state, Health = new(health, [new("app", "running", health)], f.Clock.UtcNow),
            Endpoints = resolved ? [new("app.http", "http", "http://localhost:3100", false, "app", "http")] : [],
        });
        Assert.Equal("waiting", (await f.Service.StartAsync("org.example.consumer")).Status);
        Assert.Equal(0, f.Adapter.StartCount);
        var summary = (await f.Service.ListAppsAsync()).Single(app => app.Id == "org.example.consumer");
        Assert.False(Assert.Single(summary.Dependencies!).Ready);
    }

    [Fact]
    public async Task BootstrapInstall_RespectsRequiredDependencyWait()
    {
        var f = await LifecycleFixture.CreateAsync();
        await InstallDependencyFixtureAsync(f, "org.example.consumer", "org.example.missing", system: true);
        var manifest = (await f.Apps.GetAppAsync("org.example.consumer"))!.ManifestPath;
        var catalog = Path.Combine(f.Root, "distribution-apps.json");
        await File.WriteAllTextAsync(catalog, System.Text.Json.JsonSerializer.Serialize(new
        {
            schemaVersion = "distribution-apps.0.1",
            apps = new[] { new { id = "org.example.consumer", title = "Consumer", manifestRef = manifest, defaultEnabled = true } },
        }));
        var config = new HostyCoreRuntimeConfig(f.Root, Path.Combine(f.Root, "run"), Path.Combine(f.Root, "control.json"),
            3001, "http://127.0.0.1:3001", "http://127.0.0.1:3001", "localhost", null, false);
        var bootstrap = new SystemAppBootstrapService(config, f.Apps, f.Service, f.Sources,
            new DistributionAppsProvider(NullLogger<DistributionAppsProvider>.Instance, catalog, [f.Root]),
            new DistributionSeedStore(f.Paths, f.Clock, NullLogger<DistributionSeedStore>.Instance),
            NullLogger<SystemAppBootstrapService>.Instance);
        await bootstrap.InstallAsync("org.example.consumer", CancellationToken.None);
        Assert.Equal("waiting", (await f.Apps.GetAppAsync("org.example.consumer"))!.RuntimeState);
        Assert.Equal(0, f.Adapter.StartCount);
    }

    [Fact]
    public async Task StartAutostartAppsAsync_OrdersRequiredChainAndInjectsProviderUrl()
    {
        var f = await LifecycleFixture.CreateAsync();
        await InstallDependencyFixtureAsync(f, "org.example.a", "org.example.b", system: true);
        await InstallDependencyFixtureAsync(f, "org.example.b", "org.example.z");
        await InstallDependencyFixtureAsync(f, "org.example.z");
        var order = new ConcurrentQueue<string>();
        f.Adapter.StartContextProbe = (context, _) =>
        {
            order.Enqueue(context.App.Id);
            if (context.App.Id != "org.example.z") Assert.Equal("http://localhost:3100", context.DependencyUrls["provider"]);
            return Task.CompletedTask;
        };
        var results = await f.Service.StartAutostartAppsAsync();
        Assert.All(results, result => Assert.True(result.Succeeded, result.Message));
        Assert.Equal(["org.example.z", "org.example.b", "org.example.a"], order);
    }

    [Fact]
    public async Task StartAutostartAppsAsync_ProviderInLaterTierDoesNotDeadlockEarlierConsumer()
    {
        var f = await LifecycleFixture.CreateAsync();
        await InstallDependencyFixtureAsync(f, "org.example.consumer", "org.example.provider", system: true);
        await InstallDependencyFixtureAsync(f, "org.example.provider");
        await f.Apps.UpdateAppAsync("org.example.consumer", app => app with { Provides = [PlatformCapabilities.OtlpCollector] });
        var order = new ConcurrentQueue<string>();
        f.Adapter.StartContextProbe = (context, _) => { order.Enqueue(context.App.Id); return Task.CompletedTask; };
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        await f.Service.StartAutostartAppsAsync(timeout.Token);
        Assert.Equal(["org.example.provider", "org.example.consumer"], order);
        Assert.Equal("running", (await f.Apps.GetAppAsync("org.example.consumer"))!.RuntimeState);
    }

    [Fact]
    public async Task StartAutostartAppsAsync_ReadyConsumerDoesNotWaitForIndependentSlowStart()
    {
        var f = await LifecycleFixture.CreateAsync();
        await InstallDependencyFixtureAsync(f, "org.example.a-slow", system: true);
        await InstallDependencyFixtureAsync(f, "org.example.consumer", "org.example.provider");
        await InstallDependencyFixtureAsync(f, "org.example.provider");
        var consumerStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Adapter.StartContextProbe = async (context, ct) =>
        {
            if (context.App.Id == "org.example.a-slow") await consumerStarted.Task.WaitAsync(ct);
            if (context.App.Id == "org.example.consumer") consumerStarted.SetResult();
        };
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        await f.Service.StartAutostartAppsAsync(timeout.Token);
        Assert.True(consumerStarted.Task.IsCompletedSuccessfully);
        Assert.Equal(3, f.Adapter.StartCount);
    }

    [Fact]
    public async Task StartAutostartAppsAsync_CycleWaitsAndUnrelatedAppStarts()
    {
        var f = await LifecycleFixture.CreateAsync();
        await InstallDependencyFixtureAsync(f, "org.example.a", "org.example.b");
        await InstallDependencyFixtureAsync(f, "org.example.b", "org.example.a");
        await InstallDependencyFixtureAsync(f, "org.example.independent");
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        await f.Service.StartAutostartAppsAsync(timeout.Token);
        Assert.Equal(1, f.Adapter.StartCount);
        foreach (var id in new[] { "org.example.a", "org.example.b" })
        {
            var app = await f.Apps.GetAppAsync(id);
            Assert.Equal("waiting", app!.RuntimeState);
            Assert.Contains("Required dependency cycle", app.LastError);
        }
        await f.Apps.UpdateAppAsync("org.example.b", app => app with { Dependencies = [] });
        await f.Service.ResumeWaitingAppsAsync();
        Assert.Equal(3, f.Adapter.StartCount);
        Assert.Null((await f.Apps.GetAppAsync("org.example.a"))!.LastError);
    }

    [Fact]
    public async Task ResumeWaitingAppsAsync_StopCancelsAndConcurrentResumesDoNotDuplicateStarts()
    {
        var f = await LifecycleFixture.CreateAsync();
        await InstallDependencyFixtureAsync(f, "org.example.cancelled", "org.example.provider");
        await InstallDependencyFixtureAsync(f, "org.example.consumer", "org.example.provider");
        await InstallDependencyFixtureAsync(f, "org.example.provider", autostart: false);
        await f.Service.StartAsync("org.example.cancelled");
        await f.Service.StartAsync("org.example.consumer");
        await f.Service.StopAsync("org.example.cancelled");
        await f.Service.StartAsync("org.example.provider");
        await Task.WhenAll(f.Service.ResumeWaitingAppsAsync(), f.Service.ResumeWaitingAppsAsync());
        Assert.Equal(2, f.Adapter.StartCount);
        Assert.Equal("stopped", (await f.Apps.GetAppAsync("org.example.cancelled"))!.RuntimeState);
        Assert.Equal("running", (await f.Apps.GetAppAsync("org.example.consumer"))!.RuntimeState);
    }

    [Fact]
    public async Task ResumeWaitingAppsAsync_RechecksStopAfterWaitingForAQueueSlot()
    {
        var f = await LifecycleFixture.CreateAsync();
        var consumers = Enumerable.Range(0, 5).Select(index => $"org.example.consumer{index}").ToArray();
        foreach (var id in consumers)
        {
            await InstallDependencyFixtureAsync(f, id, "org.example.provider");
            await f.Service.StartAsync(id);
        }
        await InstallDependencyFixtureAsync(f, "org.example.provider");
        await f.Service.StartAsync("org.example.provider");
        var full = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var entered = 0;
        f.Adapter.StartContextProbe = async (context, ct) =>
        {
            Assert.NotEqual(consumers[4], context.App.Id);
            if (Interlocked.Increment(ref entered) == 4) full.TrySetResult();
            await release.Task.WaitAsync(ct);
        };
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var resume = f.Service.ResumeWaitingAppsAsync(timeout.Token);
        try
        {
            await full.Task.WaitAsync(timeout.Token);
            await f.Service.StopAsync(consumers[4], timeout.Token);
        }
        finally { release.TrySetResult(); await resume; }
        Assert.Equal(4, entered);
        var cancelled = await f.Apps.GetAppAsync(consumers[4]);
        Assert.Equal("stopped", cancelled!.RuntimeState);
        Assert.Null(cancelled.LaunchProgress);
    }

    [Fact]
    public async Task Waiting_IsPreservedByRecoveryAndExcludedFromCrashSupervision()
    {
        var f = await LifecycleFixture.CreateAsync();
        await InstallDependencyFixtureAsync(f, "org.example.consumer", "org.example.missing");
        await f.Service.StartAsync("org.example.consumer");
        Assert.False(AppRuntimeStates.IsUp("waiting"));
        Assert.False(AppRuntimeStates.IsBusy("waiting"));
        Assert.False(AppRuntimeStates.IsIdle("waiting"));
        Assert.Equal(0, await f.Service.RecoverStrandedLifecycleStatesAsync());
        Assert.Empty(await f.Service.ObserveRuntimeHealthAsync(new HashSet<string> { "org.example.consumer" }));
        Assert.Equal("waiting", (await f.Apps.GetAppAsync("org.example.consumer"))!.RuntimeState);
        await f.RecreateService().ResumeWaitingAppsAsync();
        Assert.Equal(0, f.Adapter.StartCount);
    }

    [Fact]
    public async Task DependencyStartupService_ResumesFromRegistryReadinessChangeWithoutPolling()
    {
        var f = await LifecycleFixture.CreateAsync();
        await InstallDependencyFixtureAsync(f, "org.example.consumer", "org.example.provider");
        using var service = new DependencyStartupService(f.Apps, f.Service, NullLogger<DependencyStartupService>.Instance);
        await service.StartAsync(CancellationToken.None);
        try
        {
            await f.Service.StartAutostartAppsAsync();
            Assert.Equal("waiting", (await f.Apps.GetAppAsync("org.example.consumer"))!.RuntimeState);
            var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
            f.Adapter.StartContextProbe = (context, _) =>
            {
                if (context.App.Id == "org.example.consumer") started.TrySetResult();
                return Task.CompletedTask;
            };
            await InstallDependencyFixtureAsync(f, "org.example.provider", autostart: false);
            await started.Task.WaitAsync(TimeSpan.FromSeconds(10));
            await WaitUntilAsync(async () => (await f.Apps.GetAppAsync("org.example.consumer"))!.RuntimeState == "running");
        }
        finally { await service.StopAsync(CancellationToken.None); }
        Assert.Equal(2, f.Adapter.StartCount);
    }

    [Fact]
    public async Task StartAsync_AlreadyRunningConsumerIsNotDeferredWhenProviderFails()
    {
        var f = await LifecycleFixture.CreateAsync();
        await InstallDependencyFixtureAsync(f, "org.example.consumer", "org.example.provider");
        await InstallDependencyFixtureAsync(f, "org.example.provider");
        await f.Service.StartAsync("org.example.provider");
        await f.Service.StartAsync("org.example.consumer");
        await f.Service.StopAsync("org.example.provider");
        Assert.Equal("running", (await f.Service.StartAsync("org.example.consumer")).App!.RuntimeState);
    }

    [Theory]
    [InlineData(false, "waiting")]
    [InlineData(true, "running")]
    public async Task ApplyUpdateAsync_PreservesWaitingIntentAndReconsidersTheReviewedGraph(bool repair, string expectedState)
    {
        var f = await LifecycleFixture.CreateAsync();
        await InstallDependencyFixtureAsync(f, "org.example.consumer", "org.example.provider");
        await InstallDependencyFixtureAsync(f, "org.example.provider", "org.example.consumer");
        await f.Service.StartAutostartAppsAsync();
        var consumer = (await f.Apps.GetAppAsync("org.example.consumer"))!;
        var manifest = JsonNode.Parse(await File.ReadAllTextAsync(consumer.ManifestPath!))!.AsObject();
        manifest["version"] = "2.0.0";
        if (repair) manifest.Remove("dependencies");
        var target = Path.Combine(f.Root, "reviewed-update.json");
        await File.WriteAllTextAsync(target, manifest.ToJsonString());
        var plan = await f.Service.CreateUpdatePlanAsync(consumer.Id, new AppUpdatePlanRequest(target));
        var result = await f.Service.ApplyUpdateAsync(consumer.Id, new AppUpdateApplyRequest(plan.PlanDigest));
        Assert.Equal(expectedState, result.App!.RuntimeState);
        Assert.Equal("2.0.0", result.App.Version);
        if (!repair)
        {
            Assert.Equal("waiting", result.App.OperationStatus);
            Assert.Contains("Required dependency cycle", result.App.LastError);
            Assert.Equal(0, f.Adapter.StartCount);
        }
        else
        {
            await f.Service.ResumeWaitingAppsAsync();
            Assert.Equal("running", (await f.Apps.GetAppAsync("org.example.provider"))!.RuntimeState);
            Assert.Equal(2, f.Adapter.StartCount);
        }
    }

    [Fact]
    public async Task RestartAsync_ConsumerWaitsAfterStopUntilProviderReturns()
    {
        var f = await LifecycleFixture.CreateAsync();
        await InstallDependencyFixtureAsync(f, "org.example.consumer", "org.example.provider");
        await InstallDependencyFixtureAsync(f, "org.example.provider");
        await f.Service.StartAsync("org.example.provider");
        await f.Service.StartAsync("org.example.consumer");
        await f.Service.StopAsync("org.example.provider");
        Assert.Equal("waiting", (await f.Service.RestartAsync("org.example.consumer")).Status);
        Assert.Equal(2, f.Adapter.StartCount);
        await f.Service.StartAsync("org.example.provider");
        await f.Service.ResumeWaitingAppsAsync();
        Assert.Equal(4, f.Adapter.StartCount);
    }

    [Fact]
    public async Task DependencyCascade_StartsTransitiveDisabledProvidersAfterRecovery()
    {
        var f = await LifecycleFixture.CreateAsync();
        await InstallDependencyFixtureAsync(f, "org.example.consumer", "org.example.middle", autostart: false);
        await InstallDependencyFixtureAsync(f, "org.example.middle", "org.example.leaf", autostart: false);
        await InstallDependencyFixtureAsync(f, "org.example.leaf", autostart: false);
        await InstallDependencyFixtureAsync(f, "org.example.unrelated", autostart: false);
        var order = new ConcurrentQueue<string>();
        f.Adapter.StartContextProbe = (context, _) => { order.Enqueue(context.App.Id); return Task.CompletedTask; };
        Assert.Equal("waiting", (await f.Service.StartAsync("org.example.consumer")).Status);
        await f.RecreateService().ResumeWaitingAppsAsync();
        Assert.Equal(["org.example.leaf", "org.example.middle", "org.example.consumer"], order);
        Assert.Null((await f.Apps.GetAppAsync("org.example.consumer"))!.DependencyStart);
        Assert.All(await f.Apps.ListAppRecordsAsync(), app => Assert.False(app.Autostart));
        Assert.Equal("stopped", (await f.Apps.GetAppAsync("org.example.unrelated"))!.RuntimeState);
    }

    [Fact]
    public async Task DependencyCascade_SharedProviderStartsOnceAndCancelledRootStaysStopped()
    {
        var f = await LifecycleFixture.CreateAsync();
        await InstallDependencyFixtureAsync(f, "org.example.a", "org.example.provider");
        await InstallDependencyFixtureAsync(f, "org.example.b", "org.example.provider");
        await InstallDependencyFixtureAsync(f, "org.example.provider", autostart: false);
        await f.Service.StartAsync("org.example.a");
        await f.Service.StartAsync("org.example.b");
        await f.Service.StopAsync("org.example.a");
        await Task.WhenAll(f.Service.ResumeWaitingAppsAsync(), f.Service.ResumeWaitingAppsAsync());
        Assert.Equal(2, f.Adapter.StartCount);
        Assert.Equal("stopped", (await f.Apps.GetAppAsync("org.example.a"))!.RuntimeState);
        Assert.Equal("running", (await f.Apps.GetAppAsync("org.example.b"))!.RuntimeState);
    }

    [Fact]
    public async Task DependencyCascade_CancelledOnlyRootDoesNotStartItsProvider()
    {
        var f = await LifecycleFixture.CreateAsync();
        await InstallDependencyFixtureAsync(f, "org.example.consumer", "org.example.provider");
        await InstallDependencyFixtureAsync(f, "org.example.provider");
        await f.Service.StartAsync("org.example.consumer");
        await f.Service.StopAsync("org.example.consumer");
        await f.Service.ResumeWaitingAppsAsync();
        Assert.Equal(0, f.Adapter.StartCount);
    }

    [Fact]
    public async Task DependencyCascade_ExplicitProviderStopRequiresFreshConsumerStart()
    {
        var f = await LifecycleFixture.CreateAsync();
        await InstallDependencyFixtureAsync(f, "org.example.consumer", "org.example.provider");
        await InstallDependencyFixtureAsync(f, "org.example.provider");
        await f.Service.StartAsync("org.example.consumer");
        await f.Service.StopAsync("org.example.provider");
        await f.RecreateService().ResumeWaitingAppsAsync();
        Assert.Equal(0, f.Adapter.StartCount);
        Assert.Contains("explicitly stopped", (await f.Apps.GetAppAsync("org.example.consumer"))!.LastError);
        await f.Service.StartAsync("org.example.consumer");
        await f.Service.ResumeWaitingAppsAsync();
        Assert.Equal(2, f.Adapter.StartCount);
    }

    [Fact]
    public async Task DependencyCascade_StopAfterMissingProviderInstallationWinsOverPendingStart()
    {
        var f = await LifecycleFixture.CreateAsync();
        await InstallDependencyFixtureAsync(f, "org.example.consumer", "org.example.provider");
        await f.Service.StartAsync("org.example.consumer");
        await InstallDependencyFixtureAsync(f, "org.example.provider");
        await f.Service.StopAsync("org.example.provider");
        await f.RecreateService().ResumeWaitingAppsAsync();
        Assert.Equal(0, f.Adapter.StartCount);
        Assert.Contains("explicitly stopped", (await f.Apps.GetAppAsync("org.example.consumer"))!.LastError);
        await f.Service.StartAsync("org.example.consumer");
        await f.Service.ResumeWaitingAppsAsync();
        Assert.Equal(2, f.Adapter.StartCount);
    }

    [Fact]
    public async Task DependencyCascade_FailedSharedProviderDoesNotRetryUntilNewStart()
    {
        var f = await LifecycleFixture.CreateAsync();
        await InstallDependencyFixtureAsync(f, "org.example.a", "org.example.provider");
        await InstallDependencyFixtureAsync(f, "org.example.b", "org.example.provider");
        await InstallDependencyFixtureAsync(f, "org.example.provider");
        await f.Service.StartAsync("org.example.a");
        await f.Service.StartAsync("org.example.b");
        f.Adapter.FailOnStartCount = 1;
        await f.Service.ResumeWaitingAppsAsync();
        await f.RecreateService().ResumeWaitingAppsAsync();
        Assert.Equal(1, f.Adapter.StartCount);
        Assert.All((await f.Apps.ListAppRecordsAsync()).Where(app => app.Id != "org.example.provider"), app =>
        {
            Assert.Equal("waiting", app.RuntimeState);
            Assert.Contains("org.example.provider", app.LastError);
        });
        f.Adapter.FailOnStartCount = null;
        await f.Service.StartAsync("org.example.a");
        await f.Service.ResumeWaitingAppsAsync();
        Assert.Equal(4, f.Adapter.StartCount);
        Assert.Equal("running", (await f.Apps.GetAppAsync("org.example.b"))!.RuntimeState);
    }

    [Fact]
    public async Task DependencyCascade_OptionalProviderRemainsStopped()
    {
        var f = await LifecycleFixture.CreateAsync();
        await InstallDependencyFixtureAsync(f, "org.example.consumer", "org.example.provider", required: false);
        await InstallDependencyFixtureAsync(f, "org.example.provider");
        await f.Service.StartAsync("org.example.consumer");
        await f.Service.ResumeWaitingAppsAsync();
        Assert.Equal(1, f.Adapter.StartCount);
        Assert.Equal("stopped", (await f.Apps.GetAppAsync("org.example.provider"))!.RuntimeState);
    }

    [Fact]
    public async Task DependencyCascade_BootStartsDisabledRequiredProvidersOnly()
    {
        var f = await LifecycleFixture.CreateAsync();
        await InstallDependencyFixtureAsync(f, "org.example.consumer", "org.example.provider");
        await InstallDependencyFixtureAsync(f, "org.example.provider", autostart: false);
        await InstallDependencyFixtureAsync(f, "org.example.unrelated", autostart: false);
        await f.Service.StopAutostartDisabledAppsAsync();
        await f.Service.StartAutostartAppsAsync();
        Assert.Equal(2, f.Adapter.StartCount);
        Assert.False((await f.Apps.GetAppAsync("org.example.provider"))!.Autostart);
        Assert.Equal("stopped", (await f.Apps.GetAppAsync("org.example.unrelated"))!.RuntimeState);
    }

    [Fact]
    public async Task DependencyCascade_ConfigurationBlockDoesNotLoop()
    {
        var f = await LifecycleFixture.CreateAsync();
        await InstallDependencyFixtureAsync(f, "org.example.consumer", "org.example.provider");
        var path = await f.WriteManifestAsync("1.0.0", id: "org.example.provider",
            settingsJson: "\"settings\": [{\"key\":\"API_KEY\",\"type\":\"string\",\"secret\":true,\"required\":true}],");
        await f.Service.InstallAsync(new AppInstallRequest(path));
        await f.Service.StartAsync("org.example.consumer");
        await f.Service.ResumeWaitingAppsAsync();
        await f.Service.ResumeWaitingAppsAsync();
        Assert.Equal(0, f.Adapter.StartCount);
        Assert.Contains("configuration", (await f.Apps.GetAppAsync("org.example.consumer"))!.LastError);
    }

    [Fact]
    public async Task DependencyCascade_BoundsProviderStartsAndRechecksCancellationInTheQueue()
    {
        var f = await LifecycleFixture.CreateAsync();
        for (var index = 0; index < 5; index++)
        {
            await InstallDependencyFixtureAsync(f, $"org.example.consumer{index}", $"org.example.provider{index}");
            await InstallDependencyFixtureAsync(f, $"org.example.provider{index}");
            await f.Service.StartAsync($"org.example.consumer{index}");
        }
        var full = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var entered = 0;
        f.Adapter.StartContextProbe = async (context, ct) =>
        {
            Assert.DoesNotContain("4", context.App.Id);
            if (context.App.Id.Contains("provider"))
            {
                if (Interlocked.Increment(ref entered) == 4) full.TrySetResult();
                await release.Task.WaitAsync(ct);
            }
        };
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        var resume = f.Service.ResumeWaitingAppsAsync(timeout.Token);
        try
        {
            await full.Task.WaitAsync(timeout.Token);
            Assert.Equal(4, f.Adapter.StartCount);
            await f.Service.StopAsync("org.example.consumer4", timeout.Token);
        }
        finally { release.TrySetResult(); await resume; }
        Assert.Equal(8, f.Adapter.StartCount);
        Assert.Equal("stopped", (await f.Apps.GetAppAsync("org.example.provider4"))!.RuntimeState);
    }

    [Fact]
    public async Task DependencyCascade_ActivationSelectionDoesNotAdmitUnselectedProvider()
    {
        var f = await LifecycleFixture.CreateAsync();
        await InstallDependencyFixtureAsync(f, "org.example.consumer", "org.example.provider");
        await InstallDependencyFixtureAsync(f, "org.example.provider");
        // Empty reviewed selection exercises the same scope used around activation's app locks.
        await f.Service.WithActivationAppLocksAsync([], () => f.Service.StartAsync("org.example.consumer"), default);
        await f.Service.ResumeWaitingAppsAsync();
        Assert.Equal(0, f.Adapter.StartCount);
        Assert.Contains("outside the reviewed workspace activation", (await f.Apps.GetAppAsync("org.example.consumer"))!.LastError);
    }

    [Fact]
    public async Task DependencyCascade_BootPreservesRunningDisabledTransitiveProviders()
    {
        var f = await LifecycleFixture.CreateAsync();
        await InstallDependencyFixtureAsync(f, "org.example.consumer", "org.example.middle");
        await InstallDependencyFixtureAsync(f, "org.example.middle", "org.example.leaf", autostart: false);
        await InstallDependencyFixtureAsync(f, "org.example.leaf", autostart: false);
        await f.Service.StartAsync("org.example.consumer");
        await f.Service.ResumeWaitingAppsAsync();
        Assert.Empty(await f.Service.StopAutostartDisabledAppsAsync());
        Assert.All(await f.Apps.ListAppRecordsAsync(), app => Assert.Equal("running", app.RuntimeState));
    }
}
