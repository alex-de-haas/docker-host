using System.Text.Json.Nodes;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task RetiredManifest_RemainsManageableWithoutAllowingExecution(bool remove)
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var installed = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(installed));
        var app = (await fixture.Apps.GetAppAsync("com.example.notes"))!;
        // Simulate the reviewed copy already on disk when Core is upgraded first.
        var baseline = JsonNode.Parse(await File.ReadAllTextAsync(app.ManifestPath!))!;
        baseline["agentWorker"] = new JsonObject { ["service"] = "app", ["image"] = "legacy/worker:1" };
        await File.WriteAllTextAsync(app.ManifestPath!, baseline.ToJsonString());
        var data = Path.Combine(fixture.Paths.AppsRoot, app.Id, "data", "keep.txt");
        await File.WriteAllTextAsync(data, "existing app data");

        var error = await Assert.ThrowsAsync<AppLifecycleException>(() => fixture.Service.StartAsync(app.Id));
        Assert.Equal("app_manifest_agent_worker_retired", error.Code);
        await fixture.Service.StopAsync(app.Id);
        if (remove)
        {
            await fixture.Service.RemoveAsync(app.Id, new AppRemoveRequest(DeleteData: false));
        }
        else
        {
            var candidate = await fixture.WriteManifestAsync("2.0.0");
            var plan = await fixture.Service.CreateUpdatePlanAsync(app.Id, new AppUpdatePlanRequest(candidate));
            var result = await fixture.Service.ApplyUpdateAsync(app.Id, new AppUpdateApplyRequest(plan.PlanDigest, candidate));
            Assert.Equal("2.0.0", result.App?.Version);
            await fixture.Service.StartAsync(app.Id);
        }
        Assert.Equal("existing app data", await File.ReadAllTextAsync(data));
    }
}
