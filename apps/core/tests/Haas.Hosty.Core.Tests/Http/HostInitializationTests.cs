using System.Net;
using System.Text;
using Haas.Hosty.Initialization;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
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
