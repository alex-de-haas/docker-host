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
        await f.Apps.UpsertAppAsync(app with { GrantedCorePermissions = [CoreAppPermissions.CoreEnvironmentsManage] });
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
        var child = await environments.CreateAsync(new(boundary == "owner" ? "someone-else" : "admin"),
            new(Guid.NewGuid().ToString(), "Owned", Context: new(WorkspaceId: boundary == "context" ? new string('f', 64) : tree.WorkspaceId)), default);
        var error = await Record.ExceptionAsync(() => controls.EnvironmentCommandAsync(tree.WorkspaceId, "admin", SourceTestApp,
            child.Id, "finish", new(Guid.NewGuid().ToString(), boundary == "revision" ? 999 : child.Revision), default));
        Assert.Equal(expectedCode, error switch { AppIdentityException identity => identity.Code, SandboxException sandbox => sandbox.Code, _ => error?.GetType().Name });
        Assert.True(Directory.Exists(child.DataRoot)); Assert.Equal(0, runtime.Stops);
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
