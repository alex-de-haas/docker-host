using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using Haas.Hosty.Core;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class WorkspaceSharingHttpTests
{
    [Fact]
    public async Task WorkspacePermissionAllowsEveryWorkspaceWithoutLendingExecutionIdentity()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        await users.WriteAsync(new(1, [new("owner", "owner@example.test", "Owner", "host.admin", false, now, now),
            new("member", "member@example.test", "Member", "host.admin", false, now, now),
            new("outsider", "outsider@example.test", "Outsider", "host.admin", false, now, now)], [], [], []));
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var assistant = new AppRecord("example.assistant", "Independent assistant", null, "1.0.0", "runtime", true, "installed", null, null,
            "local", "installed", "running", null, null, [], new Dictionary<string, AppSettingValue>(), [], [], [], now, now)
        {
            ConfirmedRoles = ["assistant"], GrantedCorePermissions = [CoreAppPermissions.Sources, CoreAppPermissions.WorkspacesRead],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["assistant"] = [new("default", null, "/chat")] }
        };
        await apps.UpsertAppAsync(assistant);
        var root = Path.Combine(host.Services.GetRequiredService<CoreDataPaths>().CoreRoot, "sharing-fixture");
        Directory.CreateDirectory(root);
        await Git(root, "init", "--initial-branch=main");
        await File.WriteAllTextAsync(Path.Combine(root, "README.md"), "shared source");
        await Git(root, "add", ".");
        await Git(root, "-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "initial");
        await apps.UpsertAppAsync(assistant with { Id = "example.source", SourceState = new("git", root, "main", null, root, null, now) });
        using var owner = await Client("owner"); using var member = await Client("member"); using var outsider = await Client("outsider");
        const string api = "/api/internal/apps/example.assistant";
        var prepared = await owner.PostAsJsonAsync(api + "/sessions/first/workspaces",
            new WorkspacePrepare(Guid.NewGuid().ToString(), "first", "example.source", "/chat/first"), CoreJson.TypeInfo<WorkspacePrepare>());
        Assert.Equal(HttpStatusCode.OK, prepared.StatusCode);
        var tree = (await prepared.Content.ReadFromJsonAsync(CoreJson.TypeInfo<DevelopmentWorkspace>()))!;
        var participants = api + "/workspace-inspection/" + tree.WorkspaceId + "/participants";
        var association = api + "/sessions/second/workspace-association/" + tree.WorkspaceId;
        Assert.Equal(HttpStatusCode.OK, (await member.GetAsync(participants)).StatusCode);
        var state = (await owner.GetFromJsonAsync(participants, CoreJson.TypeInfo<WorkspaceParticipationView>()))!;
        var attached = await member.PostAsJsonAsync(association + "/attach", new WorkspaceSessionCommand(Guid.NewGuid().ToString(), state.Revision, "Member chat", "/chat/second"), CoreJson.TypeInfo<WorkspaceSessionCommand>());
        Assert.Equal(HttpStatusCode.OK, attached.StatusCode);
        state = (await attached.Content.ReadFromJsonAsync(CoreJson.TypeInfo<WorkspaceAssociationView>()))!.Workspace!;
        Assert.False(state.Sessions.Single(s => s.UserId == "owner").CanOpen);
        Assert.Null(state.Sessions.Single(s => s.UserId == "owner").ViewerPath);
        Assert.Equal("operator", state.Role);
        var shared = (await member.GetFromJsonAsync(api + "/sessions/second/workspaces", CoreJson.TypeInfo<WorkspaceList>()))!;
        Assert.Equal(tree.Path, Assert.Single(shared.Workspaces).Path);
        Assert.Null(shared.Workspaces[0].SourceGrant);
        var third = (await outsider.GetFromJsonAsync(api + "/workspace-inspection", CoreJson.TypeInfo<WorkspaceInventory>()))!;
        Assert.Single(third.Workspaces);
        Assert.Equal(HttpStatusCode.OK, (await outsider.GetAsync(api + "/workspace-inspection/" + tree.WorkspaceId + "/worktrees/" + tree.Id)).StatusCode);
        var lease = Guid.NewGuid().ToString();
        Assert.Equal(HttpStatusCode.OK, (await owner.PostAsJsonAsync(api + "/sessions/first/workspaces/" + tree.Id + "/operations/lease",
            new WorkspaceCommand(Guid.NewGuid().ToString(), LeaseId: lease), CoreJson.TypeInfo<WorkspaceCommand>())).StatusCode);
        // A forged user property is ignored: authority still comes from Member's own app grant.
        Assert.Equal(HttpStatusCode.Conflict, (await member.PostAsJsonAsync(api + "/sessions/second/workspace-activity",
            new { userId = "owner", status = "idle", leaseId = lease, stopped = true })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await member.GetAsync(api + "/sessions/second/workspaces/" + tree.Id)).StatusCode);
        Assert.Contains(lease, (await host.Services.GetRequiredService<DevelopmentWorkspaceService>().Read(tree.Id, null, default)).Leases);
        Assert.Equal(HttpStatusCode.OK, (await owner.PostAsJsonAsync(api + "/sessions/first/workspace-activity",
            new { status = "idle", leaseId = lease, stopped = true })).StatusCode);
        state = (await owner.GetFromJsonAsync(participants, CoreJson.TypeInfo<WorkspaceParticipationView>()))!;
        Assert.Equal(HttpStatusCode.OK, (await owner.PostAsJsonAsync(api + "/sessions/first/workspace-association/" + tree.WorkspaceId + "/detach",
            new WorkspaceSessionCommand(Guid.NewGuid().ToString(), state.Revision), CoreJson.TypeInfo<WorkspaceSessionCommand>())).StatusCode);
        var detachedWorkflow = await owner.GetAsync(api + "/sessions/first/workspaces/workflow");
        Assert.Equal(HttpStatusCode.OK, detachedWorkflow.StatusCode);
        Assert.Equal(new WorkspaceWorkflow(), await detachedWorkflow.Content.ReadFromJsonAsync(CoreJson.TypeInfo<WorkspaceWorkflow>()));
        Assert.Equal(HttpStatusCode.OK, (await owner.GetAsync(api + "/sessions/first/workspaces/" + tree.Id)).StatusCode);
        Assert.DoesNotContain(await apps.ListAppRecordsAsync(), a => a.Id.StartsWith("hosty.", StringComparison.Ordinal));

        async Task<HttpClient> Client(string user)
        {
            var client = host.CreateClient();
            client.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(assistant.Id));
            client.DefaultRequestHeaders.Add("X-Hosty-User-Token", (await BrowserAuthorityFixture.Grant(host, assistant.Id, user, browserId: "browser-" + user)).AccessToken);
            return client;
        }
    }

    private static async Task Git(string directory, params string[] args)
    {
        var start = new ProcessStartInfo("git") { WorkingDirectory = directory, RedirectStandardError = true, RedirectStandardOutput = true };
        foreach (var arg in args) start.ArgumentList.Add(arg);
        using var process = Process.Start(start)!;
        var output = process.StandardOutput.ReadToEndAsync(); var error = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync(); await output; Assert.True(process.ExitCode == 0, await error);
    }
}
