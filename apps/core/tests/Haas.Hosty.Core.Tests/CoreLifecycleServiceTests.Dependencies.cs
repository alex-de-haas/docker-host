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
        await InstallDependencyFixtureAsync(f, "org.example.provider", autostart: false);
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
            await f.Service.StartAsync("org.example.provider");
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
}
