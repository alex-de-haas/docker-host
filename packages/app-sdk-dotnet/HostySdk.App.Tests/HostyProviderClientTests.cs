using System.Net;
using System.Text;
using HostySdk.App;
using Xunit;
namespace HostySdk.App.Tests;

public sealed class HostyProviderClientTests
{
    [Fact]
    public async Task ServiceCredentialNeverReachesTheSpeechProvider()
    {
        var handler = new Handler();
        using var http = new HttpClient(handler);
        var client = new HostyProviderClient(http, new() { AppId = "ordinary", CoreOrigin = "http://core.test", ServiceToken = "private-service" });
        var provider = new HostyProvider("speech", "Speech", "speech-to-text", "default", 1, [], "http://speech.test/api/speech/v1", true);
        var result = await client.TranscribeAsync(provider, new byte[] { 1, 2, 3 });
        Assert.Equal("recognized", result.Text);
        Assert.Equal(2, handler.Calls.Count);
        Assert.Equal(("core.test", "Bearer private-service"), handler.Calls[0]);
        Assert.Equal(("speech.test", "Bearer scoped"), handler.Calls[1]);
    }
    [Fact]
    public async Task DeniedGrantDoesNotContactSpeechProvider()
    {
        var handler = new Handler { Denied = true };
        using var http = new HttpClient(handler);
        var client = new HostyProviderClient(http, new() { AppId = "ordinary", CoreOrigin = "http://core.test", ServiceToken = "private-service" });
        var error = await Assert.ThrowsAsync<HostyProviderException>(() => client.ListAsync("speech-to-text"));
        Assert.Equal(403, error.StatusCode);
        Assert.Equal("app_permission_required", error.Code);
        Assert.Single(handler.Calls);
    }
    [Fact]
    public async Task TaskDispatchUsesOnlyTheBoundReceiptAndServiceIdentityAtCore()
    {
        using var handler = new DispatchHandler(); using var http = new HttpClient(handler);
        var client = new HostyProviderClient(http, new() { AppId = "task.source", CoreOrigin = "http://core.test", ServiceToken = "source-service" });
        var dispatch = new HostyTaskDispatchRef("owner", "manual:original", Guid.NewGuid().ToString());
        var executor = new HostyTaskProviderRef("unrelated.executor", "installation", "selected");
        Assert.Empty((await client.TaskDispatchOptionsAsync(dispatch, executor)).Options);
        var result = await client.DispatchTaskAsync(new(dispatch, executor, "get", "execution-one"));
        Assert.False(result.StopConfirmed); Assert.Equal("running", result.State);
        Assert.Equal(2, handler.Bodies.Count);
        foreach (var body in handler.Bodies)
        {
            Assert.Contains(dispatch.RequestId, body); Assert.Contains(dispatch.PrincipalId, body);
            Assert.Contains(executor.InstallationId, body); Assert.DoesNotContain("source-service", body);
        }
    }
    [Fact]
    public async Task TaskWorkspaceUsesOnlyTheExactReceiptAndServiceIdentity()
    {
        using var handler = new WorkspaceHandler(); using var http = new HttpClient(handler);
        var client = new HostyProviderClient(http, new() { AppId = "executor", CoreOrigin = "http://core.test", ServiceToken = "executor-service" });
        var input = new HostyTaskWorkspaceRequest(new("owner", "manual:original", "action-id"), "execution-id", "native-session", "lease-id", "activity",
            Activity: new("idle", "lease-id", Stopped: true, Sequence: 2));
        var response = await client.TaskWorkspaceAsync(input);
        Assert.Equal("idle", response.GetProperty("state").GetString());
        Assert.Contains("action-id", handler.Body); Assert.Contains("lease-id", handler.Body); Assert.DoesNotContain("executor-service", handler.Body);
    }
    private sealed class WorkspaceHandler : HttpMessageHandler
    {
        internal string Body = "";
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Assert.Equal("http://core.test/api/internal/apps/executor/task-workspace", request.RequestUri!.AbsoluteUri);
            Assert.Equal("Bearer executor-service", request.Headers.Authorization!.ToString());
            Assert.False(request.Headers.Contains("X-Hosty-User-Token"));
            Body = await request.Content!.ReadAsStringAsync(ct);
            return new(HttpStatusCode.OK) { Content = new StringContent("{\"state\":\"idle\",\"stopRequested\":false}", Encoding.UTF8, "application/json") };
        }
    }

    private sealed class DispatchHandler : HttpMessageHandler
    {
        internal List<string> Bodies = [];
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Assert.Equal("http://core.test/api/internal/apps/task.source/task-dispatch", request.RequestUri!.AbsoluteUri);
            Assert.Equal("Bearer source-service", request.Headers.Authorization!.ToString());
            Assert.False(request.Headers.Contains("X-Hosty-User-Token"));
            Bodies.Add(await request.Content!.ReadAsStringAsync(ct));
            var value = Bodies.Count == 1 ? """{"options":[],"defaultId":null}"""
                : """{"executionId":"execution-one","revision":1,"state":"running","stopConfirmed":false,"createdAt":"now","updatedAt":"now"}""";
            return new(HttpStatusCode.OK) { Content = new StringContent(value, Encoding.UTF8, "application/json") };
        }
    }
    private sealed class Handler : HttpMessageHandler
    {
        public bool Denied { get; init; }
        public List<(string, string?)> Calls { get; } = [];
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls.Add((request.RequestUri!.Host, request.Headers.Authorization?.ToString()));
            var json = Denied ? """{"code":"app_permission_required","message":"Denied"}""" : Calls.Count == 1
                ? """{"token":"scoped","provider":{"appId":"speech","kind":"speech-to-text","key":"default","version":1,"url":"http://speech.test/api/speech/v1"}}"""
                : """{"text":"recognized"}""";
            return Task.FromResult(new HttpResponseMessage(Denied ? HttpStatusCode.Forbidden : HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") });
        }
    }
}
