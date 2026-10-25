using System.Text.Json.Nodes;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Theory]
    [InlineData("git", false)]
    [InlineData("git", true)]
    [InlineData("local-git", false)]
    [InlineData("local-git", true)]
    public async Task ExecutionTargets_PackageReturnDropsStaleCapturedOverride(string sourceType, bool interrupted)
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        await f.Service.StartAsync("test.created");
        await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", tree), default);
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        var operation = (await AppDevStore.ReadAsync(f.Paths, app, default))!;
        var missing = Path.Combine(f.Paths.CoreRoot, "development", "removed-workspace");
        var previous = operation.PreviousSource! with { Type = sourceType, LocalOverridePath = missing, OverrideCommit = "old-workspace-head" };
        // Older operations may retain an override that was removed after workspace entry.
        await AppDevStore.SaveAsync(f.Paths, operation with { PreviousSource = previous }, default);
        var data = Path.Combine(f.Paths.AppsRoot, app.Id, "data", "sentinel");
        await File.WriteAllTextAsync(data, "current ordinary data");
        var edit = Path.Combine(tree.Path, "uncommitted.txt");
        await File.WriteAllTextAsync(edit, "keep workspace edits");
        var request = await ExecutionRequest(f, owner, "package", runtime: "docker");
        if (interrupted)
        {
            await f.Service.StopAsync(app.Id);
            await AppDevStore.SaveAsync(f.Paths, operation with { PreviousSource = previous,
                PackageReturn = true, PackageRuntime = "docker", Phase = "return-stopped" }, default);
            request = request with { Phase = "switching" };
            await AppExecutionStore.SaveAsync(f.Paths, request, default);
        }

        var recovered = f.RecreateService();
        var result = await recovered.ExecuteTargetAsync(request, default);
        Assert.Equal("completed", result.State);
        app = (await f.Apps.GetAppAsync(app.Id))!;
        Assert.Equal("docker", app.SelectedRuntime);
        Assert.Equal("running", app.RuntimeState);
        Assert.Equal(sourceType == "local-git" ? f.Paths.ResolveManagedCheckoutPath(app.Id) : null, app.SourceState!.LocalOverridePath);
        Assert.Null(app.SourceState.OverrideCommit);
        Assert.Equal(previous.Commit, app.SourceState.Commit);
        Assert.Equal("returned", (await recovered.GetDevModeAsync(app.Id)).Phase);
        Assert.Equal("current ordinary data", await File.ReadAllTextAsync(data));
        Assert.Equal("keep workspace edits", await File.ReadAllTextAsync(edit));
        Assert.False(Directory.Exists(missing));
        var starts = f.Adapter.StartCount;
        var stops = f.Adapter.StopCount;
        Assert.Equal("completed", (await recovered.ExecuteTargetAsync(result, default)).State);
        Assert.Equal(starts, f.Adapter.StartCount);
        Assert.Equal(stops, f.Adapter.StopCount);
    }

    [Theory]
    [InlineData("git", false)]
    [InlineData("git", true)]
    [InlineData("local-git", false)]
    [InlineData("local-git", true)]
    public async Task ExecutionTargets_DevReturnRetryAcceptsNormalizedSourceAfterFailedPackageStart(string sourceType, bool capturedSourceExists)
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        await f.Service.StartAsync("test.created");
        await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", tree), default);
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        var operation = (await AppDevStore.ReadAsync(f.Paths, app, default))!;
        var captured = Path.Combine(f.Paths.CoreRoot, "development", "captured-override");
        if (capturedSourceExists) Directory.CreateDirectory(captured);
        await AppDevStore.SaveAsync(f.Paths, operation with { PreviousSource = operation.PreviousSource! with
            { Type = sourceType, LocalOverridePath = captured, OverrideCommit = "captured-head" } }, default);
        var data = Path.Combine(f.Paths.AppsRoot, app.Id, "data", "sentinel");
        var edit = Path.Combine(tree.Path, "uncommitted.txt");
        await File.WriteAllTextAsync(data, "current ordinary data");
        await File.WriteAllTextAsync(edit, "keep workspace edits");
        var actor = DevActor(owner);
        var request = DevRequest("return");
        request = request with { PlanDigest = (await f.Service.PlanDevModeAsync(app.Id, request, actor)).PlanDigest };
        f.Adapter.StartContextProbe = (_, _) => throw new AppLifecycleException("fixture_start_failed", "Interrupted package start");
        Assert.Equal("fixture_start_failed", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Service.ApplyDevModeAsync(app.Id, request, actor))).Code);
        var failed = await f.Service.GetDevModeAsync(app.Id);
        Assert.Equal("return-starting", failed.Phase);
        Assert.Equal("pending", Assert.Single(failed.Receipts.Where(r => r.RequestId == request.RequestId)).State);
        var source = (await f.Apps.GetAppAsync(app.Id))!.SourceState!;
        Assert.Equal(sourceType == "local-git" ? f.Paths.ResolveManagedCheckoutPath(app.Id) : null, source.LocalOverridePath);
        Assert.Null(source.OverrideCommit);
        f.Adapter.StartContextProbe = null;
        var recovered = f.RecreateService();
        // Normalization must not let a retry accept an unrelated operator-selected source.
        await f.Apps.UpdateAppAsync(app.Id, a => a with { SourceState = source with { LocalOverridePath = captured + "-other" } });
        Assert.Equal("dev_binding_changed", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            recovered.ApplyDevModeAsync(app.Id, request, actor))).Code);
        await f.Apps.UpdateAppAsync(app.Id, a => a with { SourceState = source });
        await recovered.PlanDevModeAsync(app.Id, request, actor);
        var starts = f.Adapter.StartCount;
        var stops = f.Adapter.StopCount;
        var result = await recovered.ApplyDevModeAsync(app.Id, request, actor);
        Assert.Equal("returned", result.Phase);
        Assert.Equal("docker", result.App.SelectedRuntime);
        Assert.Equal("running", result.App.RuntimeState);
        Assert.Equal("succeeded", Assert.Single(result.Receipts.Where(r => r.RequestId == request.RequestId)).State);
        Assert.Equal("current ordinary data", await File.ReadAllTextAsync(data));
        Assert.Equal("keep workspace edits", await File.ReadAllTextAsync(edit));
        Assert.Equal(capturedSourceExists, Directory.Exists(captured));
        Assert.Equal(starts + 1, f.Adapter.StartCount);
        Assert.Equal(stops + 1, f.Adapter.StopCount);
        await recovered.ApplyDevModeAsync(app.Id, request, actor);
        Assert.Equal(starts + 1, f.Adapter.StartCount);
        Assert.Equal(stops + 1, f.Adapter.StopCount);
    }

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
