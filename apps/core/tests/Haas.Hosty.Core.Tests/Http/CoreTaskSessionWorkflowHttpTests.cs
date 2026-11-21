using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Haas.Hosty.Core;
using HostySdk.App;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class CoreTaskSessionWorkflowHttpTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task EverySessionToolCrossesCoreMcpAndExactSignedConsumerBoundary(bool named)
    {
        using var transport = new WorkflowTransport();
        await using var host = await CoreHttpHarness.StartAsync(configure: services => services.AddSingleton<IHttpClientFactory>(transport));
        transport.Services = host.Services;
        var now = DateTimeOffset.UtcNow;
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1,
            [new("owner", "owner@example.test", "Owner", "host.admin", false, now, now)], [], [], []));
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var consumer = Record("independent.coordinator", now) with { RuntimeState = "running", ConfirmedRoles = ["tasks", "task-executor"],
            GrantedCorePermissions = [CoreAppPermissions.AgentProviders, CoreAppPermissions.TaskProviders, CoreAppPermissions.TaskExecutors,
                CoreAppPermissions.TasksRead, CoreAppPermissions.TasksWrite, CoreAppPermissions.TasksExecute],
            Endpoints = [new("api", "http", "http://coordinator.invalid", true)],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> {
                ["task-executor"] = [new("execution", "api", "/executor/v1", 1, named ? ["session-workflow", NamedProviderImplementations.Capability] : ["session-workflow"]), new("another", "api", "/executor/other", 1, ["session-workflow"])],
                ["tasks"] = [new("source", "api", "/tasks/v1", 1, ["markdown"])] } };
        var provider = Record("unrelated.native", now) with { RuntimeState = "running", ConfirmedRoles = ["agent"], GrantedCorePermissions = [],
            Endpoints = [new("api", "http", "http://native.invalid", true)],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["agent"] = [new("native", "api", "/agent/v1", 1, [])] } };
        await apps.UpsertAppAsync(consumer); await apps.UpsertAppAsync(provider);
        if (named)
        {
            await apps.PublishImplementationsAsync(consumer, "task-executor", new("execution", 1, [new("test-executor", "Test executor", true)]), default);
            consumer = (await apps.GetAppAsync(consumer.Id))!;
        }
        transport.Consumer = consumer;
        var credential = await BrowserAuthorityFixture.Grant(host, consumer.Id, "owner");
        var agents = host.Services.GetRequiredService<CoreAgentExecution>();
        var workflow = new CoreTaskSessionWorkflowBinding(new(consumer.Id, PanelIdentity.Installation(consumer), "execution") { ImplementationId = named ? "test-executor" : null }, Guid.NewGuid().ToString());
        var tools = CoreProviderMediation.SessionWorkflowActions.Select(t => t.Replace('-', '_')).ToArray();
        var nativeSession = Guid.NewGuid().ToString(); var run = Guid.NewGuid().ToString();
        CoreAgentAuthorizeRequest Request(CoreTaskSessionWorkflowBinding? binding) => new(new(provider.Id, PanelIdentity.Installation(provider), "native"),
            "runs.start", "PUT", $"/sessions/{nativeSession}/runs/{run}", Convert.ToHexStringLower(SHA256.HashData("native-only request"u8)),
            Resources: JsonSerializer.SerializeToElement(new[] { new { kind = "task", id = "test", revision = "1", provider = workflow.Executor } }, JsonSerializerOptions.Web),
            SessionId: nativeSession, RunId: run, Ceiling: JsonSerializer.SerializeToElement(new { workflow = binding,
                mcp = new { targets = new[] { new { target = new { kind = "core" }, tools } } } }, JsonSerializerOptions.Web));
        var request = Request(workflow);
        var binding = await agents.Authorize(consumer, credential.AccessToken, request, default);
        Assert.Equal(binding.AdmissionRef, (await agents.Authorize(consumer, credential.AccessToken, request, default)).AdmissionRef);
        await agents.Admit(provider, binding.AdmissionRef, default);
        foreach (var changed in new[] { workflow with { SessionId = Guid.NewGuid().ToString() }, workflow with { Executor = workflow.Executor with { Key = "another", ImplementationId = null } } })
            Assert.Equal("execution_conflict", (await Assert.ThrowsAsync<CoreProviderException>(() => agents.Authorize(consumer, credential.AccessToken, Request(changed), default))).Error.Code);
        Assert.Equal("execution_conflict", (await Assert.ThrowsAsync<CoreProviderException>(() => agents.Authorize(consumer, credential.AccessToken, Request(null), default))).Error.Code);
        await Assert.ThrowsAsync<AppIdentityException>(() => agents.Authorize(consumer, credential.AccessToken,
            Request(workflow with { Executor = workflow.Executor with { AppId = provider.Id } }), default));
        await host.Services.GetRequiredService<AgentPolicyStore>().ChangeAsync(AgentMcpDirectory.CoreId,
            new(null, true, new Dictionary<string, string>(), new Dictionary<string, AssistantTargetGrant> { [consumer.Id] = new(consumer.InstalledAt, "reviewed") }));
        var token = await agents.McpToken(provider, new(binding.AdmissionRef, new("core")), default);
        using var client = host.CreateClient(); client.DefaultRequestHeaders.Authorization = new("Bearer", token.Token);
        var missing = new[] { "task_executor_options", "task_execution_get", "task_result", "task_fail", "task_request_input", "task_adopt",
            "task_prepare_executor", "task_delegate", "task_wait", "task_plan", "task_bind_workspace" };
        foreach (var tool in missing)
        {
            var result = await DirectEnvironmentHttpTests.Tool(client, tool, new { input = new { requestId = Guid.NewGuid().ToString() } });
            Assert.False(result.TryGetProperty("isError", out var error) && error.GetBoolean(), result.ToString());
            Assert.Equal(tool.Replace('_', '-'), transport.LastCommand!.Action);
            Assert.Equal(workflow.SessionId, transport.LastPath!.Split('/')[2]);
            Assert.Equal(nativeSession, transport.Invocation!.AgentExecution!.SessionId); Assert.Equal(run, transport.Invocation.AgentExecution.RunId);
            Assert.Equal(provider.Id, transport.Invocation.AgentExecution.Provider.AppId);
            Assert.Equal(consumer.Id, transport.Invocation.CallerAppId); Assert.Equal("owner", transport.Invocation.UserId);
        }
        var taskId = Guid.NewGuid().ToString();
        var get = await DirectEnvironmentHttpTests.Tool(client, "task_get", new { input = new { taskRef = new { appId = consumer.Id,
            installationId = PanelIdentity.Installation(consumer), key = "source", id = taskId } } });
        Assert.False(get.TryGetProperty("isError", out var getError) && getError.GetBoolean(), get.ToString());
        Assert.Equal("source", transport.LastCommand!.Source!.Key); Assert.Equal("execution", workflow.Executor.Key);
        Assert.Equal(workflow.Executor.ImplementationId, transport.Invocation!.ImplementationId);
        Assert.Equal(taskId, transport.LastCommand.Input.GetProperty("taskId").GetString());
        var calls = transport.Calls;
        await DirectEnvironmentHttpTests.Tool(client, "task_get", new { input = new { taskRef = new { appId = consumer.Id,
            installationId = PanelIdentity.Installation(consumer), key = "wrong-source", id = taskId } } });
        Assert.Equal(calls, transport.Calls);
        await apps.UpsertAppAsync(consumer with { Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> {
            ["task-executor"] = [new("execution", "api", "/executor/v1", 1, [])] } });
        Assert.DoesNotContain("session-workflow", ProviderAccessService.Describe((await apps.GetAppAsync(consumer.Id))!, "task-executor").Single().Capabilities);
        await Assert.ThrowsAsync<CoreProviderException>(() => agents.WorkflowScope(provider, binding.AdmissionRef, default));
        await Assert.ThrowsAsync<CoreProviderException>(() => agents.Renew(provider, binding.AdmissionRef, default));
    }

    [Theory]
    [InlineData(false, false)]
    [InlineData(true, false)]
    [InlineData(false, true)]
    [InlineData(true, true)]
    public async Task ConversationToolsUseOnlyTheAdmittedChatAndReviewedSessionsEndpoint(bool named, bool management)
    {
        using var transport = new WorkflowTransport { Kind = "agent-sessions" };
        await using var host = await CoreHttpHarness.StartAsync(configure: services => services.AddSingleton<IHttpClientFactory>(transport));
        transport.Services = host.Services;
        var now = DateTimeOffset.UtcNow;
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1,
            [new("owner", "owner@example.test", "Owner", "host.admin", false, now, now)], [], [], []));
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var capability = management ? "session.profile-management" : "session.subagents";
        var nativeCapability = management ? "workflow.profile-management" : "workflow.subagents";
        var actions = management ? CoreProviderMediation.ProfileManagementActions : CoreProviderMediation.SubagentActions;
        var consumer = Record("independent.chat", now) with { RuntimeState = "running", ConfirmedRoles = ["agent-sessions"],
            GrantedCorePermissions = [CoreAppPermissions.AgentProviders], Endpoints = [new("api", "http", "http://chat.invalid", true)],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> {
                ["agent-sessions"] = [new("execution", "api", "/chats/v1", 1, named ? [capability, NamedProviderImplementations.Capability] : [capability])] } };
        var provider = Record("independent.native", now) with { RuntimeState = "running", ConfirmedRoles = ["agent"],
            Endpoints = [new("api", "http", "http://native.invalid", true)],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> {
                ["agent"] = [new("native", "api", "/agent/v1", 1, [nativeCapability])] } };
        await apps.UpsertAppAsync(consumer); await apps.UpsertAppAsync(provider);
        if (named)
        {
            await apps.PublishImplementationsAsync(consumer, "agent-sessions", new("execution", 1, [new("chat", "Chat", true)]), default);
            consumer = (await apps.GetAppAsync(consumer.Id))!;
        }
        transport.Consumer = consumer;
        var credential = await BrowserAuthorityFixture.Grant(host, consumer.Id, "owner");
        var services = host.Services;
        var agents = services.GetRequiredService<CoreAgentExecution>();
        var mediation = services.GetRequiredService<CoreProviderMediation>();
        var chat = Guid.NewGuid().ToString(); var native = Guid.NewGuid().ToString(); var run = Guid.NewGuid().ToString();
        var selected = actions.Select(name => name.Replace('-', '_')).ToArray();
        var workflow = new CoreTaskSessionWorkflowBinding(new(consumer.Id, PanelIdentity.Installation(consumer), "execution") { ImplementationId = named ? "chat" : null }, chat, selected);
        CoreAgentAuthorizeRequest Request(CoreTaskSessionWorkflowBinding binding) => new(new(provider.Id, PanelIdentity.Installation(provider), "native"),
            "runs.start", "PUT", $"/sessions/{native}/runs/{run}", new string('c', 64), SessionId: native, RunId: run,
            Ceiling: JsonSerializer.SerializeToElement(new { workflow = binding }, JsonSerializerOptions.Web),
            Conversation: new(chat, "/private/chats/" + chat, "Parent"));
        await Assert.ThrowsAsync<CoreProviderException>(() => agents.Authorize(consumer, credential.AccessToken, Request(workflow with { SessionId = native }), default));
        await Assert.ThrowsAsync<AppIdentityException>(() => agents.Authorize(consumer, credential.AccessToken, Request(workflow with { Tools = null }), default));
        if (named)
            await Assert.ThrowsAsync<CoreProviderException>(() => agents.Authorize(consumer, credential.AccessToken,
                Request(workflow with { Executor = workflow.Executor with { ImplementationId = "unpublished" } }), default));
        var admitted = await agents.Authorize(consumer, credential.AccessToken, Request(workflow), default);
        Assert.Contains(nativeCapability, admitted.SupportedWorkflowCapabilities);
        Assert.Equal(management, admitted.SupportedWorkflowCapabilities.Contains("workflow.profile-management"));
        await agents.Admit(provider, admitted.AdmissionRef, default);
        var input = JsonSerializer.SerializeToElement(new { requestId = Guid.NewGuid() });
        foreach (var action in actions)
        {
            await mediation.AgentWorkflowAsync(provider, new(admitted.AdmissionRef, action, input), default);
            Assert.Equal("/sessions/" + chat + "/workflow", transport.LastPath);
            Assert.Equal("owner", transport.Invocation!.UserId);
            Assert.Equal("agent-sessions", transport.Invocation.Kind);
            Assert.Equal(workflow.Executor.ImplementationId, transport.Invocation.ImplementationId);
            Assert.Equal(native, transport.Invocation.AgentExecution!.SessionId);
            Assert.Equal(run, transport.Invocation.AgentExecution.RunId);
        }
        await Assert.ThrowsAsync<AppIdentityException>(() => mediation.AgentWorkflowAsync(provider, new(admitted.AdmissionRef, "task-create", input), default));
        await Assert.ThrowsAsync<AppIdentityException>(() => mediation.AgentWorkflowAsync(provider, new(admitted.AdmissionRef,
            actions[0], input, new(consumer.Id, PanelIdentity.Installation(consumer), "source")), default));
        var otherAction = management ? "subagent-spawn" : "profile-create";
        await Assert.ThrowsAsync<AppIdentityException>(() => mediation.AgentWorkflowAsync(provider, new(admitted.AdmissionRef, otherAction, input), default));
        await services.GetRequiredService<AppSessionGrantStore>().RevokeByAuthorizingSessionAsync("browser-session", now);
        await Assert.ThrowsAsync<AppIdentityException>(() => mediation.AgentWorkflowAsync(provider, new(admitted.AdmissionRef, actions[0], input), default));
        Assert.Equal(actions.Length, transport.Calls);
    }

    private static AppRecord Record(string id, DateTimeOffset now) => new(id, id, null, "0.1.0", "runtime", false, "installed", null, null,
        "local", "installed", "stopped", null, null, [], new Dictionary<string, AppSettingValue>(), [], [], [], now, now);

    private sealed class WorkflowTransport : HttpMessageHandler, IHttpClientFactory
    {
        internal string Kind = "task-executor";
        internal IServiceProvider Services = null!;
        internal AppRecord Consumer = null!;
        internal CoreProviderInvocation? Invocation;
        internal CoreTaskSessionWorkflowCommand? LastCommand;
        internal string? LastPath;
        internal int Calls;
        private HttpClient? client;
        public HttpClient CreateClient(string name) => client = new(this, disposeHandler: false) { Timeout = TimeSpan.FromSeconds(30) };
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Calls++; var bytes = await request.Content!.ReadAsByteArrayAsync(ct);
            var prefix = Kind == "agent-sessions" ? "/chats/v1" : "/executor/v1";
            Assert.StartsWith(prefix + "/", request.RequestUri!.AbsolutePath);
            LastPath = request.RequestUri.AbsolutePath[prefix.Length..];
            Invocation = await Services.GetRequiredService<CoreProviderMediation>().IntrospectAsync(Consumer,
                new(request.Headers.Authorization!.Parameter!, Kind, "execution", "session.workflow", request.Method.Method,
                    LastPath, CoreProviderMediation.Hash(bytes)), ct);
            LastCommand = JsonSerializer.Deserialize(bytes, CoreJson.TypeInfo<CoreTaskSessionWorkflowCommand>());
            Assert.Equal(Invocation.AgentExecution, LastCommand!.Agent);
            var timeout = LastCommand.Action is "skill-discover" or "skill-install" ? 165 : 30;
            Assert.Equal(TimeSpan.FromSeconds(timeout), client!.Timeout);
            if (LastCommand.Source is null) Assert.False(JsonDocument.Parse(bytes).RootElement.TryGetProperty("source", out _));
            await Assert.ThrowsAsync<AppIdentityException>(() => Services.GetRequiredService<CoreProviderMediation>().IntrospectAsync(Consumer,
                new(request.Headers.Authorization.Parameter!, Kind, "execution", "session.workflow", "POST", LastPath,
                    new string('0', 64)), ct));
            return new(HttpStatusCode.OK) { Content = JsonContent.Create(new { accepted = true }) };
        }
    }
}
