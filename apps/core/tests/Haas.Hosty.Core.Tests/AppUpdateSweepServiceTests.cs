using System.Net;
using System.Text;
using Haas.Hosty.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

// Fleet update sweep (plan-first updates phase 2): one pass builds and caches per-app plans, projects
// availability verdicts into the app summaries, captures per-app failures, and stays single-flight.
public sealed class AppUpdateSweepServiceTests
{
    private const string FeedsUrl = "https://feeds.example.test/notes/feeds.json";
    private const string MainManifestUrl = "https://feeds.example.test/notes/main.json";

    [Fact]
    public async Task RunAsync_ProjectsAvailabilityIntoSummaries()
    {
        using var fixture = CreateFixture();
        fixture.Set(FeedsUrl, FeedDocument(MainManifestUrl));
        fixture.Set(MainManifestUrl, Manifest("1.0.0"));
        await fixture.InstallFromFeedAsync();

        // The feed advances to a new version after install.
        fixture.Set(MainManifestUrl, Manifest("1.1.0"));

        await fixture.Sweep.RunAsync(CancellationToken.None);

        var summary = Assert.Single(await fixture.Lifecycle.ListAppsAsync());
        Assert.NotNull(summary.UpdateCheck);
        Assert.True(summary.UpdateCheck!.UpdateAvailable);
        Assert.False(summary.UpdateCheck.RequiresReview);
        Assert.Null(summary.UpdateCheck.Error);

        // The verdict names the cached pending plan a one-click apply consumes by digest.
        var pending = (await fixture.Lifecycle.GetPendingUpdatePlanAsync("com.example.notes")).Plan;
        Assert.Equal(pending?.PlanDigest, summary.UpdateCheck.PlanDigest);

        var status = fixture.Sweep.Status;
        Assert.False(status.Running);
        Assert.NotNull(status.LastCompletedAt);
    }

    [Fact]
    public async Task RunAsync_SkipsLiveSourceApps()
    {
        using var fixture = CreateFixture();
        var manifestPath = Path.Combine(fixture.Root, "live-app.json");
        await File.WriteAllTextAsync(manifestPath, LiveManifest());
        await fixture.Lifecycle.InstallAsync(new AppInstallRequest(manifestPath, SelectedRuntime: "docker"));
        var app = await fixture.Apps.GetAppAsync("com.example.live");
        await fixture.Apps.UpsertAppAsync(app! with { SelectedRuntime = "local" });

        await fixture.Sweep.RunAsync(CancellationToken.None);

        // A live-source app has no reviewed-update path: the sweep leaves it unchecked.
        var summary = Assert.Single(await fixture.Lifecycle.ListAppsAsync());
        Assert.True(summary.Live);
        Assert.Null(summary.UpdateCheck);
    }

    [Fact]
    public async Task RunAsync_CapturesPerAppFailuresWithoutFailingTheSweep()
    {
        using var fixture = CreateFixture();
        fixture.Set(FeedsUrl, FeedDocument(MainManifestUrl));
        fixture.Set(MainManifestUrl, Manifest("1.0.0"));
        await fixture.InstallFromFeedAsync();

        // A second, healthy app installed from a plain manifest file.
        var healthyPath = Path.Combine(fixture.Root, "healthy.json");
        await File.WriteAllTextAsync(healthyPath, Manifest("1.0.0", id: "com.example.healthy"));
        await fixture.Lifecycle.InstallAsync(new AppInstallRequest(healthyPath));

        // The feed goes dark: that app's check fails, the other app's still succeeds.
        fixture.Remove(FeedsUrl);

        await fixture.Sweep.RunAsync(CancellationToken.None);

        var summaries = await fixture.Lifecycle.ListAppsAsync();
        var broken = summaries.Single(app => app.Id == "com.example.notes");
        Assert.NotNull(broken.UpdateCheck);
        Assert.NotNull(broken.UpdateCheck!.Error);
        Assert.False(broken.UpdateCheck.UpdateAvailable);

        var healthy = summaries.Single(app => app.Id == "com.example.healthy");
        Assert.NotNull(healthy.UpdateCheck);
        Assert.Null(healthy.UpdateCheck!.Error);

        Assert.NotNull(fixture.Sweep.Status.LastCompletedAt);
    }

    [Fact]
    public async Task Trigger_JoinsTheSweepAlreadyInFlight()
    {
        using var fixture = CreateFixture();
        fixture.Set(FeedsUrl, FeedDocument(MainManifestUrl));
        fixture.Set(MainManifestUrl, Manifest("1.0.0"));
        await fixture.InstallFromFeedAsync();

        // Block the feed fetch so the sweep is deterministically "in flight".
        var release = new TaskCompletionSource();
        fixture.BlockOn(FeedsUrl, release.Task);

        var first = fixture.Sweep.RunAsync(CancellationToken.None);
        Assert.True(fixture.Sweep.Status.Running);

        // A concurrent manual trigger joins rather than starting a second sweep, and the scheduler
        // path returns the same in-flight task.
        var trigger = fixture.Sweep.Trigger();
        Assert.False(trigger.Started);
        Assert.True(trigger.Status.Running);
        Assert.Same(first, fixture.Sweep.RunAsync(CancellationToken.None));

        release.SetResult();
        await first;
        Assert.False(fixture.Sweep.Status.Running);
        Assert.NotNull(fixture.Sweep.Status.LastCompletedAt);
    }

    private static Fixture CreateFixture()
        => new(Path.Combine(Path.GetTempPath(), $"hosty-update-sweep-tests-{Guid.NewGuid():N}"));

    private static string FeedDocument(string mainManifestUrl, string appId = "com.example.notes") => $$"""
        {
          "schemaVersion": "app-feeds.0.1",
          "appId": "{{appId}}",
          "feeds": [
            { "id": "main", "manifestRef": "{{mainManifestUrl}}", "default": true }
          ]
        }
        """;

    private static string Manifest(string version, string id = "com.example.notes") => $$"""
        {
          "schemaVersion": "app.0.1",
          "id": "{{id}}",
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

    private static string LiveManifest() => """
        {
          "schemaVersion": "app.0.1",
          "id": "com.example.live",
          "name": "Live App",
          "version": "1.0.0",
          "runtimeProfiles": [
            { "key": "docker", "type": "docker", "default": true },
            { "key": "local", "type": "localCommand", "development": true }
          ],
          "defaultRuntime": "docker",
          "services": [{
            "key": "app",
            "runtimes": {
              "docker": { "type": "docker", "image": "ghcr.io/example/live:1.0.0" },
              "local": { "type": "localCommand", "command": "sleep 5", "workingDirectory": "." }
            }
          }]
        }
        """;

    private sealed class Fixture : IDisposable
    {
        private readonly Dictionary<string, string> documents = new(StringComparer.Ordinal);
        private readonly Dictionary<string, Task> blocks = new(StringComparer.Ordinal);

        public Fixture(string root)
        {
            Root = root;
            Directory.CreateDirectory(root);
            var paths = new CoreDataPaths(
                DataRoot: root,
                CoreRoot: Path.Combine(root, "core"),
                AppsRoot: Path.Combine(root, "apps"),
                BackupsRoot: Path.Combine(root, "backups"),
                SourcesRoot: Path.Combine(root, "sources"),
                AuthRoot: Path.Combine(root, "core", "auth"),
                AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));
            Apps = new AppRegistryStore(paths);
            var clock = new TestClock();
            var handler = new StubHttpMessageHandler(HandleAsync);
            var manifests = new AppManifestService(new HttpClient(handler, disposeHandler: false));
            var feeds = new AppFeedService(new HttpClient(handler, disposeHandler: false));
            var backups = new AppBackupService(paths, clock);
            var sources = new AppSourceService(paths, Apps, clock);
            Lifecycle = new CoreLifecycleService(
                paths,
                Apps,
                manifests,
                backups,
                sources,
                [new NoopDockerRuntimeAdapter()],
                new NoopIngressController(),
                NullLogger<CoreLifecycleService>.Instance,
                clock: clock,
                feedService: feeds);
            Sweep = new AppUpdateSweepService(Lifecycle, clock, NullLogger<AppUpdateSweepService>.Instance);
        }

        public string Root { get; }
        public AppRegistryStore Apps { get; }
        public CoreLifecycleService Lifecycle { get; }
        public AppUpdateSweepService Sweep { get; }

        public void Set(string url, string document) => documents[url] = document;

        public void Remove(string url) => documents.Remove(url);

        // The next fetches of this URL wait for `gate` before answering, so a test can hold a sweep
        // deterministically "in flight".
        public void BlockOn(string url, Task gate) => blocks[url] = gate;

        public async Task InstallFromFeedAsync()
        {
            var plan = await Lifecycle.CreateFeedInstallPlanAsync(new AppFeedInstallPlanRequest(FeedsUrl, Autostart: false));
            _ = await Lifecycle.ApplyFeedInstallAsync(new AppFeedInstallApplyRequest(
                FeedsUrl,
                FeedId: null,
                SelectedRuntime: null,
                Settings: null,
                Autostart: false,
                PlanDigest: plan.PlanDigest,
                StartOnInstall: false));
        }

        private async Task<HttpResponseMessage> HandleAsync(HttpRequestMessage request)
        {
            var url = request.RequestUri!.AbsoluteUri;
            if (blocks.TryGetValue(url, out var gate))
            {
                await gate;
            }

            return documents.TryGetValue(url, out var document)
                ? new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(document, Encoding.UTF8, "application/json"),
                }
                : new HttpResponseMessage(HttpStatusCode.NotFound);
        }

        public void Dispose()
        {
            if (Directory.Exists(Root))
            {
                Directory.Delete(Root, recursive: true);
            }
        }
    }

    private sealed class StubHttpMessageHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> handler) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => handler(request);
    }

    private sealed class TestClock : IClock
    {
        public DateTimeOffset UtcNow => DateTimeOffset.UtcNow;
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
