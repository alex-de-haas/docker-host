using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Haas.Hosty.Core;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class WorkspaceNameHttpTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task WorkspaceNames_SessionAndInspectionRoutesRequireCurrentManagementAuthority(bool inspection)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var services = host.Services;
        var now = services.GetRequiredService<IClock>().UtcNow;
        var apps = services.GetRequiredService<AppRegistryStore>();
        await services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1,
            [new("admin", "admin@example.test", "Admin", "host.admin", false, now, now)], [], [], []));
        var app = new AppRecord("hosty.harness", "Harness", null, "1.0.0", "runtime", true, "installed", null, null,
            "local", "installed", "running", null, null, [], new Dictionary<string, AppSettingValue>(), [], [], [], now, now)
            { ConfirmedRoles = ["assistant"], GrantedCorePermissions = [CoreAppPermissions.Sources, CoreAppPermissions.WorkspacesRead],
              Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["assistant"] = [new("default", null, "/assistant")] } };
        await apps.UpsertAppAsync(app);
        var origin = Path.Combine(services.GetRequiredService<CoreDataPaths>().CoreRoot, "named-source");
        Directory.CreateDirectory(origin);
        await DevelopmentWorkspaceService.Git(origin, ["init", "--initial-branch=main"], default);
        await File.WriteAllTextAsync(Path.Combine(origin, "README.md"), "source");
        await DevelopmentWorkspaceService.Git(origin, ["add", "."], default);
        await DevelopmentWorkspaceService.Git(origin, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "initial"], default);
        await apps.UpsertAppAsync(app with { Id = "source.app", SourceState = new("git", origin, "main", null, origin, null, now) });
        var owner = new WorkspaceOwner(app.Id, app.InstalledAt, "admin", "named-session");
        var workspaces = services.GetRequiredService<DevelopmentWorkspaceService>();
        var tree = await workspaces.PrepareAsync(owner, new(Guid.NewGuid().ToString(), owner.SessionId, "source.app", "/assistant",
            LeaseId: Guid.NewGuid().ToString(), Name: "Simplify runtime switching"), default);
        var route = inspection ? $"/api/internal/apps/{app.Id}/workspace-inspection/{tree.WorkspaceId}/name"
            : $"/api/internal/apps/{app.Id}/sessions/{owner.SessionId}/workspaces/name";
        var command = new WorkspaceNameCommand(Guid.NewGuid().ToString(), "Unify package and workspace selection");
        using var client = host.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsJsonAsync(route, command, CoreJson.TypeInfo<WorkspaceNameCommand>())).StatusCode);
        client.DefaultRequestHeaders.Authorization = new("Bearer", services.GetRequiredService<AppServiceTokenService>().CreateToken(app.Id));
        client.DefaultRequestHeaders.Add("X-Hosty-User-Token", (await BrowserAuthorityFixture.Grant(host, app.Id, "admin")).AccessToken);
        var response = await client.PostAsJsonAsync(route, command, CoreJson.TypeInfo<WorkspaceNameCommand>());
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>();
        Assert.Equal(command.Name, body.GetProperty("name").GetString());
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync(route, command, CoreJson.TypeInfo<WorkspaceNameCommand>())).StatusCode);
        Assert.Equal(tree.SourceStamp, (await workspaces.Read(tree.Id, owner, default)).SourceStamp);
        Assert.Equal(tree.Leases, (await workspaces.Read(tree.Id, owner, default)).Leases);
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsJsonAsync(route, command with { Name = "Different request arguments" }, CoreJson.TypeInfo<WorkspaceNameCommand>())).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync(route, command with { RequestId = Guid.NewGuid().ToString(), Name = "" }, CoreJson.TypeInfo<WorkspaceNameCommand>())).StatusCode);
        await apps.UpsertAppAsync(app with { GrantedCorePermissions = [CoreAppPermissions.WorkspacesRead] });
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync(route, command, CoreJson.TypeInfo<WorkspaceNameCommand>())).StatusCode);
        Assert.Equal(command.Name, (await workspaces.Read(tree.Id, owner, default)).Name);
    }
}
