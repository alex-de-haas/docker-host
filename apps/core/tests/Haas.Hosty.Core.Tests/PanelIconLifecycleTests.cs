using System.Text.Json.Nodes;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Theory]
    [InlineData(null, null)]
    [InlineData("system", " ")]
    public async Task PanelIconAuthoringIsEnforcedAtInstallAndUpdateBoundaries(string? role, string? icon)
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var baseline = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(baseline));
        var candidate = await fixture.WriteManifestAsync("1.0.1");
        var document = JsonNode.Parse(await File.ReadAllTextAsync(candidate))!;
        document["role"] = role;
        document["ui"] = new JsonObject
        {
            ["entrypoint"] = new JsonObject { ["endpoint"] = "app.http", ["path"] = "/" },
            ["panels"] = new JsonArray(new JsonObject
            {
                ["endpoint"] = "app.http", ["path"] = "/panel", ["label"] = "Tool", ["icon"] = icon,
            }),
        };
        await File.WriteAllTextAsync(candidate, document.ToJsonString());

        var installPlan = await Assert.ThrowsAsync<AppManifestException>(() => fixture.Service.CreateInstallPlanAsync(new AppInstallPlanRequest(candidate)));
        var install = await Assert.ThrowsAsync<AppManifestException>(() => fixture.Service.InstallAsync(new AppInstallRequest(candidate)));
        var update = await Assert.ThrowsAsync<AppManifestException>(() => fixture.Service.CreateUpdatePlanAsync("com.example.notes", new AppUpdatePlanRequest(candidate)));
        foreach (var error in new[] { installPlan, install, update })
            Assert.Contains(error.Errors, item => item.Code == "app_manifest_ui_panel_icon_required");
        Assert.Equal("1.0.0", (await fixture.Apps.GetAppAsync("com.example.notes"))!.Version);
    }
}
