using System.Text.Json.Nodes;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static async Task AddAlternateWorkspaceRecipe(LifecycleFixture f, DevelopmentWorkspace tree)
    {
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        foreach (var path in new[] { app.ManifestPath!, Path.Combine(tree.Path, "manifest.json") })
        {
            var manifest = JsonNode.Parse(await File.ReadAllTextAsync(path))!.AsObject();
            manifest["runtimeProfiles"]!.AsArray().Add(new JsonObject { ["key"] = "dev-alt", ["type"] = "docker", ["development"] = true });
            foreach (var service in manifest["services"]!.AsArray())
                service!["runtimes"]!["dev-alt"] = service["runtimes"]!["dev"]!.DeepClone();
            if (manifest["data"]?["targets"] is JsonArray targets)
            { var target = targets[0]!.DeepClone(); target["runtime"] = "dev-alt"; targets.Add(target); }
            await File.WriteAllTextAsync(path, manifest.ToJsonString());
        }
    }

    [Fact]
    public async Task WorkspaceRecipe_ReplayDoesNotRevertNewerMetadataAndNeverRunsTheApp()
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        await AddAlternateWorkspaceRecipe(f, tree);
        var original = (await f.Apps.GetAppAsync("test.created"))!;
        var first = new WorkspaceRecipeRequest(Guid.NewGuid().ToString(), original.Id, tree.Id, "dev");
        Assert.Equal("dev", (await f.Service.ConfigureWorkspaceRecipeAsync(tree.WorkspaceId, first, owner.UserId, null, default)).Runtime);
        var second = first with { RequestId = Guid.NewGuid().ToString(), Runtime = "dev-alt" };
        var newer = await f.Service.ConfigureWorkspaceRecipeAsync(tree.WorkspaceId, second, owner.UserId, null, default);
        var replay = await f.Service.ConfigureWorkspaceRecipeAsync(tree.WorkspaceId, first, owner.UserId, null, default);
        Assert.Equal("dev-alt", replay.Runtime);
        Assert.Equal(newer.Requests, replay.Requests);
        Assert.Equal(2, replay.Requests!.Length);
        Assert.Equal("dev_request_conflict", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Service.ConfigureWorkspaceRecipeAsync(tree.WorkspaceId, first with { Runtime = "dev-alt" }, owner.UserId, null, default))).Code);
        var after = (await f.Apps.GetAppAsync(original.Id))!;
        Assert.Equal(original, after);
        Assert.Equal(0, f.Adapter.StartCount);
        Assert.Equal(0, f.Adapter.StopCount);
    }

    [Theory]
    [InlineData("wrong-user")]
    [InlineData("wrong-principal")]
    [InlineData("wrong-workspace")]
    [InlineData("unbound-app")]
    [InlineData("nondev")]
    [InlineData("invalid")]
    public async Task WorkspaceRecipe_IsSharedButRejectsUnboundOrInvalidRecipes(string failure)
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        var request = new WorkspaceRecipeRequest(Guid.NewGuid().ToString(), "test.created", tree.Id, "dev");
        var workspace = tree.WorkspaceId;
        var user = owner.UserId;
        string? principal = null;
        if (failure == "wrong-user") user = "another-user";
        if (failure == "wrong-principal") principal = "oauth:another-credential";
        if (failure == "wrong-workspace") workspace = new string('0', 64);
        if (failure == "unbound-app")
        {
            var other = NewApp("test.other");
            await f.Service.CreateLocalAppAsync(owner, other, null, default);
            request = request with { AppId = other.AppId };
        }
        if (failure == "nondev") request = request with { Runtime = "docker" };
        if (failure == "invalid") request = request with { Runtime = "missing" };
        if (failure is "wrong-user" or "wrong-principal")
        {
            await f.Service.ConfigureWorkspaceRecipeAsync(workspace, request, user, principal, default);
            Assert.Equal(0, f.Adapter.StartCount);
            Assert.Equal(0, f.Adapter.StopCount);
            return;
        }
        if (failure == "invalid")
            await Assert.ThrowsAsync<AppManifestException>(() => f.Service.ConfigureWorkspaceRecipeAsync(workspace, request, user, principal, default));
        else
            await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.ConfigureWorkspaceRecipeAsync(workspace, request, user, principal, default));
        Assert.False(File.Exists(Path.Combine(AppExecutionStore.DirectoryFor(f.Paths, request.AppId), "recipes", tree.Id + ".json")));
        Assert.Equal(0, f.Adapter.StartCount);
        Assert.Equal(0, f.Adapter.StopCount);
    }

    [Fact]
    public async Task WorkspaceRecipe_MetadataWaitsForExecutionThenKeepsItsNewerChoiceWithoutRestarting()
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        await AddAlternateWorkspaceRecipe(f, tree);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        f.Adapter.PreparationProbe = async _ => { entered.SetResult(); await release.Task; };
        var selection = f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", tree, "dev"), default);
        await entered.Task.WaitAsync(TimeSpan.FromSeconds(15));
        var request = new WorkspaceRecipeRequest(Guid.NewGuid().ToString(), "test.created", tree.Id, "dev-alt");
        var metadata = f.Service.ConfigureWorkspaceRecipeAsync(tree.WorkspaceId, request, owner.UserId, null, default);
        try
        {
            Assert.False(metadata.IsCompleted);
        }
        finally { release.SetResult(); }
        Assert.Equal("completed", (await selection).State);
        Assert.Equal("dev-alt", (await metadata).Runtime);
        var starts = f.Adapter.StartCount;
        var replay = await f.Service.ConfigureWorkspaceRecipeAsync(tree.WorkspaceId, request, owner.UserId, null, default);
        Assert.Equal("dev-alt", replay.Runtime);
        Assert.Equal("dev", (await f.Apps.GetAppAsync("test.created"))!.SelectedRuntime);
        Assert.Equal(starts, f.Adapter.StartCount);
    }

    [Fact]
    public async Task ExecutionTargets_OrphanPreparedCandidateIsPreparedAgainBeforeReplacingActiveWorkspace()
    {
        var (f, owner, workspaces, first, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, first);
        var second = await AnotherExecutionTree(f, owner, workspaces, first);
        await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", first), default);
        var request = await ExecutionRequest(f, owner, "workspace", second);
        var preparations = new List<string>();
        f.Adapter.PreparationProbe = context => { preparations.Add(context.Manifest.Services[0].Runtime.Command!); return Task.CompletedTask; };
        f.Adapter.StopProbe = () => throw new IOException("Simulated interruption before verified Stop");
        await Assert.ThrowsAsync<IOException>(() => f.Service.ExecuteTargetAsync(request, default));
        Assert.Equal(first.Id, (await f.Service.GetDevModeAsync("test.created")).WorktreeId);
        Assert.Equal("running", (await f.Apps.GetAppAsync("test.created"))!.RuntimeState);
        await EditDevManifest(second.Path, manifest => manifest["services"]![0]!["runtimes"]!["dev"]!["command"] = "node revised-after-interruption.ts");
        f.Adapter.StopProbe = null;
        var retained = (await AppExecutionStore.ReadAsync(f.Paths, request.AppId, request.Request.RequestId, default))!;
        Assert.Equal("completed", (await f.Service.ExecuteTargetAsync(retained, default)).State);
        Assert.Equal(2, preparations.Count);
        Assert.Equal("node revised-after-interruption.ts", preparations[1]);
        Assert.Equal("node revised-after-interruption.ts", f.Adapter.LastContext!.Manifest.Services[0].Runtime.Command);
        Assert.Equal(second.Id, (await f.Service.GetDevModeAsync("test.created")).WorktreeId);
    }
}
