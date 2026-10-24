using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Haas.Hosty.Launch;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class CoreStopHttpTests
{
    [Fact]
    public async Task AdminStopAcceptsCurrentInstanceAndPreservesAppsUntilHostExit()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await BrowserClient(host, "host.admin");
        var development = host.Services.GetRequiredService<CoreDevelopmentService>();
        var root = host.Services.GetRequiredService<HostyCoreRuntimeConfig>().DataRoot;
        var lifetime = host.Services.GetRequiredService<IHostApplicationLifetime>();
        var stopping = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var registration = lifetime.ApplicationStopping.Register(() => stopping.TrySetResult());
        try
        {
            // Neither an extra body field nor the legacy control query can disable preservation.
            using var response = await client.PostAsJsonAsync("/api/core/stop?keepApps=false", new { instance = development.Instance, keepApps = false });
            Assert.Equal(HttpStatusCode.Accepted, response.StatusCode);
            var body = JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement;
            Assert.Equal("accepted", body.GetProperty("status").GetString());
            Assert.Equal(development.Instance, body.GetProperty("instance").GetString());
            Assert.True(body.GetProperty("keepApps").GetBoolean());
            await stopping.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.True(host.Services.GetRequiredService<CoreShutdownOptions>().KeepRuntimeApps);
            Assert.False(lifetime.ApplicationStopped.IsCancellationRequested);
            Assert.Throws<IOException>(() => CoreLaunchFiles.Lock(root));
            var audit = Assert.Single(await host.Services.GetRequiredService<AuditStore>().ReadRecentAsync(), record => record.Action == "core.lifecycle.stop");
            Assert.Equal("accepted", audit.Outcome);
            Assert.Equal("actor", audit.ActorUserId);
            Assert.Equal("stop", audit.Details["operation"]);
        }
        finally { await host.StopAsync(); }
        // Acceptance held admission through shutdown; it is available only after actual host stop.
        using var afterExit = CoreLaunchFiles.Lock(root);
    }

    [Theory]
    [InlineData(null, true, HttpStatusCode.Unauthorized)]
    [InlineData("host.user", true, HttpStatusCode.Forbidden)]
    [InlineData("host.admin", false, HttpStatusCode.Forbidden)]
    public async Task StopRequiresAdministratorAndBrowserCsrf(string? role, bool csrf, HttpStatusCode expected)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await BrowserClient(host, role, csrf);
        using var response = await client.PostAsJsonAsync("/api/core/stop", new { instance = host.Services.GetRequiredService<CoreDevelopmentService>().Instance });
        Assert.Equal(expected, response.StatusCode);
        AssertNotStopping(host);
        using var admission = CoreLaunchFiles.Lock(host.Services.GetRequiredService<HostyCoreRuntimeConfig>().DataRoot);
    }

    [Theory]
    [InlineData("", HttpStatusCode.BadRequest, "invalid_request")]
    [InlineData("old-process", HttpStatusCode.Conflict, "core_instance_changed")]
    public async Task StopRejectsMissingOrStaleIdentityWithoutHoldingAdmission(string instance, HttpStatusCode expected, string code)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await BrowserClient(host, "host.admin");
        using var response = await client.PostAsJsonAsync("/api/core/stop", new { instance });
        Assert.Equal(expected, response.StatusCode);
        Assert.Equal(code, JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.GetProperty("code").GetString());
        AssertNotStopping(host);
        using var admission = CoreLaunchFiles.Lock(host.Services.GetRequiredService<HostyCoreRuntimeConfig>().DataRoot);
        var audit = Assert.Single(await host.Services.GetRequiredService<AuditStore>().ReadRecentAsync(), record => record.Action == "core.lifecycle.stop");
        Assert.Equal("failed", audit.Outcome);
    }

    [Theory]
    [InlineData("restart")]
    [InlineData("workspace")]
    [InlineData("launch-lease")]
    public async Task StopRefusesPendingCoreOrWorkspaceOperations(string pending)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await BrowserClient(host, "host.admin");
        var root = host.Services.GetRequiredService<HostyCoreRuntimeConfig>().DataRoot;
        using var otherAdmission = pending == "launch-lease" ? CoreLaunchFiles.Lock(root) : null;
        if (pending == "restart")
        {
            var operation = new CoreLaunchOperation(Guid.NewGuid().ToString("N"), "building", "dev", null, DateTimeOffset.UtcNow);
            CoreLaunchFiles.Write(CoreLaunchFiles.OperationPath(root, operation.Id), operation, CoreLaunchJson.Default.CoreLaunchOperation);
        }
        if (pending == "workspace")
            WorkspaceRuntimeFiles.Save(root, Activation("core-starting"));
        using var response = await client.PostAsJsonAsync("/api/core/stop", new { instance = host.Services.GetRequiredService<CoreDevelopmentService>().Instance });
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal("core_operation_in_progress", JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.GetProperty("code").GetString());
        AssertNotStopping(host);
        if (pending != "launch-lease") { using var admission = CoreLaunchFiles.Lock(root); }
    }

    [Fact]
    public async Task AnAlreadyActiveWorkspaceDoesNotPreventStoppingCore()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var development = host.Services.GetRequiredService<CoreDevelopmentService>();
        WorkspaceRuntimeFiles.Save(host.Services.GetRequiredService<HostyCoreRuntimeConfig>().DataRoot, Activation("active"));
        using var admission = await development.PrepareStopAsync(new(development.Instance), default);
        AssertNotStopping(host);
    }

    [Fact]
    public async Task DelegatedCallerRequiresCurrentLifecycleGrantAndAdminActor()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = await AppManagementHttpTests.CreateAppClient(host, "example.console", []);
        var instance = host.Services.GetRequiredService<CoreDevelopmentService>().Instance;
        using (var denied = await client.PostAsJsonAsync("/api/core/stop", new { instance }))
        {
            Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
            Assert.Equal("app_permission_required", JsonDocument.Parse(await denied.Content.ReadAsStringAsync()).RootElement.GetProperty("code").GetString());
        }
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var app = (await apps.GetAppAsync("example.console"))!;
        await apps.UpsertAppAsync(app with { GrantedCorePermissions = [CoreAppPermissions.CoreLifecycle] });
        // A stale target proves the granted caller reaches stop validation without causing shutdown.
        using (var validated = await client.PostAsJsonAsync("/api/core/stop", new { instance = "stale" }))
            Assert.Equal(HttpStatusCode.Conflict, validated.StatusCode);
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        var state = await users.ReadAsync();
        await users.WriteAsync(state with { Users = state.Users.Select(user => user with { Role = "host.user" }).ToArray() });
        using (var notAdmin = await client.PostAsJsonAsync("/api/core/stop", new { instance }))
            Assert.Equal(HttpStatusCode.Forbidden, notAdmin.StatusCode);
        AssertNotStopping(host);
    }

    [Fact]
    public async Task StopResultSignalsOnlyAfterSuccessfulResponseCompletion()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var lifetime = new StopLifetime();
        var admission = new RecordingAdmission();
        var options = new CoreShutdownOptions();
        var feature = new CompletionFeature();
        var context = new DefaultHttpContext { RequestServices = host.Services };
        context.Features.Set<IHttpResponseFeature>(feature);
        context.Response.Body = new MemoryStream();
        await new CoreStopAcceptedResult(new("accepted", "current", true), admission, options, lifetime).ExecuteAsync(context);
        Assert.Equal(202, context.Response.StatusCode);
        Assert.True(context.Response.Body.Length > 0);
        Assert.False(lifetime.ApplicationStopping.IsCancellationRequested);
        Assert.False(options.KeepRuntimeApps);
        await feature.CompleteAsync();
        Assert.True(lifetime.ApplicationStopping.IsCancellationRequested);
        Assert.True(options.KeepRuntimeApps);
        Assert.False(admission.Disposed);
        lifetime.Complete();
        Assert.True(admission.Disposed);
    }

    [Fact]
    public async Task FailedAcceptanceWriteReleasesAdmissionWithoutStopping()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var lifetime = new StopLifetime();
        var options = new CoreShutdownOptions();
        var root = host.Services.GetRequiredService<HostyCoreRuntimeConfig>().DataRoot;
        var development = host.Services.GetRequiredService<CoreDevelopmentService>();
        var admission = await development.PrepareStopAsync(new(development.Instance), default);
        var context = new DefaultHttpContext { RequestServices = host.Services };
        context.Response.Body = new FailingWriteStream();
        await Assert.ThrowsAsync<IOException>(() => new CoreStopAcceptedResult(new("accepted", development.Instance, true), admission, options, lifetime).ExecuteAsync(context));
        Assert.False(lifetime.ApplicationStopping.IsCancellationRequested);
        Assert.False(options.KeepRuntimeApps);
        using var nextAdmission = CoreLaunchFiles.Lock(root);
    }

    private static WorkspaceRuntimeActivation Activation(string phase) => new(Guid.NewGuid().ToString("D"), "workspace", "actor", "fingerprint", "instance", "source", null, null,
        new("dev", null, null, Environment.ProcessId, DateTimeOffset.UtcNow), [], phase);

    private static async Task<HttpClient> BrowserClient(CoreHttpHarness host, string? role, bool csrf = true)
    {
        var client = host.CreateClient();
        var cookies = new List<string>();
        if (role is not null)
        {
            var now = host.Services.GetRequiredService<IClock>().UtcNow;
            await host.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new(1,
                [new("actor", "actor@example.test", "Actor", role, false, now, now)], [], [],
                [new("operator", "actor", now, now.AddHours(1), null, now)]));
            cookies.Add($"{CoreSessionAuthorization.SessionCookieName}=operator");
        }
        if (csrf)
        {
            cookies.Add($"{CoreSessionAuthorization.CsrfCookieName}=stop-test");
            client.DefaultRequestHeaders.Add(CoreSessionAuthorization.CsrfHeaderName, "stop-test");
        }
        if (cookies.Count > 0) client.DefaultRequestHeaders.Add("Cookie", string.Join("; ", cookies));
        return client;
    }

    private static void AssertNotStopping(CoreHttpHarness host)
    {
        Assert.False(host.Services.GetRequiredService<CoreShutdownOptions>().KeepRuntimeApps);
        Assert.False(host.Services.GetRequiredService<IHostApplicationLifetime>().ApplicationStopping.IsCancellationRequested);
    }

    private sealed class RecordingAdmission : IDisposable
    {
        public bool Disposed { get; private set; }
        public void Dispose() => Disposed = true;
    }

    private sealed class StopLifetime : IHostApplicationLifetime, IDisposable
    {
        private readonly CancellationTokenSource stopping = new();
        private readonly CancellationTokenSource stopped = new();
        public CancellationToken ApplicationStarted => CancellationToken.None;
        public CancellationToken ApplicationStopping => stopping.Token;
        public CancellationToken ApplicationStopped => stopped.Token;
        public void StopApplication() => stopping.Cancel();
        public void Complete() => stopped.Cancel();
        public void Dispose() { Complete(); stopping.Dispose(); stopped.Dispose(); }
    }

    private sealed class CompletionFeature : HttpResponseFeature
    {
        private readonly List<(Func<object, Task> Callback, object State)> callbacks = [];
        public override void OnCompleted(Func<object, Task> callback, object state) => callbacks.Add((callback, state));
        public async Task CompleteAsync() { foreach (var (callback, state) in callbacks) await callback(state); }
    }

    private sealed class FailingWriteStream : MemoryStream
    {
        public override ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
            => ValueTask.FromException(new IOException("Client disconnected before acceptance."));
    }
}
