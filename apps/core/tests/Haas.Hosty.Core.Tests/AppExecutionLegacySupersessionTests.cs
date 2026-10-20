using System.Text.Json.Nodes;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task ExecutionTargets_InterruptedPackageRequestCannotDisplaceNewerLegacySelection(
        bool fromWorkspace, bool newerDevelopment)
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

        async Task SwitchPackage(string runtime)
        {
            var plan = await f.Service.CreateRuntimeSwitchPlanAsync(app.Id, new(runtime));
            await f.Service.ApplyRuntimeSwitchAsync(app.Id, new(runtime, plan.PlanDigest));
        }

        if (!fromWorkspace) await SwitchPackage("alternate");
        await f.Service.StartAsync(app.Id);
        if (fromWorkspace)
            await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", tree), default);
        var request = await ExecutionRequest(f, owner, "package", runtime: "docker");
        var completed = await f.Service.ExecuteTargetAsync(request, default);
        // The runtime finished, but Core stopped before its outer operation receipt was committed.
        var interrupted = completed with { State = "running", Phase = "switching" };
        await AppExecutionStore.SaveAsync(f.Paths, interrupted, default);

        if (newerDevelopment)
            await ApplyReviewedDev(f.Service, DevRequest("enter", tree.Id), DevActor(owner));
        else
            await SwitchPackage("alternate");
        var selected = (await f.Apps.GetAppAsync(app.Id))!;
        var starts = f.Adapter.StartCount;
        var stops = f.Adapter.StopCount;

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.RecreateService().ExecuteTargetAsync(interrupted, default));

        Assert.Equal("dev_selection_changed", error.Code);
        var current = (await f.Apps.GetAppAsync(app.Id))!;
        Assert.Equal(newerDevelopment ? "dev" : "alternate", current.SelectedRuntime);
        Assert.Equal(selected.DevModeId, current.DevModeId);
        Assert.Equal(selected.SourceState, current.SourceState);
        Assert.Equal(starts, f.Adapter.StartCount);
        Assert.Equal(stops, f.Adapter.StopCount);
    }
}
