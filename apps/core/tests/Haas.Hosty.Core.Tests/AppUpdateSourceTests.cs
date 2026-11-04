using Haas.Hosty.Launch;

namespace Haas.Hosty.Core.Tests;

public sealed partial class AppFeedLifecycleTests
{
    private const string MigrationFeed = "https://publisher.test/apps/notes/feeds.json";
    private const string MigrationManifest = "https://publisher.test/releases/abc/manifest.json";
    private const string NotesId = "com.example.notes";

    private static async Task<Fixture> MigrationFixture()
    {
        var fixture = new Fixture(Path.Combine(Path.GetTempPath(), "hosty-source-test-" + Guid.NewGuid().ToString("N")), new ReadyAdapter());
        fixture.Set(MainManifestUrl, Manifest("2.0.0"));
        await fixture.Lifecycle.InstallAsync(new(MainManifestUrl, StartOnInstall: false, Autostart: false));
        fixture.Set(MigrationFeed, FeedDocument(MigrationManifest).Replace("\"main\"", "\"publisher-candidate\""));
        fixture.Set(MigrationManifest, Manifest("1.0.0").Replace("app.0.1", "app.0.2")
            .Replace("\"ghcr.io/example/notes:1.0.0\"", "{\"repository\":\"ghcr.io/example/notes\",\"digest\":\"sha256:" + new string('a', 64) + "\"}"));
        return fixture;
    }

    [Fact]
    public async Task SourceSwitchIsBindingOnlyAndDurablyReplaysTheExactRequest()
    {
        using var fixture = await MigrationFixture();
        var before = (await fixture.Apps.GetAppAsync(NotesId))!;
        var plan = await fixture.Lifecycle.PlanUpdateSourceAsync(NotesId, new(MigrationFeed, "publisher-candidate"));
        Assert.Equal("installed-ahead", plan.Ordering);
        var id = Guid.NewGuid().ToString("N");
        var operation = await fixture.Lifecycle.ApplyUpdateSourceAsync(NotesId, new(plan.PlanDigest, id));
        Assert.Equal("completed", operation.Status);
        Assert.Equal(MainManifestUrl, operation.Previous.ManifestUrl);
        var after = (await fixture.Apps.GetAppAsync(NotesId))!;
        Assert.Equal(before.Version, after.Version);
        Assert.Equal(before.RuntimeState, after.RuntimeState);
        Assert.Equal(before.GrantedCorePermissions, after.GrantedCorePermissions);
        Assert.Equal(before.ArtifactLocks, after.ArtifactLocks);
        Assert.Equal(MigrationFeed, after.FeedsUrl);
        Assert.Equal("publisher-candidate", after.FollowedFeedId);
        fixture.Clock.UtcNow += TimeSpan.FromDays(1);
        Assert.Equal(operation, await fixture.Lifecycle.ApplyUpdateSourceAsync(NotesId, new(plan.PlanDigest, id)));
        Assert.Equal(operation, fixture.Lifecycle.GetUpdateSourceOperation(NotesId, id));
        Assert.Equal("update_source_request_conflict", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Lifecycle.ApplyUpdateSourceAsync(NotesId, new(new string('b', 64), id)))).Code);
        var back = await fixture.Lifecycle.PlanUpdateSourceAsync(NotesId, new(ManifestUrl: operation.Previous.ManifestUrl));
        await fixture.Lifecycle.ApplyUpdateSourceAsync(NotesId, new(back.PlanDigest, Guid.NewGuid().ToString("N")));
        var returned = (await fixture.Apps.GetAppAsync(NotesId))!;
        Assert.Null(returned.FeedsUrl);
        Assert.Equal(MainManifestUrl, returned.ManifestUrl);
        Assert.Equal(before.Version, returned.Version);
    }

    [Fact]
    public async Task SourceSwitchRejectsMovedDestinationAndChangedInstalledRevision()
    {
        using var fixture = await MigrationFixture();
        var plan = await fixture.Lifecycle.PlanUpdateSourceAsync(NotesId, new(MigrationFeed, "publisher-candidate"));
        fixture.Set(MigrationFeed, FeedDocument(MigrationManifest).Replace("\"main\"", "\"publisher-candidate\"") + "\n");
        Assert.Equal("update_source_plan_stale", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Lifecycle.ApplyUpdateSourceAsync(NotesId, new(plan.PlanDigest, Guid.NewGuid().ToString("N"))))).Code);
        Assert.Null((await fixture.Apps.GetAppAsync(NotesId))!.FeedsUrl);
        var fresh = await fixture.Lifecycle.PlanUpdateSourceAsync(NotesId, new(MigrationFeed, "publisher-candidate"));
        await fixture.Apps.UpdateAppAsync(NotesId, app => app with { UpdateSourceRevision = "another-operator" });
        Assert.Equal("update_source_plan_stale", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Lifecycle.ApplyUpdateSourceAsync(NotesId, new(fresh.PlanDigest, Guid.NewGuid().ToString("N"))))).Code);
    }

    [Fact]
    public async Task SourceSwitchRecoversRegistryWriteBeforeCompletionReceipt()
    {
        using var fixture = await MigrationFixture();
        var plan = await fixture.Lifecycle.PlanUpdateSourceAsync(NotesId, new(MigrationFeed, "publisher-candidate"));
        var id = Guid.NewGuid().ToString("N");
        CoreLaunchFiles.Write(Path.Combine(fixture.Paths.CoreRoot, "update-source", "operations", id + ".json"),
            new AppUpdateSourceOperation(id, NotesId, plan.PlanDigest, "prepared", plan.From, plan.To), CoreJsonSerializerContext.Default.AppUpdateSourceOperation);
        await fixture.Apps.UpdateAppAsync(NotesId, app => app with { ManifestUrl = plan.To.ManifestUrl,
            FeedsUrl = plan.To.FeedsUrl, FollowedFeedId = plan.To.FeedId, UpdateSourceRevision = id });
        fixture.Clock.UtcNow += TimeSpan.FromDays(1);
        Assert.Equal("completed", (await fixture.Lifecycle.ApplyUpdateSourceAsync(NotesId, new(plan.PlanDigest, id))).Status);
    }

    [Fact]
    public async Task BatchRetainsIndependentOutcomesAndRejectsReboundRequest()
    {
        using var fixture = await MigrationFixture();
        var plan = await fixture.Lifecycle.PlanUpdateSourceAsync(NotesId, new(MigrationFeed, "publisher-candidate"));
        var batch = new AppUpdateSourceBatchRequest(Guid.NewGuid().ToString("N"), [new(NotesId, plan.PlanDigest), new("missing.app", new string('c', 64))]);
        var results = await Task.WhenAll(fixture.Lifecycle.ApplyUpdateSourceBatchAsync(batch), fixture.Lifecycle.ApplyUpdateSourceBatchAsync(batch));
        foreach (var result in results)
        {
            Assert.Equal("completed", result.Results[0].Operation!.Status);
            Assert.NotNull(result.Results[1].ErrorCode);
        }
        Assert.Equal("update_source_request_conflict", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            fixture.Lifecycle.ApplyUpdateSourceBatchAsync(batch with { Items = [new(NotesId, new string('d', 64))] }))).Code);
    }

    [Fact]
    public async Task DestinationIdentityCannotReplaceTheReviewedApplication()
    {
        using var fixture = await MigrationFixture();
        fixture.Set(MigrationFeed, FeedDocument(MigrationManifest, appId: "unrelated.app").Replace("\"main\"", "\"publisher-candidate\""));
        await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Lifecycle.PlanUpdateSourceAsync(NotesId, new(MigrationFeed, "publisher-candidate")));
        Assert.Null((await fixture.Apps.GetAppAsync(NotesId))!.FeedsUrl);
    }

    private sealed class ReadyAdapter : IAppRuntimeAdapter, IImageDigestResolver
    {
        public string Type => "docker";
        public Task<string?> ResolveRemoteDigestAsync(RuntimeDockerImage image, CancellationToken cancellationToken = default)
            => Task.FromResult<string?>(image.Digest ?? "sha256:" + new string('b', 64));
        public Task<AppRuntimeStartResult> StartAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
            => throw new InvalidOperationException("A source switch must never start an application.");
        public Task<AppRuntimeOperationResult> StopAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
            => throw new InvalidOperationException("A source switch must never stop an application.");
        public Task<AppRuntimeOperationResult> RemoveAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
            => throw new InvalidOperationException("A source switch must never remove an application.");
        public Task<AppRuntimeLogsResult> GetLogsAsync(RuntimeLifecycleContext context, int tail, CancellationToken cancellationToken = default)
            => Task.FromResult(new AppRuntimeLogsResult(""));
        public Task<AppRuntimeHealthResult> GetHealthAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
            => Task.FromResult(new AppRuntimeHealthResult("stopped", []));
    }
}
