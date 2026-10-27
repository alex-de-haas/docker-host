using System.Net;
using System.Text;
using System.Text.Json;
using HostySdk.App;
using Xunit;
namespace HostySdk.App.Tests;

public sealed class HostyTaskClientTests
{
    [Fact]
    public async Task ExecutionUsesQualifiedSelectionAndOnlyScopedCredentialAtProvider()
    {
        var handler = new Handler();
        using var http = new HttpClient(handler);
        var providers = new HostyProviderClient(http, new() { AppId = "producer", CoreOrigin = "http://core.test", ServiceToken = "private-service" });
        var client = new HostyTaskExecutorClient(providers, new("independent.executor", "one", "default"), () => Task.FromResult("private-user"));
        var id = Guid.NewGuid().ToString();
        var input = new HostyTaskExecutionInput(new("producer", "original", "tasks", Guid.NewGuid().ToString()), 3,
            new("Work", "Markdown", []));
        var receipt = await client.AcceptAsync(id, input);
        Assert.Equal("accepted", receipt.State);
        Assert.Equal(2, handler.Calls.Count);
        Assert.Equal("private-user", handler.Calls[0].User);
        Assert.Equal("Bearer private-service", handler.Calls[0].Bearer);
        Assert.Null(handler.Calls[1].User);
        Assert.Equal("Bearer scoped", handler.Calls[1].Bearer);
        Assert.EndsWith("/executions/" + id, handler.Calls[1].Url);
        Assert.Contains("\"taskRevision\":3", handler.Calls[1].Body);
    }
    [Fact]
    public async Task ReplacedInstallationAndUnrelatedTaskReferencesNeverReachProvider()
    {
        var handler = new Handler { Installation = "replacement" };
        using var http = new HttpClient(handler);
        var providers = new HostyProviderClient(http, new() { AppId = "producer", CoreOrigin = "http://core.test", ServiceToken = "private-service" });
        var client = new HostyTaskExecutorClient(providers, new("independent.executor", "one", "default"));
        var error = await Assert.ThrowsAsync<HostyProviderException>(() => client.GetAsync(Guid.NewGuid().ToString()));
        Assert.Equal("provider_changed", error.Code); Assert.Single(handler.Calls);
        var tasks = new HostyTaskClient(providers, new("tasks", "one", "default"));
        await Assert.ThrowsAsync<ArgumentException>(() => tasks.GetAsync(new("tasks", "two", "default", "id")));
        Assert.Single(handler.Calls);
    }
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task UnassignedDraftRequests_PreserveExplicitNullAssignee(bool edit)
    {
        var handler = new Handler { Kind = "tasks", ProviderBody = """
            {"ref":{"appId":"independent.executor","installationId":"one","key":"default","id":"task"},
             "number":"HRN-1","revision":2,"inputRevision":2,"status":"Draft","title":"Work","markdown":"Description",
             "assignee":null,"requiresReview":false,"resources":[],"createdBy":{},"owner":{},
             "createdAt":"now","updatedAt":"now","cancelRequested":false,"attempts":[]}
            """ };
        using var http = new HttpClient(handler);
        var providers = new HostyProviderClient(http, new() { AppId = "producer", CoreOrigin = "http://core.test", ServiceToken = "service" });
        var client = new HostyTaskClient(providers, new("independent.executor", "one", "default"));
        var input = new HostyTaskInput("Work", "Description", null, []);

        if (edit) await client.EditAsync(new("independent.executor", "one", "default", "task"), new("edit-request", 1, input));
        else await client.CreateAsync(new("create-request", input));

        using var body = JsonDocument.Parse(handler.Calls[1].Body);
        var sent = body.RootElement.GetProperty("input");
        Assert.True(sent.TryGetProperty("assignee", out var assignee), "Unassigned tasks require an explicit null assignee.");
        Assert.Equal(JsonValueKind.Null, assignee.ValueKind);
        Assert.False(sent.TryGetProperty("workspaceId", out _));
    }
    [Theory]
    [InlineData(503, 503)]
    [InlineData(200, 502)]
    public async Task NonJsonResponsesPreserveTransportErrors(int responseStatus, int expectedStatus)
    {
        using var http = new HttpClient(new Handler { ProviderBody = "upstream unavailable", ProviderStatus = (HttpStatusCode)responseStatus });
        var providers = new HostyProviderClient(http, new() { AppId = "producer", CoreOrigin = "http://core.test", ServiceToken = "service" });
        var client = new HostyTaskExecutorClient(providers, new("independent.executor", "one", "default"));
        var error = await Assert.ThrowsAsync<HostyProviderException>(() => client.GetAsync(Guid.NewGuid().ToString()));
        Assert.Equal(expectedStatus, error.StatusCode);
    }
    private sealed class Handler : HttpMessageHandler
    {
        public string Installation { get; init; } = "one";
        public string Kind { get; init; } = "task-executor";
        public string? ProviderBody { get; init; }
        public HttpStatusCode ProviderStatus { get; init; } = HttpStatusCode.OK;
        public List<(string Url, string? Bearer, string? User, string Body)> Calls { get; } = [];
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Calls.Add((request.RequestUri!.AbsoluteUri, request.Headers.Authorization?.ToString(),
                request.Headers.TryGetValues("X-Hosty-User-Token", out var values) ? values.Single() : null,
                request.Content is null ? "" : await request.Content.ReadAsStringAsync(ct)));
            var json = request.RequestUri.Host == "core.test"
                ? $$$"""{"token":"scoped","provider":{"appId":"independent.executor","kind":"{{{Kind}}}","key":"default","version":1,"installationId":"{{{Installation}}}","url":"http://executor.test/v1"}}"""
                : """{"executionId":"receipt","revision":1,"state":"accepted","stopConfirmed":false,"createdAt":"now","updatedAt":"now"}""";
            return new(request.RequestUri.Host == "core.test" ? HttpStatusCode.OK : ProviderStatus) { Content = new StringContent(request.RequestUri.Host == "core.test" ? json : ProviderBody ?? json, Encoding.UTF8, "application/json") };
        }
    }
}
