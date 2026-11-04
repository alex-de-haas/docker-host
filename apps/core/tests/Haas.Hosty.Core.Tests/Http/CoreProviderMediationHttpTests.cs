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
            new("app", Executor: provider, Selection: new("option", "opaque", 1)), []));
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
    public async Task TaskMcp_ExplainsNestedArgumentsBeforeDispatch()
    {
        using var transport = new ProviderTransport();
        await using var host = await Start(transport);
        using var client = host.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", await Issue(host,
            [AccessTokenScopes.McpRead, AccessTokenScopes.McpTasksRead, AccessTokenScopes.McpTasksWrite]));
        var result = await DirectEnvironmentHttpTests.Tool(client, "task_action", new {
            taskRef = "serialized-reference", input = new { requestId = Guid.NewGuid().ToString(), expectedRevision = 1, action = "accept" }
        });
        Assert.True(result.GetProperty("isError").GetBoolean());
        Assert.Contains("input.taskRef", result.ToString());
        Assert.Contains("mcp_argument_required", result.ToString());
        Assert.Equal(0, transport.Calls);
        result = await DirectEnvironmentHttpTests.Tool(client, "task_action", new {
            input = new { taskRef = "serialized-reference", input = new { requestId = Guid.NewGuid().ToString(), expectedRevision = 1, action = "accept" } }
        });
        Assert.True(result.GetProperty("isError").GetBoolean());
        Assert.Contains("input.taskRef", result.ToString());
        Assert.Contains("mcp_argument_invalid", result.ToString());
        Assert.Equal(0, transport.Calls);
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
    public async Task Ready_SelectsAndRetainsAnIndependentExecutorsDefaultOption()
    {
        using var transport = new ProviderTransport(); await using var host = await Start(transport);
        var provider = await AddProvider(host, "source.archive", "tasks", []);
        var executor = await AddProvider(host, "independent.runner", "task-executor", ["options"]);
        transport.Provider = provider; transport.Executor = executor; transport.Services = host.Services;
        transport.ActionOperation = "execute"; transport.PublicOptions = true;
        var reference = new HostyTaskProviderRef(provider.Id, PanelIdentity.Installation(provider), "custom");
        var task = Task(reference) with { Assignee = new("app", Executor: new(executor.Id, PanelIdentity.Installation(executor), "custom")) };
        transport.Reply = JsonSerializer.SerializeToElement(task, JsonSerializerOptions.Web);
        using var client = host.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", await Issue(host,
            [AccessTokenScopes.McpRead, AccessTokenScopes.McpTasksRead, AccessTokenScopes.McpTasksWrite, AccessTokenScopes.McpTasksExecute]));
        var input = new CoreTaskAction(task.Ref, new(Guid.NewGuid().ToString(), 1, "ready"));
        var response = await client.PostAsJsonAsync("/api/tasks/v1/action", input);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("opaque-default", transport.LastAction!.Value.GetProperty("selection").GetProperty("id").GetString());
        Assert.Equal(7, transport.LastAction.Value.GetProperty("selection").GetProperty("revision").GetInt64());
        Assert.Contains("options", transport.Operations);
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, false)]
    [InlineData(true, true)]
    public async Task Retry_UsesTheForwardedSelectionRevisionForDispatch(bool savedSelection, bool explicitSelection)
    {
        using var transport = new ProviderTransport(); await using var host = await Start(transport);
        var provider = (await AddProvider(host, "independent.task.store", "tasks", [])) with { GrantedCorePermissions = [CoreAppPermissions.TaskExecutors] };
        await host.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(provider);
        var executor = await AddProvider(host, "independent.native.runner", "task-executor", ["options"]);
        var executorRef = new HostyTaskProviderRef(executor.Id, PanelIdentity.Installation(executor), "custom");
        var choice = new HostyTaskSelection("option", "opaque-default", 7);
        transport.Provider = provider; transport.Executor = executor; transport.Services = host.Services;
        transport.ActionOperation = "execute"; transport.PublicOptions = true;
        var task = Task(new(provider.Id, PanelIdentity.Installation(provider), "custom")) with
        { Status = "Blocked", Assignee = new("app", Executor: executorRef, Selection: savedSelection ? choice : null) };
        transport.Reply = JsonSerializer.SerializeToElement(task, JsonSerializerOptions.Web);
        using var client = host.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", await Issue(host,
            [AccessTokenScopes.McpRead, AccessTokenScopes.McpTasksRead, AccessTokenScopes.McpTasksWrite, AccessTokenScopes.McpTasksExecute]));
        var action = new CoreTaskAction(task.Ref, new(Guid.NewGuid().ToString(), task.Revision, "retry", Selection: explicitSelection ? choice : null));
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/tasks/v1/action", action)).StatusCode);
        var dispatch = transport.Invocation!.TaskDispatch!;
        Assert.Equal(choice.Id, transport.LastAction!.Value.GetProperty("selection").GetProperty("id").GetString());
        var executionId = Guid.NewGuid().ToString();
        var input = new HostyTaskExecutionInput(1, task.Ref, task.InputRevision + 1, new(task.Title, task.Markdown, [], new("none")),
            new(task.RootTaskRef, null, 1), [], choice);
        task = task with { Revision = task.Revision + 1, InputRevision = input.InputRevision, Status = "Ready",
            Attempts = [new(executionId, executorRef, input, false, "now")] };
        transport.Reply = JsonSerializer.SerializeToElement(task, JsonSerializerOptions.Web);
        var mediation = host.Services.GetRequiredService<CoreProviderMediation>();
        var call = new CoreTaskDispatchRequest(dispatch, executorRef, "accept", executionId, input);
        await mediation.DispatchTaskAsync(provider, call, default);
        Assert.Equal(input.InputRevision, (await mediation.TaskDispatchAuthorityAsync(executor, dispatch, default)).Scope.InputRevision);
        await mediation.DispatchTaskAsync(provider, call with { Operation = "get", Input = null }, default);
        await mediation.DispatchTaskAsync(provider, call with { Operation = "cancel", Input = null, RequestId = Guid.NewGuid().ToString() }, default);
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/tasks/v1/action", action)).StatusCode);
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
        var task = Task(reference) with { Assignee = new("app", Executor: executorRef, Selection: new("option", "explicit", 1)) };
        transport.Reply = JsonSerializer.SerializeToElement(task, JsonSerializerOptions.Web);
        using var client = host.CreateClient();
        var token = await Issue(host, [AccessTokenScopes.McpRead, AccessTokenScopes.McpTasksRead, AccessTokenScopes.McpTasksWrite, AccessTokenScopes.McpTasksExecute]);
        client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var action = new CoreTaskAction(task.Ref, new(Guid.NewGuid().ToString(), 1, "ready"));
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/tasks/v1/action", action)).StatusCode);
        var dispatch = transport.Invocation!.TaskDispatch!; Assert.NotNull(dispatch);
        var executionId = Guid.NewGuid().ToString();
        var input = new HostyTaskExecutionInput(1, task.Ref, 1, new(task.Title, task.Markdown, [], new("none")), new(task.RootTaskRef, null, 1), [], new("option", "explicit", 1));
        task = task with { Revision = 2, Status = "Ready", Attempts = [new(executionId, executorRef, input, false, DateTimeOffset.UtcNow.ToString("O"))] };
        transport.Reply = JsonSerializer.SerializeToElement(task, JsonSerializerOptions.Web);
        var mediation = host.Services.GetRequiredService<CoreProviderMediation>();
        var call = new CoreTaskDispatchRequest(dispatch, executorRef, "accept", executionId, input);
        await Assert.ThrowsAsync<AppIdentityException>(() => mediation.DispatchTaskAsync(executor, call, default));
        await Assert.ThrowsAsync<CoreProviderException>(() => mediation.DispatchTaskAsync(provider, call with { Executor = executorRef with { InstallationId = "replaced" } }, default));
        await Assert.ThrowsAsync<CoreProviderException>(() => mediation.DispatchTaskAsync(provider, call with { Input = input with { Content = input.Content with { Markdown = "Substituted" } } }, default));
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
            Assignee = new("app", Executor: executorRef) };
        transport.Reply = JsonSerializer.SerializeToElement(task, JsonSerializerOptions.Web);
        var action = new CoreTaskAction(task.Ref, new(Guid.NewGuid().ToString(), 1, "ready"));
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/tasks/v1/action", action)).StatusCode);
        var dispatch = transport.Invocation!.TaskDispatch!;
        var executionId = Guid.NewGuid().ToString();
        var input = new HostyTaskExecutionInput(1, task.Ref, 1, new(task.Title, task.Markdown, [], new("none")), new(task.RootTaskRef, null, 1), []);
        task = task with { Revision = 2, Status = "Ready", Attempts = [new(executionId, executorRef, input, false, DateTimeOffset.UtcNow.ToString("O"))] };
        transport.Reply = JsonSerializer.SerializeToElement(task, JsonSerializerOptions.Web);
        await host.Services.GetRequiredService<CoreProviderMediation>().DispatchTaskAsync(provider, new(dispatch, executorRef, "accept", executionId, input), default);
        await host.Services.GetRequiredService<CoreProviderOperationStore>().BindTaskSourceAsync(dispatch, executionId, tree.WorkspaceId, default);
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

    [Fact]
    public async Task WorkflowAndSources_RequireCurrentCoordinatorAndRetainContextAcrossRootAttempts()
    {
        using var transport = new ProviderTransport(); await using var host = await Start(transport);
        await ExternalWorkspaceMcpHttpTests.SeedSourceAsync(host);
        var provider = (await AddProvider(host, "independent.task.store", "tasks", ["parent-child"])) with { GrantedCorePermissions = [CoreAppPermissions.TaskExecutors] };
        var executor = (await AddProvider(host, "independent.coordinator", "task-executor", [])) with { GrantedCorePermissions = [CoreAppPermissions.Sources] };
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        await apps.UpsertAppAsync(provider); await apps.UpsertAppAsync(executor);
        var executorRef = new HostyTaskProviderRef(executor.Id, PanelIdentity.Installation(executor), "custom");
        transport.Provider = provider; transport.Executor = executor; transport.Services = host.Services; transport.ActionOperation = "execute";
        using var client = host.CreateClient();
        var token = await Issue(host, [AccessTokenScopes.McpRead, AccessTokenScopes.McpWorkspaces, AccessTokenScopes.McpTasksRead, AccessTokenScopes.McpTasksWrite, AccessTokenScopes.McpTasksExecute]);
        client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        var prepared = await client.PostAsJsonAsync("/api/workspaces/v1/prepare", new CanonicalWorkspacePrepare(Guid.NewGuid().ToString(), "workflow-context", "com.example.external-source", Guid.NewGuid().ToString(), "Workflow source"));
        Assert.Equal(HttpStatusCode.OK, prepared.StatusCode);
        var tree = (await prepared.Content.ReadFromJsonAsync<DevelopmentWorkspace>())!;
        var task = Task(new(provider.Id, PanelIdentity.Installation(provider), "custom")) with { Assignee = new("app", Executor: executorRef) };
        async Task<(CoreTaskDispatchRef Dispatch, string Execution)> Admit(long epoch)
        {
            transport.Reply = JsonSerializer.SerializeToElement(task, JsonSerializerOptions.Web);
            var response = await client.PostAsJsonAsync("/api/tasks/v1/action", new CoreTaskAction(task.Ref, new(Guid.NewGuid().ToString(), task.Revision, epoch == 1 ? "ready" : "retry")));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var dispatch = transport.Invocation!.TaskDispatch!; var executionId = Guid.NewGuid().ToString();
            var input = new HostyTaskExecutionInput(1, task.Ref, 1, new(task.Title, task.Markdown, [], new("none")), new(task.RootTaskRef, null, 1), []);
            var receipt = new HostyTaskExecutionReceipt(executionId, 1, "awaiting_input", false, "now", "now", SessionRef: new("session-" + epoch, "/sessions/" + epoch), NativeStopConfirmed: true);
            task = task with { Revision = task.Revision + 1, Status = "InProgress", Coordination = new(1, epoch, executionId),
                Attempts = [.. task.Attempts, new(executionId, executorRef, input, false, "now", Receipt: receipt)] };
            transport.Reply = JsonSerializer.SerializeToElement(task, JsonSerializerOptions.Web);
            await host.Services.GetRequiredService<CoreProviderMediation>().DispatchTaskAsync(provider, new(dispatch, executorRef, "accept", executionId, input), default);
            return (dispatch, executionId);
        }
        var first = await Admit(1);
        using var service = host.CreateClient();
        service.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(executor.Id));
        var route = $"/api/internal/apps/{executor.Id}/task-workflow";
        var command = new CoreTaskWorkflowRequest(first.Dispatch, task.Ref, first.Execution, 1, 1, "observe", Guid.NewGuid().ToString(), JsonSerializer.SerializeToElement(new { }));
        Assert.Equal(HttpStatusCode.OK, (await service.PostAsJsonAsync(route, command)).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await service.PostAsJsonAsync(route, command with { CoordinatorEpoch = 2 })).StatusCode);
        Assert.Equal(HttpStatusCode.Conflict, (await service.PostAsJsonAsync(route, command with { RootGeneration = 2 })).StatusCode);
        var contextId = Guid.NewGuid().ToString();
        command = command with { Operation = "bind_source", RequestId = Guid.NewGuid().ToString(), Payload = JsonSerializer.SerializeToElement(new CoreTaskSourceInput(contextId, 0, "session-1", tree.WorkspaceId)) };
        using var selected = await service.PostAsJsonAsync(route, command);
        Assert.Equal(HttpStatusCode.OK, selected.StatusCode);
        var source = (await selected.Content.ReadFromJsonAsync<CoreTaskSourceReference>())!;
        Assert.Equal(source, await (await service.PostAsJsonAsync(route, command)).Content.ReadFromJsonAsync<CoreTaskSourceReference>());
        task = task with { Status = "Blocked", Attempts = [task.Attempts[0] with { Receipt = task.Attempts[0].Receipt! with { State = "failed", StopConfirmed = true } }] };
        var second = await Admit(2);
        var next = command with { RootDispatch = second.Dispatch, ParentExecutionId = second.Execution, CoordinatorEpoch = 2, RequestId = Guid.NewGuid().ToString(),
            Payload = JsonSerializer.SerializeToElement(new CoreTaskSourceInput(contextId, 1, "session-2", tree.WorkspaceId)) };
        using var recovered = await service.PostAsJsonAsync(route, next with { Operation = "observe_source", Payload = JsonSerializer.SerializeToElement(new { }) });
        Assert.Equal(HttpStatusCode.OK, recovered.StatusCode);
        Assert.Equal(source, await recovered.Content.ReadFromJsonAsync<CoreTaskSourceReference>());
        using var rebound = await service.PostAsJsonAsync(route, next);
        Assert.Equal(HttpStatusCode.OK, rebound.StatusCode);
        var current = (await rebound.Content.ReadFromJsonAsync<CoreTaskSourceReference>())!;
        Assert.Equal(source.ContextId, current.ContextId); Assert.Equal(2, current.ContextRevision); Assert.Equal(second.Dispatch, current.RootDispatch);
        Assert.Equal(HttpStatusCode.Conflict, (await service.PostAsJsonAsync(route, command)).StatusCode);
        await Assert.ThrowsAsync<CoreProviderException>(() => host.Services.GetRequiredService<CoreTaskSources>().Validate(executor, source, "acquire_workspace_lease", default));
        await Scope(host, token, [AccessTokenScopes.McpRead, AccessTokenScopes.McpTasksRead, AccessTokenScopes.McpTasksWrite, AccessTokenScopes.McpTasksExecute]);
        Assert.Equal(HttpStatusCode.Forbidden, (await service.PostAsJsonAsync(route, next)).StatusCode);
    }

    [Fact]
    public async Task RetainedTaskMcp_MintsWithoutBrowserCredentialAndRechecksAttemptAndGrantsAtUse()
    {
        using var transport = new ProviderTransport(); await using var host = await Start(transport);
        var provider = (await AddProvider(host, "independent.task.archive", "tasks", ["parent-child"])) with { GrantedCorePermissions = [CoreAppPermissions.TaskExecutors] };
        var executor = await AddProvider(host, "independent.task.assistant", "task-executor", []);
        executor = executor with { ConfirmedRoles = ["task-executor", "assistant"],
            GrantedCorePermissions = [CoreAppPermissions.TaskProviders, CoreAppPermissions.TasksRead, CoreAppPermissions.TasksWrite, CoreAppPermissions.TasksExecute, CoreAppPermissions.TaskExecutors],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>>(executor.Interfaces!) { ["assistant"] = [new("default", null, "/assistant")] } };
        var target = await AddProvider(host, "third.party.tools", "mcp", []);
        var apps = host.Services.GetRequiredService<AppRegistryStore>(); await apps.UpsertAppAsync(provider); await apps.UpsertAppAsync(executor);
        transport.Provider = provider; transport.Executor = executor; transport.Services = host.Services; transport.ActionOperation = "execute";
        var policies = host.Services.GetRequiredService<AgentPolicyStore>();
        var link = new AgentTargetPolicy(target.InstalledAt, true, new Dictionary<string, string>(),
            new Dictionary<string, AssistantTargetGrant> { [executor.Id] = new(executor.InstalledAt, "reviewed-link") });
        await policies.ChangeAsync(target.Id, link);
        var grant = await BrowserAuthorityFixture.Grant(host, executor.Id, "admin");
        var serviceToken = host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(executor.Id);
        using var client = host.CreateClient(); client.DefaultRequestHeaders.Authorization = new("Bearer", serviceToken);
        var executorRef = new HostyTaskProviderRef(executor.Id, PanelIdentity.Installation(executor), "custom");
        var task = Task(new(provider.Id, PanelIdentity.Installation(provider), "custom")) with { Assignee = new("app", Executor: executorRef) };
        transport.Reply = JsonSerializer.SerializeToElement(task, JsonSerializerOptions.Web);
        using var launch = new HttpRequestMessage(HttpMethod.Post, "/api/tasks/v1/action") { Content = JsonContent.Create(new CoreTaskAction(task.Ref, new(Guid.NewGuid().ToString(), 1, "ready"))) };
        launch.Headers.Add("X-Hosty-App-Identity", grant.AccessToken);
        using var started = await client.SendAsync(launch); Assert.True(started.StatusCode == HttpStatusCode.OK, await started.Content.ReadAsStringAsync());
        var dispatch = transport.Invocation!.TaskDispatch!; var execution = Guid.NewGuid().ToString();
        var input = new HostyTaskExecutionInput(1, task.Ref, 1, new(task.Title, task.Markdown, [], new("none")), new(task.Ref, null, 1), []);
        task = task with { Status = "InProgress", Coordination = new(1, 1, execution), Attempts = [new(execution, executorRef, input, false, "now",
            Receipt: new(execution, 1, "running", false, "now", "now", SessionRef: new("exact-session", "/assistant?session=exact-session")))] };
        transport.Reply = JsonSerializer.SerializeToElement(task, JsonSerializerOptions.Web);
        await host.Services.GetRequiredService<CoreProviderMediation>().DispatchTaskAsync(provider, new(dispatch, executorRef, "accept", execution, input), default);
        var binding = new CoreTaskMcpBinding(dispatch, execution, "exact-session");
        var route = $"/api/internal/apps/{executor.Id}/task-mcp";
        using var issued = await client.PostAsJsonAsync(route, new CoreTaskMcpRequest(binding, target.Id));
        Assert.True(issued.StatusCode == HttpStatusCode.OK, await issued.Content.ReadAsStringAsync());
        var token = (await issued.Content.ReadFromJsonAsync<DelegatedTokenResponse>())!.Token;
        var access = host.Services.GetRequiredService<AssistantMcpAccess>();
        Assert.NotNull(await access.ValidateAsync(token, target.Id, default));
        Assert.Null(await access.ValidateAsync(token, AgentMcpDirectory.CoreId, default));
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync(route, new CoreTaskMcpRequest(binding with { SessionId = "borrowed-session" }, target.Id))).StatusCode);
        transport.Reply = JsonSerializer.SerializeToElement(task with { CancelRequested = true }, JsonSerializerOptions.Web);
        Assert.Null(await access.ValidateAsync(token, target.Id, default));
        transport.Reply = JsonSerializer.SerializeToElement(task, JsonSerializerOptions.Web);
        Assert.NotNull(await access.ValidateAsync(token, target.Id, default));
        await policies.ChangeAsync(target.Id, link with { Assistants = null });
        Assert.Null(await access.ValidateAsync(token, target.Id, default));
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync(route, new CoreTaskMcpRequest(binding, target.Id))).StatusCode);
    }

    private static HostyTaskRecord Task(HostyTaskProviderRef provider)
    {
        var reference = new HostyTaskRef(provider.AppId, provider.InstallationId, provider.Key, Guid.NewGuid().ToString());
        return new(reference, "T-1", 1, 1, "Draft", "Private title", "Private body", null, new("none"), [], new("admin", null), new("admin", null),
            DateTimeOffset.UtcNow.ToString("O"), DateTimeOffset.UtcNow.ToString("O"), false, [], reference, null, [], 0, 1, 1, false, []);
    }
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
        internal bool PublicOptions;
        internal JsonElement? LastAction;
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
            if (child) operation = route == "/options" ? PublicOptions ? "options" : "dispatch.options" : route.EndsWith("/cancel", StringComparison.Ordinal) ? "dispatch.cancel" : request.Method.Method == "PUT" ? "dispatch.accept" : "dispatch.get";
            Invocation = await Services.GetRequiredService<CoreProviderMediation>().IntrospectAsync(child ? Executor! : Provider,
                new(request.Headers.Authorization!.Parameter!, child ? "task-executor" : "tasks", "custom", operation, request.Method.Method, route, CoreProviderMediation.Hash(body)), ct);
            Operations.Add(operation);
            if (body.Length > 0)
            {
                using var doc = JsonDocument.Parse(body);
                if (route.EndsWith("/actions", StringComparison.Ordinal)) LastAction = doc.RootElement.Clone();
                if (doc.RootElement.TryGetProperty("requestId", out var id)) { Assert.True(Guid.TryParseExact(id.GetString(), "D", out _)); RequestIds.Add(id.GetString()!); }
            }
            if (route == "/options") return new(HttpStatusCode.OK) { Content = JsonContent.Create(new HostyTaskExecutorOptions(1, 2, [new("opaque-default", 7, "Independent executor", "Opaque option", ["markdown"], new("available"))], "opaque-default")) };
            return new(HttpStatusCode.OK) { Content = child
                ? JsonContent.Create(new HostyTaskExecutionReceipt(route.Split('/')[2], 1, "accepted", false, "now", "now"))
                : JsonContent.Create(Reply) };
        }
    }
}
