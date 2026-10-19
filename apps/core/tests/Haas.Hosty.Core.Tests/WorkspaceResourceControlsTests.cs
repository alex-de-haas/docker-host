using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task ResourceControls_PreserveDataFenceNewStartsAndRecoverFinishWithoutDiscardingSource()
    {
        var (f, _) = await SourceFixtureAsync();
        var workspaces = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = ExternalOwner(); var tree = await workspaces.PrepareAsync(owner, ExternalPrepare(), default);
        var inspection = new WorkspaceInspectionService(workspaces, f.Apps, f.Clock);
        var store = new CoreEnvironmentStore(f.Paths); var runtime = new ResourceControlRuntime();
        var environments = new CoreEnvironmentService(store, runtime, f.Clock, workspaces);
        var controls = new WorkspaceCleanupService(f.Paths, inspection, workspaces, null!, f.Apps, store, environments,
            new(store, environments), null!, null!, null!);
        var app = (await f.Apps.GetAppAsync(SourceTestApp))!;
        await f.Apps.UpsertAppAsync(app with { GrantedCorePermissions = [CoreAppPermissions.CoreEnvironmentsManage, CoreAppPermissions.Sources] });
        var child = await environments.CreateAsync(new("admin"), new(Guid.NewGuid().ToString(), "Retained test data",
            Context: new(WorkspaceId: tree.WorkspaceId), WorktreeIds: [tree.Id]), default);
        Assert.True((await inspection.ReadAsync(tree.WorkspaceId, tree.Id, "admin", default)).HasSandboxConsumers);
        var sentinel = Path.Combine(child.DataRoot!, "sentinel"); await File.WriteAllTextAsync(sentinel, "keep data");
        var source = Path.Combine(tree.Path, "unfinished.txt"); await File.WriteAllTextAsync(source, "keep source");
        var start = new CoreEnvironmentCommand(Guid.NewGuid().ToString(), child.Revision);
        child = await controls.EnvironmentCommandAsync(tree.WorkspaceId, "admin", SourceTestApp, child.Id, "start", start, default);
        Assert.Equal("running", child.State); Assert.Equal(1, runtime.Starts);
        child = await controls.EnvironmentCommandAsync(tree.WorkspaceId, "admin", SourceTestApp, child.Id, "stop", new(Guid.NewGuid().ToString(), child.Revision), default);
        Assert.Equal("stopped", child.State); Assert.Equal("keep data", await File.ReadAllTextAsync(sentinel));
        var close = new WorkspaceWorkflowCommand(Guid.NewGuid().ToString(), 0);
        await workspaces.ChangeWorkflowAsync(owner, "admin", "close", close, new Dictionary<string,string>(), default, true);
        await Assert.ThrowsAsync<AppLifecycleException>(() => controls.EnvironmentCommandAsync(tree.WorkspaceId,
            "admin", SourceTestApp, child.Id, "start", new(Guid.NewGuid().ToString(), child.Revision), default));
        Assert.Equal("stopped", (await controls.EnvironmentCommandAsync(tree.WorkspaceId, "admin", SourceTestApp, child.Id, "start", start, default)).State);
        Assert.Equal(1, runtime.Starts);
        await Assert.ThrowsAsync<AppLifecycleException>(() => inspection.RecoverLeaseAsync(tree.WorkspaceId, tree.Id, "admin",
            new(Guid.NewGuid().ToString(), tree.Observation!.Head!, tree.Leases[0], true), default));
        var finish = new CoreEnvironmentCommand(Guid.NewGuid().ToString(), child.Revision);
        runtime.FailStop = true;
        Assert.Equal("cleanup-failed", (await controls.EnvironmentCommandAsync(tree.WorkspaceId, "admin", SourceTestApp, child.Id, "finish", finish, default)).State);
        Assert.True(File.Exists(sentinel));
        runtime.FailStop = false;
        Assert.Equal("finished", (await controls.EnvironmentCommandAsync(tree.WorkspaceId, "admin", SourceTestApp, child.Id, "finish", finish, default)).State);
        Assert.False(File.Exists(sentinel)); Assert.Equal("keep source", await File.ReadAllTextAsync(source));
        Assert.Empty((await workspaces.Read(tree.Id, owner, default)).SandboxConsumers);
        Assert.False((await inspection.ReadAsync(tree.WorkspaceId, tree.Id, "admin", default)).HasSandboxConsumers);
        await inspection.RecoverLeaseAsync(tree.WorkspaceId, tree.Id, "admin", new(Guid.NewGuid().ToString(), tree.Observation!.Head!, tree.Leases[0], true), default);
        Assert.Equal("closed", (await workspaces.ChangeWorkflowAsync(owner, "admin", "close", close, new Dictionary<string,string>(), default)).Closure);
        Assert.Equal("workspace_dirty", (await Assert.ThrowsAsync<AppLifecycleException>(() => workspaces.ChangeWorkflowAsync(owner,
            "admin", "complete", new(Guid.NewGuid().ToString(), 1), new Dictionary<string,string>(), default))).Code);
    }

    [Theory]
    [InlineData("permission", "app_permission_required")]
    [InlineData("context", "environment_not_found")]
    [InlineData("owner", "environment_not_found")]
    [InlineData("revision", "environment_revision_conflict")]
    public async Task ResourceControls_RejectUnreviewedAuthorityOrResource(string boundary, string expectedCode)
    {
        var (f, _) = await SourceFixtureAsync();
        var workspaces = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var owner = ExternalOwner(); var tree = await workspaces.PrepareAsync(owner, ExternalPrepare(), default);
        var inspection = new WorkspaceInspectionService(workspaces, f.Apps, f.Clock);
        var store = new CoreEnvironmentStore(f.Paths); var runtime = new ResourceControlRuntime();
        var environments = new CoreEnvironmentService(store, runtime, f.Clock, workspaces);
        var controls = new WorkspaceCleanupService(f.Paths, inspection, workspaces, null!, f.Apps, store, environments, new(store, environments), null!, null!, null!);
        var app = (await f.Apps.GetAppAsync(SourceTestApp))!;
        await f.Apps.UpsertAppAsync(app with { GrantedCorePermissions = boundary == "permission" ? [] : [CoreAppPermissions.CoreEnvironmentsManage] });
        var childOwner = boundary == "owner" ? owner with { UserId = "someone-else" }
            : boundary == "context" ? owner with { SessionId = "other-task" } : owner;
        var childTree = boundary is "owner" or "context"
            ? await workspaces.PrepareAsync(childOwner, ExternalPrepare() with { SessionId = childOwner.SessionId }, default) : tree;
        var child = await environments.CreateAsync(new(childOwner.UserId),
            new(Guid.NewGuid().ToString(), "Owned", Context: new(WorkspaceId: childTree.WorkspaceId)), default);
        var error = await Record.ExceptionAsync(() => controls.EnvironmentCommandAsync(tree.WorkspaceId, "admin", SourceTestApp,
            child.Id, "finish", new(Guid.NewGuid().ToString(), boundary == "revision" ? 999 : child.Revision), default));
        Assert.Equal(expectedCode, error switch { AppIdentityException identity => identity.Code, SandboxException sandbox => sandbox.Code, _ => error?.GetType().Name });
        Assert.True(Directory.Exists(child.DataRoot)); Assert.Equal(0, runtime.Stops);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ResourceControls_RequireCurrentSourceAuthorityForStartsButAllowReplayAndCleanup(bool appSandbox)
    {
        var (f, _) = await SourceFixtureAsync();
        var workspaces = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var tree = await workspaces.PrepareAsync(ExternalOwner(), ExternalPrepare(), default);
        var inspection = new WorkspaceInspectionService(workspaces, f.Apps, f.Clock);
        var store = new CoreEnvironmentStore(f.Paths); var runtime = new ResourceControlRuntime();
        var environments = new CoreEnvironmentService(store, runtime, f.Clock, workspaces);
        var sandboxStore = new SandboxStore(f.Paths); var sandboxRuntime = new ResourceControlSandboxRuntime();
        var sandboxes = new SandboxService(sandboxStore, new ResourceControlInputs(tree.Path), sandboxRuntime, f.Clock);
        var controls = new WorkspaceCleanupService(f.Paths, inspection, workspaces, null!, f.Apps, store, environments,
            new(store, environments), sandboxStore, sandboxes, new(sandboxes, new ResourceControlLifetime()));
        var actor = new SandboxActor("admin");
        string id; long revision;
        if (appSandbox)
        {
            var plan = await sandboxes.PlanAsync(actor, new(SourceTestApp, "sandbox", new("worktree", tree.Id),
                Context: new(WorkspaceId: tree.WorkspaceId)), default);
            var instance = await sandboxes.PrepareAsync(actor, new(Guid.NewGuid().ToString(), plan.Id, plan.Digest), default);
            id = instance.Id; revision = instance.Revision;
        }
        else
        {
            var child = await environments.CreateAsync(actor, new(Guid.NewGuid().ToString(), "Source authority",
                Context: new(WorkspaceId: tree.WorkspaceId), WorktreeIds: [tree.Id]), default);
            id = child.Id; revision = child.Revision;
        }
        var app = (await f.Apps.GetAppAsync(SourceTestApp))!;
        var management = appSandbox ? CoreAppPermissions.SandboxesManage : CoreAppPermissions.CoreEnvironmentsManage;
        Task Grant(bool source) => f.Apps.UpsertAppAsync(app with {
            GrantedCorePermissions = source ? [management, CoreAppPermissions.Sources] : [management] });
        async Task<(long Revision, string State)> Command(string action, string requestId, long expected)
        {
            if (appSandbox)
            {
                var result = await controls.SandboxCommandAsync(tree.WorkspaceId, "admin", SourceTestApp, id, action, new(requestId, expected), default);
                return (result.Revision, result.State);
            }
            var child = await controls.EnvironmentCommandAsync(tree.WorkspaceId, "admin", SourceTestApp, id, action, new(requestId, expected), default);
            return (child.Revision, child.State);
        }
        int Starts() => runtime.Starts + sandboxRuntime.Starts;
        var request = Guid.NewGuid().ToString();
        await Grant(false);
        Assert.Equal("app_permission_required", (await Assert.ThrowsAsync<AppIdentityException>(() => Command("start", request, revision))).Code);
        Assert.Equal(0, Starts());
        await Grant(true);
        var started = await Command("start", request, revision);
        Assert.Equal(appSandbox ? "ready" : "running", started.State); Assert.Equal(1, Starts());
        await Grant(false);
        Assert.Equal(started, await Command("start", request, revision)); // Read-only success receipt survives revocation.
        Assert.Equal("app_permission_required", (await Assert.ThrowsAsync<AppIdentityException>(() => Command("start", Guid.NewGuid().ToString(), started.Revision))).Code);
        var stopped = await Command("stop", Guid.NewGuid().ToString(), started.Revision);
        Assert.Equal("stopped", stopped.State);
        Assert.Equal("app_permission_required", (await Assert.ThrowsAsync<AppIdentityException>(() => Command("start", Guid.NewGuid().ToString(), stopped.Revision))).Code);
        var removed = await Command(appSandbox ? "dispose" : "finish", Guid.NewGuid().ToString(), stopped.Revision);
        Assert.Equal(appSandbox ? "disposed" : "finished", removed.State); Assert.Equal(1, Starts());
        Assert.True(Directory.Exists(tree.Path));
    }

    private sealed class ResourceControlInputs(string source) : ISandboxInputs
    {
        public Task<SandboxResolvedInput> ResolveAsync(SandboxActor actor, SandboxPlanRequest request, CancellationToken ct)
        {
            var digest = new string('a', 64);
            return Task.FromResult(new SandboxResolvedInput(request.AppId, DateTimeOffset.UnixEpoch, digest,
                new(new RuntimeAppManifest { Id = request.AppId }, "/reviewed/manifest.json", digest,
                    new() { Key = request.Profile, Type = "docker" }, [], null, "{}", null),
                source, ["admin"], [], new Dictionary<string, string>(), true));
        }
        public Task AcquireAsync(SandboxInstance instance, CancellationToken ct) => Task.CompletedTask;
        public Task ReleaseAsync(SandboxInstance instance, CancellationToken ct) => Task.CompletedTask;
    }
    private sealed class ResourceControlSandboxRuntime : ISandboxRuntime
    {
        public int Starts;
        public Task<SandboxRuntimeStart> StartAsync(SandboxInstance instance, Func<SandboxResource, Task> record, CancellationToken ct)
        { Starts++; return Task.FromResult(new SandboxRuntimeStart("http://sandbox.test", "http://auth.sandbox.test", [])); }
        public Task StopAsync(SandboxInstance instance, CancellationToken ct) => Task.CompletedTask;
        public Task RemoveAsync(SandboxInstance instance, CancellationToken ct) => Task.CompletedTask;
        public Task<string> ObserveAsync(SandboxInstance instance, CancellationToken ct) => Task.FromResult(instance.State);
    }
    private sealed class ResourceControlLifetime : Microsoft.Extensions.Hosting.IHostApplicationLifetime
    {
        public CancellationToken ApplicationStarted => default;
        public CancellationToken ApplicationStopping => default;
        public CancellationToken ApplicationStopped => default;
        public void StopApplication() { }
    }

    private sealed class ResourceControlRuntime : ICoreEnvironmentRuntime
    {
        public int Starts, Stops; public bool FailStop;
        public Task<string> PrepareAsync(CoreEnvironmentRecord record, string root, CancellationToken ct) => Task.FromResult("test-core");
        public Task<CoreEnvironmentProcess?> ObserveAsync(CoreEnvironmentRecord record, string root, CancellationToken ct) => Task.FromResult(record.Process);
        public async Task StartAsync(CoreEnvironmentRecord record, string root, Func<CoreEnvironmentProcess, Task> save, CancellationToken ct)
        { Starts++; await save(new(1234567, DateTimeOffset.UtcNow)); }
        public Task StopAsync(CoreEnvironmentRecord record, string root, bool remove, CancellationToken ct)
        { if (FailStop) throw new IOException("Temporary Docker failure"); Stops++; return Task.CompletedTask; }
    }
}
