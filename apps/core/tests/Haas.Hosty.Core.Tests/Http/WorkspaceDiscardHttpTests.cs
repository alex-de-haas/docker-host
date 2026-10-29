using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Haas.Hosty.Core;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class WorkspaceDiscardHttpTests
{
    private sealed record Fixture(CoreHttpHarness Host, AppRecord Caller, DevelopmentWorkspace Tree,
        string Origin, HttpClient Client) : IAsyncDisposable
    {
        public string Route => $"/api/internal/apps/{Caller.Id}/workspace-inspection/{Tree.WorkspaceId}/discard";
        public async ValueTask DisposeAsync() { Client.Dispose(); await Host.DisposeAsync(); }
    }

    private static async Task<Fixture> CreateAsync()
    {
        var host = await CoreHttpHarness.StartAsync();
        var services = host.Services;
        var now = services.GetRequiredService<IClock>().UtcNow;
        var apps = services.GetRequiredService<AppRegistryStore>();
        var caller = AssistantMcpAccessHttpTests.Record("example.independent-workspace-ui", now) with {
            ManifestPath = null, GrantedCorePermissions = [CoreAppPermissions.Sources, CoreAppPermissions.WorkspacesRead] };
        await apps.UpsertAppAsync(caller);
        await services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1,
            [new("admin", "admin@example.test", "Admin", "host.admin", false, now, now),
             new("other-admin", "other@example.test", "Other", "host.admin", false, now, now)], [], [], []));
        var origin = Path.Combine(services.GetRequiredService<CoreDataPaths>().CoreRoot, "discard-source");
        Directory.CreateDirectory(origin);
        await DevelopmentWorkspaceService.Git(origin, ["init", "--initial-branch=main"], default);
        await File.WriteAllTextAsync(Path.Combine(origin, "README.md"), "original source");
        await DevelopmentWorkspaceService.Git(origin, ["add", "."], default);
        await DevelopmentWorkspaceService.Git(origin, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "initial"], default);
        await apps.UpsertAppAsync(caller with { Id = "example.unrelated-source", SourceState = new("git", origin, "main", null, origin, null, now) });
        // Preparation belongs to a disconnected external client; disposal uses the operator identity.
        var owner = WorkspaceOwner.ForExternal("admin", "oauth:old-client-no-longer-connected", "old-task", "Former client");
        var service = services.GetRequiredService<DevelopmentWorkspaceService>();
        var lease = Guid.NewGuid().ToString();
        var tree = await service.PrepareAsync(owner, new(Guid.NewGuid().ToString(), owner.SessionId, "example.unrelated-source", null,
            "main", lease, Name: "Discard me"), default);
        tree = await service.CommandAsync(tree.Id, owner, "release-lease", new(Guid.NewGuid().ToString(), LeaseId: lease), default);
        await File.WriteAllTextAsync(Path.Combine(tree.Path, "README.md"), "uncommitted operator-approved loss");
        var client = host.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", services.GetRequiredService<AppServiceTokenService>().CreateToken(caller.Id));
        client.DefaultRequestHeaders.Add("X-Hosty-User-Token", (await BrowserAuthorityFixture.Grant(host, caller.Id, "admin")).AccessToken);
        return new(host, caller, tree, origin, client);
    }

    private static async Task<JsonElement> PlanAsync(Fixture f)
    {
        using var response = await f.Client.GetAsync(f.Route + "/plan");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("no-store", response.Headers.CacheControl!.ToString());
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    private static object ApplyBody(JsonElement plan, string? requestId = null)
        => new { requestId = requestId ?? Guid.NewGuid().ToString(), expectedRevision = plan.GetProperty("revision").GetInt64(),
            digest = plan.GetProperty("digest").GetString(), confirmationName = plan.GetProperty("name").GetString() };

    [Fact]
    public async Task DiscardRoutesRequireActiveAdministratorAndManagementAuthorityRatherThanInspectionAlone()
    {
        await using var f = await CreateAsync();
        var plan = await PlanAsync(f);
        var body = ApplyBody(plan);
        var apps = f.Host.Services.GetRequiredService<AppRegistryStore>();
        using var anonymous = f.Host.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync(f.Route + "/plan")).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.PostAsJsonAsync(f.Route + "/apply", body)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anonymous.GetAsync(f.Route + "/status?requestId=" + Guid.NewGuid())).StatusCode);
        await apps.UpsertAppAsync(f.Caller with { GrantedCorePermissions = [CoreAppPermissions.WorkspacesRead] });
        Assert.Equal(HttpStatusCode.Forbidden, (await f.Client.GetAsync(f.Route + "/plan")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await f.Client.GetAsync(f.Route + "/status?requestId=" + Guid.NewGuid())).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await f.Client.PostAsJsonAsync(f.Route + "/apply", body)).StatusCode);
        await apps.UpsertAppAsync(f.Caller);
        f.Client.DefaultRequestHeaders.Add("Cookie", "hosty_session=browser-session");
        Assert.Equal(HttpStatusCode.Forbidden, (await f.Client.GetAsync(f.Route + "/plan")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await f.Client.PostAsJsonAsync(f.Route + "/apply", body)).StatusCode);
        f.Client.DefaultRequestHeaders.Remove("Cookie");
        await f.Host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(state => state with {
            Users = state.Users.Select(user => user.Id == "admin" ? user with { Role = "host.member" } : user).ToArray() });
        Assert.Equal(HttpStatusCode.Forbidden, (await f.Client.GetAsync(f.Route + "/plan")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await f.Client.PostAsJsonAsync(f.Route + "/apply", body)).StatusCode);
        Assert.Equal("uncommitted operator-approved loss", await File.ReadAllTextAsync(Path.Combine(f.Tree.Path, "README.md")));
    }

    [Fact]
    public async Task DiscardOperatorDoesNotNeedOriginalExternalAgentAndStatusReplaysAfterSourceAndMetadataRemoval()
    {
        await using var f = await CreateAsync();
        var plan = await PlanAsync(f);
        Assert.Equal("Discard me", plan.GetProperty("name").GetString());
        var requestId = Guid.NewGuid().ToString();
        var body = ApplyBody(plan, requestId);
        using var response = await f.Client.PostAsJsonAsync(f.Route + "/apply", body);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.False(Directory.Exists(f.Tree.Path));
        using var status = await f.Client.GetAsync(f.Route + "/status?requestId=" + requestId);
        Assert.Equal(HttpStatusCode.OK, status.StatusCode);
        Assert.Equal("no-store", status.Headers.CacheControl!.ToString());
        var receipt = await status.Content.ReadAsStringAsync();
        Assert.Contains(requestId, receipt);
        Assert.DoesNotContain("uncommitted operator-approved loss", receipt);
        Assert.Equal(HttpStatusCode.OK, (await f.Client.PostAsJsonAsync(f.Route + "/apply", body)).StatusCode);
        var service = f.Host.Services.GetRequiredService<DevelopmentWorkspaceService>();
        Assert.Empty((await service.ListAsync(f.Tree.Owner, true, default)).Workspaces);
        Assert.Equal("original source", await File.ReadAllTextAsync(Path.Combine(f.Origin, "README.md")));
        Assert.DoesNotContain((await f.Host.Services.GetRequiredService<AppRegistryStore>().ListAppRecordsAsync(default)), app => app.Id.StartsWith("hosty.", StringComparison.Ordinal));
    }

    [Fact]
    public async Task LegacyDiscardKeepsReviewBindingButSharesAcceptedRemovalReceipt()
    {
        await using var f = await CreateAsync();
        var plan = await PlanAsync(f);
        var requestId = Guid.NewGuid().ToString();
        var body = ApplyBody(plan, requestId);
        var other = await BrowserAuthorityFixture.Grant(f.Host, f.Caller.Id, "other-admin", "another-browser");
        using var client = f.Host.CreateClient();
        client.DefaultRequestHeaders.Authorization = f.Client.DefaultRequestHeaders.Authorization;
        client.DefaultRequestHeaders.Add("X-Hosty-User-Token", other.AccessToken);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync(f.Route + "/plan")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync(f.Route + "/apply", body)).StatusCode);
        Assert.True(Directory.Exists(f.Tree.Path));
        Assert.Equal(HttpStatusCode.OK, (await f.Client.PostAsJsonAsync(f.Route + "/apply", body)).StatusCode);
        var result = await client.GetAsync(f.Route + "/status?requestId=" + requestId);
        Assert.Equal(HttpStatusCode.OK, result.StatusCode);
    }
}
