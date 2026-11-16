using System.Text.Json.Nodes;
using Haas.Hosty.Core;
using Haas.Hosty.Launch;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private const string CandidateOnlyRuntime = "workspace-preview";

    private static Task AddCandidateOnlyRuntime(DevelopmentWorkspace tree, bool development = true)
        => EditDevManifest(tree.Path, manifest =>
        {
            manifest["runtimeProfiles"]!.AsArray().Add(new JsonObject
            {
                ["key"] = CandidateOnlyRuntime, ["type"] = "docker", ["development"] = development
            });
            foreach (var service in manifest["services"]!.AsArray())
            {
                var runtime = service!["runtimes"]![development ? "dev" : "docker"]!.DeepClone();
                service["runtimes"]![CandidateOnlyRuntime] = runtime;
            }
            if (manifest["data"]?["targets"] is JsonArray targets)
            {
                var target = targets[0]!.DeepClone(); target["runtime"] = CandidateOnlyRuntime; targets.Add(target);
            }
        });

    [Fact]
    public async Task CandidateWorkspaceRuntime_ConfiguresDiscoversAndRunsWithoutChangingInstalledReturnBaseline()
    {
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree);
        await AddCandidateOnlyRuntime(tree);
        var installed = (await f.Apps.GetAppAsync("test.created"))!;
        var installedJson = await File.ReadAllTextAsync(installed.ManifestPath!);
        await f.Service.StartAsync(installed.Id);
        var starts = f.Adapter.StartCount; var stops = f.Adapter.StopCount;
        var recipe = await f.Service.ConfigureWorkspaceRecipeAsync(tree.WorkspaceId,
            new(Guid.NewGuid().ToString(), installed.Id, tree.Id, CandidateOnlyRuntime), owner.UserId, null, default);
        Assert.Equal(CandidateOnlyRuntime, recipe.Runtime);
        Assert.Equal(starts, f.Adapter.StartCount); Assert.Equal(stops, f.Adapter.StopCount);
        var inventory = await new WorkspaceInspectionService(workspaces, f.Apps, f.Clock).ListAsync(owner.UserId, default);
        var targets = await f.Service.ReadExecutionTargetsAsync(installed.Id, inventory, default);
        var choice = Assert.Single(targets.Choices, choice => choice.Kind == "workspace");
        Assert.True(choice.Available, choice.Unavailable); Assert.Equal(CandidateOnlyRuntime, choice.Runtime);
        var request = await ExecutionRequest(f, owner, "workspace", tree);
        var result = await f.Service.ExecuteTargetAsync(request, default);
        if (result.State == "review-required")
        {
            Assert.Equal(starts, f.Adapter.StartCount); Assert.Equal(stops, f.Adapter.StopCount);
            await f.Service.ApproveWorkspaceManifestAsync(result.Review!.WorkspaceManifest!, owner.UserId, [], default);
            result = await f.Service.ExecuteTargetAsync(request, default);
        }
        Assert.Equal("completed", result.State);
        Assert.Equal(CandidateOnlyRuntime, (await f.Apps.GetAppAsync(installed.Id))!.SelectedRuntime);
        Assert.Equal(installedJson, await File.ReadAllTextAsync(installed.ManifestPath!));
        await f.Service.RestartAsync(installed.Id);
        var refreshed = await f.Service.ReadExecutionTargetsAsync(installed.Id, inventory, default);
        Assert.Equal(CandidateOnlyRuntime, refreshed.Current.Runtime); Assert.Equal("docker", refreshed.PackageRuntime);
        var sentinel = Path.Combine(f.Paths.AppsRoot, installed.Id, "data", "candidate-current-data");
        await File.WriteAllTextAsync(sentinel, "current data");
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "manifest.json"), "{ broken source");
        var unavailable = await f.Service.ReadExecutionTargetsAsync(installed.Id, inventory, default);
        Assert.Contains(unavailable.Choices, choice => choice.Kind == "package" && choice.Runtime == "docker" && choice.Available);
        Assert.DoesNotContain(unavailable.Choices, choice => choice.Kind == "workspace" && choice.Available);
        Assert.Equal("completed", (await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "package"), default)).State);
        var returned = (await f.Apps.GetAppAsync(installed.Id))!;
        Assert.Equal("docker", returned.SelectedRuntime); Assert.Equal(installed.ManifestPath, returned.ManifestPath);
        Assert.Equal(installedJson, await File.ReadAllTextAsync(returned.ManifestPath!));
        Assert.Equal("current data", await File.ReadAllTextAsync(sentinel)); Assert.True(Directory.Exists(tree.Path));
    }

    [Fact]
    public async Task CandidateWorkspaceRuntime_RequiresExactPermissionReviewBeforeAnyLifecycleEffect()
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree); await AddCandidateOnlyRuntime(tree);
        await EditDevManifest(tree.Path, manifest => manifest["corePermissions"] = new JsonArray("providers.agent"));
        await f.Service.StartAsync("test.created");
        var original = (await f.Apps.GetAppAsync("test.created"))!;
        var starts = f.Adapter.StartCount; var stops = f.Adapter.StopCount;
        var request = await ExecutionRequest(f, owner, "workspace", tree, CandidateOnlyRuntime);
        var review = await f.Service.ExecuteTargetAsync(request, default);
        Assert.Equal("review-required", review.State);
        Assert.Contains("providers.agent", review.Review!.WorkspaceManifest!.RequiredPermissions);
        Assert.Equal(original, await f.Apps.GetAppAsync(original.Id));
        Assert.Equal(starts, f.Adapter.StartCount); Assert.Equal(stops, f.Adapter.StopCount);
        await f.Service.ApproveWorkspaceManifestAsync(review.Review.WorkspaceManifest, owner.UserId, [], default);
        Assert.Equal("completed", (await f.Service.ExecuteTargetAsync(request, default)).State);
        Assert.Contains("providers.agent", (await f.Apps.GetAppAsync(original.Id))!.GrantedCorePermissions!);
        Assert.Equal("completed", (await f.Service.ExecuteTargetAsync(await ExecutionRequest(f, owner, "package"), default)).State);
        Assert.DoesNotContain("providers.agent", (await f.Apps.GetAppAsync(original.Id))!.GrantedCorePermissions!);
    }

    [Theory]
    [InlineData("unrelated-app")]
    [InlineData("not-development")]
    [InlineData("unknown-runtime")]
    public async Task CandidateWorkspaceRuntime_RejectsInvalidWorkspaceRecipeBeforeChangingSelection(string failure)
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree); await AddCandidateOnlyRuntime(tree, failure != "not-development");
        if (failure == "unrelated-app") await EditDevManifest(tree.Path, manifest => manifest["id"] = "unrelated.application");
        var original = (await f.Apps.GetAppAsync("test.created"))!;
        var runtime = failure == "unknown-runtime" ? "unknown-preview" : CandidateOnlyRuntime;
        var configure = () => f.Service.ConfigureWorkspaceRecipeAsync(tree.WorkspaceId,
            new(Guid.NewGuid().ToString(), original.Id, tree.Id, runtime), owner.UserId, null, default);
        if (failure == "unknown-runtime")
            Assert.Contains((await Assert.ThrowsAsync<AppManifestException>(configure)).Errors,
                error => error.Code == "app_manifest_selected_runtime_missing");
        else
            Assert.Equal(failure == "unrelated-app" ? "dev_manifest_identity_changed" : "dev_profile_unsupported",
                (await Assert.ThrowsAsync<AppLifecycleException>(configure)).Code);
        Assert.Equal(original, await f.Apps.GetAppAsync(original.Id));
        Assert.Equal(0, f.Adapter.StartCount); Assert.Equal(0, f.Adapter.StopCount);
    }

    [Fact]
    public async Task CandidateWorkspaceRuntime_GroupActivationUsesReviewedWorkspaceRecipeAndRetainsPackageReturn()
    {
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        await AddManifestPackageRuntime(f, tree); await AddCandidateOnlyRuntime(tree);
        var installed = (await f.Apps.GetAppAsync("test.created"))!;
        var installedJson = await File.ReadAllTextAsync(installed.ManifestPath!);
        var candidate = await f.Service.PrepareExecutionCandidateAsync(installed, tree.Path, CandidateOnlyRuntime,
            new(owner.UserId, "workspace-local", TrustedLocalOperator: true), default);
        await f.Service.ApproveWorkspaceManifestAsync(candidate.Review, owner.UserId, [], default);
        var selection = new WorkspaceActivationSelection(false, Apps: [new(installed.Id, Runtime: CandidateOnlyRuntime)]);
        var planner = new WorkspaceActivationPlanner(workspaces, new(workspaces, f.Apps, f.Clock), f.Apps, CoreSourceService(f));
        var row = Assert.Single((await planner.PlanAsync(tree.WorkspaceId, owner.UserId, selection, default)).Participants,
            row => row.Kind == "app");
        Assert.Null(row.Unavailable); Assert.Contains(CandidateOnlyRuntime, row.AvailableRuntimes);
        Assert.Equal(CandidateOnlyRuntime, row.TargetRuntime);
        var service = ActivationService(f, workspaces); var id = Guid.NewGuid().ToString();
        Assert.Equal("prepared", (await service.PrepareAsync(tree.WorkspaceId, new(id, owner.UserId, selection), default)).Phase);
        Assert.Equal(0, f.Adapter.StartCount); Assert.Equal(0, f.Adapter.StopCount);
        Assert.Equal("active", (await service.ApplyAppsAsync(id, default)).Phase);
        await f.Service.ValidateActivationAppAsync(WorkspaceRuntimeFiles.Read(f.Paths.DataRoot, id), installed.Id, default);
        Assert.Equal(CandidateOnlyRuntime, (await f.Apps.GetAppAsync(installed.Id))!.SelectedRuntime);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "manifest.json"), "{ removed candidate");
        var request = new WorkspaceReturnRequest(Guid.NewGuid().ToString(), [installed.Id], false, true);
        await service.PrepareReturnAsync(id, request, default); await service.ReturnAppsAsync(id, default);
        var restored = (await f.Apps.GetAppAsync(installed.Id))!;
        Assert.Equal("docker", restored.SelectedRuntime); Assert.Equal(installed.ManifestPath, restored.ManifestPath);
        Assert.Equal(installedJson, await File.ReadAllTextAsync(restored.ManifestPath!));
        Assert.Contains(installed.Id, WorkspaceRuntimeFiles.Read(f.Paths.DataRoot, id).ReturnedApps!);
    }
}
