using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class DependencyStartupHttpTests
{
    [Theory]
    [InlineData("session", false)]
    [InlineData("session", true)]
    [InlineData("mcp", false)]
    [InlineData("mcp", true)]
    [InlineData("app", false)]
    [InlineData("app", true)]
    [InlineData("control", false)]
    public async Task DeferredProvidersUseOriginalAuthority(string via, bool revoke)
    {
        var adapter = new Adapter();
        await using var host = await Host(adapter);
        using var appClient = await AppManagementHttpTests.CreateAppClient(host, "example.console", [CoreAppPermissions.AppLifecycle]);
        await Install(host, "example.consumer", "example.provider");
        await Install(host, "example.provider");
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var lifecycle = host.Services.GetRequiredService<CoreLifecycleService>();
        using var client = host.CreateClient();
        if (via == "mcp")
            await users.UpdateAsync(state => state with { Sessions = state.Sessions.Select(session => session with
            { Kind = "manual", Audience = AccessTokenScopes.CoreAudience, Scopes = [AccessTokenScopes.McpRead, AccessTokenScopes.McpLifecycle] }).ToArray() });
        if (via == "app") (await appClient.PostAsJsonAsync("/api/apps/example.consumer/start", new { })).EnsureSuccessStatusCode();
        else if (via == "mcp")
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, "/api/mcp")
            { Content = JsonContent.Create(new { jsonrpc = "2.0", id = 1, method = "tools/call", @params = new { name = "start_app", arguments = new { appId = "example.consumer" } } }) };
            request.Headers.Authorization = new("Bearer", "operator");
            request.Headers.Accept.ParseAdd("application/json");
            request.Headers.Accept.ParseAdd("text/event-stream");
            using var response = await client.SendAsync(request);
            response.EnsureSuccessStatusCode();
            Assert.Contains("waiting", await response.Content.ReadAsStringAsync());
        }
        else
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, via == "control" ? "/control/v1/apps/example.consumer/start" : "/api/apps/example.consumer/start")
            { Content = JsonContent.Create(new { }) };
            if (via == "control") request.Headers.Add("X-Hosty-Control-Secret", host.Services.GetRequiredService<ControlSecret>().Value);
            else request.Headers.Authorization = new("Bearer", "operator");
            (await client.SendAsync(request)).EnsureSuccessStatusCode();
        }
        Assert.Equal("waiting", (await apps.GetAppAsync("example.consumer"))!.RuntimeState);
        if (revoke) await users.UpdateAsync(state => state with { Sessions = state.Sessions.Select(session => session with { RevokedAt = DateTimeOffset.UtcNow }).ToArray() });
        await lifecycle.ResumeWaitingAppsAsync();
        Assert.Equal(revoke ? 0 : 2, adapter.Starts);
        Assert.Equal(revoke ? "waiting" : "running", (await apps.GetAppAsync("example.consumer"))!.RuntimeState);
        if (revoke) Assert.Contains("not authorized", (await apps.GetAppAsync("example.consumer"))!.LastError);
        else Assert.Null((await apps.GetAppAsync("example.consumer"))!.DependencyStart);
        var saved = await File.ReadAllTextAsync(Path.Combine(host.Services.GetRequiredService<CoreDataPaths>().AppsRoot, "example.consumer", "state.json"));
        Assert.DoesNotContain("\"credentialHash\":\"operator\"", saved);
    }

    [Fact]
    public async Task BackgroundGrantForConsumerCannotStartItsProvider()
    {
        var adapter = new Adapter();
        await using var host = await Host(adapter);
        using var app = await AppManagementHttpTests.CreateAppClient(host, "example.console", [CoreAppPermissions.AppLifecycle]);
        await Install(host, "example.consumer", "example.provider");
        await Install(host, "example.provider");
        var grants = host.Services.GetRequiredService<BackgroundGrantService>();
        var grant = await grants.CreateAsync("actor", new("example.console", "Start consumer",
            [new("consumer", "core", "example.consumer", ["start"])]), default);
        var token = await grants.IssueAsync("example.console", new(grant.Id, "consumer"), default);
        app.DefaultRequestHeaders.Remove(AppManagementAuthorization.IdentityHeader);
        app.DefaultRequestHeaders.Add(AppManagementAuthorization.IdentityHeader, token.AccessToken);
        (await app.PostAsJsonAsync("/api/apps/example.consumer/start", new { })).EnsureSuccessStatusCode();
        var lifecycle = host.Services.GetRequiredService<CoreLifecycleService>();
        await lifecycle.ResumeWaitingAppsAsync();
        await lifecycle.ResumeWaitingAppsAsync();
        Assert.Equal(0, adapter.Starts);
        var consumer = (await host.Services.GetRequiredService<AppRegistryStore>().GetAppAsync("example.consumer"))!;
        Assert.Contains("example.provider", consumer.LastError);
        Assert.Contains("not authorized", consumer.LastError);
        // An authorized operator may start the provider independently; the narrow consumer grant
        // remains sufficient to finish its own previously admitted start.
        await lifecycle.StartAsync("example.provider");
        await lifecycle.ResumeWaitingAppsAsync();
        Assert.Equal(2, adapter.Starts);
    }

    [Theory]
    [InlineData("allowed")]
    [InlineData("start-denied")]
    [InlineData("revoked")]
    public async Task AssistantCascadeRevalidatesItsGrantAndProviderTool(string scope)
    {
        var adapter = new Adapter();
        await using var host = await Host(adapter);
        var now = DateTimeOffset.UtcNow;
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var caller = AssistantMcpAccessHttpTests.Record("example.assistant", now) with
        {
            ConfirmedRoles = ["assistant"], GrantedCorePermissions = [CoreAppPermissions.AppLifecycle],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>>
                { ["assistant"] = [new("default", null, "/assistant")] },
        };
        await apps.UpsertAppAsync(caller);
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1,
            [new("admin", "admin@example.test", "Admin", "host.admin", false, now, now)], [], [], []));
        var parent = await BrowserAuthorityFixture.Grant(host, caller.Id, "admin");
        var policies = host.Services.GetRequiredService<AgentPolicyStore>();
        var policy = new AgentTargetPolicy(null, true, new Dictionary<string, string>(),
            new Dictionary<string, AssistantTargetGrant> { [caller.Id] = new(now, "grant",
                DeniedTools: scope == "start-denied" ? ["start_app"] : null) });
        await policies.ChangeAsync("hosty:core", policy);
        var token = await host.Services.GetRequiredService<AssistantMcpAccess>().IssueAsync(caller.Id, "hosty:core",
            host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(caller.Id), parent.AccessToken, default, "session-one");
        await Install(host, "example.consumer", "example.provider");
        await Install(host, "example.provider");
        using var client = host.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/mcp")
        { Content = JsonContent.Create(new { jsonrpc = "2.0", id = 1, method = "tools/call", @params = new
            { name = scope == "start-denied" ? "restart_app" : "start_app", arguments = new { appId = "example.consumer" } } }) };
        request.Headers.Authorization = new("Bearer", token.Token);
        request.Headers.Accept.ParseAdd("application/json, text/event-stream");
        using var response = await client.SendAsync(request);
        response.EnsureSuccessStatusCode();
        Assert.Contains("waiting", await response.Content.ReadAsStringAsync());
        if (scope == "revoked") await policies.ChangeAsync("hosty:core", policy with { Assistants = null });
        var lifecycle = host.Services.GetRequiredService<CoreLifecycleService>();
        await lifecycle.ResumeWaitingAppsAsync();
        Assert.Equal(scope == "allowed" ? 2 : 0, adapter.Starts);
        if (scope == "start-denied")
        {
            // The original Restart may finish once an operator supplies the provider, but the
            // assistant cannot use that accepted request to launch an additional app.
            await lifecycle.StartAsync("example.provider");
            await lifecycle.ResumeWaitingAppsAsync();
            Assert.Equal(2, adapter.Starts);
            Assert.Equal("running", (await apps.GetAppAsync("example.consumer"))!.RuntimeState);
        }
    }

    private static Task<CoreHttpHarness> Host(Adapter adapter) => CoreHttpHarness.StartAsync(configure: services =>
    {
        services.RemoveAll<IAppRuntimeAdapter>();
        services.AddSingleton<IAppRuntimeAdapter>(adapter);
    });

    private static async Task Install(CoreHttpHarness host, string id, string? provider = null)
    {
        var path = Path.Combine(host.Services.GetRequiredService<CoreDataPaths>().DataRoot, id + ".json");
        await File.WriteAllTextAsync(path, JsonSerializer.Serialize(new
        {
            schemaVersion = "app.0.1", id, name = id, version = "1.0.0",
            runtimeProfiles = new[] { new { key = "local", type = "localCommand", @default = true } }, defaultRuntime = "local",
            services = new[] { new { key = "app", runtimes = new { local = new { type = "localCommand", command = "echo fixture", workingDirectory = "." } } } },
            dependencies = provider is null ? [] : new[] { new { id = provider, required = true } },
        }));
        await host.Services.GetRequiredService<CoreLifecycleService>().InstallAsync(new(path, Autostart: false));
    }

    private sealed class Adapter : IAppRuntimeAdapter
    {
        public string Type => "localCommand";
        public int Starts { get; private set; }
        public Task<AppRuntimeStartResult> StartAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
        { Starts++; return Task.FromResult(new AppRuntimeStartResult("running", [])); }
        public Task<AppRuntimeOperationResult> StopAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default) => Task.FromResult(new AppRuntimeOperationResult("stopped"));
        public Task<AppRuntimeOperationResult> RemoveAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default) => Task.FromResult(new AppRuntimeOperationResult("removed"));
        public Task<AppRuntimeLogsResult> GetLogsAsync(RuntimeLifecycleContext context, int tail, CancellationToken cancellationToken = default) => Task.FromResult(new AppRuntimeLogsResult(""));
        public Task<AppRuntimeHealthResult> GetHealthAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default) => Task.FromResult(new AppRuntimeHealthResult("healthy", [new("app", "running", null, null, null, null, null, Health: "healthy")]));
    }
}
