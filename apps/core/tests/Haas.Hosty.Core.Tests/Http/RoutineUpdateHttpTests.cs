using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class RoutineUpdateHttpTests
{
    [Theory]
    [InlineData("routine")]
    [InlineData("required")]
    [InlineData("optional")]
    [InlineData("command")]
    [InlineData("revoked")]
    public async Task AppUpdate_OnlyRoutineChangesApplyWithoutConfirmation(string change)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await AppManagementHttpTests.CreateAppClient(host, "example.market", [CoreAppPermissions.Install]);
        var lifecycle = host.Services.GetRequiredService<CoreLifecycleService>();
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var path = Path.Combine(host.Services.GetRequiredService<CoreDataPaths>().DataRoot, "update-target.json");
        var required = change == "revoked" ? "\"apps.read\"" : "";
        var manifest = $$$$"""
            {"schemaVersion":"app.0.1","id":"example.target","name":"Target","version":"1.0.0",
             "corePermissions":[{{{{required}}}}],"optionalCorePermissions":[],
             "runtimeProfiles":[{"key":"dev","type":"localCommand","default":true}],"defaultRuntime":"dev",
             "services":[{"key":"app","runtimes":{"dev":{"type":"localCommand","command":"echo unused","workingDirectory":"."}}}]}
            """;
        await File.WriteAllTextAsync(path, manifest);
        await lifecycle.InstallAsync(new(path, Autostart: false));
        if (change == "revoked")
            await apps.UpdateAppAsync("example.target", app => app with { GrantedCorePermissions = [] });
        var target = manifest.Replace("1.0.0", "1.0.1");
        target = change switch
        {
            "required" => target.Replace("\"corePermissions\":[]", "\"corePermissions\":[\"apps.read\"]"),
            "optional" => target.Replace("\"optionalCorePermissions\":[]", "\"optionalCorePermissions\":[\"apps.read\"]"),
            "command" => target.Replace("echo unused", "echo changed"),
            _ => target,
        };
        await File.WriteAllTextAsync(path, target);
        var plan = await lifecycle.CreateUpdatePlanAsync("example.target", new(path));
        using var response = await client.PostAsJsonAsync("/api/apps/example.target/update", new { planDigest = plan.PlanDigest });
        if (change is "required" or "optional" or "command")
        {
            Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
            Assert.Equal("approval_required", (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString());
            Assert.Equal("1.0.0", (await apps.GetAppAsync("example.target"))!.Version);
        }
        else
        {
            response.EnsureSuccessStatusCode();
            Assert.Equal("updating", (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("status").GetString());
            if (lifecycle.TryGetRunningBackgroundUpdate("example.target") is { } run) await run;
            var updated = (await apps.GetAppAsync("example.target"))!;
            Assert.Equal("1.0.1", updated.Version);
            Assert.Empty(updated.GrantedCorePermissions!);
        }
    }
}
