using System.Text.Json.Nodes;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static async Task BreakInstalledRecipe(LifecycleFixture fixture, string runtime)
    {
        var app = (await fixture.Apps.GetAppAsync("test.created"))!;
        var manifest = JsonNode.Parse(await File.ReadAllTextAsync(app.ManifestPath!))!;
        manifest["services"]![0]!["runtimes"]!.AsObject().Remove(runtime);
        await File.WriteAllTextAsync(app.ManifestPath!, manifest.ToJsonString());
    }

    [Theory]
    [InlineData(null)]
    [InlineData("docker")]
    public async Task ManifestRecovery_PackageReturnIgnoresInvalidDefaultAndLiveRecipes(string? runtime)
    {
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        await f.Service.StartAsync("test.created");
        await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", tree), default);
        var data = Path.Combine(f.Paths.AppsRoot, "test.created", "data", "keep.txt");
        Directory.CreateDirectory(Path.GetDirectoryName(data)!);
        await File.WriteAllTextAsync(data, "current user data");
        await BreakInstalledRecipe(f, "dev");
        var liveManifest = Path.Combine(tree.Path, "manifest.json");
        await File.WriteAllTextAsync(liveManifest, "{ unfinished source edit");

        var inspection = new WorkspaceInspectionService(workspaces, f.Apps, f.Clock);
        var choices = await f.Service.ReadExecutionTargetsAsync("test.created",
            await inspection.ListAsync(owner.UserId, default), default);
        Assert.Equal("workspace", choices.Current.Kind);
        Assert.Contains(choices.Choices, c => c.Kind == "package" && c.Runtime == "docker");
        var result = await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "package", runtime: runtime), default);

        Assert.Equal("completed", result.State);
        var restored = (await f.Apps.GetAppAsync("test.created"))!;
        Assert.Equal("docker", restored.SelectedRuntime);
        Assert.Equal("running", restored.RuntimeState);
        Assert.Equal("current user data", await File.ReadAllTextAsync(data));
        Assert.Equal("{ unfinished source edit", await File.ReadAllTextAsync(liveManifest));
    }

    [Fact]
    public async Task ManifestRecovery_InvalidDestinationDoesNotStopCurrentWorkspace()
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", tree), default);
        var before = (await f.Apps.GetAppAsync("test.created"))!;
        var stops = f.Adapter.StopCount;
        var starts = f.Adapter.StartCount;
        await BreakInstalledRecipe(f, "docker");

        var request = await ExecutionRequest(f, owner, "package", runtime: "docker");
        var error = await Assert.ThrowsAsync<AppManifestException>(() =>
            f.Service.ExecuteTargetAsync(request, default));

        Assert.Equal("manifest_validation_failed", error.Code);
        Assert.Equal(stops, f.Adapter.StopCount);
        Assert.Equal(starts, f.Adapter.StartCount);
        var after = (await f.Apps.GetAppAsync(before.Id))!;
        Assert.Equal(before.SelectedRuntime, after.SelectedRuntime);
        Assert.Equal(before.DevModeId, after.DevModeId);
        Assert.Equal(before.SourceState, after.SourceState);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ManifestRecovery_CanLeaveWorkspaceWithRetiredLaunchedContract(bool legacy)
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        if (legacy) await ApplyReviewedDev(f.Service, DevRequest("enter", tree.Id), DevActor(owner));
        else await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", tree), default);
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        var operation = (await AppDevStore.ReadAsync(f.Paths, app, default))!;
        var path = operation.RunningManifest ?? operation.ExecutionManifest ?? operation.PreviousManifest;
        // Model an operation admitted before Core retired this contract. The installed destination
        // stays current; stopping the old runtime must not require admitting its contract again.
        var snapshot = JsonNode.Parse(await File.ReadAllTextAsync(path))!;
        snapshot["agentWorker"] = new JsonObject { ["service"] = "app", ["image"] = "legacy/worker:1" };
        await File.WriteAllTextAsync(path, snapshot.ToJsonString());
        var retained = await new AppManifestService().LoadAsync(path, "dev", allowRetiredContracts: true);
        await AppDevStore.SaveAsync(f.Paths, legacy ? operation with { ManifestDigest = retained.ManifestDigest }
            : operation with { ExecutionManifestDigest = retained.ManifestDigest }, default);

        Assert.Equal("stopped", (await f.Service.StopAsync(app.Id)).App!.RuntimeState);
        var result = await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "package", runtime: "docker"), default);

        Assert.Equal("completed", result.State);
        Assert.Equal("docker", (await f.Apps.GetAppAsync(app.Id))!.SelectedRuntime);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ManifestRecovery_LegacyReturnUsesCapturedContractWhenInstalledRecipeIsInvalid(bool stopFirst)
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        await f.Service.StartAsync("test.created");
        await ApplyReviewedDev(f.Service, DevRequest("enter", tree.Id), DevActor(owner));
        await BreakInstalledRecipe(f, "dev");
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "manifest.json"), "{ unfinished source edit");

        if (stopFirst) Assert.Equal("stopped", (await f.Service.StopAsync("test.created")).App!.RuntimeState);
        var restored = await ApplyReviewedDev(f.Service, DevRequest("return"), DevActor(owner));

        Assert.Equal("returned", restored.Phase);
        Assert.Equal("docker", restored.App.SelectedRuntime);
        Assert.Equal("running", restored.App.RuntimeState);
    }
}
