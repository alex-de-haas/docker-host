using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Haas.Hosty.Core;
using Haas.Hosty.Core.Tests.Http;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests;

public sealed partial class CoreLifecycleServiceTests
{
    [Fact]
    public async Task ProviderMcpPublicationUsesCurrentConsumerGrantsAndRetainsProviderAttribution()
    {
        var owner = new WorkspaceOwner("independent.agent", DateTimeOffset.UtcNow, "admin", Guid.NewGuid().ToString());
        var f = await ExternalPublicationFixture(owner);
        await using var host = await CoreHttpHarness.StartAsync(f.F.Clock, services =>
        {
            services.AddSingleton(f.F.Apps);
            services.AddSingleton(f.Users);
            services.AddSingleton(f.Workspaces);
            services.AddSingleton(f.Service);
        });
        var template = (await f.F.Apps.GetAppAsync(SourceTestApp))!;
        var consumer = template with { Id = "independent.consumer", SourceState = null,
            GrantedCorePermissions = [CoreAppPermissions.AgentProviders, CoreAppPermissions.Sources] };
        var provider = consumer with { Id = owner.AppId, InstalledAt = owner.Installation, GrantedCorePermissions = [], RuntimeState = "running",
            ConfirmedRoles = ["agent"], Endpoints = [new("api", "http", "http://127.0.0.1:3999", true)],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["agent"] = [new("native", "api", "/api/agent/v2", 2, [])] } };
        await f.F.Apps.UpsertAppAsync(consumer);
        await f.F.Apps.UpsertAppAsync(provider);
        await host.Services.GetRequiredService<AgentPolicyStore>().ChangeAsync(AgentMcpDirectory.CoreId,
            new(null, true, new Dictionary<string, string>(), new Dictionary<string, AssistantTargetGrant> { [consumer.Id] = new(consumer.InstalledAt, "reviewed") }));
        var credential = await BrowserAuthorityFixture.Grant(host, consumer.Id, f.W.Owner.UserId);
        var agents = host.Services.GetRequiredService<CoreAgentExecution>();
        var session = owner.SessionId;
        var tools = new[] { "pr_connections", "pr_list", "pr_configure", "pr_commit", "pr_publish" };
        using var client = host.CreateClient();
        async Task StartRun(AppRecord origin)
        {
            var run = Guid.NewGuid().ToString();
            var request = new CoreAgentAuthorizeRequest(new(provider.Id, PanelIdentity.Installation(provider), "native"), "runs.start", "PUT",
                $"/sessions/{session}/runs/{run}", new string('a', 64), SessionId: session, RunId: run,
                Ceiling: JsonSerializer.SerializeToElement(new { mcp = new { targets = new[] { new { target = new { kind = "core" }, tools } } } }));
            var admission = await agents.Authorize(origin, credential.AccessToken, request, default);
            await agents.Admit(provider, admission.AdmissionRef, default);
            var mcp = await agents.McpToken(provider, new(admission.AdmissionRef, new("core")), default);
            client.DefaultRequestHeaders.Authorization = new("Bearer", mcp.Token);
        }
        async Task<JsonElement> Call(string name, object arguments)
        {
            var result = await DirectEnvironmentHttpTests.Tool(client, name, arguments);
            Assert.False(result.TryGetProperty("isError", out var error) && error.GetBoolean(), result.ToString());
            return result.GetProperty("structuredContent");
        }
        Task<HttpResponseMessage> Send(string name, object arguments) => client.PostAsJsonAsync("/api/mcp",
            new { jsonrpc = "2.0", id = 1, method = "tools/call", @params = new { name, arguments } });

        await StartRun(consumer);
        var listed = await Call("pr_connections", new { });
        Assert.Equal("connection", Assert.Single(listed.GetProperty("connections").EnumerateArray()).GetProperty("id").GetString());
        var configure = new { input = new { worktreeId = f.W.Id, input = new { requestId = Guid.NewGuid().ToString(), connectionId = "connection" } } };
        using var writeDenied = await Send("pr_configure", configure);
        Assert.Equal(HttpStatusCode.Forbidden, writeDenied.StatusCode);
        Assert.Contains("app_permission_required", await writeDenied.Content.ReadAsStringAsync());

        consumer = consumer with { GrantedCorePermissions = [CoreAppPermissions.AgentProviders, CoreAppPermissions.Sources, CoreAppPermissions.PublicationWrite],
            PermissionRevision = "publication-reviewed" };
        await f.F.Apps.UpsertAppAsync(consumer);
        await StartRun(consumer);
        var configured = await Call("pr_configure", configure);
        Assert.Equal(owner, configured.GetProperty("owner").Deserialize(CoreJson.TypeInfo<WorkspaceOwner>()));
        var saved = await f.Service.ReadInspectionRecordAsync(f.W.Id, default);
        Assert.Equal(new CoreAppPermissionSource(consumer.Id, consumer.InstalledAt), saved!.PermissionSource);
        var publications = await Call("pr_list", new { input = new { workspaceId = f.W.WorkspaceId } });
        Assert.Equal(f.W.Id, Assert.Single(publications.GetProperty("publications").EnumerateArray()).GetProperty("workspaceId").GetString());
        await File.WriteAllTextAsync(Path.Combine(f.W.Path, "feature.txt"), "agent contribution");
        var committed = await Call("pr_commit", new { input = new { worktreeId = f.W.Id, input = new { requestId = Guid.NewGuid().ToString(),
            expectedHead = f.W.Observation!.Head, message = "Add feature", paths = new[] { "feature.txt" } } } });
        Assert.Equal("succeeded", committed.GetProperty("operations").EnumerateArray().Single(o => o.GetProperty("kind").GetString() == "commit").GetProperty("state").GetString());
        var head = (await f.Workspaces.ObserveAsync(f.W.Id, owner, default)).Observation!.Head;
        Assert.NotEqual(f.W.Observation!.Head, head);
        var publish = new { input = new { worktreeId = f.W.Id, input = new { requestId = Guid.NewGuid().ToString(), expectedHead = head, title = "Contribution" } } };
        var published = await Call("pr_publish", publish);
        Assert.Equal("open", published.GetProperty("observation").GetProperty("state").GetString());
        Assert.Equal(provider.Id, published.GetProperty("operations").EnumerateArray().Single(o => o.GetProperty("kind").GetString() == "publish").GetProperty("actor").GetProperty("appId").GetString());
        await Call("pr_publish", publish);
        Assert.Equal(1, f.Provider.Created);
        Assert.Equal("open", (await f.Service.ObserveAsync(f.W.Id, null, default)).Observation!.State);

        await f.F.Apps.UpsertAppAsync(consumer with { GrantedCorePermissions = [CoreAppPermissions.AgentProviders], PermissionRevision = "revoked" });
        using var revoked = await Send("pr_connections", new { });
        Assert.Equal(HttpStatusCode.Forbidden, revoked.StatusCode);
        Assert.Equal("unavailable", (await f.Service.ObserveAsync(f.W.Id, null, default)).Observation!.State);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CanonicalPublication_CurrentUserCanContinueAcrossCreatorClients(bool external)
    {
        var f = await PublicationFixture();
        var actor = external ? WorkspaceOwner.ForExternal(f.W.Owner.UserId, "manual:reviewed", "independent-task", "Independent client")
            : f.W.Owner with { AppId = "independent.editor", SessionId = "opaque-allocation" };
        if (!external) await f.F.Apps.UpsertAppAsync((await f.F.Apps.GetAppAsync(f.W.Owner.AppId))! with { Id = actor.AppId });
        Assert.Empty((await f.Service.ListAsync(actor, default)).Publications);
        Assert.Single((await f.Service.ListAsync(actor, default, canonical: true)).Publications);
        await f.F.Apps.RemoveAppAsync(f.W.Owner.AppId);
        var input = new PublicationCommand(Guid.NewGuid().ToString(), f.W.Observation!.Head, Title: "Independent publication");
        var result = await f.Service.CommandAsync(f.W.Id, actor, "publish", input, default, canonical: true);
        Assert.Equal(1, f.Provider.Created);
        Assert.Equal(f.W.Owner, result.Owner); // Creator attribution is immutable.
        Assert.Equal(actor, Assert.Single(result.Operations).Actor);
        Assert.Equal("open", result.Observation!.State);
        await f.Service.CommandAsync(f.W.Id, actor, "publish", input, default, canonical: true);
        Assert.Equal(1, f.Provider.Created);
        Assert.Equal("open", (await f.Service.ObserveAsync(f.W.Id, actor, default, canonical: true)).Observation!.State);
        var otherUser = actor with { UserId = "another-admin" };
        await f.Users.UpdateAsync(s => s with { Users = [.. s.Users, s.Users[0] with { Id = otherUser.UserId }] });
        Assert.Empty((await f.Service.ListAsync(otherUser, default, canonical: true)).Publications);
        await Assert.ThrowsAsync<PublicationException>(() => f.Service.CommandAsync(f.W.Id, otherUser, "publish", input, default, canonical: true));
    }

    [Fact]
    public async Task CanonicalPublication_RevokedOriginPreventsRemoteAdmission()
    {
        var f = await PublicationFixture();
        var actor = WorkspaceOwner.ForExternal(f.W.Owner.UserId, "manual:reviewed", "task", "Independent client");
        await Assert.ThrowsAsync<AppIdentityException>(() => f.Service.CommandAsync(f.W.Id, actor, "publish",
            new(Guid.NewGuid().ToString(), f.W.Observation!.Head, Title: "Blocked"), default, canonical: true,
            validateCaller: _ => throw new AppIdentityException("scope_required", "Publication grant revoked.")));
        Assert.Equal(0, f.Provider.Created); Assert.Equal(0, f.Provider.Pushed);
    }
    [Fact]
    public async Task CanonicalPublication_NativeCommitAndExternalPullRequestRequireVerifiedLinkBeforeCompletion()
    {
        var f = await PublicationFixture();
        var actor = WorkspaceOwner.ForExternal(f.W.Owner.UserId, "manual:independent", "native-source", "Independent editor");
        await File.WriteAllTextAsync(Path.Combine(f.W.Path, "native-addition.txt"), "Native edit and commit");
        await RunGitAsync(f.W.Path, ["add", "native-addition.txt"]);
        await RunGitAsync(f.W.Path, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Native source edit"]);
        var current = await f.Workspaces.ObserveAsync(f.W.Id, actor, default);
        var head = current.Observation!.Head!;
        Assert.NotEqual(f.W.Observation!.Head, head);
        f.Provider.Head = head; f.Provider.ExpectedBranch = f.W.Branch;
        f.Provider.Reference = new(42, "https://github.com/owner/repo/pull/42", head, null);
        var observed = await f.Service.ObserveAsync(f.W.Id, actor, default, canonical: true);
        Assert.Equal(42, observed.Number); Assert.Equal(head, observed.Observation!.Head);
        Assert.Null(observed.PublishedHead); // Discovery is evidence, not an implicit publication decision.
        var input = new PublicationCommand(Guid.NewGuid().ToString(), head, Number: 42);
        var linked = await f.Service.CommandAsync(f.W.Id, actor, "link", input, default, canonical: true);
        Assert.Equal(head, linked.PublishedHead);
        Assert.Equal(actor, Assert.Single(linked.Operations).Actor);
        await f.Service.CommandAsync(f.W.Id, actor, "link", input, default, canonical: true);
        Assert.Equal(0, f.Provider.Pushed); Assert.Equal(0, f.Provider.Created); Assert.Equal(0, f.Provider.Merged);
        await f.Users.UpdateAsync(state => state with { ProviderConnections = [] });
        var unavailable = await f.Service.ObserveAsync(f.W.Id, actor, default, canonical: true);
        Assert.Equal("unavailable", unavailable.Observation!.State);
        Assert.Null(unavailable.Observation.Head);
    }

}
