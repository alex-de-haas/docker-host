using Haas.Hosty.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed class DockerDevelopmentFactAttribute : FactAttribute
{
    public DockerDevelopmentFactAttribute()
    {
        if (Environment.GetEnvironmentVariable("HOSTY_TEST_DOCKER_DEVELOPMENT") != "1")
            Skip = "Opt in with HOSTY_TEST_DOCKER_DEVELOPMENT=1; requires local Docker and Node.js.";
    }
}

public sealed class TorrentDevelopmentFactAttribute : FactAttribute
{
    public TorrentDevelopmentFactAttribute()
    {
        if (Environment.GetEnvironmentVariable("HOSTY_TEST_TORRENT_SOURCE") is null)
            Skip = "Opt in with HOSTY_TEST_TORRENT_SOURCE pointing to the companion checkout; requires local Docker.";
    }
}

public sealed partial class CoreLifecycleServiceTests
{
    [TorrentDevelopmentFact]
    public async Task Torrent_CoreManagedSourceStartsBehindClosedVpnFirewall()
    {
        var source = Environment.GetEnvironmentVariable("HOSTY_TEST_TORRENT_SOURCE")!;
        var fixture = await LifecycleFixture.CreateAsync(withPortAllocator: true);
        var root = fixture.Root;
        var external = root + "-mounts";
        var config = new HostyCoreRuntimeConfig(root, root + "/run", root + "/control.json", 3001,
            "http://127.0.0.1:3001", null, "127.0.0.1", null, false, InstanceId: Guid.NewGuid().ToString("N"));
        var tokens = new AppServiceTokenService(new AppServiceSigningKey("torrent-development-test-key"u8.ToArray()));
        var docker = new DockerRuntimeAdapter(config, tokens, NullLogger<DockerRuntimeAdapter>.Instance);
        var lifecycle = new CoreLifecycleService(fixture.Paths, fixture.Apps, fixture.Manifests, fixture.Backups,
            fixture.Sources, [docker], new NoopIngressController(), NullLogger<CoreLifecycleService>.Instance,
            portAllocator: new RuntimePortAllocator(config));
        const string appId = "com.haas.torrent-engine";
        Assert.NotEqual("hosty-com-haas-torrent-engine-engine", DockerRuntimeAdapter.BuildContainerName(config.InstanceId, appId, "engine"));
        try
        {
            await lifecycle.InstallAsync(new(Path.Combine(source, "manifest.json"), "dev"));
            Directory.CreateDirectory(Path.Combine(external, "downloads"));
            Directory.CreateDirectory(Path.Combine(external, "vpn"));
            await lifecycle.ConfigureMountsAsync(appId, new([new("downloads", "test", Path.Combine(external, "downloads")), new("vpn", "test", Path.Combine(external, "vpn"))]));
            await lifecycle.StartAsync(appId);
            var app = (await fixture.Apps.GetAppAsync(appId))!;
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
            var url = Assert.Single(app.Endpoints).Url!.TrimEnd('/') + "/healthz";
            bool ready = false;
            for (var i = 0; i < 120; i++)
            {
                try { ready = (await http.GetStringAsync(url)).Contains("ok"); if (ready) break; }
                catch (HttpRequestException) { }
                if ((await lifecycle.GetHealthAsync(appId)).Services.All(service => service.Status != "running")) break;
                await Task.Delay(500);
            }
            var runner = new ProcessDockerCommandRunner();
            var container = DockerRuntimeAdapter.BuildContainerName(config.InstanceId, appId, "engine");
            var diagnostics = await runner.RunAsync(["logs", "--tail", "50", container], null, default);
            Assert.True(ready, diagnostics.StandardOutput + diagnostics.StandardError);
            var rules = await runner.RunAsync(["exec", container, "iptables", "-S", "OUTPUT"], null, default);
            Assert.Equal(0, rules.ExitCode);
            Assert.Contains("-P OUTPUT DROP", rules.StandardOutput);
            var escape = await runner.RunAsync(["exec", container, "timeout", "3", "bash", "-c", "echo test > /dev/tcp/1.1.1.1/80"], null, default);
            Assert.NotEqual(0, escape.ExitCode);
            Assert.Equal("development-image", app.ArtifactLocks!["engine"].Kind);
            var sourceFile = Path.Combine(source, "src/TorrentEngine.Api/Program.cs");
            var original = await File.ReadAllTextAsync(sourceFile);
            Assert.Contains("new HealthResponse(\"ok\")", original);
            try
            {
                await File.WriteAllTextAsync(sourceFile, original.Replace("new HealthResponse(\"ok\")", "new HealthResponse(\"source-reloaded\")"));
                bool reloaded = false;
                for (var i = 0; i < 60; i++)
                {
                    try { reloaded = (await http.GetStringAsync(url)).Contains("source-reloaded"); if (reloaded) break; }
                    catch (HttpRequestException) { }
                    await Task.Delay(500);
                }
                Assert.True(reloaded, (await lifecycle.GetLogsAsync(appId, 30)).Text);
            }
            finally { await File.WriteAllTextAsync(sourceFile, original); }
        }
        finally
        {
            var app = await fixture.Apps.GetAppAsync(appId);
            if (app is not null)
                await docker.RemoveAsync(new(app, await fixture.Manifests.LoadAsync(app.ManifestPath!, "dev"), Path.Combine(fixture.Paths.AppsRoot, appId),
                    Path.Combine(fixture.Paths.AppsRoot, appId, "data"), new Dictionary<string, string>(), [], SourceRoot: source));
            Directory.Delete(root, recursive: true);
            if (Directory.Exists(external)) Directory.Delete(external, recursive: true);
        }
    }

    [DockerDevelopmentFact]
    public async Task Telemetry_CoreManagedMixedProfileIngestsAndAuthenticatesReads()
    {
        var fixture = await LifecycleFixture.CreateAsync(withPortAllocator: true);
        var root = fixture.Root;
        var checkout = new DirectoryInfo(AppContext.BaseDirectory);
        while (checkout is not null && !File.Exists(Path.Combine(checkout.FullName, "Directory.Build.props"))) checkout = checkout.Parent;
        Assert.NotNull(checkout);
        var config = new HostyCoreRuntimeConfig(root, root + "/run", root + "/control.json", 3001,
            "http://127.0.0.1:3001", null, "127.0.0.1", null, false, InstanceId: Guid.NewGuid().ToString("N"));
        var tokens = new AppServiceTokenService(new AppServiceSigningKey("telemetry-development-test-key"u8.ToArray()));
        var key = DelegatedTokenSigningKey.LoadOrCreate(fixture.Paths);
        var docker = new DockerRuntimeAdapter(config, tokens, NullLogger<DockerRuntimeAdapter>.Instance);
        var local = new LocalCommandRuntimeAdapter(config, fixture.LocalProcesses, tokens, delegatedTokenKey: key,
            appIdentityTokens: new AppIdentityTokenService(key, new SystemClock()));
        var lifecycle = new CoreLifecycleService(fixture.Paths, fixture.Apps, fixture.Manifests, fixture.Backups,
            fixture.Sources, [docker, local], new NoopIngressController(), NullLogger<CoreLifecycleService>.Instance,
            portAllocator: new RuntimePortAllocator(config));
        const string appId = "hosty.telemetry";
        foreach (var service in new[] { "collector", "backend", "ui" })
            Assert.NotEqual("hosty-hosty-telemetry-" + service, DockerRuntimeAdapter.BuildContainerName(config.InstanceId, appId, service));
        try
        {
            await lifecycle.InstallAsync(new(Path.Combine(checkout.FullName, "apps/telemetry/manifest.json"), "dev",
                Settings: new Dictionary<string, string?> { [RuntimePortHelper.ServiceScopedOverrideSettingKey("collector", "otlp-http")] = RuntimePortHelper.AllocateLoopbackPort().ToString() }));
            await lifecycle.StartAsync(appId);
            var app = (await fixture.Apps.GetAppAsync(appId))!;
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
            string Url(string endpoint) => app.Endpoints.Single(e => e.Key == endpoint).Url!.TrimEnd('/');
            async Task<string> WaitFor(string url, string expected)
            {
                string last = "";
                for (var i = 0; i < 90; i++)
                {
                    try { last = await http.GetStringAsync(url); if (last.Contains(expected)) return last; }
                    catch (HttpRequestException error) { last = error.Message; }
                    await Task.Delay(500);
                }
                throw new InvalidOperationException(last + "\n" + (await lifecycle.GetLogsAsync(appId, 20)).Text);
            }
            await WaitFor(Url("query") + "/healthz", "ok");
            Assert.Equal(System.Net.HttpStatusCode.Unauthorized, (await http.GetAsync(Url("query") + "/api/observability/logs")).StatusCode);
            var now = (DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() * 1_000_000).ToString();
            var resource = new { attributes = new[] { new { key = "hosty.app.id", value = new { stringValue = "mixed-test" } } } };
            var payload = System.Text.Json.JsonSerializer.Serialize(new { resourceLogs = new[] { new { resource,
                scopeLogs = new[] { new { logRecords = new[] { new { timeUnixNano = now, severityNumber = 9, body = new { stringValue = "mixed-runtime-ingested" } } } } } } } });
            (await http.PostAsync(Url("otlp-http") + "/v1/logs", new StringContent(payload, System.Text.Encoding.UTF8, "application/json"))).EnsureSuccessStatusCode();
            var tracePayload = System.Text.Json.JsonSerializer.Serialize(new { resourceSpans = new[] { new { resource,
                scopeSpans = new[] { new { spans = new[] { new { traceId = "01020304050607080910111213141516", spanId = "0102030405060708", name = "mixed-runtime-span", kind = 1,
                    startTimeUnixNano = now, endTimeUnixNano = (long.Parse(now) + 1_000_000).ToString() } } } } } } });
            (await http.PostAsync(Url("otlp-http") + "/v1/traces", new StringContent(tracePayload, System.Text.Encoding.UTF8, "application/json"))).EnsureSuccessStatusCode();
            var metricPayload = System.Text.Json.JsonSerializer.Serialize(new { resourceMetrics = new[] { new { resource,
                scopeMetrics = new[] { new { metrics = new[] { new { name = "mixed_test_metric", gauge = new { dataPoints = new[] { new { timeUnixNano = now, asDouble = 42.0 } } } } } } } } } });
            (await http.PostAsync(Url("otlp-http") + "/v1/metrics", new StringContent(metricPayload, System.Text.Encoding.UTF8, "application/json"))).EnsureSuccessStatusCode();
            http.DefaultRequestHeaders.Authorization = new("Bearer", new DelegatedTokenService(key, new SystemClock()).CreateToken(appId, "test-admin", "admin").Token);
            await WaitFor(Url("query") + "/api/observability/logs", "mixed-runtime-ingested");
            await WaitFor(Url("query") + "/api/observability/traces", "mixed-runtime-span");
            await WaitFor(Url("metrics") + "/metrics", "mixed_test_metric");
            await WaitFor(Url("http") + "/healthz", "ok");
            var health = await lifecycle.GetHealthAsync(appId);
            Assert.Equal(3, health.Services.Count);
            Assert.All(health.Services, service => Assert.Equal("running", service.Status));
            Assert.True(File.Exists(Path.Combine(fixture.Paths.AppsRoot, appId, "data/store/telemetry.db")));
            var collectorStarted = health.Services.Single(service => service.Service == "collector").StartedAt;
            // Opt-in acceptance test: change a health response, observe actual reload, then restore
            // exact source bytes even if the assertion fails. These facts run serially in this class.
            foreach (var (relative, from, to, endpoint) in new[]
            {
                ("apps/telemetry-backend/src/Haas.Hosty.TelemetryBackend/Program.cs", "new HealthResponse(\"ok\")", "new HealthResponse(\"reload-verified\")", "query"),
                ("apps/telemetry-ui/src/app/healthz/route.ts", "status: \"ok\"", "status: \"reload-verified\"", "http"),
            })
            {
                var file = Path.Combine(checkout.FullName, relative);
                var original = await File.ReadAllTextAsync(file);
                Assert.Contains(from, original);
                try
                {
                    await File.WriteAllTextAsync(file, original.Replace(from, to));
                    await WaitFor(Url(endpoint) + "/healthz", "reload-verified");
                    Assert.Equal(collectorStarted, (await lifecycle.GetHealthAsync(appId)).Services.Single(service => service.Service == "collector").StartedAt);
                }
                finally { await File.WriteAllTextAsync(file, original); }
            }
            await lifecycle.StopAsync(appId);
            var switchPlan = await lifecycle.CreateRuntimeSwitchPlanAsync(appId, new("docker"));
            await lifecycle.ApplyRuntimeSwitchAsync(appId, new("docker", switchPlan.PlanDigest));
            Assert.True(File.Exists(Path.Combine(fixture.Paths.AppsRoot, appId, "data/store/telemetry.db")));
            switchPlan = await lifecycle.CreateRuntimeSwitchPlanAsync(appId, new("dev"));
            await lifecycle.ApplyRuntimeSwitchAsync(appId, new("dev", switchPlan.PlanDigest));
            await lifecycle.StartAsync(appId);
            app = (await fixture.Apps.GetAppAsync(appId))!;
            await WaitFor(Url("query") + "/api/observability/logs", "mixed-runtime-ingested");
        }
        finally
        {
            var app = await fixture.Apps.GetAppAsync(appId);
            if (app is not null)
            {
                var selection = await fixture.Manifests.LoadAsync(app.ManifestPath!, "dev");
                await new MixedRuntimeAdapter([docker, local]).RemoveAsync(new(app, selection, Path.Combine(fixture.Paths.AppsRoot, appId),
                    Path.Combine(fixture.Paths.AppsRoot, appId, "data"), new Dictionary<string, string>(), [], SourceRoot: checkout.FullName));
            }
            Directory.Delete(root, recursive: true);
        }
    }

    [DockerDevelopmentFact]
    public async Task DockerDevelopment_CoreManagedMixedLifecycleReloadsSourceWithoutRebuilding()
    {
        var fixture = await LifecycleFixture.CreateAsync(withPortAllocator: true);
        var root = fixture.Root;
        var source = Path.Combine(root, "source");
        Directory.CreateDirectory(source);
        var checkout = new DirectoryInfo(AppContext.BaseDirectory);
        while (checkout is not null && !File.Exists(Path.Combine(checkout.FullName, "Directory.Build.props"))) checkout = checkout.Parent;
        Assert.NotNull(checkout);
        foreach (var file in Directory.GetFiles(Path.Combine(checkout.FullName, "apps/core/tests/fixtures/docker-development")))
            File.Copy(file, Path.Combine(source, Path.GetFileName(file)));
        var config = new HostyCoreRuntimeConfig(root, root + "/run", root + "/control.json", 3001,
            "http://127.0.0.1:3001", null, "127.0.0.1", null, false, InstanceId: Guid.NewGuid().ToString("N"));
        var tokens = new AppServiceTokenService(new AppServiceSigningKey("docker-development-test-key"u8.ToArray()));
        var docker = new DockerRuntimeAdapter(config, tokens, NullLogger<DockerRuntimeAdapter>.Instance);
        var local = new LocalCommandRuntimeAdapter(config, fixture.LocalProcesses, tokens);
        var lifecycle = new CoreLifecycleService(fixture.Paths, fixture.Apps, fixture.Manifests, fixture.Backups,
            fixture.Sources, [docker, local], new NoopIngressController(), NullLogger<CoreLifecycleService>.Instance,
            portAllocator: new RuntimePortAllocator(config));
        const string appId = "com.example.docker-development";
        try
        {
            try { await lifecycle.InstallAsync(new(Path.Combine(source, "manifest.json"), "dev")); }
            catch (AppManifestException error) { throw new InvalidOperationException(string.Join("; ", error.Errors.Select(item => item.Code + ": " + item.Message)), error); }
            await lifecycle.StartAsync(appId);
            var app = (await fixture.Apps.GetAppAsync(appId))!;
            Assert.True(app.RuntimeState == "running", $"Start failed: {app.LastError}");
            var endpoint = Assert.Single(app.Endpoints).Url!;
            using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(5) };
            async Task<string> ReadReady()
            {
                for (var attempt = 0; attempt < 30; attempt++)
                {
                    try { return await http.GetStringAsync(endpoint); }
                    catch (HttpRequestException) { await Task.Delay(200); }
                }
                var logs = await lifecycle.GetLogsAsync(appId, 20);
                var health = await lifecycle.GetHealthAsync(appId);
                throw new InvalidOperationException($"Endpoint {endpoint}; assignments {string.Join(",", app.PortAssignments!.Select(port => port.Service + ":" + port.HostPort))}; health {string.Join(",", health.Services.Select(service => service.Service + ":" + service.Status))}; logs {logs.Text}");
            }
            Assert.Contains("source-before-edit", await ReadReady());
            var healthBefore = await lifecycle.GetHealthAsync(appId);
            var image = app.ArtifactLocks!["web"].ImageDigest;
            Assert.StartsWith("sha256:", image);
            await File.WriteAllTextAsync(Path.Combine(source, "index.html"), "source-after-edit");
            Assert.Contains("source-after-edit", await ReadReady());
            var healthAfter = await lifecycle.GetHealthAsync(appId);
            Assert.Equal(healthBefore.Services.Single(s => s.Service == "web").StartedAt, healthAfter.Services.Single(s => s.Service == "web").StartedAt);
            await lifecycle.StopAsync(appId);
            await lifecycle.StartAsync(appId);
            Assert.Equal(image, (await fixture.Apps.GetAppAsync(appId))!.ArtifactLocks!["web"].ImageDigest);
            Assert.Contains("source-after-edit", await ReadReady());
        }
        finally
        {
            var app = await fixture.Apps.GetAppAsync(appId);
            if (app is not null)
            {
                var selection = await fixture.Manifests.LoadAsync(app.ManifestPath!, "dev");
                await new MixedRuntimeAdapter([docker, local]).RemoveAsync(new(app, selection, Path.Combine(fixture.Paths.AppsRoot, appId),
                    Path.Combine(fixture.Paths.AppsRoot, appId, "data"), new Dictionary<string, string>(), [], SourceRoot: source));
            }
            Directory.Delete(root, recursive: true);
        }
    }
}
