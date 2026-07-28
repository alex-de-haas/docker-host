using System.Net;
using System.Text;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed class RuntimeAppSupervisorServiceTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), $"hosty-supervisor-tests-{Guid.NewGuid():N}");

    [Fact]
    public async Task StartAsync_InstalledApp_IsLeftEntirelyAlone()
    {
        // Boot neither fetches nor edits an installed app: no version movement, no pointer rewrite, no
        // settings stamping. Everything about an installed app changes through the operator's own
        // reviewed flows from here on.
        var fixture = CreateFixture(_ => throw new HttpRequestException("no remote fetches expected at boot"));
        var localManifest = Path.Combine(root, "old-shell-manifest.json");
        await File.WriteAllTextAsync(localManifest, CreateShellManifest("0.1.0", "hosty-shell", "local", "never"));
        await fixture.Lifecycle.InstallAsync(new AppInstallRequest(
            ManifestPath: localManifest,
            SelectedRuntime: "docker",
            System: true,
            Autostart: false));
        var config = CreateConfig(fixture.Paths, shellAutostart: false);
        var supervisor = CreateSupervisor(fixture, config, CreateDistribution(
            ("hosty.shell", "https://raw.githubusercontent.com/alex-de-haas/docker-host/main/apps/shell/manifest.json", true)));

        await supervisor.StartAsync(CancellationToken.None);
        try
        {
            await WaitForFileAsync(Path.Combine(fixture.Paths.CoreRoot, DistributionSeedSchema.FileName));

            var shell = (await fixture.Apps.GetAppAsync("hosty.shell"))!;
            Assert.Equal("0.1.0", shell.Version);
            Assert.Equal("docker", shell.SelectedRuntime);
            Assert.False(shell.Autostart);
            // The distribution entry's URL is not stamped onto a record that was installed locally.
            Assert.Null(shell.ManifestUrl);
        }
        finally
        {
            await supervisor.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task StopAsync_KeepApps_LeavesRuntimeAppsRunning()
    {
        var fixture = CreateFixture(_ => throw new HttpRequestException("no remote fetches expected"));
        var manifest = Path.Combine(root, "keep-apps-manifest.json");
        await File.WriteAllTextAsync(manifest, CreateShellManifest("1.0.0", "hosty-shell", "local", "never"));
        await fixture.Lifecycle.InstallAsync(new AppInstallRequest(
            ManifestPath: manifest,
            SelectedRuntime: "docker",
            System: false,
            Autostart: true));
        var config = CreateConfig(fixture.Paths, shellAutostart: true);
        var supervisor = CreateSupervisor(fixture, config, CreateDistribution(), new CoreShutdownOptions { KeepRuntimeApps = true });

        await supervisor.StartAsync(CancellationToken.None);
        await WaitForAppAsync(fixture.Apps, "hosty.shell", app => string.Equals(app.RuntimeState, "running", StringComparison.Ordinal));

        await supervisor.StopAsync(CancellationToken.None);

        // Light stop: Core exits without stopping app containers, so the adapter's Stop is never called
        // and the record stays running (to be re-adopted by the next Core).
        Assert.Equal(0, fixture.Docker.StopCount);
        var app = await fixture.Apps.GetAppAsync("hosty.shell");
        Assert.Equal("running", app?.RuntimeState);
    }

    [Fact]
    public async Task StopAsync_Default_StopsRuntimeApps()
    {
        var fixture = CreateFixture(_ => throw new HttpRequestException("no remote fetches expected"));
        var manifest = Path.Combine(root, "default-stop-manifest.json");
        await File.WriteAllTextAsync(manifest, CreateShellManifest("1.0.0", "hosty-shell", "local", "never"));
        await fixture.Lifecycle.InstallAsync(new AppInstallRequest(
            ManifestPath: manifest,
            SelectedRuntime: "docker",
            System: false,
            Autostart: true));
        var config = CreateConfig(fixture.Paths, shellAutostart: true);
        var supervisor = CreateSupervisor(fixture, config, CreateDistribution());

        await supervisor.StartAsync(CancellationToken.None);
        await WaitForAppAsync(fixture.Apps, "hosty.shell", app => string.Equals(app.RuntimeState, "running", StringComparison.Ordinal));

        await supervisor.StopAsync(CancellationToken.None);

        // Default shutdown stops the app containers so Core can release their ports.
        Assert.True(fixture.Docker.StopCount >= 1);
    }

    [Fact]
    public async Task StopAsync_HostShutdownTokenAlreadyCancelled_StillStopsRuntimeApps()
    {
        // Kestrel stops before the supervisor, and one held connection (an open notification SSE
        // stream) makes it eat the whole HostOptions.ShutdownTimeout budget — the supervisor then
        // receives an already-cancelled token. The sweep must still run on its own budget; linking
        // to the host token skipped it silently and left every container and localCommand tree
        // running after `hosty stop`.
        var fixture = CreateFixture(_ => throw new HttpRequestException("no remote fetches expected"));
        var manifest = Path.Combine(root, "spent-budget-stop-manifest.json");
        await File.WriteAllTextAsync(manifest, CreateShellManifest("1.0.0", "hosty-shell", "local", "never"));
        await fixture.Lifecycle.InstallAsync(new AppInstallRequest(
            ManifestPath: manifest,
            SelectedRuntime: "docker",
            System: false,
            Autostart: true));
        var config = CreateConfig(fixture.Paths, shellAutostart: true);
        var supervisor = CreateSupervisor(fixture, config, CreateDistribution());

        await supervisor.StartAsync(CancellationToken.None);
        await WaitForAppAsync(fixture.Apps, "hosty.shell", app => string.Equals(app.RuntimeState, "running", StringComparison.Ordinal));

        using var spentBudget = new CancellationTokenSource();
        spentBudget.Cancel();
        await supervisor.StopAsync(spentBudget.Token);

        Assert.True(fixture.Docker.StopCount >= 1);
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
    public async Task StartAsync_LocalDistributionReference_KeepsInstalledManifestUrl()
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
            await WaitForFileAsync(Path.Combine(fixture.Paths.CoreRoot, DistributionSeedSchema.FileName));

            // The installed record keeps its own remote update source; the distribution entry (here a
            // local path, as on a dev host walking the repo) never rewrites it.
            var shell = (await fixture.Apps.GetAppAsync("hosty.shell"))!;
            Assert.Equal("0.2.0", shell.Version);
            Assert.Equal(manifestUrl, shell.ManifestUrl);
        }
        finally
        {
            await supervisor.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task StartAsync_MovedManifestUrl_LeavesTheInstalledPointerAlone()
    {
        const string oldUrl = "https://raw.githubusercontent.com/alex-de-haas/docker-host/main/apps/collector/manifest.json";
        const string newUrl = "https://raw.githubusercontent.com/alex-de-haas/docker-host/main/apps/telemetry/manifest.json";
        var shellManifest = CreateShellManifest("0.2.0", "ghcr.io/alex-de-haas/hosty-shell", "latest", "always");
        var fetches = 0;
        var fixture = CreateFixture(request =>
        {
            // Only the initial URL install may fetch; the boot migration itself must not.
            if (Interlocked.Increment(ref fetches) > 1)
            {
                throw new HttpRequestException("no remote fetches expected at boot");
            }

            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(shellManifest, Encoding.UTF8, "application/json"),
            };
        });
        await fixture.Lifecycle.InstallAsync(new AppInstallRequest(
            ManifestPath: oldUrl,
            SelectedRuntime: "docker",
            System: true,
            Autostart: false));
        var config = CreateConfig(fixture.Paths, shellAutostart: false);
        var supervisor = CreateSupervisor(fixture, config, CreateDistribution(("hosty.shell", newUrl, true)));

        await supervisor.StartAsync(CancellationToken.None);
        try
        {
            await WaitForFileAsync(Path.Combine(fixture.Paths.CoreRoot, DistributionSeedSchema.FileName));

            // Boot no longer rewrites an installed app's update source, so a moved distribution
            // reference is the operator's to adopt (reinstall from the catalog, or a feed-bound record).
            var shell = (await fixture.Apps.GetAppAsync("hosty.shell"))!;
            Assert.Equal("0.2.0", shell.Version);
            Assert.Equal(oldUrl, shell.ManifestUrl);
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
            // Autostart is a normal per-app setting now: first install takes the default (true) and
            // later boots preserve whatever the operator configures.
            Assert.True(collector.Autostart);

            // The otlp-collector capability provisioner (run on the start path) delivered the
            // Core-owned config and sink/store dirs.
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
    public async Task Start_DirectlyInstalledCapabilityApp_ProvisionsOnStartNotBootstrap()
    {
        // The whole point of capability-based provisioning: an app that declares provides:[otlp-collector]
        // gets its Core-owned config + sink dirs on the start path even when it was installed directly
        // (the marketplace/CLI path), never touching the bootstrap descriptor.
        var fixture = CreateFixture(_ => throw new HttpRequestException("no remote fetches expected"));
        var collectorManifest = Path.Combine(root, "collector-manifest.json");
        await File.WriteAllTextAsync(collectorManifest, CreateCollectorManifest("0.1.0"));
        await fixture.Lifecycle.InstallAsync(new AppInstallRequest(
            ManifestPath: collectorManifest,
            SelectedRuntime: "docker",
            System: true,
            Autostart: false));

        var dataDir = Path.Combine(fixture.Paths.AppsRoot, "hosty.telemetry", "data");
        // Not provisioned by install alone — provisioning is a start-time step.
        Assert.False(File.Exists(Path.Combine(dataDir, "config.yaml")));

        await fixture.Lifecycle.StartAsync("hosty.telemetry");

        await WaitForFileAsync(Path.Combine(dataDir, "config.yaml"));
        Assert.True(Directory.Exists(Path.Combine(dataDir, "otlp-logs")));
        Assert.True(Directory.Exists(Path.Combine(dataDir, "otlp-traces")));
        Assert.True(Directory.Exists(Path.Combine(dataDir, "store")));
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
            var marketplace = await WaitForAppAsync(fixture.Apps, MarketplaceBootstrap.AppId, IsDistributionStamped);

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
    public async Task StartAsync_NewerDistributionManifest_DoesNotUpdateInstalledApp()
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
            // A newer manifest behind the distribution entry is an ordinary update: it waits for the
            // operator's reviewed plan/apply and is never applied at boot.
            await WaitForFileAsync(Path.Combine(fixture.Paths.CoreRoot, DistributionSeedSchema.FileName));

            var marketplace = (await fixture.Apps.GetAppAsync(MarketplaceBootstrap.AppId))!;
            Assert.Equal("0.1.0", marketplace.Version);
            Assert.Equal("docker", marketplace.SelectedRuntime);
            Assert.False(marketplace.Autostart);
        }
        finally
        {
            await supervisor.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task StartAsync_FeedsUrlEntry_InstallsThroughFeedPathAndStampsProvenanceOnly()
    {
        const string feedsUrl = "https://example.test/demo/feeds.json";
        const string manifestUrl = "https://example.test/demo/manifest.json";
        // Deliberately no role:system — being in the distribution list is provenance, not privilege,
        // so the seeded app stays an ordinary app exactly as its manifest declares it.
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
            var demo = await WaitForAppAsync(fixture.Apps, "hosty.demo", IsDistributionOrigin);

            Assert.Equal(feedsUrl, demo.FeedsUrl);
            Assert.Equal("stable", demo.FollowedFeedId);
            // The manifest declares no role, so the app is not a system app — the distribution list
            // never confers that on its own.
            Assert.False(demo.System);
            Assert.Equal(AppInstallOrigins.Distribution, demo.InstallOrigin);
        }
        finally
        {
            await supervisor.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task StartAsync_SeededHost_DoesNotReinstallARemovedApp()
    {
        // The whole point of one-time seeding: an app the operator removed stays removed, no matter
        // that the release still ships it as a default.
        var fixture = CreateFixture(_ => throw new HttpRequestException("no remote fetches expected"));
        var marketplaceManifest = Path.Combine(root, "marketplace-manifest.json");
        await File.WriteAllTextAsync(marketplaceManifest, CreateMarketplaceManifest("0.1.0", defaultRuntime: "dev"));
        var config = CreateConfig(fixture.Paths, shellAutostart: false);
        var distribution = CreateDistribution((MarketplaceBootstrap.AppId, marketplaceManifest, true));

        var first = CreateSupervisor(fixture, config, distribution);
        await first.StartAsync(CancellationToken.None);
        try
        {
            // Wait for the seed MARKER, not just the installed app: SeedFreshHostAsync writes the
            // marker after the last install, under the boot token. Stopping the supervisor as soon as
            // the app record appears can cancel that write, and a host with no marker and no apps left
            // (the operator removes the app below) is indistinguishable from a fresh one — so the
            // second boot would legitimately re-seed and this test would fail for the wrong reason.
            await WaitForAppAsync(fixture.Apps, MarketplaceBootstrap.AppId);
            await WaitForFileAsync(Path.Combine(fixture.Paths.CoreRoot, DistributionSeedSchema.FileName));
        }
        finally
        {
            await first.StopAsync(CancellationToken.None);
        }

        await fixture.Lifecycle.RemoveAsync(MarketplaceBootstrap.AppId, new AppRemoveRequest());
        Assert.Null(await fixture.Apps.GetAppAsync(MarketplaceBootstrap.AppId));

        var second = CreateSupervisor(fixture, config, distribution);
        await second.StartAsync(CancellationToken.None);
        try
        {
            await Task.Delay(250);
            Assert.Null(await fixture.Apps.GetAppAsync(MarketplaceBootstrap.AppId));
        }
        finally
        {
            await second.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task StartAsync_ExistingHost_IsAdoptedAsSeededWithoutInstalling()
    {
        // An upgrade must not gain a default app it never had: any installed app at all proves the
        // host predates seeding, so it is marked seeded and left alone.
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
            await WaitForFileAsync(Path.Combine(fixture.Paths.CoreRoot, DistributionSeedSchema.FileName));
            Assert.Null(await fixture.Apps.GetAppAsync(MarketplaceBootstrap.AppId));
        }
        finally
        {
            await supervisor.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task StartAsync_HostWithLegacyChoicesFile_IsAdoptedAsSeeded()
    {
        // A pre-seeding host that had removed everything: the registry is empty, but its choices file
        // proves it already made those decisions.
        var fixture = CreateFixture(_ => throw new HttpRequestException("no remote fetches expected"));
        var marketplaceManifest = Path.Combine(root, "marketplace-manifest.json");
        await File.WriteAllTextAsync(marketplaceManifest, CreateMarketplaceManifest("0.1.0", defaultRuntime: "dev"));
        Directory.CreateDirectory(fixture.Paths.CoreRoot);
        await File.WriteAllTextAsync(
            Path.Combine(fixture.Paths.CoreRoot, DistributionSeedSchema.LegacyChoicesFileName),
            """{ "schemaVersion": "bootstrap-choices.0.1", "apps": { "hosty.marketplace": { "enabled": false } } }""");
        var config = CreateConfig(fixture.Paths, shellAutostart: false);
        var supervisor = CreateSupervisor(
            fixture, config, CreateDistribution((MarketplaceBootstrap.AppId, marketplaceManifest, true)));

        await supervisor.StartAsync(CancellationToken.None);
        try
        {
            await WaitForFileAsync(Path.Combine(fixture.Paths.CoreRoot, DistributionSeedSchema.FileName));
            Assert.Null(await fixture.Apps.GetAppAsync(MarketplaceBootstrap.AppId));
        }
        finally
        {
            await supervisor.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task StartAsync_FreshHost_SeedsDefaultsAndMarksSeeded()
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
            await WaitForFileAsync(Path.Combine(fixture.Paths.CoreRoot, DistributionSeedSchema.FileName));
        }
        finally
        {
            await supervisor.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task StartAsync_SeedFailure_RecordsThePendingEntry()
    {
        var fixture = CreateFixture(_ => throw new HttpRequestException("no remote fetches expected"));
        var config = CreateConfig(fixture.Paths, shellAutostart: false);
        var supervisor = CreateSupervisor(
            fixture,
            config,
            CreateDistribution((MarketplaceBootstrap.AppId, Path.Combine(root, "missing-manifest.json"), true)));

        await supervisor.StartAsync(CancellationToken.None);
        try
        {
            await WaitForFileAsync(Path.Combine(fixture.Paths.CoreRoot, DistributionSeedSchema.FileName));
            Assert.Null(await fixture.Apps.GetAppAsync(MarketplaceBootstrap.AppId));

            // The marker is written even though the install failed — what earns the retry is the
            // pending list, not a withheld marker.
            var marker = await fixture.Seed.LoadAsync();
            Assert.Equal([MarketplaceBootstrap.AppId], marker!.Pending);
        }
        finally
        {
            await supervisor.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task StartAsync_PartialSeed_RetriesOnlyTheMissingDefaultOnTheNextBoot()
    {
        // The regression this guards: one default installs, another fails. The successful app makes
        // the host count as seeded, so without the pending list the failed one would be lost forever.
        var shellManifest = Path.Combine(root, "shell-manifest.json");
        var marketplaceManifest = Path.Combine(root, "marketplace-manifest.json");
        var fixture = CreateFixture(_ => throw new HttpRequestException("no remote fetches expected"));
        await File.WriteAllTextAsync(shellManifest, CreateShellManifest("0.1.0", "hosty-shell", "local", "never"));
        var config = CreateConfig(fixture.Paths, shellAutostart: false);
        var distribution = CreateDistribution(
            ("hosty.shell", shellManifest, true),
            (MarketplaceBootstrap.AppId, marketplaceManifest, true));

        var first = CreateSupervisor(fixture, config, distribution);
        await first.StartAsync(CancellationToken.None);
        try
        {
            await WaitForAppAsync(fixture.Apps, "hosty.shell");
            await WaitForFileAsync(Path.Combine(fixture.Paths.CoreRoot, DistributionSeedSchema.FileName));
            Assert.Null(await fixture.Apps.GetAppAsync(MarketplaceBootstrap.AppId));
            Assert.Equal([MarketplaceBootstrap.AppId], (await fixture.Seed.LoadAsync())!.Pending);
        }
        finally
        {
            await first.StopAsync(CancellationToken.None);
        }

        // The manifest that was unreadable during the first boot is available now.
        await File.WriteAllTextAsync(marketplaceManifest, CreateMarketplaceManifest("0.1.0", defaultRuntime: "dev"));

        var second = CreateSupervisor(fixture, config, distribution);
        await second.StartAsync(CancellationToken.None);
        try
        {
            await WaitForAppAsync(fixture.Apps, MarketplaceBootstrap.AppId);
            await WaitForSeedMarkerAsync(fixture, marker => marker.Pending.Count == 0);
        }
        finally
        {
            await second.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task StartAsync_PendingEntryRemovedFromTheCatalog_IsDroppedNotRetried()
    {
        var fixture = CreateFixture(_ => throw new HttpRequestException("no remote fetches expected"));
        Directory.CreateDirectory(fixture.Paths.CoreRoot);
        await fixture.Seed.SaveAsync(["hosty.retired"], ["hosty.retired"]);
        var marketplaceManifest = Path.Combine(root, "marketplace-manifest.json");
        await File.WriteAllTextAsync(marketplaceManifest, CreateMarketplaceManifest("0.1.0", defaultRuntime: "dev"));
        var config = CreateConfig(fixture.Paths, shellAutostart: false);
        var supervisor = CreateSupervisor(
            fixture, config, CreateDistribution((MarketplaceBootstrap.AppId, marketplaceManifest, true)));

        await supervisor.StartAsync(CancellationToken.None);
        try
        {
            await WaitForSeedMarkerAsync(fixture, marker => marker.Pending.Count == 0);
            // The host was already seeded, so the catalog's own entry is not installed either.
            Assert.Null(await fixture.Apps.GetAppAsync(MarketplaceBootstrap.AppId));
        }
        finally
        {
            await supervisor.StopAsync(CancellationToken.None);
        }
    }

    [Fact]
    public async Task RemoveAsync_SystemApp_SucceedsOnTheOrdinaryPath()
    {
        // No control-plane escape hatch anymore: the same call the browser makes removes a system app.
        var fixture = CreateFixture(_ => throw new HttpRequestException("no remote fetches expected"));
        var marketplaceManifest = Path.Combine(root, "marketplace-manifest.json");
        await File.WriteAllTextAsync(marketplaceManifest, CreateMarketplaceManifest("0.1.0", defaultRuntime: "dev"));
        await fixture.Lifecycle.InstallAsync(new AppInstallRequest(
            ManifestPath: marketplaceManifest,
            SelectedRuntime: "dev",
            Autostart: false));
        var installed = await fixture.Apps.GetAppAsync(MarketplaceBootstrap.AppId);
        Assert.True(installed!.System);

        await fixture.Lifecycle.RemoveAsync(MarketplaceBootstrap.AppId, new AppRemoveRequest());

        Assert.Null(await fixture.Apps.GetAppAsync(MarketplaceBootstrap.AppId));
    }

    [Fact]
    public async Task InstallAsync_InstallsAndStartsACatalogEntry()
    {
        var fixture = CreateFixture(_ => throw new HttpRequestException("no remote fetches expected"));
        var marketplaceManifest = Path.Combine(root, "marketplace-manifest.json");
        await File.WriteAllTextAsync(marketplaceManifest, CreateMarketplaceManifest("0.1.0", defaultRuntime: "dev"));
        var config = CreateConfig(fixture.Paths, shellAutostart: false);
        // defaultEnabled: false — an explicit install is intent in its own right.
        var service = CreateBootstrapService(
            fixture, config, CreateDistribution((MarketplaceBootstrap.AppId, marketplaceManifest, false)));

        await service.InstallAsync(MarketplaceBootstrap.AppId, CancellationToken.None);

        var marketplace = await fixture.Apps.GetAppAsync(MarketplaceBootstrap.AppId);
        Assert.NotNull(marketplace);
        Assert.Equal("running", marketplace!.RuntimeState);
        Assert.Equal(AppInstallOrigins.Distribution, marketplace.InstallOrigin);
    }

    [Fact]
    public async Task InstallAsync_UnknownAppId_Throws()
    {
        var fixture = CreateFixture(_ => throw new HttpRequestException("no remote fetches expected"));
        var marketplaceManifest = Path.Combine(root, "marketplace-manifest.json");
        await File.WriteAllTextAsync(marketplaceManifest, CreateMarketplaceManifest("0.1.0", defaultRuntime: "dev"));
        var config = CreateConfig(fixture.Paths, shellAutostart: false);
        var service = CreateBootstrapService(
            fixture, config, CreateDistribution((MarketplaceBootstrap.AppId, marketplaceManifest, true)));

        var exception = await Assert.ThrowsAsync<AppLifecycleException>(
            () => service.InstallAsync("hosty.unknown", CancellationToken.None));

        Assert.Equal("bootstrap_app_unknown", exception.Code);
    }

    [Fact]
    public async Task InstallAsync_FailedInstall_Throws()
    {
        var fixture = CreateFixture(_ => throw new HttpRequestException("no remote fetches expected"));
        var config = CreateConfig(fixture.Paths, shellAutostart: false);
        var service = CreateBootstrapService(
            fixture, config, CreateDistribution((MarketplaceBootstrap.AppId, Path.Combine(root, "missing-manifest.json"), false)));

        await Assert.ThrowsAnyAsync<Exception>(
            () => service.InstallAsync(MarketplaceBootstrap.AppId, CancellationToken.None));

        Assert.Null(await fixture.Apps.GetAppAsync(MarketplaceBootstrap.AppId));
    }

    [Fact]
    public async Task GetStateAsync_ReportsCatalogEntriesAndInstallState()
    {
        var fixture = CreateFixture(_ => throw new HttpRequestException("no remote fetches expected"));
        var marketplaceManifest = Path.Combine(root, "marketplace-manifest.json");
        await File.WriteAllTextAsync(marketplaceManifest, CreateMarketplaceManifest("0.1.0", defaultRuntime: "dev"));
        var shellManifest = Path.Combine(root, "shell-manifest.json");
        await File.WriteAllTextAsync(shellManifest, CreateShellManifest("0.1.0", "hosty-shell", "local", "never"));
        var config = CreateConfig(fixture.Paths, shellAutostart: false);
        var distribution = CreateDistribution(
            ("hosty.shell", shellManifest, true),
            (MarketplaceBootstrap.AppId, marketplaceManifest, true));
        var service = CreateBootstrapService(fixture, config, distribution);
        await service.InstallAsync("hosty.shell", CancellationToken.None);

        var state = await service.GetStateAsync(CancellationToken.None);

        Assert.Equal(2, state.Apps.Count);
        Assert.NotNull(state.Apps.Single(status => status.Entry.Id == "hosty.shell").Installed);
        Assert.Null(state.Apps.Single(status => status.Entry.Id == MarketplaceBootstrap.AppId).Installed);
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

    private static Task<AppRecord> WaitForAppAsync(AppRegistryStore apps, string appId)
        => WaitForAppAsync(apps, appId, static _ => true);

    // Bootstrap installs an app in two steps the supervisor runs back to back: the install/reconcile
    // itself, then a provenance stamp (InstallOrigin=distribution, System=true) as a separate write.
    // A test that polls for "the app exists" can observe the intermediate, pre-stamp record, so any
    // assertion on the stamped markers must wait for the settled state, not just the record's presence.
    private static async Task<AppRecord> WaitForAppAsync(AppRegistryStore apps, string appId, Func<AppRecord, bool> until)
    {
        var deadline = DateTimeOffset.UtcNow.AddSeconds(5);
        while (DateTimeOffset.UtcNow < deadline)
        {
            var app = await apps.GetAppAsync(appId);
            if (app is not null && until(app))
            {
                return app;
            }

            await Task.Delay(50);
        }

        throw new TimeoutException($"{appId} did not reach the expected state within the timeout.");
    }

    private static async Task WaitForSeedMarkerAsync(TestFixture fixture, Func<DistributionSeedDocument, bool> predicate)
    {
        var deadline = DateTimeOffset.UtcNow.AddSeconds(5);
        while (DateTimeOffset.UtcNow < deadline)
        {
            if (await fixture.Seed.LoadAsync() is { } marker && predicate(marker))
            {
                return;
            }

            await Task.Delay(50);
        }

        throw new TimeoutException("The distribution seed marker did not reach the expected state within the timeout.");
    }

    private static bool IsDistributionStamped(AppRecord app)
        => IsDistributionOrigin(app) && app.System;

    private static bool IsDistributionOrigin(AppRecord app)
        => string.Equals(app.InstallOrigin, AppInstallOrigins.Distribution, StringComparison.Ordinal);

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
        var seed = new DistributionSeedStore(paths, clock, NullLogger<DistributionSeedStore>.Instance);
        var docker = new NoopDockerRuntimeAdapter();
        var lifecycle = new CoreLifecycleService(
            paths,
            apps,
            manifests,
            backups,
            sources,
            [docker, new NoopLocalCommandRuntimeAdapter()],
            new NoopIngressController(),
            Microsoft.Extensions.Logging.Abstractions.NullLogger<CoreLifecycleService>.Instance,
            feedService: new AppFeedService(new HttpClient(new StubHttpMessageHandler(manifestHandler))));
        return new TestFixture(paths, apps, sources, lifecycle, seed, docker);
    }

    private static HostyCoreRuntimeConfig CreateConfig(CoreDataPaths paths, bool shellAutostart)
        => new(
            DataRoot: paths.DataRoot,
            RunDirectory: Path.Combine(paths.CoreRoot, "run"),
            ControlDiscoveryPath: Path.Combine(paths.CoreRoot, "run", "control.json"),
            CorePort: 3001,
            ListenUrl: "http://127.0.0.1:3001",
            CorePublicOrigin: "http://127.0.0.1:3001",
            RuntimePublicHost: "localhost",
            ShellSourceOverridePath: null,
            ShellAutostart: shellAutostart);

    private RuntimeAppSupervisorService CreateSupervisor(
        TestFixture fixture,
        HostyCoreRuntimeConfig config,
        DistributionAppsProvider distribution,
        CoreShutdownOptions? shutdownOptions = null)
        => new(
            config,
            fixture.Apps,
            fixture.Lifecycle,
            CreateBootstrapService(fixture, config, distribution),
            shutdownOptions ?? new CoreShutdownOptions(),
            NullLogger<RuntimeAppSupervisorService>.Instance);

    private static SystemAppBootstrapService CreateBootstrapService(
        TestFixture fixture,
        HostyCoreRuntimeConfig config,
        DistributionAppsProvider distribution)
        => new(
            config,
            fixture.Apps,
            fixture.Lifecycle,
            fixture.Sources,
            distribution,
            fixture.Seed,
            NullLogger<SystemAppBootstrapService>.Instance);

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
              "provides": ["otlp-collector"],
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
        DistributionSeedStore Seed,
        NoopDockerRuntimeAdapter Docker);

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
        public int StopCount { get; private set; }

        public string Type => "docker";

        public Task<AppRuntimeStartResult> StartAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
            => Task.FromResult(new AppRuntimeStartResult("running", []));

        public Task<AppRuntimeOperationResult> StopAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
        {
            StopCount++;
            return Task.FromResult(new AppRuntimeOperationResult("stopped"));
        }

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
