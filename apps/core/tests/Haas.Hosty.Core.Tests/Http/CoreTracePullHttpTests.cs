using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class CoreTracePullHttpTests
{
    [Fact]
    public async Task EmptyRegistryAnonymousAndRemovedCredentialsCannotActivateCapture()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var client = host.CreateClient();
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/internal/telemetry/traces")).StatusCode);
        client.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken("removed"));
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/internal/telemetry/traces")).StatusCode);
        Assert.False(host.Services.GetRequiredService<CoreTraceBuffer>().IsCapturing);
        Assert.Empty(host.Services.GetRequiredService<CoreApiActivity>().Read().Apps);
    }
    [Fact]
    public async Task AnyExplicitlyAuthorizedInstallationCanRead_AndEveryReadRechecksGrants()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var app = CoreApiObservabilityTests.App("unrelated.reader");
        await apps.UpsertAppAsync(app);
        using var client = host.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(app.Id));
        using var response = await client.GetAsync("/api/internal/telemetry/traces?limit=999999");
        response.EnsureSuccessStatusCode();
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        Assert.Equal(1, json.RootElement.GetProperty("contractVersion").GetInt32());
        Assert.True(json.RootElement.GetProperty("capturing").GetBoolean());
        Assert.Equal(0.1, json.RootElement.GetProperty("rootSampleRatio").GetDouble());
        var activity = host.Services.GetRequiredService<CoreApiActivity>();
        Assert.Equal(1, activity.Read().Apps[app.Id].TotalRequests);
        Assert.Equal(0, activity.Read().Apps[app.Id].TotalEligibleRequests);
        await apps.UpsertAppAsync(app with { GrantedCorePermissions = [CoreAppPermissions.ReadApps] });
        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/internal/telemetry/traces")).StatusCode);
        Assert.False(host.Services.GetRequiredService<CoreTraceBuffer>().IsCapturing);
        // Identity is known even though authorization rejected the request.
        Assert.Equal(2, activity.Read().Apps[app.Id].TotalRequests);
    }
    [Fact]
    public async Task StreamOpeningIsCountedBeforeDisconnect_HeartbeatsDoNotAddRequests()
    {
        await using var host = await CoreHttpHarness.StartAsync(map: app => app.MapGet("/api/fixture/stream", async (HttpContext http, AppServiceTokenService tokens, AppRegistryStore apps) =>
        {
            var token = CoreSessionAuthorization.ReadBearerToken(http.Request)!;
            var id = tokens.ResolveAppId(token)!;
            _ = await apps.GetAppAsync(id);
            http.Response.ContentType = "text/event-stream";
            for (var i = 0; i < 5; i++) await http.Response.WriteAsync("data: heartbeat\n\n", http.RequestAborted);
            await http.Response.Body.FlushAsync(http.RequestAborted);
            try { await Task.Delay(Timeout.InfiniteTimeSpan, http.RequestAborted); }
            catch (OperationCanceledException) { }
        }));
        var caller = CoreApiObservabilityTests.App();
        await host.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(caller);
        using var client = host.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(caller.Id));
        for (var attempt = 1; attempt <= 2; attempt++)
        {
            using var cancellation = new CancellationTokenSource();
            using var response = await client.GetAsync("/api/fixture/stream", HttpCompletionOption.ResponseHeadersRead, cancellation.Token);
            Assert.Equal(attempt, host.Services.GetRequiredService<CoreApiActivity>().Read().Apps[caller.Id].TotalEligibleRequests);
            cancellation.Cancel();
        }
    }
    [Fact]
    public async Task ExactCountersAreExportedWithoutAnyCpuSamplesOrTelemetryProcess()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        var app = CoreApiObservabilityTests.App();
        await host.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(app);
        using var client = host.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", host.Services.GetRequiredService<AppServiceTokenService>().CreateToken(app.Id));
        (await client.GetAsync("/api/internal/telemetry/logs")).EnsureSuccessStatusCode();
        var metrics = await client.GetStringAsync("/api/internal/telemetry/metrics");
        Assert.Contains("hosty_core_api_requests_total", metrics);
        Assert.Contains("hosty_app_id=\"example.caller\"", metrics);
        Assert.DoesNotContain("container.cpu.percent", metrics);
        Assert.Equal(2, host.Services.GetRequiredService<CoreApiActivity>().Read().Apps[app.Id].TotalRequests);
    }
}
