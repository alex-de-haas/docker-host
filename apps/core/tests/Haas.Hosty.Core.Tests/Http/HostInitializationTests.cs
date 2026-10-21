using System.Net;
using System.Net.Sockets;
using System.Text;
using Haas.Hosty.Initialization;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class HostInitializationTests
{
    [Fact]
    public async Task PreselectionBoot_DoesNotSeedDefaultsOrClaimCompletion()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var paths = host.Services.GetRequiredService<CoreDataPaths>();
        InitializationFiles.Request(paths.DataRoot);
        await host.Services.GetRequiredService<SystemAppBootstrapService>().SeedBootAsync(default);
        Assert.False(host.Services.GetRequiredService<DistributionSeedStore>().Exists);
        Assert.Empty(await host.Services.GetRequiredService<AppRegistryStore>().ListAppRecordsAsync());
        Assert.Equal("selection", (await host.Services.GetRequiredService<HostInitializationService>().GetAsync(default)).Phase);
        Assert.False(InitializationFiles.CanStart(paths.DataRoot));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ExplicitInitialization_AppliesDevelopmentOverridesWithoutSeeding(bool completed)
    {
        var directory = Path.Combine(Path.GetTempPath(), "hosty-init-override-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var manifest = Path.Combine(directory, "manifest.json");
            await File.WriteAllTextAsync(manifest, """
              {"schemaVersion":"app.0.1","id":"hosty.shell","name":"Shell","version":"1.0.0",
               "runtimeProfiles":[{"key":"local","type":"localCommand","default":true}],
               "services":[{"key":"worker","runtimes":{"local":{"type":"localCommand","command":"echo fixture","workingDirectory":"."}}}]}
              """);
            var catalog = Path.Combine(directory, "distribution.json");
            await File.WriteAllTextAsync(catalog, """
              {"schemaVersion":"distribution-apps.0.1","apps":[
               {"id":"hosty.shell","title":"Shell","manifestRef":"manifest.json","defaultEnabled":true},
               {"id":"example.unselected","title":"Unselected","manifestRef":"missing.json","defaultEnabled":true}]}
              """);
            await using var host = await CoreHttpHarness.StartAsync();
            var config = host.Services.GetRequiredService<HostyCoreRuntimeConfig>();
            InitializationFiles.Request(config.DataRoot);
            var service = host.Services.GetRequiredService<HostInitializationService>();
            if (completed)
            {
                await service.SubmitAsync(new(Guid.NewGuid().ToString(), []), default);
                await service.StartAsync(default);
                try { await WaitForAsync(service, "ready"); }
                finally { await service.StopAsync(default); }
            }
            var lifecycle = host.Services.GetRequiredService<CoreLifecycleService>();
            await lifecycle.InstallAsync(new(manifest, Autostart: false, StartOnInstall: false));
            var apps = host.Services.GetRequiredService<AppRegistryStore>();
            var seed = host.Services.GetRequiredService<DistributionSeedStore>();
            var bootstrap = new SystemAppBootstrapService(config with { ShellSourceOverridePath = directory }, apps,
                lifecycle, host.Services.GetRequiredService<AppSourceService>(),
                new DistributionAppsProvider(NullLogger<DistributionAppsProvider>.Instance, catalog, [directory]),
                seed, NullLogger<SystemAppBootstrapService>.Instance);

            await bootstrap.SeedBootAsync(default);

            var installed = Assert.Single(await apps.ListAppRecordsAsync());
            Assert.Equal("hosty.shell", installed.Id);
            Assert.Equal(MountPathPolicy.ResolveRealPath(directory), installed.SourceState?.LocalOverridePath);
            Assert.Equal(completed, seed.Exists);
            if (completed) Assert.Empty((await seed.LoadAsync())!.Apps);
            Assert.Equal(completed ? "ready" : "selection", (await service.GetAsync(default)).Phase);
        }
        finally { Directory.Delete(directory, true); }
    }

    [Fact]
    public async Task CoreOnly_ResumesAcceptedInput_UsesNormalSetup_AndNeverPersistsTheToken()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var service = host.Services.GetRequiredService<HostInitializationService>();
        var paths = host.Services.GetRequiredService<CoreDataPaths>();
        InitializationFiles.Request(paths.DataRoot);
        var input = new InitializationRequest(Guid.NewGuid().ToString(), []);
        await service.SubmitAsync(input, default);
        await service.SubmitAsync(input, default);
        Assert.Equal("pending", (await service.GetAsync(default)).Phase);
        await service.StartAsync(default);
        try
        {
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            InitializationStatus state;
            do { await Task.Delay(20, timeout.Token); state = await service.GetAsync(timeout.Token); } while (state.Phase != "ready");
            Assert.False(state.HasAdministrator);
            Assert.True(InitializationFiles.CanStart(paths.DataRoot));
            Assert.Empty((await host.Services.GetRequiredService<DistributionSeedStore>().LoadAsync())!.Apps);
            var token = await service.SetupLinkAsync(default);
            Assert.Contains("/setup?setupToken=", token.SetupUrl);
            Assert.DoesNotContain(token.Token, await File.ReadAllTextAsync(InitializationFiles.StatePath(paths.DataRoot)));
            Assert.DoesNotContain(token.Token, CoreJson.Text(await service.GetAsync(default)));
            await host.Services.GetRequiredService<AuthBootstrapService>().BootstrapAsync(
                new(token.Token, "admin@init.test", "Test administrator", "A-long-test-password-123!"));
            Assert.True((await service.GetAsync(default)).HasAdministrator);
            Assert.Equal("ready", (await service.SubmitAsync(input, default)).Phase);
            await Assert.ThrowsAsync<AuthBootstrapException>(() => service.SetupLinkAsync(default));
        }
        finally { await service.StopAsync(default); }
    }

    [Fact]
    public async Task UnknownSelection_AndConflictingReplay_DoNotOverwriteAcceptedInput()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var service = host.Services.GetRequiredService<HostInitializationService>();
        var paths = host.Services.GetRequiredService<CoreDataPaths>();
        InitializationFiles.Request(paths.DataRoot);
        await Assert.ThrowsAsync<AppLifecycleException>(() => service.SubmitAsync(new(Guid.NewGuid().ToString(), ["missing.app"]), default));
        Assert.False(File.Exists(InitializationFiles.StatePath(paths.DataRoot)));
        var input = new InitializationRequest(Guid.NewGuid().ToString(), []);
        await service.SubmitAsync(input, default);
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => service.SubmitAsync(input with { Apps = ["hosty.shell"] }, default));
        Assert.Equal("initialization_request_conflict", error.Code);
        Assert.Empty((await service.GetAsync(default)).SelectedApps);
    }

    [Fact]
    public async Task CorruptMarker_IsDiagnosed_AndCannotEnableLegacySeeding()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var paths = host.Services.GetRequiredService<CoreDataPaths>();
        InitializationFiles.Request(paths.DataRoot);
        await File.WriteAllTextAsync(InitializationFiles.StatePath(paths.DataRoot), "broken");
        var service = host.Services.GetRequiredService<HostInitializationService>();
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => service.GetAsync(default));
        Assert.Equal("initialization_state_invalid", error.Code);
        await host.Services.GetRequiredService<SystemAppBootstrapService>().SeedBootAsync(default);
        Assert.False(host.Services.GetRequiredService<DistributionSeedStore>().Exists);
        Assert.Equal("broken", await File.ReadAllTextAsync(InitializationFiles.StatePath(paths.DataRoot)));
    }

    [Fact]
    public async Task ControlEndpoints_RequireSecret_AndSetupLinkWaitsForReadiness()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = host.CreateClient();
        using var denied = await client.GetAsync("/control/v1/core/initialization");
        Assert.Equal(HttpStatusCode.Unauthorized, denied.StatusCode);
        client.DefaultRequestHeaders.Add("X-Hosty-Control-Secret", host.Services.GetRequiredService<ControlSecret>().Value);
        using var status = await client.GetAsync("/control/v1/core/initialization");
        Assert.Equal(HttpStatusCode.OK, status.StatusCode);
        using var link = await client.PostAsync("/control/v1/core/initialization/setup-link", new StringContent("{}", Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.Conflict, link.StatusCode);
        Assert.True(link.Headers.CacheControl?.NoStore);
    }

    [Fact]
    public async Task FailedStart_ResumesInstalledApps_WaitsForHealth_AndPreservesLaterRemoval()
    {
        var directory = Path.Combine(Path.GetTempPath(), "hosty-init-selection-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            foreach (var id in new[] { "example.a", "example.b" })
                await File.WriteAllTextAsync(Path.Combine(directory, id + ".json"), """
                  {"schemaVersion":"app.0.1","id":"APP_ID","name":"APP_ID","version":"1.0.0",
                   "runtimeProfiles":[{"key":"local","type":"localCommand","default":true}],
                   "services":[{"key":"worker","runtimes":{"local":{"type":"localCommand","command":"echo fixture","workingDirectory":"."}}}]}
                  """.Replace("APP_ID", id));
            var catalog = Path.Combine(directory, "distribution.json");
            await File.WriteAllTextAsync(catalog, """
              {"schemaVersion":"distribution-apps.0.1","apps":[
               {"id":"example.a","title":"First","manifestRef":"example.a.json","defaultEnabled":true},
               {"id":"example.b","title":"Second","manifestRef":"example.b.json","defaultEnabled":true}]}
              """);
            var adapter = new InitializationAdapter();
            await using var host = await CoreHttpHarness.StartAsync(configure: services => {
                services.RemoveAll<IAppRuntimeAdapter>(); services.AddSingleton<IAppRuntimeAdapter>(adapter);
                services.AddSingleton(new DistributionAppsProvider(NullLogger<DistributionAppsProvider>.Instance, catalog, [directory]));
            });
            var service = host.Services.GetRequiredService<HostInitializationService>();
            var apps = host.Services.GetRequiredService<AppRegistryStore>();
            var input = new InitializationRequest(Guid.NewGuid().ToString(), ["example.a", "example.b"]);
            await service.SubmitAsync(input, default); await service.StartAsync(default);
            try
            {
                var failed = await WaitForAsync(service, "failed");
                Assert.Equal("ready", failed.Apps[0].State); Assert.Equal("failed", failed.Apps[1].State);
                Assert.Equal(2, (await apps.ListAppRecordsAsync()).Count);
                var first = (await apps.GetAppAsync("example.a"))!;
                await Assert.ThrowsAsync<AppLifecycleException>(() => service.SetupLinkAsync(default));
                adapter.FailSecond = false; adapter.HealthySecond = false;
                await service.SubmitAsync(input, default);
                await WaitUntilAsync(() => adapter.SecondHealthChecked.Task.IsCompleted);
                Assert.Equal("preparing", (await service.GetAsync(default)).Phase);
                adapter.HealthySecond = true;
                var ready = await WaitForAsync(service, "ready");
                Assert.All(ready.Apps, app => Assert.Equal("ready", app.State));
                Assert.Equal(first.InstalledAt, (await apps.GetAppAsync("example.a"))!.InstalledAt);
                Assert.Equal(1, adapter.FirstStarts);
                await host.Services.GetRequiredService<CoreLifecycleService>().RemoveAsync("example.a", new());
                await service.SubmitAsync(input, default);
                Assert.Null(await apps.GetAppAsync("example.a"));
            }
            finally { await service.StopAsync(default); }
        }
        finally { Directory.Delete(directory, true); }
    }
    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ExplicitReview_AllowsOnlyTheRetainedOperatorPort(bool retainAssignment)
    {
        var directory = Path.Combine(Path.GetTempPath(), "hosty-init-port-review-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            foreach (var id in new[] { "example.a", "example.b" })
                await File.WriteAllTextAsync(Path.Combine(directory, id + ".json"), """
                  {"schemaVersion":"app.0.1","id":"APP_ID","name":"APP_ID","version":"1.0.0",
                   "runtimeProfiles":[{"key":"local","type":"localCommand","default":true}],
                   "services":[{"key":"worker","runtimes":{"local":{"type":"localCommand","command":"echo fixture","workingDirectory":".",
                     "ports":[{"key":"http","containerPort":8080}]}}}]}
                  """.Replace("APP_ID", id));
            var catalog = Path.Combine(directory, "distribution.json");
            await File.WriteAllTextAsync(catalog, """
              {"schemaVersion":"distribution-apps.0.1","apps":[
               {"id":"example.a","title":"First","manifestRef":"example.a.json","defaultEnabled":true},
               {"id":"example.b","title":"Second","manifestRef":"example.b.json","defaultEnabled":true}]}
              """);
            var adapter = new InitializationAdapter();
            await using var host = await CoreHttpHarness.StartAsync(configure: services => {
                services.RemoveAll<IAppRuntimeAdapter>(); services.AddSingleton<IAppRuntimeAdapter>(adapter);
                services.AddSingleton(new DistributionAppsProvider(NullLogger<DistributionAppsProvider>.Instance, catalog, [directory]));
            });
            using var reservation = new TcpListener(IPAddress.Loopback, 0);
            reservation.Start();
            var port = ((IPEndPoint)reservation.LocalEndpoint).Port;
            reservation.Stop();
            var service = host.Services.GetRequiredService<HostInitializationService>();
            var apps = host.Services.GetRequiredService<AppRegistryStore>();
            var input = new InitializationRequest(Guid.NewGuid().ToString(), ["example.a", "example.b"], [new("example.a", "worker", "http", port)]);
            await service.SubmitAsync(input, default); await service.StartAsync(default);
            try
            {
                await WaitForAsync(service, "failed");
                var installed = (await apps.GetAppAsync("example.a"))!;
                var assignment = Assert.Single(installed.PortAssignments!);
                Assert.Equal(port, assignment.HostPort);
                Assert.Equal(AppPortSources.Operator, assignment.Source);
                Assert.True(AppRuntimeStates.IsUp(installed.RuntimeState));
                // Model the socket retained by a running app, or an unrelated occupied socket.
                using var bound = new TcpListener(IPAddress.Loopback, retainAssignment ? port : 0);
                bound.Start();
                var requested = ((IPEndPoint)bound.LocalEndpoint).Port;
                Assert.False(RuntimePortHelper.IsLoopbackTcpPortAvailable(requested));
                adapter.FailSecond = false;
                var review = input with { RequestId = Guid.NewGuid().ToString(), Ports = [new("example.a", "worker", "http", requested)] };
                await service.SubmitAsync(review, default);
                var result = await WaitForAsync(service, retainAssignment ? "ready" : "failed");
                if (!retainAssignment) Assert.Contains("occupied", result.Error);
                Assert.Equal(1, adapter.FirstStarts);
                var retained = (await apps.GetAppAsync("example.a"))!;
                Assert.Equal(installed.InstalledAt, retained.InstalledAt);
                Assert.Equal(assignment, Assert.Single(retained.PortAssignments!));
            }
            finally { await service.StopAsync(default); }
        }
        finally { Directory.Delete(directory, true); }
    }

    [Fact]
    public async Task ExplicitReview_AfterFailure_RetiresOriginalRequestWithoutResettingData()
    {
        var directory = Path.Combine(Path.GetTempPath(), "hosty-init-review-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        try
        {
            var catalog = Path.Combine(directory, "distribution.json");
            await File.WriteAllTextAsync(catalog, """
              {"schemaVersion":"distribution-apps.0.1","apps":[
               {"id":"example.missing","title":"Missing","manifestRef":"missing.json","defaultEnabled":true}]}
              """);
            await using var host = await CoreHttpHarness.StartAsync(configure: services =>
                services.AddSingleton(new DistributionAppsProvider(NullLogger<DistributionAppsProvider>.Instance, catalog, [directory])));
            var service = host.Services.GetRequiredService<HostInitializationService>();
            var input = new InitializationRequest(Guid.NewGuid().ToString(), ["example.missing"]);
            await service.SubmitAsync(input, default); await service.StartAsync(default);
            try
            {
                await WaitForAsync(service, "failed");
                var conflict = await Assert.ThrowsAsync<AppLifecycleException>(() => service.SubmitAsync(input with { Apps = [] }, default));
                Assert.Equal("initialization_request_conflict", conflict.Code);
                var review = input with { RequestId = Guid.NewGuid().ToString(), Apps = [] };
                await service.SubmitAsync(review, default);
                await WaitForAsync(service, "ready");
                var retired = await Assert.ThrowsAsync<AppLifecycleException>(() => service.SubmitAsync(input, default));
                Assert.Equal("initialization_request_superseded", retired.Code);
                Assert.Empty((await service.GetAsync(default)).SelectedApps);
            }
            finally { await service.StopAsync(default); }
        }
        finally { Directory.Delete(directory, true); }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SubmitAsync_FailedWorkerStillReleasingGate_RejectsChangedReplayAndProcessesRetry(bool review)
    {
        var directory = Path.Combine(Path.GetTempPath(), "hosty-init-completion-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        using var logger = new CompletingWorkerLogger();
        try
        {
            var catalog = Path.Combine(directory, "distribution.json");
            await File.WriteAllTextAsync(catalog, """
              {"schemaVersion":"distribution-apps.0.1","apps":[
               {"id":"example.missing","title":"Missing","manifestRef":"missing.json","defaultEnabled":true}]}
              """);
            await using var host = await CoreHttpHarness.StartAsync(configure: services => {
                services.AddSingleton(new DistributionAppsProvider(NullLogger<DistributionAppsProvider>.Instance, catalog, [directory]));
                services.AddSingleton<ILogger<HostInitializationService>>(logger);
            });
            var service = host.Services.GetRequiredService<HostInitializationService>();
            var input = new InitializationRequest(Guid.NewGuid().ToString(), ["example.missing"]);
            await service.SubmitAsync(input, default);
            await service.StartAsync(default);
            try
            {
                await logger.FirstFailure.Task.WaitAsync(TimeSpan.FromSeconds(10));
                Assert.Equal("failed", (await service.GetAsync(default)).Phase);
                var conflict = await Assert.ThrowsAsync<AppLifecycleException>(() => service.SubmitAsync(input with { Apps = [] }, default));
                Assert.Equal("initialization_request_conflict", conflict.Code);

                var retry = review ? input with { RequestId = Guid.NewGuid().ToString(), Apps = [] } : input;
                var submission = service.SubmitAsync(retry, default);
                logger.Release.Set();
                await submission;
                if (review)
                {
                    await WaitForAsync(service, "ready");
                    var retired = await Assert.ThrowsAsync<AppLifecycleException>(() => service.SubmitAsync(input, default));
                    Assert.Equal("initialization_request_superseded", retired.Code);
                }
                else
                {
                    await WaitUntilAsync(() => logger.FailureCount == 2);
                    Assert.Equal("failed", (await service.GetAsync(default)).Phase);
                }
                Assert.Equal(HostInitializationService.Normalize(retry).RequestId, (await service.GetAsync(default)).RequestId);
            }
            finally { logger.Release.Set(); await service.StopAsync(default); }
        }
        finally { Directory.Delete(directory, true); }
    }

    private sealed class CompletingWorkerLogger : ILogger<HostInitializationService>, IDisposable
    {
        private int failureCount;
        public int FailureCount => Volatile.Read(ref failureCount);
        public TaskCompletionSource FirstFailure { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public ManualResetEventSlim Release { get; } = new(false);
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel level) => true;
        public void Log<TState>(LogLevel level, EventId id, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (level != LogLevel.Warning || Interlocked.Increment(ref failureCount) != 1) return;
            FirstFailure.TrySetResult();
            if (!Release.Wait(TimeSpan.FromSeconds(10))) throw new TimeoutException("The test did not release the completed worker.");
        }
        public void Dispose() => Release.Dispose();
    }

    private static async Task<InitializationStatus> WaitForAsync(HostInitializationService service, string phase)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        while (true)
        {
            var state = await service.GetAsync(timeout.Token);
            if (state.Phase == phase) return state;
            if (state.Phase == "failed") Assert.Fail(state.Error);
            await Task.Delay(20, timeout.Token);
        }
    }
    private static async Task WaitUntilAsync(Func<bool> predicate)
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!predicate()) await Task.Delay(20, timeout.Token);
    }
    private sealed class InitializationAdapter : IAppRuntimeAdapter
    {
        public string Type => "localCommand";
        public bool FailSecond = true, HealthySecond = true;
        public int FirstStarts;
        public TaskCompletionSource SecondHealthChecked = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public Task<AppRuntimeStartResult> StartAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
        {
            if (context.App.Id == "example.b" && FailSecond) throw new AppLifecycleException("fixture_start_failed", "Synthetic start failure.");
            if (context.App.Id == "example.a") FirstStarts++;
            return Task.FromResult(new AppRuntimeStartResult("running", []));
        }
        public Task<AppRuntimeOperationResult> StopAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default) => Task.FromResult(new AppRuntimeOperationResult("stopped"));
        public Task<AppRuntimeOperationResult> RemoveAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default) => Task.FromResult(new AppRuntimeOperationResult("removed"));
        public Task<AppRuntimeLogsResult> GetLogsAsync(RuntimeLifecycleContext context, int tail, CancellationToken cancellationToken = default) => Task.FromResult(new AppRuntimeLogsResult(""));
        public Task<AppRuntimeHealthResult> GetHealthAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
        {
            if (context.App.Id == "example.b") SecondHealthChecked.TrySetResult();
            var health = context.App.Id != "example.b" || HealthySecond ? "healthy" : "starting";
            return Task.FromResult(new AppRuntimeHealthResult(health, [new("worker", "running", null, null, null, null, null, Health: health)]));
        }
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1023)]
    [InlineData(65536)]
    public void InvalidManualPort_IsRejected(int port)
        => Assert.Throws<AppLifecycleException>(() => HostInitializationService.Normalize(new(Guid.NewGuid().ToString(), ["hosty.shell"], [new("hosty.shell", "web", "http", port)])));
}
