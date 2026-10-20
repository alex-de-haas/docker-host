using System.Text.Json.Nodes;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Theory]
    [InlineData("return-bound", false, "alternate")]
    [InlineData("return-starting", false, "alternate")]
    [InlineData("return-starting", true, "alternate")]
    [InlineData("return-starting", false, "docker")]
    public async Task ExecutionTargets_NewPackageChoiceSupersedesInterruptedReturn(string phase, bool missingCapturedTarget, string requestedTarget)
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
        await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", tree), default);
        var data = Path.Combine(f.Paths.AppsRoot, app.Id, "data", "sentinel");
        await File.WriteAllTextAsync(data, "current workspace data");
        f.Adapter.FailOnStartCount = f.Adapter.StartCount + 1;
        var failedReturn = await ExecutionRequest(f, owner, "package", runtime: "docker");
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.ExecuteTargetAsync(failedReturn, default));
        app = (await f.Apps.GetAppAsync(app.Id))!;
        Assert.Equal("docker", app.SelectedRuntime);
        var interrupted = (await AppDevStore.ReadAsync(f.Paths, app, default))!;
        Assert.Equal("return-starting", interrupted.Phase);
        // Include recovery from a retained legacy operation without a captured package target.
        await AppDevStore.SaveAsync(f.Paths, interrupted with { Phase = phase,
            PackageRuntime = missingCapturedTarget ? null : interrupted.PackageRuntime }, default);
        f.Adapter.FailOnStartCount = null;
        var starts = f.Adapter.StartCount;
        var stops = f.Adapter.StopCount;
        var selection = await ExecutionRequest(f, owner, "package", runtime: requestedTarget);
        Assert.Equal("completed", (await f.Service.ExecuteTargetAsync(selection, default)).State);
        app = (await f.Apps.GetAppAsync(app.Id))!;
        Assert.Equal(requestedTarget, app.SelectedRuntime);
        Assert.Equal(requestedTarget, f.Adapter.LastContext!.Manifest.RuntimeProfile.Key);
        Assert.Equal(starts + 1, f.Adapter.StartCount);
        Assert.Equal(stops + (requestedTarget == "docker" ? 1 : 2), f.Adapter.StopCount);
        Assert.Equal(requestedTarget, await f.RecreateService().PackageRuntimeAsync(app, default));
        Assert.Equal("current workspace data", await File.ReadAllTextAsync(data));
    }
}
