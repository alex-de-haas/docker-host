using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Haas.Hosty.Core;
using HostySdk.App;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class CoreAgentSessionHttpTests
{
    [Fact]
    public async Task IndependentExecutorSeparatesReadAndControlAndSupportsSubjectBoundRunStreams()
    {
        using var source = new Executor();
        await using var host = await CoreHttpHarness.StartAsync(configure: services => services.AddSingleton<IHttpClientFactory>(source));
        source.Services = host.Services; var now = host.Services.GetRequiredService<IClock>().UtcNow;
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1, [new("owner", "owner@example.test", "Owner", "host.admin", false, now, now)], [], [], []));
        source.App = new("independent.execution", "Independent executor", null, "1.0.0", "runtime", false, "installed", null, null, "local", "installed", "running", null, null, [], new Dictionary<string, AppSettingValue>(), [], [], [], now, now)
        {
            ConfirmedRoles = ["agent-sessions"], Endpoints = [new("api", "http", "http://executor.invalid", true)],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["agent-sessions"] = [new("custom", "api", "/v1", 1, ["session.read", "session.list", "run.cancel", "run.events"])] },
        };
        await host.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(source.App);
        var provider = new HostyProviderRef(source.App.Id, PanelIdentity.Installation(source.App), "custom");
        source.Run = new(new(provider, "run-separate"), "1", "running", now, "current", false, new(provider, "native-separate"), new(provider, "conversation-separate"));
        async Task<string> Token(params string[] scopes) => (await AccessTokenEndpoints.IssueAsync("owner", AccessTokenKinds.Manual, "Execution test", host.Services.GetRequiredService<UserDirectoryStore>(), host.Services.GetRequiredService<IClock>(), host.Services.GetRequiredService<AuthLifetimes>(), default, audience: AccessTokenScopes.CoreAudience, scopes: scopes)).Id;
        using var client = host.CreateClient(); var token = await Token(AccessTokenScopes.McpRead, AccessTokenScopes.McpHistoryRead);
        client.DefaultRequestHeaders.Authorization = new("Bearer", token);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync("/api/agent-sessions/v1/runs/get", new CoreAgentRunGet(source.Run.Ref))).StatusCode);
        await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(state => state with { Sessions = state.Sessions.Select(s => s.Id == token ? s with { Scopes = [AccessTokenScopes.McpRead, AccessTokenScopes.McpAgentSessionsRead] } : s).ToArray() });
        var result = await DirectEnvironmentHttpTests.Tool(client, "agent_run_get", new { input = new CoreAgentRunGet(source.Run.Ref) });
        Assert.Equal("running", result.GetProperty("structuredContent").GetProperty("state").GetString());
        var cancel = new CoreAgentRunCancel(source.Run.Ref, Guid.NewGuid().ToString(), "1");
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsJsonAsync("/api/agent-sessions/v1/runs/cancel", cancel)).StatusCode);
        using var created = await client.PostAsJsonAsync("/api/agent-sessions/v1/runs/subscriptions", new CoreAgentRunSubscriptionCreate(source.Run.Ref));
        var subscription = await created.Content.ReadFromJsonAsync<CoreAgentRunSubscription>(); Assert.Equal(HttpStatusCode.OK, created.StatusCode);
        using var other = host.CreateClient(); other.DefaultRequestHeaders.Authorization = new("Bearer", await Token(AccessTokenScopes.McpRead, AccessTokenScopes.McpAgentSessionsRead));
        Assert.Equal(HttpStatusCode.Gone, (await other.GetAsync("/api/agent-sessions/v1/runs/subscriptions/" + subscription!.Handle)).StatusCode);
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/agent-sessions/v1/runs/subscriptions/" + subscription!.Handle);
        using var stream = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
        Assert.Equal("text/event-stream", stream.Content.Headers.ContentType!.MediaType);
        using var reader = new StreamReader(await stream.Content.ReadAsStreamAsync(timeout.Token));
        Assert.Equal("event: run.changed", await reader.ReadLineAsync(timeout.Token));
        await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(state => state with { Sessions = state.Sessions.Select(s => s.Id == token ? s with { Scopes = [AccessTokenScopes.McpRead, AccessTokenScopes.McpAgentSessionsRead, AccessTokenScopes.McpAgentSessionsControl] } : s).ToArray() });
        using var cancelled = await client.PostAsJsonAsync("/api/agent-sessions/v1/runs/cancel", cancel);
        Assert.Equal(HttpStatusCode.OK, cancelled.StatusCode);
        var receipt = await cancelled.Content.ReadFromJsonAsync<HostyRunCancelReceipt>(); Assert.True(receipt!.Run.StopConfirmed);
        await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(state => state with { Sessions = state.Sessions.Select(s => s.Id == token ? s with { Scopes = [AccessTokenScopes.McpRead] } : s).ToArray() });
        string? line; do { line = await reader.ReadLineAsync(timeout.Token); } while (line is not null && line != "event: stream.closed");
        Assert.Equal("event: stream.closed", line);
    }

    [Fact]
    public async Task BrowserEnvironmentConsumersRetainTheSamePrincipalThroughProviderMediation()
    {
        using var source = new Executor();
        await using var host = await CoreHttpHarness.StartAsync(configure: services => services.AddSingleton<IHttpClientFactory>(source));
        source.Services = host.Services; var now = host.Services.GetRequiredService<IClock>().UtcNow;
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1, [new("owner", "owner@example.test", "Owner", "host.admin", false, now, now)], [], [], []));
        source.App = new("independent.execution", "Independent executor", null, "1.0.0", "runtime", false, "installed", null, null, "local", "installed", "running", null, null, [], new Dictionary<string, AppSettingValue>(), [], [], [], now, now)
        {
            ConfirmedRoles = ["agent-sessions"], Endpoints = [new("api", "http", "http://executor.invalid", true)],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["agent-sessions"] = [new("custom", "api", "/v1", 1, ["session.read", "session.list", "run.cancel", "run.events"])] },
        };
        await host.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(source.App);
        var provider = new HostyProviderRef(source.App.Id, PanelIdentity.Installation(source.App), "custom");
        source.Run = new(new(provider, "run-separate"), "1", "running", now, "current", false, new(provider, "native-separate"), new(provider, "conversation-separate"));
        const string session = "browser-consumer";
        await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(state => state with { Sessions = [new(session, "owner", now, now.AddHours(1), null, now)] });
        using var client = host.CreateClient();
        using var created = await CoreReviewFixture.AsUserAsync(client, HttpMethod.Post, "/api/core-environments", session,
            new CoreEnvironmentCreate(Guid.NewGuid().ToString(), "Browser consumer"));
        created.EnsureSuccessStatusCode();
        var environment = (await created.Content.ReadFromJsonAsync<CoreEnvironmentView>())!;
        var root = "/api/core-environments/" + environment.Id + "/consumers";
        var registration = new CoreEnvironmentConsumerRegister(Guid.NewGuid().ToString(), Guid.NewGuid().ToString(), environment.Revision, source.Run.Ref);
        using var registered = await CoreReviewFixture.AsUserAsync(client, HttpMethod.Post, root + "/register", session, registration);
        registered.EnsureSuccessStatusCode();
        var consumer = (await registered.Content.ReadFromJsonAsync<CoreEnvironmentConsumerResult>())!.Consumer;
        Assert.Equal(CoreCapabilityAuthorization.OperatorPrincipal("owner", AppIdentityService.HashToken(session)), consumer.PrincipalId);
        source.Run = source.Run with { Revision = "2", State = "cancelled", StopConfirmed = true };
        using var released = await CoreReviewFixture.AsUserAsync(client, HttpMethod.Post, root + "/release", session,
            new CoreEnvironmentConsumerRelease(consumer.ConsumerId, Guid.NewGuid().ToString(), consumer.Revision, new("provider-confirmed-stop", DateTimeOffset.UtcNow, "Provider confirmed exit")));
        released.EnsureSuccessStatusCode();
        Assert.Equal("released", (await released.Content.ReadFromJsonAsync<CoreEnvironmentConsumerResult>())!.Consumer.State);
    }

    private sealed class Executor : HttpMessageHandler, IHttpClientFactory
    {
        internal IServiceProvider Services = null!; internal AppRecord App = null!; internal HostyAgentRun Run = null!;
        public HttpClient CreateClient(string name) => new(this, false);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var path = request.RequestUri!.AbsolutePath[3..]; var operation = path.Trim('/').Replace('/', '.');
            var bytes = await request.Content!.ReadAsByteArrayAsync(ct);
            var actor = await Services.GetRequiredService<CoreProviderMediation>().IntrospectAsync(App,
                new(request.Headers.Authorization!.Parameter!, "agent-sessions", "custom", operation, request.Method.Method, path, CoreProviderMediation.Hash(bytes)), ct);
            Assert.Equal("owner", actor.UserId); Assert.Null(actor.CallerAppId);
            using var input = JsonDocument.Parse(bytes);
            if (path == "/runs/notifications" && input.RootElement.GetProperty("waitSeconds").GetInt32() > 0) await Task.Delay(100, ct);
            if (path == "/runs/cancel") Run = Run with { Revision = "2", State = "cancelled", StopConfirmed = true };
            object result = path switch
            {
                "/runs/get" => Run,
                "/runs/cancel" => new HostyRunCancelReceipt(input.RootElement.GetProperty("requestId").GetString()!, "completed", Run),
                "/runs/notifications" => new HostyAgentRunNotification(Run, "opaque-run-" + Run.Revision, false),
                _ => throw new InvalidOperationException(path),
            };
            return new(HttpStatusCode.OK) { Content = new StringContent(JsonSerializer.Serialize(result, result.GetType(), JsonSerializerOptions.Web), System.Text.Encoding.UTF8, "application/json") };
        }
    }
}
