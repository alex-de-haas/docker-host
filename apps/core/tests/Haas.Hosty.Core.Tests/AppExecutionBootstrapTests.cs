using System.Text.Json.Nodes;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ExecutionTargets_DevelopmentOnlyBootstrapRemainsAvailableAfterWorkspaceEntry(bool interrupted)
    {
        var (f, owner, workspaces, tree, created, _) = await LocalHandoffFixture();
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        var installed = await File.ReadAllTextAsync(app.ManifestPath!);
        var inventory = await new WorkspaceInspectionService(workspaces, f.Apps, f.Clock).ListAsync(owner.UserId, default);
        var before = await f.Service.ReadExecutionTargetsAsync(app.Id, inventory, default);
        Assert.Equal("dev", before.PackageRuntime);
        Assert.Equal("package", before.Current.Kind);
        Assert.Equal("dev", Assert.Single(before.Choices, choice => choice.Kind == "package").Runtime);
        await f.Service.StartAsync(app.Id);
        await EditDevManifest(tree.Path, manifest => manifest["services"]![0]!["runtimes"]!["dev"]!["command"] = "node workspace.ts");
        var request = await ExecutionRequest(f, owner, "workspace", tree);
        if (interrupted)
        {
            f.Adapter.StartContextProbe = (_, _) => throw new IOException("Interrupted workspace start");
            await Assert.ThrowsAsync<IOException>(() => f.Service.ExecuteTargetAsync(request, default));
            Assert.Equal("starting", (await f.Service.GetDevModeAsync(app.Id)).Phase);
            f.Adapter.StartContextProbe = null;
        }
        else
            Assert.Equal("completed", (await f.Service.ExecuteTargetAsync(request, default)).State);

        var selected = await f.Service.ReadExecutionTargetsAsync(app.Id, inventory, default);
        Assert.Equal("workspace", selected.Current.Kind);
        Assert.Equal(tree.Id, selected.Current.WorktreeId);
        Assert.Equal("dev", selected.PackageRuntime);
        Assert.Contains(selected.Choices, choice => choice.Kind == "package" && choice.Runtime == "dev");
        var data = Path.Combine(f.Paths.AppsRoot, app.Id, "data", "sentinel");
        await File.WriteAllTextAsync(data, "current data");
        var edit = Path.Combine(tree.Path, "uncommitted.txt");
        await File.WriteAllTextAsync(edit, "keep worktree edits");
        var recovered = f.RecreateService();
        var returned = await recovered.ExecuteTargetAsync(await ExecutionRequest(f, owner, "package"), default);
        Assert.Equal("completed", returned.State);
        app = (await f.Apps.GetAppAsync(app.Id))!;
        Assert.Equal("running", app.RuntimeState);
        Assert.Equal(created.Operation.SourcePath, app.SourceState!.LocalOverridePath);
        Assert.Equal("returned", (await recovered.GetDevModeAsync(app.Id)).Phase);
        var targets = await recovered.ReadExecutionTargetsAsync(app.Id, inventory, default);
        Assert.Equal("package", targets.Current.Kind);
        Assert.Null(targets.Current.WorktreeId);
        Assert.Equal(installed, await File.ReadAllTextAsync(app.ManifestPath!));
        Assert.Equal("current data", await File.ReadAllTextAsync(data));
        Assert.Equal("keep worktree edits", await File.ReadAllTextAsync(edit));
        var workspaceManifest = JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(tree.Path, "manifest.json")))!;
        Assert.Equal("node workspace.ts", workspaceManifest["services"]![0]!["runtimes"]!["dev"]!["command"]!.GetValue<string>());
        var starts = f.Adapter.StartCount;
        Assert.Equal("completed", (await recovered.ExecuteTargetAsync(returned, default)).State);
        Assert.Equal(starts, f.Adapter.StartCount);
    }

    [Fact]
    public async Task ExecutionTargets_DevelopmentOnlyBootstrapKeepsManualOverrideDistinctFromPackage()
    {
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", tree), default);
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        var operation = (await AppDevStore.ReadAsync(f.Paths, app, default))!;
        await AppDevStore.SaveAsync(f.Paths, operation with { WorktreeId = null }, default);
        var inventory = await new WorkspaceInspectionService(workspaces, f.Apps, f.Clock).ListAsync(owner.UserId, default);
        var targets = await f.Service.ReadExecutionTargetsAsync(app.Id, inventory, default);
        Assert.Equal("legacy", targets.Current.Kind);
        Assert.Equal("dev", targets.PackageRuntime);
        Assert.Contains(targets.Choices, choice => choice.Kind == "package" && choice.Runtime == "dev");
    }

    [Fact]
    public async Task ExecutionTargets_DevelopmentOnlyInstallationRetainsOnlyItsDefaultAsPackage()
    {
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        var manifest = JsonNode.Parse(await File.ReadAllTextAsync(app.ManifestPath!))!;
        manifest["runtimeProfiles"]!.AsArray().Add(new JsonObject { ["key"] = "authoring", ["type"] = "docker", ["development"] = true });
        foreach (var service in manifest["services"]!.AsArray())
            service!["runtimes"]!["authoring"] = service["runtimes"]!["dev"]!.DeepClone();
        if (manifest["data"]?["targets"] is JsonArray targets)
        {
            var target = targets[0]!.DeepClone();
            target["runtime"] = "authoring";
            targets.Add(target);
        }
        await File.WriteAllTextAsync(app.ManifestPath!, manifest.ToJsonString());
        var inventory = await new WorkspaceInspectionService(workspaces, f.Apps, f.Clock).ListAsync(owner.UserId, default);
        var choices = await f.Service.ReadExecutionTargetsAsync(app.Id, inventory, default);
        Assert.Equal("dev", Assert.Single(choices.Choices, choice => choice.Kind == "package").Runtime);
        var request = await ExecutionRequest(f, owner, "package", runtime: "authoring");
        Assert.Equal("dev_package_invalid", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Service.ExecuteTargetAsync(request, default))).Code);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ExecutionTargets_DevelopmentOnlyPackageHonorsDeclaredDefaultRuntime(bool conflictingProfileDefault)
    {
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        var manifest = JsonNode.Parse(await File.ReadAllTextAsync(app.ManifestPath!))!;
        manifest["runtimeProfiles"]![0]!["default"] = false;
        manifest["runtimeProfiles"]!.AsArray().Add(new JsonObject {
            ["key"] = "authoring", ["type"] = "docker", ["development"] = true, ["default"] = conflictingProfileDefault });
        manifest["defaultRuntime"] = "dev";
        foreach (var service in manifest["services"]!.AsArray())
            service!["runtimes"]!["authoring"] = service["runtimes"]!["dev"]!.DeepClone();
        if (manifest["data"]?["targets"] is JsonArray targets)
        {
            var target = targets[0]!.DeepClone();
            target["runtime"] = "authoring";
            targets.Add(target);
        }
        await File.WriteAllTextAsync(app.ManifestPath!, manifest.ToJsonString());
        var inventory = await new WorkspaceInspectionService(workspaces, f.Apps, f.Clock).ListAsync(owner.UserId, default);
        var choices = await f.Service.ReadExecutionTargetsAsync(app.Id, inventory, default);
        Assert.Equal("dev", choices.PackageRuntime);
        Assert.Equal("package", choices.Current.Kind);
        Assert.Equal("dev", Assert.Single(choices.Choices, choice => choice.Kind == "package").Runtime);
        var selected = await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "package"), default);
        Assert.Equal("completed", selected.State);
        var rejected = await ExecutionRequest(f, owner, "package", runtime: "authoring");
        Assert.Equal("dev_package_invalid", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Service.ExecuteTargetAsync(rejected, default))).Code);
    }

    [Fact]
    public async Task ExecutionTargets_DevelopmentOnlyPackageUsesFirstProfileWhenDefaultsAreOmitted()
    {
        var (f, owner, workspaces, tree, created, _) = await LocalHandoffFixture();
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        foreach (var path in new[] { app.ManifestPath!, Path.Combine(tree.Path, "manifest.json") })
        {
            var manifest = JsonNode.Parse(await File.ReadAllTextAsync(path))!.AsObject();
            manifest.Remove("defaultRuntime");
            manifest["runtimeProfiles"]![0]!.AsObject().Remove("default");
            manifest["runtimeProfiles"]!.AsArray().Add(new JsonObject {
                ["key"] = "authoring", ["type"] = "docker", ["development"] = true });
            foreach (var service in manifest["services"]!.AsArray())
                service!["runtimes"]!["authoring"] = service["runtimes"]!["dev"]!.DeepClone();
            if (manifest["data"]?["targets"] is JsonArray targets)
            {
                var target = targets[0]!.DeepClone(); target["runtime"] = "authoring"; targets.Add(target);
            }
            await File.WriteAllTextAsync(path, manifest.ToJsonString());
        }
        Assert.Equal("dev", (await f.Manifests.LoadAsync(app.ManifestPath!, validateAllProfiles: true)).RuntimeProfile.Key);
        var inventory = await new WorkspaceInspectionService(workspaces, f.Apps, f.Clock).ListAsync(owner.UserId, default);
        var before = await f.Service.ReadExecutionTargetsAsync(app.Id, inventory, default);
        Assert.Equal("dev", before.PackageRuntime);
        Assert.Equal("package", before.Current.Kind);
        Assert.Equal("dev", Assert.Single(before.Choices, choice => choice.Kind == "package").Runtime);
        await f.Service.StartAsync(app.Id);
        Assert.Equal("completed", (await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "workspace", tree), default)).State);
        var selected = await f.Service.ReadExecutionTargetsAsync(app.Id, inventory, default);
        Assert.Equal("workspace", selected.Current.Kind);
        Assert.Equal("dev", selected.PackageRuntime);
        Assert.Equal("completed", (await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "package"), default)).State);
        app = (await f.Apps.GetAppAsync(app.Id))!;
        Assert.Equal(created.Operation.SourcePath, app.SourceState!.LocalOverridePath);
        Assert.Equal("running", app.RuntimeState);
        Assert.Equal("package", (await f.Service.ReadExecutionTargetsAsync(app.Id, inventory, default)).Current.Kind);
    }

    [Fact]
    public async Task ExecutionTargets_DevelopmentOnlyManualNativeOverrideRequiresExplicitSourceClear()
    {
        var native = new ManifestNativeAdapter();
        var f = await LifecycleFixture.CreateAsync(localRuntimeAdapter: native);
        var owner = WorkspaceTestOwner(f);
        var created = await f.Service.CreateLocalAppAsync(owner, NewApp(), null, default);
        var workspaces = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var tree = await workspaces.PrepareAsync(owner,
            new(created.Operation.Id, owner.SessionId, "test.created", "/assistant", "main"), default);
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        foreach (var path in new[] { app.ManifestPath!, Path.Combine(tree.Path, "manifest.json") })
        {
            var manifest = JsonNode.Parse(await File.ReadAllTextAsync(path))!;
            manifest["runtimeProfiles"]![0]!["type"] = "localCommand";
            var runtime = manifest["services"]![0]!["runtimes"]!["dev"]!;
            manifest["services"]![0]!["runtimes"]!["dev"] = new JsonObject {
                ["type"] = "localCommand", ["artifact"] = "source", ["command"] = "echo manual-native",
                ["workingDirectory"] = ".", ["ports"] = runtime["ports"]!.DeepClone() };
            await File.WriteAllTextAsync(path, manifest.ToJsonString());
        }
        await f.Apps.UpdateAppAsync(app.Id, current => current with { RuntimeProfiles = [new("dev", "localCommand", true, true)] });
        await f.Sources.SetLocalOverrideAsync(app.Id, new(tree.Path));
        await f.Service.StartAsync(app.Id);
        app = (await f.Apps.GetAppAsync(app.Id))!;
        Assert.Null(app.DevModeId);
        var source = app.SourceState;
        var data = Path.Combine(f.Paths.AppsRoot, app.Id, "data", "sentinel");
        await File.WriteAllTextAsync(data, "preserve ordinary data");
        var inventory = await new WorkspaceInspectionService(workspaces, f.Apps, f.Clock).ListAsync(owner.UserId, default);
        var targets = await f.Service.ReadExecutionTargetsAsync(app.Id, inventory, default);
        Assert.Equal("legacy", targets.Current.Kind);
        var package = Assert.Single(targets.Choices, choice => choice.Kind == "package");
        Assert.False(package.Available);
        Assert.Contains("Source override", package.Unavailable!);
        var starts = native.StartCount;
        var runningContext = native.LastContext;
        var request = await ExecutionRequest(f, owner, "package");
        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.ExecuteTargetAsync(request, default));
        Assert.Equal("dev_package_source_override", error.Code);
        Assert.Contains("Source override", error.Message);
        app = (await f.Apps.GetAppAsync(app.Id))!;
        Assert.Equal(source, app.SourceState);
        Assert.Equal("running", app.RuntimeState);
        Assert.Null(app.DevModeId);
        Assert.Equal(starts, native.StartCount);
        Assert.Same(runningContext, native.LastContext);
        Assert.Equal("preserve ordinary data", await File.ReadAllTextAsync(data));
    }

    [Fact]
    public async Task ExecutionTargets_ReleasePackageDoesNotExposeOrAdmitDevelopmentRecipesAsPackages()
    {
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        var inventory = await new WorkspaceInspectionService(workspaces, f.Apps, f.Clock).ListAsync(owner.UserId, default);
        var targets = await f.Service.ReadExecutionTargetsAsync("test.created", inventory, default);
        Assert.Equal("docker", targets.PackageRuntime);
        Assert.Equal("docker", Assert.Single(targets.Choices, choice => choice.Kind == "package").Runtime);
        var stops = f.Adapter.StopCount;
        var request = await ExecutionRequest(f, owner, "package", runtime: "dev");
        Assert.Equal("dev_package_invalid", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Service.ExecuteTargetAsync(request, default))).Code);
        Assert.Equal(stops, f.Adapter.StopCount);
    }
}
