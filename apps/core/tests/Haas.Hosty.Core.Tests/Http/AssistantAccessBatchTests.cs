using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class AssistantAccessBatchTests
{
    [Fact]
    public async Task BatchPreservesOtherAssistantsAndMissingToolDenials_AndRejectsStaleReplay()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var now = DateTimeOffset.UtcNow;
        var assistant = AssistantMcpAccessHttpTests.Record("assistant", now) with { ConfirmedRoles = ["assistant"],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["assistant"] = [new("default", null, "/assistant")] } };
        var target = AssistantMcpAccessHttpTests.Record("target", now) with {
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["mcp"] = [new("default", null, "/mcp")] } };
        await apps.UpsertAppAsync(assistant); await apps.UpsertAppAsync(assistant with { Id = "other" }); await apps.UpsertAppAsync(target);
        var policies = host.Services.GetRequiredService<AgentPolicyStore>();
        await policies.ChangeAsync(target.Id, new(now, false, new Dictionary<string, string>(), new Dictionary<string, AssistantTargetGrant> {
            ["other"] = new(now, "other-revision", ["other-denial"], true) }));
        var directory = host.Services.GetRequiredService<AgentMcpDirectory>();
        var plan = await directory.ReviewBatchAsync(new(Guid.NewGuid().ToString(), assistant.Id, (await directory.ReadAsync()).Revision,
            [new(target.Id, true, ["removed_tool", "delete"]), new(AgentMcpDirectory.CoreId, true, ["restart_core"])]), default);
        await directory.ApplyBatchAsync(plan, "actor", default);
        var saved = (await policies.ReadAsync()).Targets[target.Id];
        Assert.Equal("other-revision", saved.Assistants!["other"].Revision);
        Assert.Equal(new[] { "delete", "removed_tool" }, saved.Assistants[assistant.Id].DeniedTools);
        Assert.True(saved.Assistants[assistant.Id].Enabled);
        Assert.True((await directory.ReadForAssistantAsync(assistant.Id, default)).Targets.Single(t => t.Id == target.Id).Offered);
        await Assert.ThrowsAsync<AppLifecycleException>(() => directory.ApplyBatchAsync(plan, "actor", default));
        var disable = await directory.ReviewBatchAsync(new(Guid.NewGuid().ToString(), assistant.Id, (await directory.ReadAsync()).Revision,
            [new(target.Id, false, ["removed_tool", "delete"])]), default);
        await directory.ApplyBatchAsync(disable, "actor", default);
        var disabled = (await policies.ReadAsync()).Targets[target.Id].Assistants![assistant.Id];
        Assert.False(disabled.Enabled); Assert.Contains("removed_tool", disabled.DeniedTools!);
    }

    [Fact]
    public async Task ReviewRejectsUnknownTargetWithoutChangingAnyGrant()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var app = AssistantMcpAccessHttpTests.Record("assistant", DateTimeOffset.UtcNow) with { ConfirmedRoles = ["assistant"],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["assistant"] = [new("default", null, "/assistant")] } };
        await host.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(app);
        var directory = host.Services.GetRequiredService<AgentMcpDirectory>();
        var revision = (await directory.ReadAsync()).Revision;
        await Assert.ThrowsAsync<AppLifecycleException>(() => directory.ReviewBatchAsync(new(Guid.NewGuid().ToString(), app.Id, revision,
            [new(AgentMcpDirectory.CoreId, true, []), new("missing", true, [])]), default));
        Assert.Equal(revision, (await directory.ReadAsync()).Revision);
    }

    [Fact]
    public async Task DeniedToolCannotBeIntrospectedAsCallable_AndFutureToolsRemainAvailable()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var now = DateTimeOffset.UtcNow;
        var caller = AssistantMcpAccessHttpTests.Record("assistant", now) with { ConfirmedRoles = ["assistant"],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["assistant"] = [new("default", null, "/assistant")] } };
        var target = AssistantMcpAccessHttpTests.Record("target", now) with { Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["mcp"] = [new("default", null, "/mcp")] } };
        await apps.UpsertAppAsync(caller); await apps.UpsertAppAsync(target);
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1, [new("admin", "admin@example.test", "Admin", "host.admin", false, now, now)], [], [], []));
        var parent = await BrowserAuthorityFixture.Grant(host, caller.Id, "admin");
        await host.Services.GetRequiredService<AgentPolicyStore>().ChangeAsync(target.Id, new(now, false, new Dictionary<string, string>(),
            new Dictionary<string, AssistantTargetGrant> { [caller.Id] = new(now, "revision", ["delete"], true) }));
        var services = host.Services.GetRequiredService<AppServiceTokenService>();
        var token = await host.Services.GetRequiredService<AssistantMcpAccess>().IssueAsync(caller.Id, target.Id, services.CreateToken(caller.Id), parent.AccessToken, default, "chat");
        using var client = host.CreateClient();
        foreach (var tool in new[] { "read", "new_tool", "delete" })
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/internal/apps/{target.Id}/token/introspect") {
                Content = JsonContent.Create(new { token = token.Token, purpose = "mcp", tool }) };
            request.Headers.Authorization = new("Bearer", services.CreateToken(target.Id));
            using var response = await client.SendAsync(request); response.EnsureSuccessStatusCode();
            Assert.Equal(tool != "delete", (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("active").GetBoolean());
        }
    }
}
