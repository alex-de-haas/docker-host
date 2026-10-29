using System.Text.Json.Nodes;
using Haas.Hosty.Core;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static async Task AddManifestPackageRuntime(LifecycleFixture f, DevelopmentWorkspace tree)
    {
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        foreach (var path in new[] { app.ManifestPath!, Path.Combine(tree.Path, "manifest.json") })
        {
            var manifest = JsonNode.Parse(await File.ReadAllTextAsync(path))!.AsObject();
            manifest["runtimeProfiles"]!.AsArray().Add(new JsonObject { ["key"] = "docker", ["type"] = "docker" });
            foreach (var service in manifest["services"]!.AsArray())
            {
                var release = service!["runtimes"]!["dev"]!.DeepClone().AsObject();
                foreach (var field in new[] { "artifact", "sourceMount", "build", "setup", "command", "workingDirectory" }) release.Remove(field);
                service["runtimes"]!["docker"] = release;
            }
            if (manifest["data"]?["targets"] is JsonArray targets)
            {
                var release = targets[0]!.DeepClone(); release["runtime"] = "docker"; targets.Add(release);
            }
            await File.WriteAllTextAsync(path, manifest.ToJsonString());
        }
        await f.Apps.UpdateAppAsync(app.Id, a => a with { SelectedRuntime = "docker",
            RuntimeProfiles = [new("dev", "docker", true, true), new("docker", "docker", false)] });
    }

    private static async Task<AppExecutionOperation> SelectManifestTarget(LifecycleFixture f, WorkspaceOwner owner,
        DevelopmentWorkspace tree, string kind = "workspace")
    {
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        var request = new AppExecutionTargetRequest(Guid.NewGuid().ToString("D"), kind,
            kind == "package" ? "docker" : "dev", kind == "workspace" ? tree.WorkspaceId : null,
            kind == "workspace" ? tree.Id : null);
        return await f.Service.ExecuteTargetAsync(new(app.Id, request, new(owner.UserId, "test-assistant"),
            app.InstalledAt, AppExecutionStore.Binding(app), "manifest-test:" + request.RequestId), default);
    }

    [Theory]
    [InlineData("metadata", false)]
    [InlineData("execution", false)]
    [InlineData("topology", false)]
    [InlineData("optional", false)]
    [InlineData("core", true)]
    [InlineData("source-write", true)]
    [InlineData("host-network", true)]
    [InlineData("capability", true)]
    [InlineData("device", true)]
    [InlineData("unknown", true)]
    public async Task WorkspaceManifest_ClassifiesRealAuthorityRatherThanAllManifestChanges(string edit, bool review)
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        await EditDevManifest(tree.Path, manifest =>
        {
            var runtime = manifest["services"]![0]!["runtimes"]!["dev"]!;
            switch (edit)
            {
                case "metadata": manifest["version"] = "0.2.0"; manifest["description"] = "A useful description"; break;
                case "execution": runtime["command"] = "node changed.ts"; runtime["environment"] = new JsonObject { ["MODE"] = "test" }; break;
                case "topology":
                    var extra = manifest["services"]![0]!.DeepClone(); extra["key"] = "worker";
                    extra["runtimes"]!["dev"]!["ports"] = new JsonArray();
                    extra["runtimes"]!["dev"]!.AsObject().Remove("healthcheck");
                    manifest["services"]!.AsArray().Add(extra); break;
                case "optional": manifest["optionalCorePermissions"] = new JsonArray("apps.read"); break;
                case "core": manifest["corePermissions"] = new JsonArray("apps.read"); break;
                case "source-write": runtime["sourceMount"]!["mode"] = "rw"; break;
                case "host-network": runtime["network"] = "host"; break;
                case "capability": runtime["capabilities"] = new JsonArray("NET_ADMIN"); break;
                case "device": runtime["devices"] = new JsonArray("/dev/net/tun"); break;
                case "unknown": manifest["newAuthorityExtension"] = new JsonObject { ["write"] = true }; break;
            }
        });
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        var candidate = await f.Service.PrepareExecutionCandidateAsync(app, tree.Path, "dev", DevActor(owner), default);
        Assert.Equal(review, candidate.ReviewRequired);
        Assert.Equal(edit == "metadata" ? "metadata" : review ? "access" : "execution", candidate.Classification.Kind);
        Assert.Equal(app.InstalledAt, candidate.Review.Installation);
        Assert.Equal(candidate.Selection.ManifestDigest, candidate.Review.CandidateDigest);
    }

    [Fact]
    public async Task WorkspaceManifest_ApprovalIsExactScopedAndRevocableBeforeAnyLifecycleMutation()
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        await f.Service.StartAsync("test.created");
        await EditDevManifest(tree.Path, m => m["corePermissions"] = new JsonArray("apps.read"));
        var before = (await f.Apps.GetAppAsync("test.created"))!;
        var bytes = await File.ReadAllTextAsync(before.ManifestPath!);
        var stops = f.Adapter.StopCount;
        var required = await SelectManifestTarget(f, owner, tree);
        Assert.Equal("review-required", required.State);
        Assert.Equal(stops, f.Adapter.StopCount);
        var plan = required.Review!.WorkspaceManifest!;
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.ApproveWorkspaceManifestAsync(plan, "someone-else", [], default));
        await f.Service.ApproveWorkspaceManifestAsync(plan, owner.UserId, [], default);
        Assert.DoesNotContain("apps.read", (await f.Apps.GetAppAsync("test.created"))!.GrantedCorePermissions ?? []);
        var selected = await f.Service.ExecuteTargetAsync(required, default);
        Assert.Equal("completed", selected.State);
        Assert.Contains("apps.read", (await f.Apps.GetAppAsync("test.created"))!.GrantedCorePermissions!);
        Assert.Equal(bytes, await File.ReadAllTextAsync(before.ManifestPath!));
        await f.Apps.UpdateAppAsync("test.created", app => app with { PermissionRevision = "revoked", GrantedCorePermissions = [] });
        var starts = f.Adapter.StartCount;
        Assert.Equal("dev_review_required", (await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.RestartAsync("test.created"))).Code);
        Assert.Equal(starts, f.Adapter.StartCount);
        Assert.Equal("completed", (await SelectManifestTarget(f, owner, tree, "package")).State);
        var after = (await f.Apps.GetAppAsync("test.created"))!;
        Assert.Empty(after.GrantedCorePermissions ?? []);
        Assert.Equal(bytes, await File.ReadAllTextAsync(before.ManifestPath!));
    }

    [Fact]
    public async Task WorkspaceManifest_StaleApprovalCannotAdmitChangedManifestOrInstallation()
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        await EditDevManifest(tree.Path, m => m["corePermissions"] = new JsonArray("apps.read"));
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        var candidate = await f.Service.PrepareExecutionCandidateAsync(app, tree.Path, "dev", DevActor(owner), default);
        await EditDevManifest(tree.Path, m => m["version"] = "0.5.0");
        Assert.Equal("dev_review_stale", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Service.ApproveWorkspaceManifestAsync(candidate.Review, owner.UserId, [], default))).Code);
        await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.PrepareWorkspaceManifestReviewAsync(candidate.Review, owner.UserId, default));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task WorkspaceManifest_RestartKeepsOnlyStillGrantedWorkspacePermissionsAndReturnRemovesThem(bool revoke)
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        await EditDevManifest(tree.Path, m => {
            m["corePermissions"] = new JsonArray("apps.read");
            m["optionalCorePermissions"] = new JsonArray("apps.logs");
        });
        var required = await SelectManifestTarget(f, owner, tree);
        Assert.Equal("review-required", required.State);
        await f.Service.ApproveWorkspaceManifestAsync(required.Review!.WorkspaceManifest!, owner.UserId, ["apps.logs"], default);
        Assert.Equal("completed", (await f.Service.ExecuteTargetAsync(required, default)).State);
        await EditDevManifest(tree.Path, m => { m["version"] = "0.4.0"; m["optionalCorePermissions"] = new JsonArray(); });
        await f.RecreateService().RestartAsync("test.created");
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        Assert.Contains("apps.read", app.GrantedCorePermissions!);
        Assert.DoesNotContain("apps.logs", app.GrantedCorePermissions!);
        if (revoke)
        {
            await f.Apps.UpdateAppAsync(app.Id, a => a with { PermissionRevision = "revoked", GrantedCorePermissions = [] });
            var starts = f.Adapter.StartCount;
            Assert.Equal("dev_review_required", (await Assert.ThrowsAsync<AppLifecycleException>(() => f.Service.RestartAsync(app.Id))).Code);
            Assert.Equal(starts, f.Adapter.StartCount);
        }
        Assert.Equal("completed", (await SelectManifestTarget(f, owner, tree, "package")).State);
        Assert.Empty((await f.Apps.GetAppAsync(app.Id))!.GrantedCorePermissions!);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task WorkspaceManifest_RestartReadsObsoletePackagePermissionsButValidatesTheNewSource(bool managedRestart)
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        Assert.Equal("completed", (await SelectManifestTarget(f, owner, tree)).State);
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        var installed = JsonNode.Parse(await File.ReadAllTextAsync(app.ManifestPath!))!.AsObject();
        installed["optionalCorePermissions"] = new JsonArray("retired.example.permission");
        var packageBytes = installed.ToJsonString();
        await File.WriteAllTextAsync(app.ManifestPath!, packageBytes);
        await EditDevManifest(tree.Path, m => m["services"]![0]!["runtimes"]!["dev"]!["command"] = "node repaired.ts");
        if (managedRestart)
            Assert.Equal("active", (await ApplyReviewedDev(f.Service, DevRequest("restart"), DevActor(owner))).Phase);
        else
            await f.RecreateService().RestartAsync(app.Id);
        Assert.Equal("node repaired.ts", f.Adapter.LastContext!.Manifest.Services[0].Runtime.Command);
        Assert.DoesNotContain("retired.example.permission", (await f.Apps.GetAppAsync(app.Id))!.GrantedCorePermissions ?? []);
        Assert.Equal(packageBytes, await File.ReadAllTextAsync(app.ManifestPath!));
        var stops = f.Adapter.StopCount;
        await EditDevManifest(tree.Path, m => m["optionalCorePermissions"] = new JsonArray(""));
        await Assert.ThrowsAsync<AppManifestException>(() => f.Service.RestartAsync(app.Id));
        Assert.Equal(stops, f.Adapter.StopCount);
    }

    [Fact]
    public async Task WorkspaceManifest_ExecutionRefreshAndInvalidSourceReturnKeepInstalledPackageAndCurrentData()
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        await f.Service.StartAsync("test.created");
        var before = (await f.Apps.GetAppAsync("test.created"))!;
        var bytes = await File.ReadAllTextAsync(before.ManifestPath!);
        await EditDevManifest(tree.Path, m => { m["version"] = "0.3.0"; m["services"]![0]!["runtimes"]!["dev"]!["command"] = "node first.ts"; });
        Assert.Equal("completed", (await SelectManifestTarget(f, owner, tree)).State);
        Assert.Equal("node first.ts", f.Adapter.LastContext!.Manifest.Services[0].Runtime.Command);
        Assert.Equal(before.Version, (await f.Apps.GetAppAsync(before.Id))!.Version);
        await EditDevManifest(tree.Path, m => m["services"]![0]!["runtimes"]!["dev"]!["command"] = "node second.ts");
        await f.RecreateService().RestartAsync(before.Id);
        Assert.Equal("node second.ts", f.Adapter.LastContext!.Manifest.Services[0].Runtime.Command);
        var data = Path.Combine(f.Paths.AppsRoot, before.Id, "data", "sentinel");
        await File.WriteAllTextAsync(data, "keep current ordinary data");
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "manifest.json"), "{");
        await f.Service.StopAsync(before.Id);
        Assert.Equal("completed", (await SelectManifestTarget(f, owner, tree, "package")).State);
        Assert.Equal("docker", (await f.Apps.GetAppAsync(before.Id))!.SelectedRuntime);
        Assert.Equal(bytes, await File.ReadAllTextAsync(before.ManifestPath!));
        Assert.Equal("keep current ordinary data", await File.ReadAllTextAsync(data));
        Assert.Equal("{", await File.ReadAllTextAsync(Path.Combine(tree.Path, "manifest.json")));
    }
    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task WorkspaceManifest_PreservesNativeAndMixedRecipesForOrdinaryAndSystemApps(bool system, bool mixed)
    {
        var native = new ManifestNativeAdapter();
        var f = await LifecycleFixture.CreateAsync(localRuntimeAdapter: native);
        var owner = WorkspaceTestOwner(f);
        var created = await f.Service.CreateLocalAppAsync(owner, NewApp(), null, default);
        var workspaces = new DevelopmentWorkspaceService(f.Paths, f.Apps, f.Clock);
        var tree = await workspaces.PrepareAsync(owner,
            new(created.Operation.Id, owner.SessionId, "test.created", "/assistant", "main"), default);
        await AddManifestPackageRuntime(f, tree);
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        foreach (var path in new[] { app.ManifestPath!, Path.Combine(tree.Path, "manifest.json") })
        {
            var manifest = JsonNode.Parse(await File.ReadAllTextAsync(path))!.AsObject();
            manifest["runtimeProfiles"]![0]!["type"] = mixed ? "mixed" : "localCommand";
            var recipe = new JsonObject { ["type"] = "localCommand", ["artifact"] = "source",
                ["command"] = "echo native", ["workingDirectory"] = "." };
            if (mixed)
            {
                manifest["services"]!.AsArray().Add(new JsonObject { ["key"] = "worker", ["runtimes"] = new JsonObject {
                    ["dev"] = recipe, ["docker"] = manifest["services"]![0]!["runtimes"]!["docker"]!.DeepClone() } });
            }
            else
            {
                recipe["ports"] = manifest["services"]![0]!["runtimes"]!["dev"]!["ports"]!.DeepClone();
                manifest["services"]![0]!["runtimes"]!["dev"] = recipe;
            }
            await File.WriteAllTextAsync(path, manifest.ToJsonString());
        }
        await f.Apps.UpdateAppAsync(app.Id, current => current with { System = system,
            RuntimeProfiles = [new("dev", mixed ? "mixed" : "localCommand", true, true), new("docker", "docker", false)] });
        await EditDevManifest(tree.Path, manifest => manifest["services"]![mixed ? 1 : 0]!["runtimes"]!["dev"]!["command"] = "echo changed-native");
        Assert.Equal("completed", (await SelectManifestTarget(f, owner, tree)).State);
        Assert.Equal("echo changed-native", native.LastContext!.Manifest.Services.Single(service => service.Runtime.Type == "localCommand").Runtime.Command);
        Assert.Equal(system, (await f.Apps.GetAppAsync(app.Id))!.System);
        Assert.Equal("completed", (await SelectManifestTarget(f, owner, tree, "package")).State);
        Assert.Equal("docker", (await f.Apps.GetAppAsync(app.Id))!.SelectedRuntime);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task WorkspaceManifest_DefaultSettingsDoNotLookLikeOperatorBindingDrift(bool required)
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        foreach (var path in new[] { app.ManifestPath!, Path.Combine(tree.Path, "manifest.json") })
        {
            var manifest = JsonNode.Parse(await File.ReadAllTextAsync(path))!.AsObject();
            manifest["settings"] = new JsonArray(new JsonObject { ["key"] = "EXISTING", ["type"] = "string",
                ["required"] = true, ["default"] = "initial" });
            await File.WriteAllTextAsync(path, manifest.ToJsonString());
        }
        await f.Apps.UpdateAppAsync(app.Id, current => current with { Settings = new Dictionary<string, AppSettingValue> {
            ["EXISTING"] = new("EXISTING", "string", "operator-configured", false, true) } });
        await EditDevManifest(tree.Path, manifest => manifest["settings"]!.AsArray().Add(new JsonObject {
            ["key"] = "WORKSPACE_MODE", ["type"] = "string", ["required"] = required, ["default"] = "workspace-default" }));
        Assert.Equal("completed", (await SelectManifestTarget(f, owner, tree)).State);
        Assert.Equal("workspace-default", (await f.Apps.GetAppAsync(app.Id))!.Settings["WORKSPACE_MODE"].Value);
        Assert.Equal("active", (await ApplyReviewedDev(f.Service, DevRequest("restart"), DevActor(owner))).Phase);
        await EditDevManifest(tree.Path, manifest => manifest["settings"]!.AsArray().Add(new JsonObject {
            ["key"] = "LATER_SETTING", ["type"] = "string", ["default"] = "later-default" }));
        await f.Service.RestartAsync(app.Id);
        Assert.Equal("active", (await ApplyReviewedDev(f.Service, DevRequest("restart"), DevActor(owner))).Phase);
        await f.Apps.UpdateAppAsync(app.Id, current => current with { Settings = current.Settings.ToDictionary(pair => pair.Key,
            pair => pair.Key == "EXISTING" ? pair.Value with { Value = "newer-operator-setting" } : pair.Value) });
        Assert.Equal("dev_binding_changed", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Service.PlanDevModeAsync(app.Id, DevRequest("restart"), DevActor(owner)))).Code);
        Assert.Equal("completed", (await SelectManifestTarget(f, owner, tree, "package")).State);
        Assert.Equal("newer-operator-setting", (await f.Apps.GetAppAsync(app.Id))!.Settings["EXISTING"].Value);
    }

    [Fact]
    public async Task WorkspaceManifest_RecoversInterruptedExecutionSnapshotProjection()
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        Assert.Equal("completed", (await SelectManifestTarget(f, owner, tree)).State);
        await EditDevManifest(tree.Path, manifest => manifest["settings"] = new JsonArray(new JsonObject {
            ["key"] = "AFTER_CRASH", ["type"] = "string", ["required"] = true, ["default"] = "recovered-default" }));
        var app = (await f.Apps.GetAppAsync("test.created"))!;
        var operation = (await AppDevStore.ReadAsync(f.Paths, app, default))!;
        var candidate = await f.Service.PrepareExecutionCandidateAsync(app, tree.Path, "dev", operation.Actor, default);
        operation = await f.Service.SaveExecutionCandidateAsync(operation, candidate, default);
        await AppDevStore.SaveAsync(f.Paths, operation, default);
        Assert.True(operation.ExecutionProjectionPending);
        Assert.False(app.Settings.ContainsKey("AFTER_CRASH"));
        await f.RecreateService().RestartAsync(app.Id);
        var recovered = (await f.Apps.GetAppAsync(app.Id))!;
        Assert.Equal("recovered-default", recovered.Settings["AFTER_CRASH"].Value);
        Assert.False((await AppDevStore.ReadAsync(f.Paths, recovered, default))!.ExecutionProjectionPending);
        Assert.Equal("active", (await ApplyReviewedDev(f.Service, DevRequest("restart"), DevActor(owner))).Phase);
        Assert.Equal("completed", (await SelectManifestTarget(f, owner, tree, "package")).State);
    }

    private sealed class ManifestNativeAdapter : IRuntimePreparation, IAppRuntimeAdapter
    {
        private readonly RecordingRuntimeAdapter inner = new("localCommand");
        public string Type => "localCommand";
        public RuntimeLifecycleContext? LastContext => inner.LastContext;
        public Task<RuntimePreparation> PrepareAsync(RuntimeLifecycleContext context, CancellationToken ct) => inner.PrepareAsync(context, ct);
        public async Task<AppRuntimeStartResult> StartAsync(RuntimeLifecycleContext context, CancellationToken ct = default)
            => (await inner.StartAsync(context, ct)) with { Endpoints = [] };
        public Task<AppRuntimeOperationResult> StopAsync(RuntimeLifecycleContext context, CancellationToken ct = default) => inner.StopAsync(context, ct);
        public Task<AppRuntimeOperationResult> RemoveAsync(RuntimeLifecycleContext context, CancellationToken ct = default) => inner.RemoveAsync(context, ct);
        public Task<AppRuntimeLogsResult> GetLogsAsync(RuntimeLifecycleContext context, int tail, CancellationToken ct = default) => inner.GetLogsAsync(context, tail, ct);
        public Task<AppRuntimeHealthResult> GetHealthAsync(RuntimeLifecycleContext context, CancellationToken ct = default) => inner.GetHealthAsync(context, ct);
    }

}
