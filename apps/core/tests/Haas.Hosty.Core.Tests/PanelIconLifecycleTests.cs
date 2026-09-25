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

    [Fact]
    public async Task UnchangedLegacyPanelManifestCanBeCheckedButNewAuthoringStillRequiresIcons()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var source = await fixture.WriteManifestAsync("1.0.0");
        await fixture.Service.InstallAsync(new AppInstallRequest(source));
        var app = (await fixture.Apps.GetAppAsync("com.example.notes"))!;
        var document = JsonNode.Parse(await File.ReadAllTextAsync(source))!;
        document["ui"] = new JsonObject
        {
            ["panels"] = new JsonArray(new JsonObject
            {
                ["endpoint"] = "app.http", ["path"] = "/panel", ["label"] = "Legacy tool",
            }),
        };
        // Simulate a pre-upgrade installation; both its reviewed copy and update source lack icons.
        await File.WriteAllTextAsync(source, document.ToJsonString());
        await File.WriteAllTextAsync(app.ManifestPath!, document.ToJsonString());
        var plan = await fixture.Service.CreateUpdatePlanAsync(app.Id, new AppUpdatePlanRequest());
        Assert.Equal("1.0.0", plan.TargetVersion);
        var install = await Assert.ThrowsAsync<AppManifestException>(() => fixture.Service.CreateInstallPlanAsync(new(source)));
        Assert.Contains(install.Errors, e => e.Code == "app_manifest_ui_panel_icon_required");
        document["version"] = "1.0.1";
        await File.WriteAllTextAsync(source, document.ToJsonString());
        var update = await Assert.ThrowsAsync<AppManifestException>(() => fixture.Service.CreateUpdatePlanAsync(app.Id, new AppUpdatePlanRequest()));
        Assert.Contains(update.Errors, e => e.Code == "app_manifest_ui_panel_icon_required");
    }

    [Fact]
    public async Task StoppedResourcesUseDeclaredServicesAfterHealthIsCleared()
    {
        var fixture = await LifecycleFixture.CreateAsync();
        var source = await fixture.WriteManifestAsync("1.0.0");
        var document = JsonNode.Parse((await File.ReadAllTextAsync(source)).Replace("\"app\"", "\"backend\""))!;
        var worker = document["services"]![0]!.DeepClone();
        worker["key"] = "worker";
        worker["runtimes"]!["docker"]!.AsObject().Remove("ports");
        document["services"]!.AsArray().Add(worker);
        await File.WriteAllTextAsync(source, document.ToJsonString());
        await fixture.Service.InstallAsync(new(source));
        await fixture.Service.StopAsync("com.example.notes");
        var app = (await fixture.Apps.GetAppAsync("com.example.notes"))!;
        Assert.Null(app.Health);
        var sampler = new RuntimeResourceSampler(null!, null!, null!, new CoreEventHub(), new SystemClock(),
            Microsoft.Extensions.Logging.Abstractions.NullLogger<RuntimeResourceSampler>.Instance, new AppManifestService());
        var samples = new List<RuntimeResourceSample>();
        await sampler.ReconcileAppAsync(samples, app, DateTimeOffset.UtcNow, CancellationToken.None);
        Assert.Equal(["backend", "worker"], samples.Select(s => s.Service).Order());
        Assert.All(samples, s => { Assert.Equal(0d, s.CpuPercent); Assert.Equal(0d, s.MemoryBytes); });
    }
}
