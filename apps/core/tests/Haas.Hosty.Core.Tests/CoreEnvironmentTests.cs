using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class CoreEnvironmentTests
{
    [Fact]
    public async Task Create_ReplayAndCrossOwner_KeepIndependentRootsWithoutWorkspace()
    {
        using var f = new Fixture(); var input = new CoreEnvironmentCreate(Guid.NewGuid().ToString(), "QA");
        var first = await f.Service.CreateAsync(f.Actor, input, default);
        var replay = await f.Service.CreateAsync(f.Actor, input, default);
        Assert.Equal(first.Id, replay.Id); Assert.Null(first.Context);
        Assert.Equal(first.Id, File.ReadAllText(CoreInstanceId.BuildPath(first.DataRoot!)));
        Assert.Contains("\"apps\":[]", File.ReadAllText(Path.Combine(first.DataRoot!, "core/distribution-apps.json")));
        var other = await f.Service.CreateAsync(new("someone", "qa.client", DateTimeOffset.UnixEpoch), input, default);
        Assert.NotEqual(first.Id, other.Id); Assert.NotEqual(first.Port, other.Port);
        await Assert.ThrowsAsync<SandboxException>(() => f.Service.ReadAsync(new("someone", "qa.client", DateTimeOffset.UnixEpoch), first.Id, default));
        await Assert.ThrowsAsync<SandboxException>(() => f.Service.CreateAsync(f.Actor, input with { Label = "changed" }, default));
    }
    [Fact]
    public async Task Lifecycle_StopPreservesData_FinishRemovesOwnedRootAndPreservesBorrowedDirectory()
    {
        using var f = new Fixture(); var item = await f.Create();
        var outside = Path.Combine(f.Root, "borrowed"); Directory.CreateDirectory(outside); File.WriteAllText(Path.Combine(outside, "keep"), "test source");
        Directory.CreateSymbolicLink(Path.Combine(item.DataRoot!, "source"), outside);
        File.WriteAllText(Path.Combine(item.DataRoot!, "fixture"), "synthetic");
        item = await f.Command(item, "start"); Assert.Equal("running", item.State);
        item = await f.Command(item, "stop"); Assert.Equal("stopped", item.State);
        Assert.True(File.Exists(Path.Combine(item.DataRoot!, "fixture")));
        var root = item.DataRoot;
        item = await f.Command(item, "finish"); Assert.Equal("finished", item.State); Assert.Null(item.DataRoot);
        Assert.False(Directory.Exists(root)); Assert.True(File.Exists(Path.Combine(outside, "keep")));
        Assert.Contains(true, f.Runtime.Removals);
    }
    [Fact]
    public async Task Lifecycle_ReplayDoesNotRepeatSpawn_RevisionAndArgumentsAreChecked()
    {
        using var f = new Fixture(); var item = await f.Create();
        var input = new CoreEnvironmentCommand(Guid.NewGuid().ToString(), item.Revision);
        item = await f.Service.CommandAsync(f.Actor, item.Id, "start", input, default);
        await f.Service.CommandAsync(f.Actor, item.Id, "start", input, default);
        Assert.Equal(1, f.Runtime.Starts);
        await Assert.ThrowsAsync<SandboxException>(() => f.Service.CommandAsync(f.Actor, item.Id, "stop", input, default));
        await Assert.ThrowsAsync<SandboxException>(() => f.Service.CommandAsync(f.Actor, item.Id, "stop", input with { RequestId = Guid.NewGuid().ToString() }, default));
    }
    [Fact]
    public async Task Finish_FailedCleanup_RetainsDataUntilExplicitRetrySucceeds()
    {
        using var f = new Fixture(); var item = await f.Create(); f.Runtime.FailStop = true;
        item = await f.Command(item, "finish"); Assert.Equal("cleanup-failed", item.State); Assert.True(Directory.Exists(item.DataRoot));
        Assert.Equal("failed", item.Operations.Last().State);
        f.Runtime.FailStop = false; item = await f.Command(item, "finish");
        Assert.Equal("finished", item.State);
    }
    [Fact]
    public async Task Restart_BuildFails_DoesNotStopExistingCore()
    {
        using var f = new Fixture(); var item = await f.Command(await f.Create(), "start");
        f.Runtime.FailBuild = true;
        item = await f.Command(item, "restart");
        Assert.Equal("failed", item.State); Assert.Empty(f.Runtime.Removals); Assert.NotNull(item.Process);
        Assert.Equal("running", (await f.Service.ReadAsync(f.Actor, item.Id, default)).State);
    }
    [Fact]
    public async Task Shutdown_KeepAppsAdopts_NormalStopClosesAdmissionAndPreservesRoots()
    {
        using var f = new Fixture(); var first = await f.Command(await f.Create(), "start");
        await f.Service.ShutdownAsync(true, default); Assert.Empty(f.Runtime.Removals);
        var replacement = new CoreEnvironmentService(f.Store, f.Runtime, new Clock()); await replacement.ReconcileAsync(default);
        Assert.Equal("running", (await replacement.ReadAsync(f.Actor, first.Id, default)).State);
        await replacement.ShutdownAsync(false, default); Assert.Equal([false], f.Runtime.Removals);
        Assert.True(Directory.Exists(first.DataRoot));
        await Assert.ThrowsAsync<SandboxException>(() => replacement.CreateAsync(f.Actor, new(Guid.NewGuid().ToString(), "closed"), default));
    }
    [Fact]
    public async Task Recovery_InterruptedOperation_IsVisibleAndCanBeFinished()
    {
        using var f = new Fixture(); var item = await f.Create(); var record = (await f.Store.ReadAsync(item.Id, default))!;
        await f.Store.WriteAsync(record with { State = "starting", Operations = [new("old", "start", "fingerprint", "running")] }, default);
        await f.Service.ReconcileAsync(default); item = await f.Service.ReadAsync(f.Actor, item.Id, default);
        Assert.Equal("failed", item.Operations.Single().State); Assert.NotNull(item.Error);
        item = await f.Command(item, "finish"); Assert.Equal("finished", item.State);
    }
    [Fact]
    public async Task Finish_ChangedRootIdentity_DoesNotDeleteOrStopAnything()
    {
        using var f = new Fixture(); var item = await f.Create(); File.WriteAllText(CoreInstanceId.BuildPath(item.DataRoot!), new string('a', 32));
        item = await f.Command(item, "finish"); Assert.Equal("cleanup-failed", item.State);
        Assert.Empty(f.Runtime.Removals); Assert.True(Directory.Exists(item.DataRoot));
    }
    [Fact]
    public async Task Recovery_BrokenRoot_DoesNotPreventOtherChildrenFromReconciling()
    {
        using var f = new Fixture(); var broken = await f.Create(); var healthy = await f.Create();
        File.WriteAllText(CoreInstanceId.BuildPath(broken.DataRoot!), new string('a', 32));
        var record = (await f.Store.ReadAsync(healthy.Id, default))!;
        await f.Store.WriteAsync(record with { Operations = [new("old", "start", "hash", "running")] }, default);
        await f.Service.ReconcileAsync(default);
        Assert.Equal("failed", (await f.Store.ReadAsync(broken.Id, default))!.State);
        Assert.Equal("failed", (await f.Store.ReadAsync(healthy.Id, default))!.Operations!.Single().State);
    }
    [Fact]
    public async Task Finish_RemainsAvailableWhenOperationJournalIsFull()
    {
        using var f = new Fixture(); var item = await f.Create(); var record = (await f.Store.ReadAsync(item.Id, default))!;
        await f.Store.WriteAsync(record with { Operations = Enumerable.Range(0, 1024)
            .Select(i => new CoreEnvironmentOperation(i.ToString(), "stop", "hash", "succeeded")).ToArray() }, default);
        item = await f.Command(item, "finish");
        Assert.Equal("finished", item.State);
    }
    [Fact]
    public async Task Inventory_ObservesAChildThatExitedWithoutAParentCommand()
    {
        using var f = new Fixture(); var item = await f.Command(await f.Create(), "start");
        f.Runtime.ExitAll();
        var observed = (await f.Service.ListAsync(f.Actor, default)).Environments.Single();
        Assert.Equal("stopped", observed.State); Assert.Null(observed.Process);
        Assert.Equal("stopped", (await f.Store.ReadAsync(item.Id, default))!.State);
    }
    [Fact]
    public async Task Inventory_RemainsAvailableDuringALongBuild()
    {
        using var f = new Fixture(); var item = await f.Create();
        f.Runtime.Preparation = new(TaskCreationOptions.RunContinuationsAsynchronously);
        var start = f.Command(item, "start");
        await f.Runtime.PreparationStarted.Task.WaitAsync(TimeSpan.FromSeconds(5));
        try
        {
            var observed = await f.Service.ReadAsync(f.Actor, item.Id, default).WaitAsync(TimeSpan.FromSeconds(2));
            Assert.Equal("starting", observed.State);
            Assert.Equal("running", observed.Operations.Last().State);
            var list = await f.Service.ListAsync(f.Actor, default).WaitAsync(TimeSpan.FromSeconds(2));
            Assert.Equal("starting", list.Environments.Single().State);
            await Assert.ThrowsAsync<SandboxException>(() => f.Service.ReadAsync(new("other", "qa.client", DateTimeOffset.UnixEpoch), item.Id, default));
        }
        finally { f.Runtime.Preparation.SetResult("prepared"); await start; }
    }
    [Fact]
    public void ApplicationPreview_UsesInstallationBoundCoreNavigationAndDoesNotExposeChildPayload()
    {
        using var json = System.Text.Json.JsonDocument.Parse("""
            {"id":"demo.app","displayName":"Demo","runtimeState":"running","health":{"status":"healthy"},
             "embeddedUrl":"http://demo.test/","installationId":"installed","entryEndpoint":"web","entryPath":"/view?one=two",
             "settings":{"password":"never-expose"}}
            """);
        var app = CoreEnvironmentAccess.ProjectApp(json.RootElement, "http://core.test");
        var url = new Uri(app.PreviewUrl!);
        Assert.Equal("/api/apps/demo.app/open", url.AbsolutePath);
        var query = Microsoft.AspNetCore.WebUtilities.QueryHelpers.ParseQuery(url.Query);
        Assert.Equal("installed", query["installationId"]);
        Assert.Equal("web", query["endpoint"]); Assert.Equal("/view?one=two", query["route"]);
        Assert.Equal("healthy", app.Health);
        Assert.DoesNotContain("never-expose", CoreJson.Text(app));
        using var headless = System.Text.Json.JsonDocument.Parse("""{"id":"worker","runtimeState":"running"}""");
        Assert.Null(CoreEnvironmentAccess.ProjectApp(headless.RootElement, "http://core.test").PreviewUrl);
    }
    [Fact]
    public void ProcessIdentity_DoesNotAcceptReusedPid()
    {
        using var process = System.Diagnostics.Process.GetCurrentProcess();
        Assert.True(CoreEnvironmentRuntime.Alive(new(process.Id, process.StartTime.ToUniversalTime())));
        Assert.False(CoreEnvironmentRuntime.Alive(new(process.Id, DateTimeOffset.UnixEpoch)));
    }
    [Fact]
    public async Task NestedAdmission_SharesCapacityAcrossServicesAndRestart_FinishReleasesIt()
    {
        using var f = new Fixture();
        var child = await f.Create();
        var config = new HostyCoreRuntimeConfig(child.DataRoot!, child.DataRoot!, "", 7070, "http://localhost:7070", null, "localhost", null, false);
        var childStore = new CoreEnvironmentStore(CoreDataPaths.FromConfig(config));
        var nested = new CoreEnvironmentService(childStore, f.Runtime, new Clock());
        // Independent service/store instances contend on the on-disk root reservation.
        var replacement = new CoreEnvironmentService(f.Store, f.Runtime, new Clock());
        async Task<CoreEnvironmentView?> TryCreate(CoreEnvironmentService service)
        {
            try { return await service.CreateAsync(f.Actor, new(Guid.NewGuid().ToString(), "Concurrent"), default); }
            catch (SandboxException ex) { Assert.Equal("environment_capacity", ex.Code); return null; }
        }
        var results = await Task.WhenAll(TryCreate(nested), TryCreate(replacement));
        var allocated = Assert.Single(results, r => r is not null)!;
        Assert.Single(results, r => r is null);
        var owner = (await childStore.ListAsync(default)).Any(r => r.Id == allocated.Id) ? nested : replacement;
        var restart = new CoreEnvironmentService(childStore, f.Runtime, new Clock());
        Assert.Null(await TryCreate(restart));
        var finished = await owner.CommandAsync(f.Actor, allocated.Id, "finish", new(Guid.NewGuid().ToString(), allocated.Revision), default);
        Assert.Equal("finished", finished.State);
        var grandchild = await restart.CreateAsync(f.Actor, new(Guid.NewGuid().ToString(), "Nested"), default);
        Assert.NotEqual(child.Port, grandchild.Port);
        var deeperConfig = config with { DataRoot = grandchild.DataRoot! };
        var deeper = new CoreEnvironmentService(new(CoreDataPaths.FromConfig(deeperConfig)), f.Runtime, new Clock());
        Assert.Null(await TryCreate(deeper));
        // Parent Finish removes its entire owned subtree and restores the root budget.
        Assert.Equal("finished", (await f.Command(child, "finish")).State);
        Assert.False(Directory.Exists(grandchild.DataRoot));
        Assert.NotNull(await TryCreate(replacement));
        Assert.NotNull(await TryCreate(replacement));
    }
    [Fact]
    public async Task OperatorAccess_AllowsOwnAppsButRejectsAnotherAdministratorsEnvironments()
    {
        using var f = new Fixture(); var item = await f.Create();
        var owner = new SandboxActor(f.Actor.UserId);
        var other = new SandboxActor("another-admin");
        Assert.Equal(item.Id, (await f.Service.ReadAsync(owner, item.Id, default)).Id);
        Assert.Single((await f.Service.ListAsync(owner, default)).Environments);
        Assert.Empty((await f.Service.ListAsync(other, default)).Environments);
        Assert.Equal("environment_forbidden", (await Assert.ThrowsAsync<SandboxException>(
            () => f.Service.ReadAsync(other, item.Id, default))).Code);
        foreach (var kind in new[] { "start", "stop", "restart", "finish" })
            await Assert.ThrowsAsync<SandboxException>(() => f.Service.CommandAsync(other, item.Id, kind,
                new(Guid.NewGuid().ToString(), item.Revision), default));
        var access = new CoreEnvironmentAccess(f.Store, f.Service);
        await Assert.ThrowsAsync<SandboxException>(() => access.SetupAsync(other, item.Id,
            new("other@example.test", "Other", "unused-password"), default));
        await Assert.ThrowsAsync<SandboxException>(() => access.SendAsync(other, item.Id, new("GET", "/api/apps"), default));
        Assert.Empty(f.Runtime.Removals); Assert.True(Directory.Exists(item.DataRoot));
        Assert.Equal("finished", (await f.Service.CommandAsync(owner, item.Id, "finish",
            new(Guid.NewGuid().ToString(), item.Revision), default)).State);
    }
    private sealed class Clock : IClock { public DateTimeOffset UtcNow => DateTimeOffset.UtcNow; }
    private sealed class Fixture : IDisposable
    {
        public string Root { get; } = Path.Combine(Path.GetTempPath(), "hosty-environment-test-" + Guid.NewGuid().ToString("N"));
        public SandboxActor Actor { get; } = new("admin", "qa.client", DateTimeOffset.UnixEpoch);
        public FakeRuntime Runtime { get; } = new();
        public CoreEnvironmentStore Store { get; }
        public CoreEnvironmentService Service { get; }
        public Fixture()
        {
            var config = new HostyCoreRuntimeConfig(Root, Root, "", 7070, "http://localhost:7070", null, "localhost", null, false);
            Store = new(CoreDataPaths.FromConfig(config)); Service = new(Store, Runtime, new Clock());
        }
        public Task<CoreEnvironmentView> Create() => Service.CreateAsync(Actor, new(Guid.NewGuid().ToString(), "QA"), default);
        public Task<CoreEnvironmentView> Command(CoreEnvironmentView item, string kind)
            => Service.CommandAsync(Actor, item.Id, kind, new(Guid.NewGuid().ToString(), item.Revision), default);
        public void Dispose() { if (Directory.Exists(Root)) Directory.Delete(Root, true); }
    }
    private sealed class FakeRuntime : ICoreEnvironmentRuntime
    {
        public void ExitAll() => live.Clear();
        public int Starts; public bool FailStop; public bool FailBuild; public List<bool> Removals = [];
        private readonly Dictionary<string, CoreEnvironmentProcess> live = [];
        public TaskCompletionSource<string>? Preparation;
        public TaskCompletionSource PreparationStarted = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public Task<string> PrepareAsync(CoreEnvironmentRecord record, string root, CancellationToken ct)
        { PreparationStarted.TrySetResult(); return FailBuild ? throw new IOException("Build failed") : Preparation?.Task ?? Task.FromResult("prepared-core"); }
        public Task<CoreEnvironmentProcess?> ObserveAsync(CoreEnvironmentRecord record, string root, CancellationToken ct)
            => Task.FromResult(live.GetValueOrDefault(record.Id));
        public async Task StartAsync(CoreEnvironmentRecord record, string root, Func<CoreEnvironmentProcess, Task> save, CancellationToken ct)
        { Starts++; var process = new CoreEnvironmentProcess(1234567, DateTimeOffset.UtcNow); live[record.Id] = process; await save(process); }
        public Task StopAsync(CoreEnvironmentRecord record, string root, bool remove, CancellationToken ct)
        { if (FailStop) throw new IOException("Docker unavailable"); Removals.Add(remove); live.Remove(record.Id); return Task.CompletedTask; }
    }
}
