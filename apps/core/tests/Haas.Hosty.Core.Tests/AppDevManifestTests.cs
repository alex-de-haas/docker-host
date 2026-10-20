using System.Text.Json.Nodes;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    private static async Task EditDevManifest(string root, Action<JsonObject> edit)
    {
        var path = Path.Combine(root, "manifest.json");
        var manifest = JsonNode.Parse(await File.ReadAllTextAsync(path))!.AsObject();
        edit(manifest);
        await File.WriteAllTextAsync(path, manifest.ToJsonString());
    }

    [Fact]
    public async Task DevMode_VersionEditsAllowEntryRestartAndReturnWithoutReplacingInstalledManifest()
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        await f.Service.StartAsync("test.created");
        var before = (await f.Apps.GetAppAsync("test.created"))!;
        var installed = await File.ReadAllTextAsync(before.ManifestPath!);
        await EditDevManifest(tree.Path, manifest => manifest["version"] = "0.2.0");
        var actor = DevActor(owner);
        Assert.Equal("active", (await ApplyReviewedDev(f.Service, DevRequest("enter", tree.Id), actor)).Phase);
        await EditDevManifest(tree.Path, manifest => manifest["version"] = "0.2.1");
        Assert.Equal("running", (await f.Service.RestartAsync("test.created")).App!.RuntimeState);
        Assert.Equal("active", (await ApplyReviewedDev(f.RecreateService(), DevRequest("restart"), actor)).Phase);
        await f.Service.StopAsync("test.created");
        Assert.Equal("running", (await f.Service.StartAsync("test.created")).App!.RuntimeState);
        var returned = await ApplyReviewedDev(f.Service, DevRequest("return", accept: true), actor);
        Assert.Equal("returned", returned.Phase);
        Assert.Equal("running", returned.App.RuntimeState);
        Assert.Equal(before.Version, returned.App.Version);
        Assert.Equal(installed, await File.ReadAllTextAsync(before.ManifestPath!));
        Assert.Equal("0.2.1", JsonNode.Parse(await File.ReadAllTextAsync(Path.Combine(tree.Path, "manifest.json")))!["version"]!.GetValue<string>());
    }

    [Theory]
    [InlineData("corePermissions")]
    [InlineData("optionalCorePermissions")]
    [InlineData("command")]
    [InlineData("environment")]
    public async Task DevMode_VersionEditsDoNotAdmitOtherContractChanges(string changed)
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        await f.Service.StartAsync("test.created");
        var stops = f.Adapter.StopCount;
        await EditDevManifest(tree.Path, manifest =>
        {
            manifest["version"] = "0.2.0";
            if (changed is "corePermissions" or "optionalCorePermissions") manifest[changed] = new JsonArray("apps.read");
            else
            {
                var runtime = manifest["services"]![0]!["runtimes"]!["dev"]!;
                if (changed == "command") runtime["command"] = "npm run different-command";
                else
                {
                    runtime["environment"] ??= new JsonObject();
                    runtime["environment"]!["CHANGED"] = "yes";
                }
            }
        });
        Assert.Equal("dev_contract_changed", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Service.PlanDevModeAsync("test.created", DevRequest("enter", tree.Id), DevActor(owner)))).Code);
        Assert.Equal(stops, f.Adapter.StopCount);
        Assert.Empty(await f.Backups.ListBackupsAsync("test.created"));
        Assert.Equal("running", (await f.Apps.GetAppAsync("test.created"))!.RuntimeState);
    }

    [Fact]
    public async Task DevMode_VersionChangeAfterEntryDoesNotHideNewPermissionsOnRestart()
    {
        var (f, owner, _, tree, _, _) = await LocalHandoffFixture();
        var actor = DevActor(owner);
        await ApplyReviewedDev(f.Service, DevRequest("enter", tree.Id), actor);
        await f.Service.StopAsync("test.created");
        await EditDevManifest(tree.Path, manifest =>
        {
            manifest["version"] = "0.2.0";
            manifest["optionalCorePermissions"] = new JsonArray("apps.read");
        });
        var starts = f.Adapter.StartCount;
        Assert.Equal("dev_contract_changed", (await Assert.ThrowsAsync<AppLifecycleException>(() =>
            f.Service.StartAsync("test.created"))).Code);
        Assert.Equal(starts, f.Adapter.StartCount);
        Assert.Equal("returned", (await ApplyReviewedDev(f.Service, DevRequest("return", accept: true), actor)).Phase);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ActivationExecution_VersionEditKeepsInstalledContractForSystemAndOrdinaryApps(bool system)
    {
        var (f, owner, workspaces, tree, _, _) = await LocalHandoffFixture();
        await f.Apps.UpdateAppAsync("test.created", app => app with { System = system });
        await EditDevManifest(tree.Path, manifest => manifest["version"] = "0.2.0");
        var before = (await f.Apps.GetAppAsync("test.created"))!;
        var installed = await File.ReadAllTextAsync(before.ManifestPath!);
        var service = ActivationService(f, workspaces);
        var request = new WorkspaceActivationRequest(Guid.NewGuid().ToString(), owner.UserId, new(false));
        Assert.Equal("prepared", (await service.PrepareAsync(tree.WorkspaceId, request, default)).Phase);
        Assert.Equal("active", (await service.ApplyAppsAsync(request.RequestId, default)).Phase);
        Assert.Equal(before.Version, (await f.Apps.GetAppAsync("test.created"))!.Version);
        Assert.Equal(installed, await File.ReadAllTextAsync(before.ManifestPath!));
    }
}


public sealed class AppDevelopmentManifestTests
{
    [Fact]
    public void VersionFormattingAndPropertyOrderAreNotExecutionChanges()
    {
        Assert.True(AppDevelopmentManifest.HasSameContract(
            """{"version":"0.1.0","id":"test.app","services":[],"corePermissions":["apps.read"]}""",
            """{ "corePermissions": ["apps.read"], "services": [], "id": "test.app", "version": "0.2.0" }"""));
    }

    [Theory]
    [InlineData("version")]
    [InlineData("unknownPermission")]
    public void NestedVersionsAndUnknownFieldsStillBelongToTheContract(string field)
    {
        var before = new JsonObject { ["version"] = "0.1.0", ["extension"] = new JsonObject { [field] = "before" } };
        var after = (JsonObject)before.DeepClone();
        after["version"] = "0.2.0";
        after["extension"]![field] = "after";
        Assert.False(AppDevelopmentManifest.HasSameContract(before.ToJsonString(), after.ToJsonString()));
    }
}
