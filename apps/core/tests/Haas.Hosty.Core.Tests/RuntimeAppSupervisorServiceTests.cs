using System.Net;
using System.Text;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed class RuntimeAppSupervisorServiceTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"hosty-supervisor-tests-{Guid.NewGuid():N}");

    [Fact]
    public async Task StartAsync_ReconcilesInstalledShellFromConfiguredManifestUrl()
    {
        const string manifestUrl = "https://raw.githubusercontent.com/alex-de-haas/docker-host/main/apps/shell/manifest.json";
        var remoteManifest = CreateShellManifest("0.2.0", "ghcr.io/alex-de-haas/hosty-shell", "latest", "always");
        var fixture = CreateFixture(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(remoteManifest, Encoding.UTF8, "application/json"),
        });
        var oldManifest = Path.Combine(root, "old-shell-manifest.json");
        await File.WriteAllTextAsync(oldManifest, CreateShellManifest("0.1.0", "hosty-shell", "local", "never"));
        await fixture.Lifecycle.InstallAsync(new AppInstallRequest(
            ManifestPath: oldManifest,
            SelectedRuntime: "docker",
            System: true,
            Autostart: false));
        var config = CreateConfig(fixture.Paths, shellAutostart: false);
        var supervisor = CreateSupervisor(fixture, config, CreateDistribution(("hosty.shell", manifestUrl, true)));

        await supervisor.StartAsync(CancellationToken.None);
        try
        {
            var shell = await WaitForShellVersionAsync(fixture.Apps, "0.2.0");

            Assert.Equal(manifestUrl, shell.ManifestUrl);
            Assert.Equal("docker", shell.SelectedRuntime);
            Assert.False(shell.Autostart);
            // A pre-existing record is adopted by the distribution bootstrap.
            Assert.Equal(AppInstallOrigins.Distribution, shell.InstallOrigin);
        }
        finally
        {
            await supervisor.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task StartAsync_ShellBootstrapHttpFailureLeavesCoreSupervisorRunning()
    {
        const string manifestUrl = "https://raw.githubusercontent.com/alex-de-haas/docker-host/main/apps/shell/manifest.json";
        var fixture = CreateFixture(_ => throw new HttpRequestException("offline"));
        var config = CreateConfig(fixture.Paths, shellAutostart: false);
        var supervisor = CreateSupervisor(fixture, config, CreateDistribution(("hosty.shell", manifestUrl, true)));

        await supervisor.StartAsync(CancellationToken.None);
        try
        {
            await Task.Delay(250);
            Assert.Null(await fixture.Apps.GetAppAsync("hosty.shell"));
        }
        finally
        {
            await supervisor.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task StartAsync_ReconcilesInstalledShellFromRemoteManifestToConfiguredLocalPath()
    {
        const string manifestUrl = "https://raw.githubusercontent.com/alex-de-haas/docker-host/main/apps/shell/manifest.json";
        var shellManifest = CreateShellManifest("0.2.0", "ghcr.io/alex-de-haas/hosty-shell", "latest", "always");
        var fixture = CreateFixture(_ => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(shellManifest, Encoding.UTF8, "application/json"),
        });
        await fixture.Lifecycle.InstallAsync(new AppInstallRequest(
            ManifestPath: manifestUrl,
            SelectedRuntime: "docker",
            System: true,
            Autostart: false));
        var localManifest = Path.Combine(root, "shell-manifest.json");
        await File.WriteAllTextAsync(localManifest, shellManifest);
        var config = CreateConfig(fixture.Paths, shellAutostart: false);
        var supervisor = CreateSupervisor(fixture, config, CreateDistribution(("hosty.shell", localManifest, true)));

        await supervisor.StartAsync(CancellationToken.None);
        try
        {
            var shell = await WaitForShellManifestUrlAsync(fixture.Apps, expectedManifestUrl: null);

            Assert.Equal("0.2.0", shell.Version);
            Assert.Null(shell.ManifestUrl);
        }
        finally
        {
            await supervisor.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task StartAsync_ObservabilityEnabled_BootstrapsCollectorAndProvisionsConfig()
    {
        var fixture = CreateFixture(_ => throw new HttpRequestException("no remote fetches expected"));
        var shellManifest = Path.Combine(root, "shell-manifest.json");
        await File.WriteAllTextAsync(shellManifest, CreateShellManifest("0.1.0", "hosty-shell", "local", "never"));
        var collectorManifest = Path.Combine(root, "collector-manifest.json");
        await File.WriteAllTextAsync(collectorManifest, CreateCollectorManifest("0.1.0"));
        var config = CreateConfig(fixture.Paths, shellAutostart: false) with
        {
            ObservabilityEnabled = true,
            CollectorAutostart = false,
            // The legacy explicit enable outranks the entry's defaultEnabled=false.
            Legacy = new LegacyBootstrapEnv(ObservabilityEnabled: true),
        };
        var supervisor = CreateSupervisor(fixture, config, CreateDistribution(
            ("hosty.shell", shellManifest, true),
            ("hosty.telemetry", collectorManifest, false)));

        await supervisor.StartAsync(CancellationToken.None);
        try
        {
            var collector = await WaitForAppAsync(fixture.Apps, "hosty.telemetry");
            Assert.True(collector.System);
            Assert.False(collector.Autostart);

            // The descriptor's provision hook delivered the Core-owned config and sink/store dirs.
            var dataDir = Path.Combine(fixture.Paths.AppsRoot, "hosty.telemetry", "data");
            await WaitForFileAsync(Path.Combine(dataDir, "config.yaml"));
            Assert.True(Directory.Exists(Path.Combine(dataDir, "otlp-logs")));
            Assert.True(Directory.Exists(Path.Combine(dataDir, "otlp-traces")));
            Assert.True(Directory.Exists(Path.Combine(dataDir, "store")));
        }
        finally
        {
            await supervisor.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task StartAsync_ObservabilityDisabled_SkipsCollectorBootstrap()
    {
        var fixture = CreateFixture(_ => throw new HttpRequestException("no remote fetches expected"));
        var shellManifest = Path.Combine(root, "shell-manifest.json");
        await File.WriteAllTextAsync(shellManifest, CreateShellManifest("0.1.0", "hosty-shell", "local", "never"));
        var collectorManifest = Path.Combine(root, "collector-manifest.json");
        await File.WriteAllTextAsync(collectorManifest, CreateCollectorManifest("0.1.0"));
        var config = CreateConfig(fixture.Paths, shellAutostart: false);
        var supervisor = CreateSupervisor(fixture, config, CreateDistribution(
            ("hosty.shell", shellManifest, true),
            ("hosty.telemetry", collectorManifest, false)));

        await supervisor.StartAsync(CancellationToken.None);
        try
        {
            await WaitForAppAsync(fixture.Apps, "hosty.shell");
            Assert.Null(await fixture.Apps.GetAppAsync("hosty.telemetry"));
        }
        finally
        {
            await supervisor.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task StartAsync_MarketplaceManifestPathAlone_UsesManifestRuntimeAndAutostartDefaults()
    {
        var fixture = CreateFixture(_ => throw new HttpRequestException("no remote fetches expected"));
        var marketplaceManifest = Path.Combine(root, "marketplace-manifest.json");
        await File.WriteAllTextAsync(marketplaceManifest, CreateMarketplaceManifest("0.1.0", defaultRuntime: "dev"));
        var config = CreateConfig(fixture.Paths, shellAutostart: false);
        var supervisor = CreateSupervisor(
            fixture, config, CreateDistribution((MarketplaceBootstrap.AppId, marketplaceManifest, true)));

        await supervisor.StartAsync(CancellationToken.None);
        try
        {
            var marketplace = await WaitForAppAsync(fixture.Apps, MarketplaceBootstrap.AppId);

            Assert.True(marketplace.System);
            Assert.Equal("dev", marketplace.SelectedRuntime);
            Assert.True(marketplace.Autostart);
            Assert.Equal(AppInstallOrigins.Distribution, marketplace.InstallOrigin);
        }
        finally
        {
            await supervisor.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task StartAsync_MarketplaceReconciliation_PreservesInstalledRuntimeAndAutostart()
    {
        var fixture = CreateFixture(_ => throw new HttpRequestException("no remote fetches expected"));
        var originalManifest = Path.Combine(root, "marketplace-original.json");
        await File.WriteAllTextAsync(originalManifest, CreateMarketplaceManifest("0.1.0", defaultRuntime: "dev"));
        await fixture.Lifecycle.InstallAsync(new AppInstallRequest(
            originalManifest,
            SelectedRuntime: "docker",
            System: true,
            Autostart: false,
            StartOnInstall: false));

        var updatedManifest = Path.Combine(root, "marketplace-updated.json");
        await File.WriteAllTextAsync(updatedManifest, CreateMarketplaceManifest("0.2.0", defaultRuntime: "dev"));
        var config = CreateConfig(fixture.Paths, shellAutostart: false);
        var supervisor = CreateSupervisor(
            fixture, config, CreateDistribution((MarketplaceBootstrap.AppId, updatedManifest, true)));

        await supervisor.StartAsync(CancellationToken.None);
        try
        {
            var marketplace = await WaitForAppVersionAsync(fixture.Apps, MarketplaceBootstrap.AppId, "0.2.0");

            Assert.Equal("docker", marketplace.SelectedRuntime);
            Assert.False(marketplace.Autostart);
        }
        finally
        {
            await supervisor.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task StartAsync_FeedsUrlEntry_InstallsThroughFeedPathAndNormalizesMarkers()
    {
        const string feedsUrl = "https://example.test/demo/feeds.json";
        const string manifestUrl = "https://example.test/demo/manifest.json";
        // Deliberately no role:system — the feed path installs with System=false, and the bootstrap
        // must normalize the flag together with the provenance stamp.
        const string manifest = """
            {
              "schemaVersion": "app.0.1",
              "id": "hosty.demo",
              "name": "Demo",
              "version": "0.1.0",
              "runtimeProfiles": [{ "key": "docker", "type": "docker", "default": true }],
              "services": [{ "key": "web", "runtimes": { "docker": { "type": "docker", "image": "ghcr.io/example/demo:0.1.0" } } }]
            }
            """;
        var feeds = $$"""
            { "schemaVersion": "app-feeds.0.1", "appId": "hosty.demo", "feeds": [ { "id": "stable", "manifestRef": "{{manifestUrl}}", "default": true } ] }
            """;
        var fixture = CreateFixture(request => new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent(
                string.Equals(request.RequestUri!.AbsoluteUri, feedsUrl, StringComparison.Ordinal) ? feeds : manifest,
                Encoding.UTF8,
                "application/json"),
        });
        var config = CreateConfig(fixture.Paths, shellAutostart: false);
        var supervisor = CreateSupervisor(fixture, config, CreateDistributionRaw(
            $"{{ \"id\": \"hosty.demo\", \"title\": \"Demo\", \"manifestRef\": \"{manifestUrl}\", \"feedsUrl\": \"{feedsUrl}\", \"defaultEnabled\": true }}"));

        await supervisor.StartAsync(CancellationToken.None);
        try
        {
            var demo = await WaitForAppAsync(fixture.Apps, "hosty.demo");

            Assert.Equal(feedsUrl, demo.FeedsUrl);
            Assert.Equal("stable", demo.FollowedFeedId);
            Assert.True(demo.System);
            Assert.Equal(AppInstallOrigins.Distribution, demo.InstallOrigin);
        }
        finally
        {
            await supervisor.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task StartAsync_ChoicesDisableOutranksDefaultEnabled()
    {
        var fixture = CreateFixture(_ => throw new HttpRequestException("no remote fetches expected"));
        var marketplaceManifest = Path.Combine(root, "marketplace-manifest.json");
        await File.WriteAllTextAsync(marketplaceManifest, CreateMarketplaceManifest("0.1.0", defaultRuntime: "dev"));
        await fixture.Choices.SetEnabledAsync(MarketplaceBootstrap.AppId, enabled: false);
        var config = CreateConfig(fixture.Paths, shellAutostart: false);
        var supervisor = CreateSupervisor(
            fixture, config, CreateDistribution((MarketplaceBootstrap.AppId, marketplaceManifest, true)));

        await supervisor.StartAsync(CancellationToken.None);
        try
        {
            await Task.Delay(250);
            Assert.Null(await fixture.Apps.GetAppAsync(MarketplaceBootstrap.AppId));
        }
        finally
        {
            await supervisor.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task StartAsync_UpgradeWithoutChoicesFile_PinsInstalledStateAsChoices()
    {
        // A host that already has apps (an upgrade) must not silently gain a default-enabled app it
        // never had: the first boot pins the current effective state into the choices file.
        var fixture = CreateFixture(_ => throw new HttpRequestException("no remote fetches expected"));
        var shellManifest = Path.Combine(root, "shell-manifest.json");
        await File.WriteAllTextAsync(shellManifest, CreateShellManifest("0.1.0", "hosty-shell", "local", "never"));
        var marketplaceManifest = Path.Combine(root, "marketplace-manifest.json");
        await File.WriteAllTextAsync(marketplaceManifest, CreateMarketplaceManifest("0.1.0", defaultRuntime: "dev"));
        await fixture.Lifecycle.InstallAsync(new AppInstallRequest(
            ManifestPath: shellManifest,
            SelectedRuntime: "docker",
            System: true,
            Autostart: false));
        var config = CreateConfig(fixture.Paths, shellAutostart: false);
        var supervisor = CreateSupervisor(fixture, config, CreateDistribution(
            ("hosty.shell", shellManifest, true),
            (MarketplaceBootstrap.AppId, marketplaceManifest, true)));

        await supervisor.StartAsync(CancellationToken.None);
        try
        {
            await Task.Delay(250);
            Assert.Null(await fixture.Apps.GetAppAsync(MarketplaceBootstrap.AppId));

            var choices = await fixture.Choices.LoadAsync();
            Assert.NotNull(choices);
            Assert.True(choices!.EnabledFor("hosty.shell"));
            Assert.False(choices.EnabledFor(MarketplaceBootstrap.AppId));
        }
        finally
        {
            await supervisor.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task StartAsync_FreshInstall_WritesNoChoicesFileAndFollowsDefaults()
    {
        var fixture = CreateFixture(_ => throw new HttpRequestException("no remote fetches expected"));
        var marketplaceManifest = Path.Combine(root, "marketplace-manifest.json");
        await File.WriteAllTextAsync(marketplaceManifest, CreateMarketplaceManifest("0.1.0", defaultRuntime: "dev"));
        var config = CreateConfig(fixture.Paths, shellAutostart: false);
        var supervisor = CreateSupervisor(
            fixture, config, CreateDistribution((MarketplaceBootstrap.AppId, marketplaceManifest, true)));

        await supervisor.StartAsync(CancellationToken.None);
        try
        {
            await WaitForAppAsync(fixture.Apps, MarketplaceBootstrap.AppId);
            Assert.False(fixture.Choices.Exists);
        }
        finally
        {
            await supervisor.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task RemoveAsync_DistributionOriginApp_RecordsDisabledChoice()
    {
        var fixture = CreateFixture(_ => throw new HttpRequestException("no remote fetches expected"));
        var marketplaceManifest = Path.Combine(root, "marketplace-manifest.json");
        await File.WriteAllTextAsync(marketplaceManifest, CreateMarketplaceManifest("0.1.0", defaultRuntime: "dev"));
        var config = CreateConfig(fixture.Paths, shellAutostart: false);
        var supervisor = CreateSupervisor(
            fixture, config, CreateDistribution((MarketplaceBootstrap.AppId, marketplaceManifest, true)));

        await supervisor.StartAsync(CancellationToken.None);
        try
        {
            await WaitForAppAsync(fixture.Apps, MarketplaceBootstrap.AppId);
        }
        finally
        {
            await supervisor.StopAsync(CancellationToken.None);
        }

        await fixture.Lifecycle.RemoveAsync(MarketplaceBootstrap.AppId, new AppRemoveRequest(), allowSystemRemoval: true);

        Assert.Null(await fixture.Apps.GetAppAsync(MarketplaceBootstrap.AppId));
        var choices = await fixture.Choices.LoadAsync();
        Assert.False(choices?.EnabledFor(MarketplaceBootstrap.AppId));
    }

    public void Dispose()
    {
        if (Directory.Exists(root))
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Theory]
    [InlineData("degraded", "warning")]
    [InlineData("unhealthy", "warning")]
    [InlineData("stopped", "error")]
    public void DescribeHealthTransition_WorseStateFromHealthy_ProducesAdvisory(string current, string expectedLevel)
    {
        var (level, title, body) = RuntimeAppSupervisorService.DescribeHealthTransition("app.one", "healthy", current);

        Assert.Equal(expectedLevel, level);
        Assert.NotNull(title);
        Assert.NotNull(body);
    }

    [Fact]
    public void DescribeHealthTransition_RecoveryToHealthy_IsSuccess()
        => Assert.Equal("success", RuntimeAppSupervisorService.DescribeHealthTransition("app.one", "degraded", "healthy").Level);

    [Fact]
    public void DescribeHealthTransition_StartupHopToHealthy_IsSilent()
        => Assert.Null(RuntimeAppSupervisorService.DescribeHealthTransition("app.one", "starting", "healthy").Level);

    [Theory]
    [InlineData("starting")]
    [InlineData("unknown")]
    public void DescribeHealthTransition_TransientOrAmbiguousStates_AreSilent(string current)
        => Assert.Null(RuntimeAppSupervisorService.DescribeHealthTransition("app.one", "healthy", current).Level);

    [Fact]
    public void EvaluateRestart_DisabledPolicy_Skips()
    {
        var (decision, _) = RuntimeAppSupervisorService.EvaluateRestart(
            RuntimeRestartPolicy.Disabled, RestartGateState.Initial, DateTimeOffset.UnixEpoch, TimeSpan.FromMinutes(5));

        Assert.Equal(RestartDecision.Skip, decision);
    }

    [Fact]
    public void EvaluateRestart_FirstFailure_RestartsAndArmsBaseBackoff()
    {
        var now = DateTimeOffset.UnixEpoch;

        var (decision, next) = RuntimeAppSupervisorService.EvaluateRestart(
            new RuntimeRestartPolicy("on-failure", 3, 10), RestartGateState.Initial, now, TimeSpan.FromMinutes(5));

        Assert.Equal(RestartDecision.Restart, decision);
        Assert.Equal(1, next.Attempts);
        Assert.Equal(now.AddSeconds(10), next.NextEligibleAt);
        Assert.False(next.GaveUp);
    }

    [Fact]
    public void EvaluateRestart_WithinBackoffWindow_Skips()
    {
        var now = DateTimeOffset.UnixEpoch;
        var armed = new RestartGateState(1, now.AddSeconds(10), false);

        var (decision, _) = RuntimeAppSupervisorService.EvaluateRestart(
            new RuntimeRestartPolicy("always", 3, 10), armed, now.AddSeconds(5), TimeSpan.FromMinutes(5));

        Assert.Equal(RestartDecision.Skip, decision);
    }

    [Fact]
    public void EvaluateRestart_BackoffGrowsExponentially()
    {
        var now = DateTimeOffset.UnixEpoch;
        var afterTwo = new RestartGateState(2, now, false);

        var (decision, next) = RuntimeAppSupervisorService.EvaluateRestart(
            new RuntimeRestartPolicy("on-failure", 5, 10), afterTwo, now, TimeSpan.FromMinutes(5));

        Assert.Equal(RestartDecision.Restart, decision);
        Assert.Equal(now.AddSeconds(40), next.NextEligibleAt); // 10 * 2^2
    }

    [Fact]
    public void EvaluateRestart_BackoffCappedAtMax()
    {
        var now = DateTimeOffset.UnixEpoch;
        var deep = new RestartGateState(10, now, false);

        var (_, next) = RuntimeAppSupervisorService.EvaluateRestart(
            new RuntimeRestartPolicy("always", 100, 60), deep, now, TimeSpan.FromMinutes(5));

        Assert.Equal(now.AddMinutes(5), next.NextEligibleAt);
    }

    [Fact]
    public void EvaluateRestart_ExhaustedRetries_GivesUp()
    {
        var now = DateTimeOffset.UnixEpoch;
        var exhausted = new RestartGateState(2, now, false);

        var (decision, next) = RuntimeAppSupervisorService.EvaluateRestart(
            new RuntimeRestartPolicy("always", 2, 10), exhausted, now, TimeSpan.FromMinutes(5));

        Assert.Equal(RestartDecision.GiveUp, decision);
        Assert.True(next.GaveUp);
    }

    [Fact]
    public void RestartPolicy_FromManifest_AppliesDefaultsAndNormalizesMode()
    {
        var resolved = RuntimeRestartPolicy.FromManifest(new RuntimeAppRestartPolicyManifest { Mode = "ON-FAILURE" });

        Assert.Equal("on-failure", resolved.Mode);
        Assert.True(resolved.Enabled);
        Assert.Equal(5, resolved.MaxRetries);
        Assert.Equal(10, resolved.BackoffSeconds);
    }

    [Fact]
    public void RestartPolicy_FromManifest_NullOrUnknownModeIsDisabled()
    {
        Assert.False(RuntimeRestartPolicy.FromManifest(null).Enabled);
        Assert.False(RuntimeRestartPolicy.FromManifest(new RuntimeAppRestartPolicyManifest { Mode = "whenever" }).Enabled);
    }

    private static async Task<AppRecord> WaitForAppAsync(AppRegistryStore apps, string appId)
    {
        var deadline = DateTimeOffset.UtcNow.AddSeconds(5);
        while (DateTimeOffset.UtcNow < deadline)
        {
            var app = await apps.GetAppAsync(appId);
            if (app is not null)
            {
                return app;
            }

            await Task.Delay(50);
        }

        throw new TimeoutException($"{appId} was not installed by the supervisor bootstrap.");
    }

    private static async Task<AppRecord> WaitForAppVersionAsync(AppRegistryStore apps, string appId, string version)
    {
        var deadline = DateTimeOffset.UtcNow.AddSeconds(5);
        while (DateTimeOffset.UtcNow < deadline)
        {
            var app = await apps.GetAppAsync(appId);
            if (app?.Version == version)
            {
                return app;
            }

            await Task.Delay(50);
        }

        throw new TimeoutException($"{appId} did not reach version {version}.");
    }

    private static async Task WaitForFileAsync(string path)
    {
        var deadline = DateTimeOffset.UtcNow.AddSeconds(5);
        while (DateTimeOffset.UtcNow < deadline)
        {
            if (File.Exists(path))
            {
                return;
            }

            await Task.Delay(50);
        }

        throw new TimeoutException($"File '{path}' was not provisioned.");
    }

    private static async Task<AppRecord> WaitForShellVersionAsync(AppRegistryStore apps, string version)
    {
        var deadline = DateTimeOffset.UtcNow.AddSeconds(5);
        while (DateTimeOffset.UtcNow < deadline)
        {
            var shell = await apps.GetAppAsync("hosty.shell");
            if (shell?.Version == version)
            {
                return shell;
            }

            await Task.Delay(50);
        }

        throw new TimeoutException($"hosty.shell did not reach version {version}.");
    }

    private static async Task<AppRecord> WaitForShellManifestUrlAsync(AppRegistryStore apps, string? expectedManifestUrl)
    {
        var deadline = DateTimeOffset.UtcNow.AddSeconds(5);
        while (DateTimeOffset.UtcNow < deadline)
        {
            var shell = await apps.GetAppAsync("hosty.shell");
            if (shell is not null && string.Equals(shell.ManifestUrl, expectedManifestUrl, StringComparison.Ordinal))
            {
                return shell;
            }

            await Task.Delay(50);
        }

        throw new TimeoutException($"hosty.shell did not reach manifest URL '{expectedManifestUrl ?? "<local>"}'.");
    }

    private TestFixture CreateFixture(Func<HttpRequestMessage, HttpResponseMessage> manifestHandler)
    {
        Directory.CreateDirectory(root);
        var paths = new CoreDataPaths(
            DataRoot: root,
            CoreRoot: Path.Combine(root, "core"),
            AppsRoot: Path.Combine(root, "apps"),
            BackupsRoot: Path.Combine(root, "backups"),
            SourcesRoot: Path.Combine(root, "sources"),
            AuthRoot: Path.Combine(root, "core", "auth"),
            AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));
        var apps = new AppRegistryStore(paths);
        var clock = new TestClock();
        var manifests = new AppManifestService(new HttpClient(new StubHttpMessageHandler(manifestHandler)));
        var backups = new AppBackupService(paths, clock);
        var sources = new AppSourceService(paths, apps, clock);
        var choices = new BootstrapChoicesStore(paths, NullLogger<BootstrapChoicesStore>.Instance);
        var lifecycle = new CoreLifecycleService(
            paths,
            apps,
            manifests,
            backups,
            sources,
            [new NoopDockerRuntimeAdapter(), new NoopLocalCommandRuntimeAdapter()],
            new NoneIngressController(),
            Microsoft.Extensions.Logging.Abstractions.NullLogger<CoreLifecycleService>.Instance,
            feedService: new AppFeedService(new HttpClient(new StubHttpMessageHandler(manifestHandler))),
            bootstrapChoices: choices);
        return new TestFixture(paths, apps, sources, lifecycle, choices);
    }

    private static HostyCoreRuntimeConfig CreateConfig(CoreDataPaths paths, bool shellAutostart)
        => new(
            DataRoot: paths.DataRoot,
            RunDirectory: Path.Combine(paths.CoreRoot, "run"),
            ControlDiscoveryPath: Path.Combine(paths.CoreRoot, "run", "control.json"),
            CorePort: 3001,
            ShellPort: 3000,
            ListenUrl: "http://127.0.0.1:3001",
            CorePublicOrigin: "http://127.0.0.1:3001",
            ShellPublicOrigin: "http://127.0.0.1:3000",
            RuntimePublicHost: "localhost",
            ShellBootstrapRuntime: "docker",
            ShellSourceOverridePath: null,
            ShellAutostart: shellAutostart);

    private RuntimeAppSupervisorService CreateSupervisor(
        TestFixture fixture,
        HostyCoreRuntimeConfig config,
        DistributionAppsProvider distribution)
        => new(
            config,
            fixture.Apps,
            fixture.Lifecycle,
            fixture.Sources,
            distribution,
            fixture.Choices,
            NullLogger<RuntimeAppSupervisorService>.Instance);

    private DistributionAppsProvider CreateDistributionRaw(string appsJson)
    {
        Directory.CreateDirectory(root);
        var path = Path.Combine(root, $"distribution-{Guid.NewGuid():N}.json");
        File.WriteAllText(path, $"{{ \"schemaVersion\": \"distribution-apps.0.1\", \"apps\": [{appsJson}] }}");
        return new DistributionAppsProvider(NullLogger<DistributionAppsProvider>.Instance, explicitPathOverride: path);
    }

    // Writes a one-off distribution list into the test root and returns a provider pinned to it (the
    // explicit path keeps the walk from ever finding the repo's own distribution-apps.json).
    private DistributionAppsProvider CreateDistribution(params (string Id, string ManifestRef, bool DefaultEnabled)[] entries)
    {
        Directory.CreateDirectory(root);
        var apps = string.Join(",\n", entries.Select(entry =>
            $"{{ \"id\": \"{entry.Id}\", \"title\": \"{entry.Id}\", \"manifestRef\": \"{entry.ManifestRef.Replace("\\", "\\\\")}\", \"defaultEnabled\": {(entry.DefaultEnabled ? "true" : "false")} }}"));
        var path = Path.Combine(root, $"distribution-{Guid.NewGuid():N}.json");
        File.WriteAllText(path, $"{{ \"schemaVersion\": \"distribution-apps.0.1\", \"apps\": [{apps}] }}");
        return new DistributionAppsProvider(NullLogger<DistributionAppsProvider>.Instance, explicitPathOverride: path);
    }

    private static string CreateCollectorManifest(string version)
        => $$"""
            {
              "schemaVersion": "app.0.1",
              "id": "hosty.telemetry",
              "name": "Hosty Telemetry",
              "version": "{{version}}",
              "role": "system",
              "runtimeProfiles": [{ "key": "docker", "type": "docker", "default": true }],
              "services": [{
                "key": "collector",
                "runtimes": {
                  "docker": {
                    "type": "docker",
                    "image": "otel/opentelemetry-collector-contrib:0.155.0"
                  }
                }
              }]
            }
            """;

    private static string CreateMarketplaceManifest(string version, string defaultRuntime)
        => $$"""
            {
              "schemaVersion": "app.0.1",
              "id": "hosty.marketplace",
              "name": "Hosty Marketplace",
              "version": "{{version}}",
              "role": "system",
              "runtimeProfiles": [
                { "key": "docker", "type": "docker", "default": {{(defaultRuntime == "docker" ? "true" : "false")}} },
                { "key": "dev", "type": "localCommand", "default": {{(defaultRuntime == "dev" ? "true" : "false")}} }
              ],
              "defaultRuntime": "{{defaultRuntime}}",
              "services": [{
                "key": "web",
                "runtimes": {
                  "docker": { "type": "docker", "image": "ghcr.io/example/marketplace:{{version}}" },
                  "dev": { "type": "localCommand", "workingDirectory": ".", "command": "true" }
                }
              }]
            }
            """;

    private static string CreateShellManifest(string version, string repository, string tag, string pullPolicy)
        => $$"""
            {
              "schemaVersion": "app.0.1",
              "id": "hosty.shell",
              "name": "Hosty Shell",
              "version": "{{version}}",
              "runtimeProfiles": [
                { "key": "docker", "type": "docker", "default": true },
                { "key": "dev", "type": "localCommand" }
              ],
              "defaultRuntime": "docker",
              "services": [
                {
                  "key": "web",
                  "runtimes": {
                    "docker": {
                      "type": "docker",
                      "image": {
                        "repository": "{{repository}}",
                        "tag": "{{tag}}",
                        "pullPolicy": "{{pullPolicy}}"
                      },
                      "ports": [
                        {
                          "key": "http",
                          "containerPort": 3000,
                          "localPort": 3000,
                          "protocol": "http",
                          "public": true
                        }
                      ]
                    },
                    "dev": {
                      "type": "localCommand",
                      "workingDirectory": "apps/shell",
                      "command": "npm run dev"
                    }
                  }
                }
              ],
              "endpoints": [
                {
                  "key": "web",
                  "service": "web",
                  "port": "http",
                  "protocol": "http",
                  "public": true
                }
              ],
              "capabilities": ["open", "update", "restart", "stop", "logs"]
            }
            """;

    private sealed record TestFixture(
        CoreDataPaths Paths,
        AppRegistryStore Apps,
        AppSourceService Sources,
        CoreLifecycleService Lifecycle,
        BootstrapChoicesStore Choices);

    private sealed class TestClock : IClock
    {
        public DateTimeOffset UtcNow { get; } = DateTimeOffset.Parse("2026-06-02T12:00:00Z");
    }

    private sealed class StubHttpMessageHandler(Func<HttpRequestMessage, HttpResponseMessage> handler) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => Task.FromResult(handler(request));
    }

    private sealed class NoopDockerRuntimeAdapter : IAppRuntimeAdapter
    {
        public string Type => "docker";

        public Task<AppRuntimeStartResult> StartAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
            => Task.FromResult(new AppRuntimeStartResult("running", []));

        public Task<AppRuntimeOperationResult> StopAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
            => Task.FromResult(new AppRuntimeOperationResult("stopped"));

        public Task<AppRuntimeOperationResult> RemoveAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
            => Task.FromResult(new AppRuntimeOperationResult("removed"));

        public Task<AppRuntimeLogsResult> GetLogsAsync(RuntimeLifecycleContext context, int tail, CancellationToken cancellationToken = default)
            => Task.FromResult(new AppRuntimeLogsResult(""));

        public Task<AppRuntimeHealthResult> GetHealthAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
            => Task.FromResult(new AppRuntimeHealthResult("unknown", []));
    }

    private sealed class NoopLocalCommandRuntimeAdapter : IAppRuntimeAdapter
    {
        public string Type => "localCommand";

        public Task<AppRuntimeStartResult> StartAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
            => Task.FromResult(new AppRuntimeStartResult("running", []));

        public Task<AppRuntimeOperationResult> StopAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
            => Task.FromResult(new AppRuntimeOperationResult("stopped"));

        public Task<AppRuntimeOperationResult> RemoveAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
            => Task.FromResult(new AppRuntimeOperationResult("removed"));

        public Task<AppRuntimeLogsResult> GetLogsAsync(RuntimeLifecycleContext context, int tail, CancellationToken cancellationToken = default)
            => Task.FromResult(new AppRuntimeLogsResult(string.Empty));

        public Task<AppRuntimeHealthResult> GetHealthAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
            => Task.FromResult(new AppRuntimeHealthResult("unknown", []));
    }
}
