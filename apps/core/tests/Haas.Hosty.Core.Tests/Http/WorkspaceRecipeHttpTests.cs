using System.Net;
using System.Net.Http.Json;
using System.Text.Json.Nodes;
using Haas.Hosty.Core;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class WorkspaceRecipeHttpTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task WorkspaceRecipe_SourceOnlyAuthorityConfiguresMetadataButCannotStartTheApp(bool inspection)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await AppManagementHttpTests.CreateAppClient(host, "example.editor", [CoreAppPermissions.Sources]);
        var paths = host.Services.GetRequiredService<CoreDataPaths>();
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var caller = (await apps.GetAppAsync("example.editor"))!;
        var origin = Directory.CreateDirectory(Path.Combine(paths.CoreRoot, "recipe-source")).FullName;
        var manifest = JsonNode.Parse("""
            {"schemaVersion":"app.0.1","id":"example.target","name":"Target","version":"0.1.0",
             "runtimeProfiles":[{"key":"dev","type":"localCommand","default":true,"development":true}],"defaultRuntime":"dev",
             "services":[{"key":"app","runtimes":{"dev":{"type":"localCommand","command":"echo not-started","workingDirectory":"."}}}]}
            """)!.AsObject();
        manifest["source"] = new JsonObject { ["type"] = "git", ["repository"] = origin, ["branch"] = "main" };
        var manifestPath = Path.Combine(origin, "manifest.json");
        await File.WriteAllTextAsync(manifestPath, manifest.ToJsonString());
        await DevelopmentWorkspaceService.Git(origin, ["init", "--initial-branch=main"], default);
        await DevelopmentWorkspaceService.Git(origin, ["add", "manifest.json"], default);
        await DevelopmentWorkspaceService.Git(origin, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "initial"], default);
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        await apps.UpsertAppAsync(new AppRecord("example.target", "Target", null, "0.1.0", "runtime", false, origin,
            manifestPath, null, "dev", "installed", "stopped", null, null, [], new Dictionary<string, AppSettingValue>(), [], [], [], now, now,
            SourceState: new("git", origin, "main", null, origin, null, now),
            RuntimeProfiles: [new("dev", "localCommand", true, true)]));
        var owner = new WorkspaceOwner(caller.Id, caller.InstalledAt, "actor", "recipe-session");
        var workspaces = host.Services.GetRequiredService<DevelopmentWorkspaceService>();
        var tree = await workspaces.PrepareAsync(owner, new(Guid.NewGuid().ToString(), owner.SessionId, "example.target", "/assistant",
            Name: "Configure workspace runtime"), default);
        var route = inspection ? $"/api/internal/apps/{caller.Id}/workspace-inspection/{tree.WorkspaceId}/execution-recipe"
            : $"/api/development/workspaces/{tree.WorkspaceId}/execution-recipe";
        if (inspection)
            client.DefaultRequestHeaders.Add("X-Hosty-User-Token", client.DefaultRequestHeaders.GetValues(AppManagementAuthorization.IdentityHeader).Single());
        var command = new WorkspaceRecipeRequest(Guid.NewGuid().ToString(), "example.target", tree.Id, "dev");
        var response = await client.PostAsJsonAsync(route, command, CoreJson.TypeInfo<WorkspaceRecipeRequest>());
        Assert.True(response.StatusCode == HttpStatusCode.OK, await response.Content.ReadAsStringAsync());
        var result = await response.Content.ReadFromJsonAsync(CoreJson.TypeInfo<WorkspaceExecutionRecipe>());
        Assert.Equal("dev", result!.Runtime);
        Assert.DoesNotContain(CoreAppPermissions.AppLifecycle, caller.GrantedCorePermissions!);
        Assert.DoesNotContain(CoreAppPermissions.Install, caller.GrantedCorePermissions!);
        Assert.Equal("stopped", (await apps.GetAppAsync(command.AppId))!.RuntimeState);
        Assert.Null((await apps.GetAppAsync(command.AppId))!.DevModeId);
        Assert.Equal(tree.SourceStamp, (await workspaces.Read(tree.Id, owner, default)).SourceStamp);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync($"/api/apps/{command.AppId}/execution-target",
            new { requestId = Guid.NewGuid().ToString(), kind = "workspace", workspaceId = tree.WorkspaceId, worktreeId = tree.Id })).StatusCode);
        await apps.UpdateAppAsync(caller.Id, current => current with { GrantedCorePermissions = [] });
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync(route, command, CoreJson.TypeInfo<WorkspaceRecipeRequest>())).StatusCode);
    }
}
