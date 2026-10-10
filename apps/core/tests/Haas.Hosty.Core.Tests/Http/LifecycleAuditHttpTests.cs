using System.Net;
using System.Net.Http.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Microsoft.Extensions.Hosting;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class LifecycleAuditHttpTests
{
    private const string AppId = "example.audit";
    private const string Session = "browser-credential-canary-never-export";

    [Theory]
    [InlineData("http", "start")]
    [InlineData("control", "start")]
    [InlineData("http", "stop")]
    [InlineData("control", "stop")]
    [InlineData("http", "restart")]
    [InlineData("control", "restart")]
    [InlineData("http", "autostart")]
    [InlineData("control", "autostart")]
    [InlineData("http", "configure")]
    [InlineData("control", "configure")]
    [InlineData("http", "switch-runtime")]
    [InlineData("control", "switch-runtime")]
    [InlineData("http", "update")]
    [InlineData("control", "update")]
    public async Task LifecycleRoutes_RecordActorAndOutcomeForBothTransports(string via, string verb)
    {
        var adapter = new AuditAdapter();
        await using var host = await CreateHostAsync(adapter);
        await SeedUserAsync(host);
        var path = await InstallAsync(host);
        var lifecycle = host.Services.GetRequiredService<CoreLifecycleService>();
        await lifecycle.StartAsync(AppId);
        object body = new { };
        if (verb == "autostart") body = new { autostart = true };
        if (verb == "switch-runtime")
        {
            var plan = await lifecycle.CreateRuntimeSwitchPlanAsync(AppId, new("alternate"));
            body = new { targetRuntime = "alternate", planDigest = plan.PlanDigest };
        }
        if (verb == "update")
        {
            await File.WriteAllTextAsync(path, Manifest.Replace("1.0.0", "1.0.1"));
            var plan = await lifecycle.CreateUpdatePlanAsync(AppId, new(path));
            body = new { planDigest = plan.PlanDigest };
        }
        using var client = host.CreateClient();
        using var request = Request(host, via, AppId, verb, body);
        using var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        if (lifecycle.TryGetRunningBackgroundUpdate(AppId) is { } run) await run;

        var records = (await host.Services.GetRequiredService<AuditStore>().ReadRecentAsync())
            .Where(e => e.Action == "app.lifecycle." + verb).Reverse().ToArray();
        Assert.Equal(via == "http" && verb == "update" ? ["accepted", "succeeded"] : ["succeeded"], records.Select(e => e.Outcome));
        Assert.Single(records.Select(e => e.Details["operationId"]).Distinct());
        Assert.All(records, e =>
        {
            Assert.Equal(AppId, e.ResourceId);
            Assert.Equal(via == "http" ? "audit-user" : null, e.ActorUserId);
            Assert.Equal(via, e.Details["via"]);
            Assert.DoesNotContain(Session, CoreJson.Text(e));
        });
    }

    [Theory]
    [InlineData("http", "StOp/")]
    [InlineData("control", "StOp/")]
    [InlineData("http", "stop/")]
    [InlineData("control", "STOP")]
    public async Task LifecycleRoutes_AuditEquivalentRouteSpellings(string via, string verb)
    {
        await using var host = await CreateHostAsync(new());
        await SeedUserAsync(host);
        await InstallAsync(host);
        using var client = host.CreateClient();
        using var request = Request(host, via, AppId, verb, new { });
        using var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var entry = Assert.Single(await host.Services.GetRequiredService<AuditStore>().ReadRecentAsync(),
            e => e.Action == "app.lifecycle.stop");
        Assert.Equal("succeeded", entry.Outcome);
        Assert.Equal(via, entry.Details["via"]);
    }

    [Theory]
    [InlineData("http", false, "failed")]
    [InlineData("control", false, "failed")]
    [InlineData("http", true, "refused")]
    [InlineData("control", true, "refused")]
    public async Task LifecycleRoutes_RecordMissingTargetsAndAuthorizationRefusals(string via, bool refuse, string outcome)
    {
        await using var host = await CreateHostAsync(new());
        await SeedUserAsync(host, refuse ? "host.user" : "host.admin");
        using var client = host.CreateClient();
        using var request = Request(host, via, "example.absent", "stop", new { });
        if (via == "control" && refuse)
        {
            request.Headers.Remove("X-Hosty-Control-Secret");
            request.Headers.Add("X-Hosty-Control-Secret", "wrong");
        }
        using var response = await client.SendAsync(request);
        Assert.False(response.IsSuccessStatusCode);
        var entry = Assert.Single(await host.Services.GetRequiredService<AuditStore>().ReadRecentAsync(),
            e => e.Action == "app.lifecycle.stop");
        Assert.Equal(outcome, entry.Outcome);
        Assert.Equal(via == "http" ? "audit-user" : null, entry.ActorUserId);
    }

    [Fact]
    public async Task AppManagementTransport_PreservesTheActingUserWithoutExportingItsCredentials()
    {
        await using var host = await CreateHostAsync(new());
        await InstallAsync(host);
        using var client = await AppManagementHttpTests.CreateAppClient(host, "example.shell", [CoreAppPermissions.AppLifecycle]);
        using var response = await client.PostAsJsonAsync($"/api/apps/{AppId}/stop", new { });
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var entry = Assert.Single(await host.Services.GetRequiredService<AuditStore>().ReadRecentAsync(),
            e => e.Action == "app.lifecycle.stop");
        Assert.Equal("actor", entry.ActorUserId);
        foreach (var value in client.DefaultRequestHeaders.SelectMany(h => h.Value))
            Assert.DoesNotContain(value, CoreJson.Text(entry));
    }

    [Theory]
    [InlineData("stop")]
    [InlineData("StOp/")]
    public async Task AppManagementScopeRefusal_IsRecordedBeforeTheEndpointRuns(string verb)
    {
        await using var host = await CreateHostAsync(new());
        await InstallAsync(host);
        using var client = await AppManagementHttpTests.CreateAppClient(host, "example.shell", []);
        using var response = await client.PostAsJsonAsync($"/api/apps/{AppId}/{verb}", new { });
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        var entry = Assert.Single(await host.Services.GetRequiredService<AuditStore>().ReadRecentAsync(),
            e => e.Action == "app.lifecycle.stop");
        Assert.Equal("refused", entry.Outcome);
        Assert.Null(entry.ActorUserId);
        Assert.Equal("http", entry.Details["via"]);
    }

    [Fact]
    public async Task QueuedUpdate_AuditFailureAfterAcceptanceDoesNotUndoOrMisreportAppliedWork()
    {
        var adapter = new AuditAdapter();
        await using var host = await CreateHostAsync(adapter);
        await SeedUserAsync(host);
        var path = await InstallAsync(host);
        var lifecycle = host.Services.GetRequiredService<CoreLifecycleService>();
        await lifecycle.StartAsync(AppId);
        await File.WriteAllTextAsync(path, Manifest.Replace("1.0.0", "1.0.1"));
        var plan = await lifecycle.CreateUpdatePlanAsync(AppId, new(path));
        adapter.StopGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        using var client = host.CreateClient();
        using var request = Request(host, "http", AppId, "update", new { planDigest = plan.PlanDigest });
        using var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var run = lifecycle.TryGetRunningBackgroundUpdate(AppId);
        Assert.NotNull(run);
        var auditPath = host.Services.GetRequiredService<CoreDataPaths>().AuditLogPath;
        File.Delete(auditPath);
        Directory.CreateDirectory(auditPath);
        adapter.StopGate.SetResult();
        await run.WaitAsync(TimeSpan.FromSeconds(10));
        var app = (await host.Services.GetRequiredService<AppRegistryStore>().GetAppAsync(AppId))!;
        Assert.Equal("1.0.1", app.Version);
        Assert.Equal("running", app.RuntimeState);
        Assert.Null(app.LastError);
    }

    [Theory]
    [InlineData("succeeded")]
    [InlineData("failed")]
    [InlineData("cancelled")]
    public async Task QueuedUpdate_RecordsAcceptanceBeforeWorkAndSettlesAfterTheRequest(string outcome)
    {
        var adapter = new AuditAdapter();
        await using var host = await CreateHostAsync(adapter);
        await SeedUserAsync(host);
        var path = await InstallAsync(host);
        var lifecycle = host.Services.GetRequiredService<CoreLifecycleService>();
        await lifecycle.StartAsync(AppId);
        await File.WriteAllTextAsync(path, Manifest.Replace("1.0.0", "1.0.1"));
        var plan = await lifecycle.CreateUpdatePlanAsync(AppId, new(path));
        adapter.StopGate = new(TaskCreationOptions.RunContinuationsAsynchronously);
        adapter.FailStop = outcome == "failed";
        using var client = host.CreateClient();
        using var cancellation = new CancellationTokenSource();
        using var request = Request(host, "http", AppId, "update", new { planDigest = plan.PlanDigest });
        using var response = await client.SendAsync(request, cancellation.Token);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var audit = host.Services.GetRequiredService<AuditStore>();
        var accepted = Assert.Single(await audit.ReadRecentAsync(), e => e.Action == "app.lifecycle.update");
        Assert.Equal("accepted", accepted.Outcome);
        var run = lifecycle.TryGetRunningBackgroundUpdate(AppId);
        Assert.NotNull(run);
        cancellation.Cancel(); // The request lifetime cannot cancel accepted work.
        if (outcome == "cancelled") host.Services.GetRequiredService<IHostApplicationLifetime>().StopApplication();
        else adapter.StopGate.SetResult();
        await run.WaitAsync(TimeSpan.FromSeconds(10));
        var entries = (await audit.ReadRecentAsync()).Where(e => e.Action == "app.lifecycle.update").ToArray();
        Assert.Equal([outcome, "accepted"], entries.Select(e => e.Outcome));
        Assert.All(entries, e => Assert.Equal("audit-user", e.ActorUserId));
        Assert.Single(entries.Select(e => e.Details["operationId"]).Distinct());
        Assert.DoesNotContain("exception-credential-canary", await File.ReadAllTextAsync(host.Services.GetRequiredService<CoreDataPaths>().AuditLogPath));
    }

    [Fact]
    public async Task AuditDiskFailure_DoesNotChangeSuccessfulHttpResponse()
    {
        await using var host = await CreateHostAsync(new());
        await SeedUserAsync(host);
        await InstallAsync(host);
        var auditPath = host.Services.GetRequiredService<CoreDataPaths>().AuditLogPath;
        Directory.CreateDirectory(auditPath); // A directory cannot receive an append.
        using var client = host.CreateClient();
        using var request = Request(host, "http", AppId, "stop", new { });
        using var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("stopped", (await host.Services.GetRequiredService<AppRegistryStore>().GetAppAsync(AppId))!.RuntimeState);
    }

    private static Task<CoreHttpHarness> CreateHostAsync(AuditAdapter adapter)
        => CoreHttpHarness.StartAsync(configure: services =>
        {
            services.RemoveAll<IAppRuntimeAdapter>();
            services.AddSingleton<IAppRuntimeAdapter>(adapter);
        });

    private static async Task SeedUserAsync(CoreHttpHarness host, string role = "host.admin")
    {
        var now = host.Services.GetRequiredService<IClock>().UtcNow;
        await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1,
            [new("audit-user", "audit@example.test", "Audit", role, false, now, now)], [], [],
            [new(Session, "audit-user", now, now.AddHours(1), null, now)]));
    }

    private static HttpRequestMessage Request(CoreHttpHarness host, string via, string appId, string verb, object body)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, $"{(via == "http" ? "/api" : "/control/v1")}/apps/{appId}/{verb}")
        { Content = JsonContent.Create(body) };
        if (via == "control") request.Headers.Add("X-Hosty-Control-Secret", host.Services.GetRequiredService<ControlSecret>().Value);
        else
        {
            request.Headers.Add("Cookie", $"hosty_session={Session}; hosty_csrf=audit-csrf");
            request.Headers.Add(CoreSessionAuthorization.CsrfHeaderName, "audit-csrf");
        }
        return request;
    }

    private static async Task<string> InstallAsync(CoreHttpHarness host)
    {
        var path = Path.Combine(host.Services.GetRequiredService<CoreDataPaths>().DataRoot, "audit-fixture.json");
        await File.WriteAllTextAsync(path, Manifest);
        await host.Services.GetRequiredService<CoreLifecycleService>().InstallAsync(new(path, Autostart: false));
        return path;
    }

    private const string Manifest = """
        {"schemaVersion":"app.0.1","id":"example.audit","name":"Audit","version":"1.0.0",
        "runtimeProfiles":[{"key":"local","type":"localCommand","default":true},{"key":"alternate","type":"localCommand"}],
        "defaultRuntime":"local","services":[{"key":"app","runtimes":{
        "local":{"type":"localCommand","command":"echo fixture","workingDirectory":"."},
        "alternate":{"type":"localCommand","command":"echo fixture","workingDirectory":"."}}}]}
        """;

    private sealed class AuditAdapter : IAppRuntimeAdapter
    {
        public string Type => "localCommand";
        public TaskCompletionSource? StopGate { get; set; }
        public bool FailStop { get; set; }
        public Task<AppRuntimeStartResult> StartAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
            => Task.FromResult(new AppRuntimeStartResult("running", []));
        public async Task<AppRuntimeOperationResult> StopAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default)
        {
            if (StopGate is { } gate) await gate.Task.WaitAsync(cancellationToken);
            if (FailStop) throw new AppLifecycleException("runtime_stop_failed", "exception-credential-canary");
            return new("stopped");
        }
        public Task<AppRuntimeOperationResult> RemoveAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default) => Task.FromResult(new AppRuntimeOperationResult("removed"));
        public Task<AppRuntimeLogsResult> GetLogsAsync(RuntimeLifecycleContext context, int tail, CancellationToken cancellationToken = default) => Task.FromResult(new AppRuntimeLogsResult(""));
        public Task<AppRuntimeHealthResult> GetHealthAsync(RuntimeLifecycleContext context, CancellationToken cancellationToken = default) => Task.FromResult(new AppRuntimeHealthResult("healthy", []));
    }
}
