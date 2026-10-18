using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Haas.Hosty.Core;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class AppCreationHttpTests
{
    [Fact]
    public async Task CreationRequiresReviewedInstallPermissionAndReturnsOwnedWorktree()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new UserDirectoryState(1,
            [new HostUserRecord("admin", "admin@example.test", "Admin", "host.admin", false, now, now)], [], [], []));
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var caller = new AppRecord("hosty.harness", "Harness", null, "1.0.0", "runtime", true, "installed", null, null,
            "local", "installed", "running", null, null, [], new Dictionary<string, AppSettingValue>(), [], [], [], now, now)
        {
            ConfirmedRoles = ["assistant"],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["assistant"] = [new("default", null, "/assistant")] },
            GrantedCorePermissions = [CoreAppPermissions.Sources],
        };
        await apps.UpsertAppAsync(caller);
        using var client = host.CreateClient();
        const string root = "/api/internal/apps/hosty.harness/sessions/session-one/app-creations";
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync(root + "/capabilities")).StatusCode);
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(caller.Id));
        client.DefaultRequestHeaders.Add("X-Hosty-User-Token", (await BrowserAuthorityFixture.Grant(host, caller.Id, "admin")).AccessToken);
        var input = new AppCreationRequest(Guid.NewGuid().ToString(), "test.creation-http", "Created app", BootstrapCommit: true, AuthorName: "Test", AuthorEmail: "test@example.test");
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync(root, input)).StatusCode);
        Assert.Null(await apps.GetAppAsync(input.AppId));
        await apps.UpsertAppAsync(caller with { GrantedCorePermissions = [CoreAppPermissions.Sources, CoreAppPermissions.Install] });
        var response = await client.PostAsJsonAsync(root, input);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True(response.Headers.CacheControl!.NoStore);
        var created = (await response.Content.ReadFromJsonAsync<AppCreationResult>())!;
        Assert.NotNull(created.Workspace);
        Assert.Equal(input.AppId, Assert.Single(created.Workspace.Apps).AppId);
        Assert.Equal("local-git", (await apps.GetAppAsync(input.AppId))!.SourceState!.Type);
        var replay = (await (await client.PostAsJsonAsync(root, input)).Content.ReadFromJsonAsync<AppCreationResult>())!;
        Assert.Equal(created.Workspace.Id, replay.Workspace!.Id);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(root.Replace("session-one", "other") + "/" + input.RequestId)).StatusCode);
        var remoteRoot = "/api/internal/apps/hosty.harness/sessions/session-one/workspaces/" + created.Workspace.Id + "/remote";
        foreach (var query in new[] { "", "?sourceAppId=", "?sourceAppId=" + new string('x', 64) })
        {
            var missingApp = await client.GetAsync(remoteRoot + query);
            Assert.Equal(HttpStatusCode.Conflict, missingApp.StatusCode);
            Assert.Equal("workspace_request_invalid", (await missingApp.Content.ReadFromJsonAsync<ErrorResponse>())!.Code);
        }
        var remote = (await client.GetFromJsonAsync<LocalRemoteStatus>(remoteRoot + "?sourceAppId=" + input.AppId))!;
        Assert.Equal(input.AppId, remote.AppId);
        Assert.Null(remote.Remote);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(remoteRoot.Replace("session-one", "other") + "?sourceAppId=" + input.AppId)).StatusCode);
        var localRoot = root + "/local/" + input.AppId;
        var local = (await client.GetFromJsonAsync<LocalAppHandoffStatus>(localRoot + "?workspaceId=" + created.Workspace.Id))!;
        var acceptance = new LocalAppHandoffRequest(Guid.NewGuid().ToString(), created.Workspace.Id, local.SourceHead, local.TargetHead);
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync(localRoot + "/accept", acceptance)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync(localRoot + "/use", acceptance with { RequestId = Guid.NewGuid().ToString() })).StatusCode);
        Assert.Equal("stopped", (await apps.GetAppAsync(input.AppId))!.RuntimeState);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync(localRoot.Replace("session-one", "other") + "?workspaceId=" + created.Workspace.Id)).StatusCode);
        var guide = (await client.GetFromJsonAsync<AppDevelopmentGuide>(root + "/guide"))!;
        Assert.Contains("Docker", guide.Text);
        Assert.True(guide.Text.Length < 20000);
    }
    [Theory]
    [InlineData("install-permission")]
    [InlineData("source-permission")]
    [InlineData("member")]
    [InlineData("disabled")]
    [InlineData("signed-out")]
    [InlineData("reinstalled")]
    [InlineData("other-user")]
    [InlineData("other-session")]
    public async Task CreationReplay_RevalidatesCurrentAuthorityWithoutChangingSource(string change)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        await users.WriteAsync(new(1, [new("admin", "admin@example.test", "Admin", "host.admin", false, now, now),
            new("other", "other@example.test", "Other", "host.admin", false, now, now)], [], [], []));
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var caller = AssistantMcpAccessHttpTests.Record("hosty.harness", now) with
        {
            ConfirmedRoles = ["assistant"],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["assistant"] = [new("default", null, "/assistant")] },
            GrantedCorePermissions = [CoreAppPermissions.Sources, CoreAppPermissions.Install],
        };
        await apps.UpsertAppAsync(caller);
        using var client = host.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(caller.Id));
        client.DefaultRequestHeaders.Add("X-Hosty-User-Token", (await BrowserAuthorityFixture.Grant(host, caller.Id, "admin")).AccessToken);
        var root = "/api/internal/apps/hosty.harness/sessions/creation/app-creations";
        var input = new AppCreationRequest(Guid.NewGuid().ToString(), "test.authority", "Authority test", BootstrapCommit: true,
            AuthorName: "Test", AuthorEmail: "test@example.test");
        var first = await client.PostAsJsonAsync(root, input);
        Assert.Equal(HttpStatusCode.OK, first.StatusCode);
        var created = (await first.Content.ReadFromJsonAsync<AppCreationResult>())!;
        var file = Path.Combine(created.Workspace!.Path, "unfinished.txt");
        await File.WriteAllTextAsync(file, "preserve uncommitted work");
        if (change == "install-permission") await apps.UpsertAppAsync(caller with { GrantedCorePermissions = [CoreAppPermissions.Sources] });
        if (change == "source-permission") await apps.UpsertAppAsync(caller with { GrantedCorePermissions = [CoreAppPermissions.Install] });
        if (change is "member" or "disabled") await users.UpdateAsync(state => state with
        {
            Users = state.Users.Select(u => u.Id != "admin" ? u : u with { Role = change == "member" ? "host.member" : u.Role, Disabled = change == "disabled" }).ToArray(),
            // A member still has ordinary app access; denial must come from workspace authority.
            Assignments = [new(caller.Id, "admin", now)],
        });
        if (change == "signed-out") await users.UpdateAsync(state => state with { Sessions = [] });
        if (change == "reinstalled") await apps.UpsertAppAsync(caller with { InstalledAt = now.AddMinutes(1) });
        if (change == "other-user")
        {
            client.DefaultRequestHeaders.Remove("X-Hosty-User-Token");
            client.DefaultRequestHeaders.Add("X-Hosty-User-Token", (await BrowserAuthorityFixture.Grant(host, caller.Id, "other", "other-browser")).AccessToken);
        }
        if (change == "other-session") root = root.Replace("/creation/", "/other-session/");
        Assert.Contains((await client.PostAsJsonAsync(root, input)).StatusCode, new[] { HttpStatusCode.Unauthorized, HttpStatusCode.Forbidden });
        if (change != "install-permission")
            Assert.Contains((await client.GetAsync(root + "/" + input.RequestId)).StatusCode, new[] { HttpStatusCode.Unauthorized, HttpStatusCode.Forbidden });
        Assert.Equal("preserve uncommitted work", await File.ReadAllTextAsync(file));
        Assert.Equal(created.Operation.Commit, (await DevelopmentWorkspaceService.Git(created.Operation.SourcePath, ["rev-parse", "HEAD"], default)).StandardOutput.Trim());
        Assert.Single(await apps.ListAppRecordsAsync(), a => a.Id == input.AppId);
    }

}
