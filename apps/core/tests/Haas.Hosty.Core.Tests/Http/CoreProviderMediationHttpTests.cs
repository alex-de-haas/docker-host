using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Haas.Hosty.Core;
using HostySdk.App;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class CoreProviderMediationHttpTests
{
    [Fact]
    public void CanonicalTaskWireOmitsOptionalNullsButRetainsExplicitUnassignment()
    {
        var provider = new HostyTaskProviderRef("independent.executor", "installation", "default");
        var input = new HostyTaskCreate(Guid.NewGuid().ToString(), new("Task", "Body",
            new("app", Executor: provider, OptionId: "opaque"), []));
        using var encoded = JsonDocument.Parse(CoreJson.Text(input));
        var assignee = encoded.RootElement.GetProperty("input").GetProperty("assignee");
        Assert.Equal("app", assignee.GetProperty("kind").GetString());
        Assert.False(assignee.TryGetProperty("name", out _));
        Assert.False(assignee.TryGetProperty("userId", out _));
        Assert.False(encoded.RootElement.GetProperty("input").TryGetProperty("workspaceId", out _));
        using var unassigned = JsonDocument.Parse(CoreJson.Text(input with { Input = input.Input with { Assignee = null } }));
        Assert.Equal(JsonValueKind.Null, unassigned.RootElement.GetProperty("input").GetProperty("assignee").ValueKind);
    }

    [Fact]
    public async Task DirectTasks_UseQualifiedProviderAndSourceIntrospectionWithoutSyntheticApplication()
    {
        using var transport = new ProviderTransport();
        await using var host = await Start(transport);
        using var client = host.CreateClient();
        var token = await Issue(host, [AccessTokenScopes.McpRead, AccessTokenScopes.McpTasksRead]);
        client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var directory = await client.GetFromJsonAsync<ProviderDirectory>("/api/tasks/v1/providers");
        Assert.Empty(directory!.Providers);
        var provider = await AddProvider(host, "independent.archive", "tasks", []);
        transport.Provider = provider; transport.Services = host.Services;
        transport.Reply = JsonSerializer.SerializeToElement(new HostyTaskPage([], null), JsonSerializerOptions.Web);
        var reference = new HostyTaskProviderRef(provider.Id, PanelIdentity.Installation(provider), "custom");
        using var response = await client.PostAsJsonAsync("/api/tasks/v1/list", new CoreTaskQuery(reference));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Empty((await response.Content.ReadFromJsonAsync<HostyTaskPage>())!.Tasks);
        Assert.NotNull(transport.Invocation);
        Assert.Equal("admin", transport.Invocation.UserId);
        Assert.Null(transport.Invocation.CallerAppId);
        Assert.StartsWith("manual:", transport.Invocation.PrincipalId);
        Assert.Equal(2, transport.Invocation.Version);
        var mcp = await DirectEnvironmentHttpTests.Tool(client, "task_list", new { input = new CoreTaskQuery(reference) });
        Assert.False(mcp.TryGetProperty("isError", out var error) && error.GetBoolean(), mcp.ToString());
        Assert.Equal(0, mcp.GetProperty("structuredContent").GetProperty("tasks").GetArrayLength());
        directory = await client.GetFromJsonAsync<ProviderDirectory>("/api/tasks/v1/providers");
        Assert.Null(Assert.Single(directory!.Providers).Url);
        Assert.Equal(provider.Id, directory.Providers[0].AppId);
        var before = transport.Calls;
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/tasks/v1/list", new { provider = (object?)null })).StatusCode);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await client.PostAsJsonAsync("/api/tasks/v1/list", new CoreTaskQuery(reference with { InstallationId = "old" }))).StatusCode);
        Assert.Equal(before, transport.Calls);
        await host.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(provider with { RuntimeState = "stopped" });
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await client.PostAsJsonAsync("/api/tasks/v1/list", new CoreTaskQuery(reference))).StatusCode);
        Assert.False(Assert.Single((await client.GetFromJsonAsync<ProviderDirectory>("/api/tasks/v1/providers"))!.Providers).Available);
    }

    [Fact]
    public async Task SourceCredential_IsBoundToExactOperationBodyAndCurrentGrants()
    {
        using var transport = new ProviderTransport();
        await using var host = await Start(transport);
        var provider = await AddProvider(host, "independent.execution", "agent-sessions", ["session.read", "run.cancel"]);
        var token = await Issue(host, [AccessTokenScopes.McpRead, AccessTokenScopes.McpAgentSessionsRead]);
        var context = new Microsoft.AspNetCore.Http.DefaultHttpContext { RequestServices = host.Services };
        context.Request.Headers.Authorization = "Bearer " + token;
        var caller = await host.Services.GetRequiredService<CoreCapabilityAuthorization>().RequireAsync(context.Request,
            [AccessTokenScopes.McpAgentSessionsRead], [], default);
        var mediation = host.Services.GetRequiredService<CoreProviderMediation>();
        var reference = new HostyProviderRef(provider.Id, PanelIdentity.Installation(provider), "custom");
        var body = Encoding.UTF8.GetBytes("{\"run\":\"run-one\"}");
        var binding = await mediation.IssueAsync(caller, reference, CoreProviderPolicy.For("agent-sessions", "runs.get"),
            "POST", "/runs/get", body, ["run-one"], default);
        var input = new CoreProviderIntrospectionRequest(binding.Token, "agent-sessions", "custom", "runs.get", "POST", "/runs/get", CoreProviderMediation.Hash(body));
        Assert.Equal("admin", (await mediation.IntrospectAsync(provider, input, default)).UserId);
        foreach (var changed in new[] { input with { Path = "/runs/cancel" }, input with { Operation = "runs.cancel" }, input with { BodyHash = CoreProviderMediation.Hash([]) }, input with { Key = "other" } })
            await Assert.ThrowsAsync<AppIdentityException>(() => mediation.IntrospectAsync(provider, changed, default));
        await Assert.ThrowsAsync<AppIdentityException>(() => mediation.IntrospectAsync(provider with { InstalledAt = provider.InstalledAt.AddMinutes(1) }, input, default));
        await Scope(host, token, [AccessTokenScopes.McpRead]);
        Assert.Equal("scope_required", (await Assert.ThrowsAsync<AppIdentityException>(() => mediation.IntrospectAsync(provider, input, default))).Code);
    }

    [Fact]
    public async Task MutationsRequireWriteAndRetainContentFreeReceiptsWithExactReplay()
    {
        using var transport = new ProviderTransport();
        await using var host = await Start(transport);
        var provider = await AddProvider(host, "another.task.provider", "tasks", []);
        transport.Provider = provider; transport.Services = host.Services;
        var reference = new HostyTaskProviderRef(provider.Id, PanelIdentity.Installation(provider), "custom");
        var task = Task(reference);
        transport.Reply = JsonSerializer.SerializeToElement(task, JsonSerializerOptions.Web);
        using var client = host.CreateClient();
        var token = await Issue(host, [AccessTokenScopes.McpRead, AccessTokenScopes.McpTasksRead]);
        client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var request = new CoreTaskCreate(reference, new(Guid.NewGuid().ToString(), new("Private title", "Private body", null, [])));
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync("/api/tasks/v1/create", request)).StatusCode);
        Assert.Equal(0, transport.Calls);
        await Scope(host, token, [AccessTokenScopes.McpRead, AccessTokenScopes.McpTasksRead, AccessTokenScopes.McpTasksWrite]);
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/tasks/v1/create", request)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/tasks/v1/create", request)).StatusCode);
        Assert.Equal(2, transport.Calls); // The source receives the same UUID and owns exact result replay.
        Assert.Single(transport.RequestIds.Distinct());
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsJsonAsync("/api/tasks/v1/create", request with { Input = request.Input with { Input = request.Input.Input with { Title = "Changed" } } })).StatusCode);
        Assert.Equal(2, transport.Calls);
        var root = host.Services.GetRequiredService<CoreDataPaths>().CoreRoot;
        var receiptText = await File.ReadAllTextAsync(Assert.Single(Directory.GetFiles(Path.Combine(root, "provider-operations"), "*.json", SearchOption.AllDirectories)));
        Assert.DoesNotContain("Private title", receiptText); Assert.DoesNotContain("Private body", receiptText); Assert.DoesNotContain(token, receiptText);
        Assert.Contains("completed", receiptText);
        await Scope(host, token, [AccessTokenScopes.McpRead, AccessTokenScopes.McpTasksRead]);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync("/api/tasks/v1/create", request)).StatusCode);
        Assert.Equal(2, transport.Calls);
    }

    [Fact]
    public async Task TaskWriteDoesNotAuthorizeExecutorDispatchOrCancellation()
    {
        using var transport = new ProviderTransport();
        await using var host = await Start(transport);
        var provider = await AddProvider(host, "task.archive", "tasks", []);
        var executor = await AddProvider(host, "unrelated.runner", "task-executor", []);
        transport.Provider = provider; transport.Services = host.Services;
        var reference = new HostyTaskProviderRef(provider.Id, PanelIdentity.Installation(provider), "custom");
        var task = Task(reference) with { Assignee = new("app", Executor: new(executor.Id, PanelIdentity.Installation(executor), "custom")) };
        transport.Reply = JsonSerializer.SerializeToElement(task, JsonSerializerOptions.Web);
        using var client = host.CreateClient();
        var token = await Issue(host, [AccessTokenScopes.McpRead, AccessTokenScopes.McpTasksRead, AccessTokenScopes.McpTasksWrite]);
        client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var input = new CoreTaskAction(task.Ref, new(Guid.NewGuid().ToString(), 1, "ready"));
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync("/api/tasks/v1/action", input)).StatusCode);
        Assert.Equal(["get"], transport.Operations);
        await Scope(host, token, [AccessTokenScopes.McpRead, AccessTokenScopes.McpTasksRead, AccessTokenScopes.McpTasksWrite, AccessTokenScopes.McpTasksExecute]);
        transport.ActionOperation = "execute";
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/tasks/v1/action", input)).StatusCode);
        Assert.Equal("execute", transport.Operations.Last());
    }

    [Fact]
    public async Task TaskActionReplay_RetainsOriginalExecutionClassificationAndCannotRetargetRequest()
    {
        using var transport = new ProviderTransport(); await using var host = await Start(transport);
        var provider = await AddProvider(host, "source.archive", "tasks", []);
        var executor = await AddProvider(host, "source.runner", "task-executor", []);
        transport.Provider = provider; transport.Services = host.Services; transport.ActionOperation = "execute";
        var reference = new HostyTaskProviderRef(provider.Id, PanelIdentity.Installation(provider), "custom");
        var task = Task(reference) with { Assignee = new("app", Executor: new(executor.Id, PanelIdentity.Installation(executor), "custom")) };
        transport.Reply = JsonSerializer.SerializeToElement(task, JsonSerializerOptions.Web);
        using var client = host.CreateClient();
        var token = await Issue(host, [AccessTokenScopes.McpRead, AccessTokenScopes.McpTasksRead, AccessTokenScopes.McpTasksWrite, AccessTokenScopes.McpTasksExecute]);
        client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var input = new CoreTaskAction(task.Ref, new(Guid.NewGuid().ToString(), 1, "ready"));
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/tasks/v1/action", input)).StatusCode);
        transport.Reply = JsonSerializer.SerializeToElement(task with { Revision = 9, Assignee = new("human", "admin") }, JsonSerializerOptions.Web);
        var before = transport.Calls;
        await Scope(host, token, [AccessTokenScopes.McpRead, AccessTokenScopes.McpTasksRead, AccessTokenScopes.McpTasksWrite]);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync("/api/tasks/v1/action", input)).StatusCode);
        Assert.Equal(before, transport.Calls);
        await Scope(host, token, [AccessTokenScopes.McpRead, AccessTokenScopes.McpTasksRead, AccessTokenScopes.McpTasksWrite, AccessTokenScopes.McpTasksExecute]);
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/tasks/v1/action", input)).StatusCode);
        Assert.Equal(before + 1, transport.Calls); Assert.Equal("execute", transport.Operations.Last());
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsJsonAsync("/api/tasks/v1/action", input with { Input = input.Input with { Action = "cancel" } })).StatusCode);
    }

    [Fact]
    public async Task Dispatch_RequiresOriginalLiveAuthorityAndPinsSourceExecutorInputAndAttempt()
    {
        using var transport = new ProviderTransport(); await using var host = await Start(transport);
        var provider = (await AddProvider(host, "independent.task.store", "tasks", [])) with { GrantedCorePermissions = [CoreAppPermissions.TaskExecutors] };
        await host.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(provider);
        var executor = await AddProvider(host, "independent.native.runner", "task-executor", []);
        var executorRef = new HostyTaskProviderRef(executor.Id, PanelIdentity.Installation(executor), "custom");
        transport.Provider = provider; transport.Executor = executor; transport.Services = host.Services; transport.ActionOperation = "execute";
        var reference = new HostyTaskProviderRef(provider.Id, PanelIdentity.Installation(provider), "custom");
        var task = Task(reference) with { Assignee = new("app", Executor: executorRef, OptionId: "explicit") };
        transport.Reply = JsonSerializer.SerializeToElement(task, JsonSerializerOptions.Web);
        using var client = host.CreateClient();
        var token = await Issue(host, [AccessTokenScopes.McpRead, AccessTokenScopes.McpTasksRead, AccessTokenScopes.McpTasksWrite, AccessTokenScopes.McpTasksExecute]);
        client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var action = new CoreTaskAction(task.Ref, new(Guid.NewGuid().ToString(), 1, "ready"));
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/tasks/v1/action", action)).StatusCode);
        var dispatch = transport.Invocation!.TaskDispatch!; Assert.NotNull(dispatch);
        var executionId = Guid.NewGuid().ToString();
        var input = new HostyTaskExecutionInput(task.Ref, 1, new(task.Title, task.Markdown, [], false), "explicit");
        task = task with { Revision = 2, Status = "Ready", Attempts = [new(executionId, executorRef, input, false, DateTimeOffset.UtcNow.ToString("O"))] };
        transport.Reply = JsonSerializer.SerializeToElement(task, JsonSerializerOptions.Web);
        var mediation = host.Services.GetRequiredService<CoreProviderMediation>();
        var call = new CoreTaskDispatchRequest(dispatch, executorRef, "accept", executionId, input);
        await Assert.ThrowsAsync<AppIdentityException>(() => mediation.DispatchTaskAsync(executor, call, default));
        await Assert.ThrowsAsync<CoreProviderException>(() => mediation.DispatchTaskAsync(provider, call with { Executor = executorRef with { InstallationId = "replaced" } }, default));
        await Assert.ThrowsAsync<CoreProviderException>(() => mediation.DispatchTaskAsync(provider, call with { Input = input with { Input = input.Input with { Markdown = "Substituted" } } }, default));
        await mediation.DispatchTaskAsync(provider, call, default);
        var observed = transport.Invocation!;
        Assert.Null(observed.CallerAppId); Assert.Equal(dispatch.PrincipalId, observed.PrincipalId);
        Assert.Equal(task.Ref, observed.TaskDelegation!.TaskRef); Assert.Equal(executionId, observed.TaskDelegation.ExecutionId);
        Assert.Equal(executionId, (await mediation.TaskDispatchAuthorityAsync(executor, dispatch, default)).Scope.ExecutionId);
        var replacement = Guid.NewGuid().ToString();
        transport.Reply = JsonSerializer.SerializeToElement(task with { Attempts = [new(replacement, executorRef, input, false, DateTimeOffset.UtcNow.ToString("O"))] }, JsonSerializerOptions.Web);
        await Assert.ThrowsAsync<CoreProviderException>(() => mediation.DispatchTaskAsync(provider, call with { ExecutionId = replacement }, default));
        await Scope(host, token, [AccessTokenScopes.McpRead, AccessTokenScopes.McpTasksRead, AccessTokenScopes.McpTasksWrite]);
        await Assert.ThrowsAsync<AppIdentityException>(() => mediation.TaskDispatchAuthorityAsync(executor, dispatch, default));
        var receipt = await host.Services.GetRequiredService<CoreProviderOperationStore>().TaskDispatchAsync(dispatch, default);
        var serialized = CoreJson.Text(receipt);
        Assert.DoesNotContain(task.Markdown, serialized); Assert.DoesNotContain(token, serialized);
    }

    [Fact]
    public async Task TaskWorkspace_RestrictsNativeAdmissionToTheAttemptAndAllowsOnlyExactStopAfterRevocation()
    {
        using var transport = new ProviderTransport(); await using var host = await Start(transport);
        await ExternalWorkspaceMcpHttpTests.SeedSourceAsync(host);
        var provider = (await AddProvider(host, "independent.task.store", "tasks", [])) with { GrantedCorePermissions = [CoreAppPermissions.TaskExecutors] };
        await host.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(provider);
        var executor = await AddProvider(host, "independent.native.runner", "task-executor", []);
        var executorRef = new HostyTaskProviderRef(executor.Id, PanelIdentity.Installation(executor), "custom");
        transport.Provider = provider; transport.Executor = executor; transport.Services = host.Services; transport.ActionOperation = "execute";
        using var client = host.CreateClient();
        var token = await Issue(host, [AccessTokenScopes.McpRead, AccessTokenScopes.McpWorkspaces,
            AccessTokenScopes.McpTasksRead, AccessTokenScopes.McpTasksWrite, AccessTokenScopes.McpTasksExecute]);
        client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var prepare = new CanonicalWorkspacePrepare(Guid.NewGuid().ToString(), "allocated-work", "com.example.external-source", Guid.NewGuid().ToString(), "Implement task");
        using var prepared = await client.PostAsJsonAsync("/api/workspaces/v1/prepare", prepare);
        Assert.Equal(HttpStatusCode.OK, prepared.StatusCode);
        var tree = (await prepared.Content.ReadFromJsonAsync<DevelopmentWorkspace>())!;
        var task = Task(new(provider.Id, PanelIdentity.Installation(provider), "custom")) with {
            Assignee = new("app", Executor: executorRef), WorkspaceId = tree.WorkspaceId };
        transport.Reply = JsonSerializer.SerializeToElement(task, JsonSerializerOptions.Web);
        var action = new CoreTaskAction(task.Ref, new(Guid.NewGuid().ToString(), 1, "ready"));
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/tasks/v1/action", action)).StatusCode);
        var dispatch = transport.Invocation!.TaskDispatch!;
        var executionId = Guid.NewGuid().ToString();
        var input = new HostyTaskExecutionInput(task.Ref, 1, new(task.Title, task.Markdown, [], false, tree.WorkspaceId));
        task = task with { Revision = 2, Status = "Ready", Attempts = [new(executionId, executorRef, input, false, DateTimeOffset.UtcNow.ToString("O"))] };
        transport.Reply = JsonSerializer.SerializeToElement(task, JsonSerializerOptions.Web);
        await host.Services.GetRequiredService<CoreProviderMediation>().DispatchTaskAsync(provider, new(dispatch, executorRef, "accept", executionId, input), default);
        using var service = host.CreateClient();
        service.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(executor.Id));
        var route = $"/api/internal/apps/{executor.Id}/task-workspace";
        var request = new CoreTaskWorkspaceRequest(dispatch, executionId, "provider-session", Guid.NewGuid().ToString(), "observe");
        Assert.Equal(HttpStatusCode.Forbidden, (await service.PostAsJsonAsync(route, request)).StatusCode);
        executor = executor with { GrantedCorePermissions = [CoreAppPermissions.Sources] };
        await host.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(executor);
        using var observed = await service.PostAsJsonAsync(route, request);
        Assert.Equal(HttpStatusCode.OK, observed.StatusCode);
        var view = (await observed.Content.ReadFromJsonAsync<CoreTaskWorkspaceView>())!;
        Assert.Equal(tree.Id, Assert.Single(view.Sources.Workspaces).Id);
        Assert.Equal(tree.WorkspaceId, view.Association.Workspace!.Id);
        Assert.Equal(HttpStatusCode.Conflict, (await service.PostAsJsonAsync(route, request with { SessionId = "another-session" })).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await service.PostAsJsonAsync(route, request with { ExecutionId = Guid.NewGuid().ToString() })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await service.PostAsJsonAsync(route, request with { Kind = "attach", RequestId = executionId,
            ExpectedRevision = view.Association.Workspace.Revision, Title = "Independent execution", NavigationPath = "/runs/selected" })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await service.PostAsJsonAsync(route, request with { Kind = "lease", RequestId = Guid.NewGuid().ToString() })).StatusCode);
        var activity = request with { Kind = "activity", Activity = new("running", request.LeaseId, Sequence: 1) };
        Assert.Equal(HttpStatusCode.OK, (await service.PostAsJsonAsync(route, activity)).StatusCode);
        transport.Reply = JsonSerializer.SerializeToElement(task with { CancelRequested = true }, JsonSerializerOptions.Web);
        Assert.Equal(HttpStatusCode.Forbidden, (await service.PostAsJsonAsync(route, activity with { Activity = activity.Activity! with { Sequence = 2 } })).StatusCode);
        await Scope(host, token, [AccessTokenScopes.McpRead]);
        await host.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(executor with { GrantedCorePermissions = [] });
        Assert.Equal(HttpStatusCode.Forbidden, (await service.PostAsJsonAsync(route, request)).StatusCode);
        var stop = request with { Kind = "activity", Activity = new("idle", request.LeaseId, Stopped: true, Sequence: 3) };
        Assert.Equal(HttpStatusCode.Forbidden, (await service.PostAsJsonAsync(route, stop with { LeaseId = prepare.LeaseId, Activity = stop.Activity! with { LeaseId = prepare.LeaseId } })).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await service.PostAsJsonAsync(route, stop)).StatusCode);
        var retained = (await host.Services.GetRequiredService<DevelopmentWorkspaceService>().ListAsync(null, true, default)).Workspaces.Single(w => w.Id == tree.Id);
        Assert.DoesNotContain(request.LeaseId, retained.Leases); Assert.Contains(prepare.LeaseId, retained.Leases);
    }

    private static HostyTaskRecord Task(HostyTaskProviderRef provider) => new(new(provider.AppId, provider.InstallationId, provider.Key, Guid.NewGuid().ToString()),
        "T-1", 1, 1, "Draft", "Private title", "Private body", null, false, [], new("admin", null), new("admin", null),
        DateTimeOffset.UtcNow.ToString("O"), DateTimeOffset.UtcNow.ToString("O"), false, []);
    private static async Task<CoreHttpHarness> Start(ProviderTransport transport)
    {
        var host = await CoreHttpHarness.StartAsync(configure: s => s.AddSingleton<IHttpClientFactory>(transport));
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1, [new("admin", "admin@example.test", "Admin", "host.admin", false, now, now)], [], [], []));
        return host;
    }
    private static async Task<AppRecord> AddProvider(CoreHttpHarness host, string id, string kind, string[] capabilities)
    {
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        var app = new AppRecord(id, "Independent provider", null, "1.0.0", "runtime", false, "installed", null, null,
            "local", "installed", "running", null, null, [], new Dictionary<string, AppSettingValue>(), [], [], [], now, now)
        {
            ConfirmedRoles = [kind], Endpoints = [new("api", "http", "http://provider.invalid", true)],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { [kind] = [new("custom", "api", "/v1", 1, capabilities)] },
        };
        await host.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(app); return app;
    }
    private static async Task<string> Issue(CoreHttpHarness host, string[] scopes)
        => (await AccessTokenEndpoints.IssueAsync("admin", AccessTokenKinds.Manual, "External test", host.Services.GetRequiredService<UserDirectoryStore>(),
            host.Services.GetRequiredService<IClock>(), host.Services.GetRequiredService<AuthLifetimes>(), default, audience: AccessTokenScopes.CoreAudience, scopes: scopes)).Id;
    private static Task Scope(CoreHttpHarness host, string token, string[] scopes) => host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(s => s with
        { Sessions = s.Sessions.Select(r => r.Id == token ? r with { Scopes = scopes } : r).ToArray() });
    private sealed class ProviderTransport : HttpMessageHandler, IHttpClientFactory
    {
        internal IServiceProvider Services = null!;
        internal AppRecord Provider = null!;
        internal AppRecord? Executor;
        internal CoreProviderInvocation? Invocation;
        internal JsonElement Reply;
        internal int Calls;
        internal string ActionOperation = "action";
        internal List<string> Operations = [];
        internal List<string> RequestIds = [];
        // Source services also construct typed clients; every actual request is still confined below.
        public HttpClient CreateClient(string name) => new(this, false);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Calls++;
            Assert.Equal("provider.invalid", request.RequestUri!.Host);
            var route = request.RequestUri.PathAndQuery["/v1".Length..];
            var body = request.Content is null ? [] : await request.Content.ReadAsByteArrayAsync(ct);
            var operation = route == "/capabilities" ? "options" : route.StartsWith("/tasks?", StringComparison.Ordinal) ? "list"
                : route == "/tasks" ? "create" : route.EndsWith("/actions", StringComparison.Ordinal) ? ActionOperation : request.Method.Method == "PATCH" ? "edit" : "get";
            var child = route.StartsWith("/executions/", StringComparison.Ordinal) || route == "/options";
            if (child) operation = route == "/options" ? "dispatch.options" : route.EndsWith("/cancel", StringComparison.Ordinal) ? "dispatch.cancel" : request.Method.Method == "PUT" ? "dispatch.accept" : "dispatch.get";
            Invocation = await Services.GetRequiredService<CoreProviderMediation>().IntrospectAsync(child ? Executor! : Provider,
                new(request.Headers.Authorization!.Parameter!, child ? "task-executor" : "tasks", "custom", operation, request.Method.Method, route, CoreProviderMediation.Hash(body)), ct);
            Operations.Add(operation);
            if (body.Length > 0)
            {
                using var doc = JsonDocument.Parse(body);
                if (doc.RootElement.TryGetProperty("requestId", out var id)) { Assert.True(Guid.TryParseExact(id.GetString(), "D", out _)); RequestIds.Add(id.GetString()!); }
            }
            return new(HttpStatusCode.OK) { Content = child
                ? JsonContent.Create(new HostyTaskExecutionReceipt(route.Split('/')[2], 1, "accepted", false, "now", "now"))
                : JsonContent.Create(Reply) };
        }
    }
}
