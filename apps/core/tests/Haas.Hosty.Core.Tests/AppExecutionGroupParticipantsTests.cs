using Haas.Hosty.Core;
using Haas.Hosty.Launch;
using Haas.Hosty.Core.Tests.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Theory]
    [InlineData("workspace", false)]
    [InlineData("workspace", true)]
    [InlineData("package", false)]
    [InlineData("package", true)]
    public async Task ExecutionTargets_GroupSelectionExcludesRemovedAndReinstalledBindings(string kind, bool reinstalled)
    {
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        const string staleId = "zz.stale";
        var current = (await f.Apps.GetAppAsync("test.created"))!;
        var stale = current with { Id = staleId };
        await f.Apps.UpsertAppAsync(stale);
        if (reinstalled)
            await f.Apps.UpdateAppAsync(staleId, app => app with { InstalledAt = app.InstalledAt.AddMinutes(1) });
        else
            await f.Apps.RemoveAppAsync(staleId);
        var staleBefore = await f.Apps.GetAppAsync(staleId);
        await JsonStorage.WriteAsync(Path.Combine(f.Paths.CoreRoot, "development", "workspaces", tree.Id + ".json"),
            tree with { Apps = [.. tree.Apps, new(staleId, stale.InstalledAt, null)] });
        await f.Service.StartAsync(current.Id);
        if (kind == "package")
            await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", tree), default);
        var data = Path.Combine(f.Paths.AppsRoot, current.Id, "data", "group-sentinel");
        await File.WriteAllTextAsync(data, "preserve current data");

        await using var host = await CoreHttpHarness.StartAsync(f.Clock);
        using var worker = new AppExecutionTargetService(f.Paths, f.Apps, f.Service, workspaces,
            new WorkspaceInspectionService(workspaces, f.Apps, f.Clock),
            host.Services.GetRequiredService<WorkspaceActivationAccess>(), NullLogger<AppExecutionTargetService>.Instance);
        var actor = new WorkspaceActivationActor(owner.UserId, "local-control", Principal: "local-control");
        var request = new AppExecutionTargetRequest(Guid.NewGuid().ToString("D"), kind);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        await worker.StartAsync(timeout.Token);
        try
        {
            var admitted = await worker.SubmitWorkspaceAsync(tree.WorkspaceId, request, actor, timeout.Token);
            Assert.Equal(current.Id, Assert.Single(admitted.Apps).AppId);
            WorkspaceExecutionStatus status;
            do
            {
                status = await worker.WorkspaceStatusAsync(tree.WorkspaceId, request.RequestId, owner.UserId, timeout.Token);
                if (status.State == "running") await Task.Delay(20, timeout.Token);
            } while (status.State == "running");
            Assert.Equal("completed", status.State);
            var child = Assert.Single(status.Apps);
            Assert.Equal(current.Id, child.AppId);
            Assert.Equal("completed", child.State);
            Assert.Null(await AppExecutionStore.ReadAsync(f.Paths, staleId,
                WorkspaceRuntimeFiles.ChildId(request.RequestId, staleId), timeout.Token));
            Assert.Equal(staleBefore, await f.Apps.GetAppAsync(staleId));
            Assert.Equal(kind == "workspace" ? "dev" : "docker", (await f.Apps.GetAppAsync(current.Id))!.SelectedRuntime);
            Assert.Equal("preserve current data", await File.ReadAllTextAsync(data));
            var starts = f.Adapter.StartCount;
            var stops = f.Adapter.StopCount;
            Assert.Equal("completed", (await worker.SubmitWorkspaceAsync(tree.WorkspaceId, request, actor, timeout.Token)).State);
            Assert.Equal(starts, f.Adapter.StartCount);
            Assert.Equal(stops, f.Adapter.StopCount);
        }
        finally { await worker.StopAsync(CancellationToken.None); }
    }
}
