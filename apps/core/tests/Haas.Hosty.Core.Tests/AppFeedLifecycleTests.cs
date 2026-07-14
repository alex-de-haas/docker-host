using System.Net;
using System.Text;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed class AppFeedLifecycleTests
{
    private const string FeedsUrl = "https://apps.example.test/notes/feeds.json";
    private const string MainManifestUrl = "https://apps.example.test/notes/main/manifest.json";
    private const string BetaManifestUrl = "https://apps.example.test/notes/beta/manifest.json";
    private const string NextManifestUrl = "https://apps.example.test/notes/next/manifest.json";

    [Fact]
    public async Task FeedInstallPlanAndApply_UsesSoleDefaultAndPersistsFeedState()
    {
        using var fixture = CreateFixture();
        fixture.Set(FeedsUrl, FeedDocument(MainManifestUrl));
        fixture.Set(MainManifestUrl, Manifest("1.0.0"));

        var plan = await fixture.Lifecycle.CreateFeedInstallPlanAsync(
            new AppFeedInstallPlanRequest(FeedsUrl, Autostart: false));
        var applied = await fixture.Lifecycle.ApplyFeedInstallAsync(new AppFeedInstallApplyRequest(
            FeedsUrl,
            FeedId: null,
            SelectedRuntime: null,
            Settings: null,
            Autostart: false,
            PlanDigest: plan.PlanDigest,
            StartOnInstall: false));

        Assert.Equal("main", plan.FeedId);
        Assert.Equal(MainManifestUrl, plan.ManifestUrl);
        Assert.Equal("com.example.notes", applied.App?.Id);

        var installed = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.NotNull(installed);
        Assert.Equal(FeedsUrl, installed.FeedsUrl);
        Assert.Equal("main", installed.FollowedFeedId);
        Assert.Equal(MainManifestUrl, installed.ManifestUrl);

        var feeds = await fixture.Lifecycle.GetFeedsAsync("com.example.notes");
        Assert.Equal(FeedsUrl, feeds.FeedsUrl);
        Assert.Equal("main", feeds.FollowedFeedId);
        Assert.True(Assert.Single(feeds.Feeds).Default);
    }

    [Fact]
    public async Task FeedInstallApply_RejectsChangedFeedDocumentAfterReview()
    {
        using var fixture = CreateFixture();
        fixture.Set(FeedsUrl, FeedDocument(MainManifestUrl));
        fixture.Set(MainManifestUrl, Manifest("1.0.0"));
        var plan = await fixture.Lifecycle.CreateFeedInstallPlanAsync(new AppFeedInstallPlanRequest(FeedsUrl));

        fixture.Set(FeedsUrl, FeedDocument(MainManifestUrl).Replace("\n}", "\n \n}", StringComparison.Ordinal));

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Lifecycle.ApplyFeedInstallAsync(new AppFeedInstallApplyRequest(
                FeedsUrl, null, null, null, null, plan.PlanDigest, StartOnInstall: false)));

        Assert.Equal("feed_install_plan_digest_mismatch", error.Code);
        Assert.Null(await fixture.Apps.GetAppAsync("com.example.notes"));
    }

    [Fact]
    public async Task FeedInstallApply_RejectsChangedManifestAfterReview()
    {
        using var fixture = CreateFixture();
        fixture.Set(FeedsUrl, FeedDocument(MainManifestUrl));
        fixture.Set(MainManifestUrl, Manifest("1.0.0"));
        var plan = await fixture.Lifecycle.CreateFeedInstallPlanAsync(new AppFeedInstallPlanRequest(FeedsUrl));

        fixture.Set(MainManifestUrl, Manifest("1.1.0"));

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Lifecycle.ApplyFeedInstallAsync(new AppFeedInstallApplyRequest(
                FeedsUrl, null, null, null, null, plan.PlanDigest, StartOnInstall: false)));

        Assert.Equal("feed_install_plan_digest_mismatch", error.Code);
        Assert.Null(await fixture.Apps.GetAppAsync("com.example.notes"));
    }

    [Fact]
    public async Task FeedInstallPlan_RejectsManifestForAnotherApp()
    {
        using var fixture = CreateFixture();
        fixture.Set(FeedsUrl, FeedDocument(MainManifestUrl, appId: "com.example.other"));
        fixture.Set(MainManifestUrl, Manifest("1.0.0"));

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Lifecycle.CreateFeedInstallPlanAsync(new AppFeedInstallPlanRequest(FeedsUrl)));

        Assert.Equal("app_feed_manifest_app_mismatch", error.Code);
    }

    [Fact]
    public async Task FeedSelectionAndUpdatePlan_ReResolveStoredFeedsUrl()
    {
        using var fixture = CreateFixture();
        fixture.Set(FeedsUrl, FeedDocument(MainManifestUrl, BetaManifestUrl));
        fixture.Set(MainManifestUrl, Manifest("1.0.0"));
        fixture.Set(BetaManifestUrl, Manifest("1.1.0"));
        fixture.Set(NextManifestUrl, Manifest("1.2.0"));

        var installPlan = await fixture.Lifecycle.CreateFeedInstallPlanAsync(
            new AppFeedInstallPlanRequest(FeedsUrl, FeedId: "main", Autostart: false));
        await fixture.Lifecycle.ApplyFeedInstallAsync(new AppFeedInstallApplyRequest(
            FeedsUrl, "main", null, null, false, installPlan.PlanDigest, StartOnInstall: false));

        await fixture.Lifecycle.SetFeedAsync("com.example.notes", new AppFeedRequest("beta"));
        var selected = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.Equal("beta", selected?.FollowedFeedId);
        Assert.Equal(BetaManifestUrl, selected?.ManifestUrl);

        fixture.Set(FeedsUrl, FeedDocument(MainManifestUrl, NextManifestUrl));
        var updatePlan = await fixture.Lifecycle.CreateUpdatePlanAsync(
            "com.example.notes",
            new AppUpdatePlanRequest());

        Assert.Equal("1.2.0", updatePlan.TargetVersion);
        Assert.Equal(NextManifestUrl, updatePlan.ManifestPath);

        fixture.Set(FeedsUrl, FeedDocument(MainManifestUrl, BetaManifestUrl));
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Lifecycle.ApplyUpdateAsync(
                "com.example.notes",
                new AppUpdateApplyRequest(updatePlan.PlanDigest)));

        Assert.Equal("update_plan_digest_mismatch", error.Code);
    }

    [Fact]
    public async Task UpdateStatus_DetectsManifestMovementThroughStoredFeed()
    {
        using var fixture = CreateFixture();
        fixture.Set(FeedsUrl, FeedDocument(MainManifestUrl));
        fixture.Set(MainManifestUrl, Manifest("1.0.0"));
        fixture.Set(NextManifestUrl, Manifest("1.1.0"));
        var installPlan = await fixture.Lifecycle.CreateFeedInstallPlanAsync(
            new AppFeedInstallPlanRequest(FeedsUrl, Autostart: false));
        await fixture.Lifecycle.ApplyFeedInstallAsync(new AppFeedInstallApplyRequest(
            FeedsUrl, null, null, null, false, installPlan.PlanDigest, StartOnInstall: false));

        fixture.Set(FeedsUrl, FeedDocument(NextManifestUrl));
        var status = await fixture.Lifecycle.GetUpdateStatusAsync("com.example.notes");

        Assert.True(status.UpdateAvailable);
        Assert.True(status.ManifestUpdateAvailable);
        Assert.False(status.ManifestUnknown);
    }

    [Fact]
    public async Task DirectManifestInstall_RemainsFeedless()
    {
        using var fixture = CreateFixture();
        var manifestPath = Path.Combine(fixture.Root, "manifest.json");
        await File.WriteAllTextAsync(manifestPath, Manifest("1.0.0"));

        await fixture.Lifecycle.InstallAsync(new AppInstallRequest(
            manifestPath,
            Autostart: false,
            StartOnInstall: false));

        var installed = await fixture.Apps.GetAppAsync("com.example.notes");
        Assert.NotNull(installed);
        Assert.Null(installed.FeedsUrl);
        Assert.Null(installed.FollowedFeedId);
        Assert.Null(installed.ManifestUrl);
    }

    private static Fixture CreateFixture()
        => new(Path.Combine(Path.GetTempPath(), $"hosty-feed-lifecycle-tests-{Guid.NewGuid():N}"));

    private static string FeedDocument(
        string mainManifestUrl,
        string? betaManifestUrl = null,
        string appId = "com.example.notes")
    {
        var beta = betaManifestUrl is null
            ? string.Empty
            : $$""", { "id": "beta", "manifestRef": "{{betaManifestUrl}}" }""";
        return $$"""
            {
              "schemaVersion": "app-feeds.0.1",
              "appId": "{{appId}}",
              "feeds": [
                { "id": "main", "manifestRef": "{{mainManifestUrl}}", "default": true }{{beta}}
              ]
            }
            """;
    }

    private static string Manifest(string version)
        => $$"""
            {
              "schemaVersion": "app.0.1",
              "id": "com.example.notes",
              "name": "Notes",
              "version": "{{version}}",
              "runtimeProfiles": [{ "key": "docker", "type": "docker", "default": true }],
              "defaultRuntime": "docker",
              "services": [{
                "key": "app",
                "runtimes": {
                  "docker": {
                    "type": "docker",
                    "image": "ghcr.io/example/notes:{{version}}"
                  }
                }
              }]
            }
            """;

    private sealed class Fixture : IDisposable
    {
        private readonly Dictionary<string, string> documents = new(StringComparer.Ordinal);

        public Fixture(string root)
        {
            Root = root;
            Directory.CreateDirectory(root);
            Paths = new CoreDataPaths(
                DataRoot: root,
                CoreRoot: Path.Combine(root, "core"),
                AppsRoot: Path.Combine(root, "apps"),
                BackupsRoot: Path.Combine(root, "backups"),
                SourcesRoot: Path.Combine(root, "sources"),
                AuthRoot: Path.Combine(root, "core", "auth"),
                AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));
            Apps = new AppRegistryStore(Paths);
            var clock = new TestClock();
            var handler = new StubHttpMessageHandler(Handle);
            var manifests = new AppManifestService(new HttpClient(handler, disposeHandler: false));
            var feeds = new AppFeedService(new HttpClient(handler, disposeHandler: false));
            var backups = new AppBackupService(Paths, clock);
            var sources = new AppSourceService(Paths, Apps, clock);
            Lifecycle = new CoreLifecycleService(
                Paths,
                Apps,
                manifests,
                backups,
                sources,
                [new NoopDockerRuntimeAdapter()],
                new NoopIngressController(),
                NullLogger<CoreLifecycleService>.Instance,
                clock: clock,
                feedService: feeds);
        }

        public string Root { get; }
        public CoreDataPaths Paths { get; }
        public AppRegistryStore Apps { get; }
        public CoreLifecycleService Lifecycle { get; }

        public void Set(string url, string document) => documents[url] = document;

        private HttpResponseMessage Handle(HttpRequestMessage request)
            => documents.TryGetValue(request.RequestUri!.AbsoluteUri, out var document)
                ? new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(document, Encoding.UTF8, "application/json"),
                }
                : new HttpResponseMessage(HttpStatusCode.NotFound);

        public void Dispose()
        {
            if (Directory.Exists(Root))
            {
                Directory.Delete(Root, recursive: true);
            }
        }
    }

    private sealed class StubHttpMessageHandler(Func<HttpRequestMessage, HttpResponseMessage> handler) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => Task.FromResult(handler(request));
    }

    private sealed class TestClock : IClock
    {
        public DateTimeOffset UtcNow { get; } = DateTimeOffset.Parse("2026-07-11T12:00:00Z");
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
            => Task.FromResult(new AppRuntimeLogsResult(string.Empty));

        public Task<AppRuntimeHealthResult> GetHealthAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
            => Task.FromResult(new AppRuntimeHealthResult("unknown", []));
    }
}
