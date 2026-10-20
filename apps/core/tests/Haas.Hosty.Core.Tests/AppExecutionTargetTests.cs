using System.Text.Json.Nodes;
using Haas.Hosty.Core;
using Haas.Hosty.Launch;
using Haas.Hosty.Core.Tests.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static async Task<AppExecutionOperation> ExecutionRequest(LifecycleFixture f, WorkspaceOwner owner,
        string kind, DevelopmentWorkspace? tree = null, string? runtime = null, string? onlyWorkspace = null)
    {
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        var request = new AppExecutionTargetRequest(Guid.NewGuid().ToString("D"), kind, runtime,
            kind == "workspace" ? tree!.WorkspaceId : null, kind == "workspace" ? tree!.Id : null);
        var previous = await JsonStorage.ReadAsync<AppExecutionOwner>(
            Path.Combine(AppExecutionStore.DirectoryFor(f.Paths, app.Id), "owner.json"));
        return new(app.Id, request, new(owner.UserId, "test-assistant"), app.InstalledAt, AppExecutionStore.Binding(app),
            "test:" + request.RequestId, OnlyWorkspaceId: onlyWorkspace, PreviousRequestId: previous?.RequestId);
    }

    private static async Task<DevelopmentWorkspace> AnotherExecutionTree(LifecycleFixture f, WorkspaceOwner owner,
        DevelopmentWorkspaceService workspaces, DevelopmentWorkspace first)
    {
        var other = owner with { SessionId = owner.SessionId + "-second" };
        var tree = await workspaces.PrepareAsync(other, new(Guid.NewGuid().ToString(), other.SessionId,
            "test.created", "/assistant", "main", Name: "Second workspace"), default);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "manifest.json"),
            await File.ReadAllTextAsync(Path.Combine(first.Path, "manifest.json")));
        return tree;
    }

    [Fact]
    public async Task ExecutionTargets_WorkspaceToWorkspaceReturnsToPackageAndRetainsCurrentData()
    {
        var (f, owner, workspaces, first, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, first);
        var second = await AnotherExecutionTree(f, owner, workspaces, first);
        await f.Service.StartAsync("test.created");
        var installed = await File.ReadAllTextAsync((await f.Apps.GetAppAsync("test.created"))!.ManifestPath!);
        var a = await ExecutionRequest(f, owner, "workspace", first);
        Assert.Equal("completed", (await f.Service.ExecuteTargetAsync(a, default)).State);
        var b = await ExecutionRequest(f, owner, "workspace", second);
        Assert.Equal("completed", (await f.Service.ExecuteTargetAsync(b, default)).State);
        Assert.Equal(second.Id, (await f.Service.GetDevModeAsync("test.created")).WorktreeId);
        Assert.Equal("docker", (await f.Service.GetDevModeAsync("test.created")).PreviousRuntime);
        var data = Path.Combine(f.Paths.AppsRoot, "test.created", "data", "sentinel");
        await File.WriteAllTextAsync(data, "current data survives");
        var back = await ExecutionRequest(f, owner, "package");
        Assert.Equal("completed", (await f.Service.ExecuteTargetAsync(back, default)).State);
        Assert.Equal("docker", (await f.Apps.GetAppAsync("test.created"))!.SelectedRuntime);
        Assert.Equal("current data survives", await File.ReadAllTextAsync(data));
        Assert.Equal(installed, await File.ReadAllTextAsync((await f.Apps.GetAppAsync("test.created"))!.ManifestPath!));
        Assert.True(Directory.Exists(first.Path));
        Assert.True(Directory.Exists(second.Path));
    }

    [Fact]
    public async Task ExecutionTargets_FailedPreparationKeepsRunningWorkspaceAndCanReturn()
    {
        var (f, owner, workspaces, first, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, first);
        var second = await AnotherExecutionTree(f, owner, workspaces, first);
        await f.Service.StartAsync("test.created");
        await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", first), default);
        var stops = f.Adapter.StopCount;
        f.Adapter.PreparationProbe = async _ =>
        {
            Assert.NotEmpty((await workspaces.Read(second.Id, second.Owner, default)).Leases);
            throw new IOException("test build failure");
        };
        var request = await ExecutionRequest(f, owner, "workspace", second);
        await Assert.ThrowsAsync<IOException>(() => f.Service.ExecuteTargetAsync(request, default));
        Assert.Equal(stops, f.Adapter.StopCount);
        Assert.Empty((await workspaces.Read(second.Id, second.Owner, default)).Leases);
        Assert.Equal(first.Id, (await f.Service.GetDevModeAsync("test.created")).WorktreeId);
        Assert.Equal("running", (await f.Apps.GetAppAsync("test.created"))!.RuntimeState);
        f.Adapter.PreparationProbe = null;
        Assert.Equal("completed", (await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "package"), default)).State);
    }

    [Fact]
    public async Task ExecutionTargets_GroupReturnDoesNotDisplaceAnotherWorkspace()
    {
        var (f, owner, workspaces, first, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, first);
        var second = await AnotherExecutionTree(f, owner, workspaces, first);
        await f.Service.StartAsync("test.created");
        await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", second), default);
        var starts = f.Adapter.StartCount;
        var staleGroupReturn = await ExecutionRequest(f, owner, "package", onlyWorkspace: first.WorkspaceId);
        var result = await f.Service.ExecuteTargetAsync(staleGroupReturn, default);
        Assert.Equal("execution_target_unchanged", result.Code);
        Assert.Equal(second.Id, (await f.Service.GetDevModeAsync("test.created")).WorktreeId);
        Assert.Equal(starts, f.Adapter.StartCount);
    }

    [Fact]
    public async Task ExecutionTargets_RetiredPackageRequestCannotDisplaceANewerWorkspace()
    {
        var (f, owner, workspaces, first, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, first);
        var second = await AnotherExecutionTree(f, owner, workspaces, first);
        await f.Service.StartAsync("test.created");
        await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", first), default);
        var back = await ExecutionRequest(f, owner, "package");
        var completed = await f.Service.ExecuteTargetAsync(back, default);
        await AppExecutionStore.SaveAsync(f.Paths, completed with { State = "running", Phase = "switching" }, default);
        await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", second), default);
        var stops = f.Adapter.StopCount;
        Assert.Equal("dev_selection_changed", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Service.ExecuteTargetAsync(completed with { State = "running", Phase = "switching" }, default))).Code);
        Assert.Equal(second.Id, (await f.Service.GetDevModeAsync("test.created")).WorktreeId);
        Assert.Equal(stops, f.Adapter.StopCount);
    }

    [Fact]
    public async Task ExecutionTargets_CompletedReplayNeverChangesNewerSelection()
    {
        var (f, owner, workspaces, first, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, first);
        var second = await AnotherExecutionTree(f, owner, workspaces, first);
        await f.Service.StartAsync("test.created");
        var a = await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", first), default);
        await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", second), default);
        var starts = f.Adapter.StartCount;
        Assert.Equal("completed", (await f.Service.ExecuteTargetAsync(a, default)).State);
        Assert.Equal(second.Id, (await f.Service.GetDevModeAsync("test.created")).WorktreeId);
        Assert.Equal(starts, f.Adapter.StartCount);
    }

    [Fact]
    public async Task ExecutionTargets_ExplicitReleaseSelectionBecomesBaselineAcrossServiceRecovery()
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        foreach (var path in new[] { app.ManifestPath!, Path.Combine(tree.Path, "manifest.json") })
        {
            var manifest = JsonNode.Parse(await File.ReadAllTextAsync(path))!;
            manifest["runtimeProfiles"]!.AsArray().Add(new JsonObject { ["key"] = "alternate", ["type"] = "docker" });
            foreach (var service in manifest["services"]!.AsArray())
                service!["runtimes"]!["alternate"] = service["runtimes"]!["docker"]!.DeepClone();
            if (manifest["data"]?["targets"] is JsonArray targets)
            {
                var target = targets.First(t => t?["runtime"]?.GetValue<string>() == "docker")!.DeepClone();
                target["runtime"] = "alternate";
                targets.Add(target);
            }
            await File.WriteAllTextAsync(path, manifest.ToJsonString());
        }
        await f.Service.StartAsync(app.Id);
        await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", tree), default);
        await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "package", runtime: "alternate"), default);
        await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", tree), default);
        var recovered = f.RecreateService();
        Assert.Equal("alternate", await recovered.PackageRuntimeAsync((await f.Apps.GetAppAsync(app.Id))!, default));
        await recovered.ExecuteTargetAsync(await ExecutionRequest(f, owner, "package"), default);
        Assert.Equal("alternate", (await f.Apps.GetAppAsync(app.Id))!.SelectedRuntime);
    }

    [Fact]
    public async Task ExecutionTargets_GroupRetryAfterAuthorityRestorationKeepsItsOriginalRequestId()
    {
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        await using var host = await CoreHttpHarness.StartAsync(f.Clock);
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        var now = f.Clock.UtcNow;
        await users.WriteAsync(new(1,
            [new(owner.UserId, "operator@example.test", "Operator", "host.admin", true, now, now)], [], [],
            [new("group-browser", owner.UserId, now, now.AddHours(8), null, now, BrowserOrigin: "http://localhost:7070")]));
        var actor = new WorkspaceActivationActor(owner.UserId, "manual",
            Principal: "browser:" + DevelopmentWorkspaceService.Hash("group-browser"));
        var request = new AppExecutionTargetRequest(Guid.NewGuid().ToString("D"), "package");
        await AppExecutionStore.SaveGroupAsync(f.Paths,
            new(tree.WorkspaceId, request, actor, ["test.created"],
                DevelopmentWorkspaceService.Hash(CoreJson.Text(request) + "\n" + CoreJson.Text(actor) + "\n" + tree.WorkspaceId)), default);
        using var worker = new AppExecutionTargetService(f.Paths, f.Apps, f.Service, workspaces,
            new WorkspaceInspectionService(workspaces, f.Apps, f.Clock),
            host.Services.GetRequiredService<WorkspaceActivationAccess>(), NullLogger<AppExecutionTargetService>.Instance);
        await worker.StartAsync(default);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        async Task<WorkspaceExecutionStatus> AwaitResult()
        {
            while (true)
            {
                var result = await worker.WorkspaceStatusAsync(tree.WorkspaceId, request.RequestId, owner.UserId, timeout.Token);
                if (result.State != "running") return result;
                await Task.Delay(20, timeout.Token);
            }
        }
        try
        {
            Assert.Equal("failed", (await AwaitResult()).State);
            await users.UpdateAsync(state => state with { Users = state.Users.Select(u => u with { Disabled = false }).ToArray() });
            await worker.SubmitWorkspaceAsync(tree.WorkspaceId, request, actor, timeout.Token);
            var recovered = await AwaitResult();
            Assert.Equal("completed", recovered.State);
            Assert.Equal("completed", Assert.Single(recovered.Apps).State);
            Assert.Equal(request.RequestId, recovered.RequestId);
        }
        finally { await worker.StopAsync(CancellationToken.None); }
    }

    [Fact]
    public async Task ExecutionTargets_ReturnUsesCurrentInstalledPackage()
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        await f.Service.StartAsync("test.created");
        await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", tree), default);
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        var manifest = JsonNode.Parse(await File.ReadAllTextAsync(app.ManifestPath!))!;
        manifest["version"] = "0.9.0";
        await File.WriteAllTextAsync(app.ManifestPath!, manifest.ToJsonString());
        var before = await File.ReadAllTextAsync(app.ManifestPath!);
        Assert.Equal("completed", (await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "package"), default)).State);
        Assert.Equal("0.9.0", (await f.Apps.GetAppAsync(app.Id))!.Version);
        Assert.Equal(before, await File.ReadAllTextAsync(app.ManifestPath!));
    }
}
