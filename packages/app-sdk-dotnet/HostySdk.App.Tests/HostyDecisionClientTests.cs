using System.Net;
using System.Text;
using HostySdk.App;
using Xunit;
namespace HostySdk.App.Tests;

public sealed class HostyDecisionClientTests
{
    [Fact]
    public async Task EveryOperationUsesCurrentUserAndConflictsAreNeverRetried()
    {
        var handler = new Handler(); using var http = new HttpClient(handler);
        var generation = 0;
        var client = new HostyDecisionClient(http, new() { AppId = "independent.source", CoreOrigin = "https://core.test", ServiceToken = "service" },
            _ => Task.FromResult("user-" + ++generation));
        await client.ListAsync(new(Subject: "a&b"));
        await client.ResponsesAsync();
        handler.Conflict = true;
        var error = await Assert.ThrowsAsync<HostyProviderException>(() => client.ResolveAsync("id/one", new("same-command", 7, new Dictionary<string, HostyDecisionAnswer> { ["first"] = new(Text: "Answer") })));
        Assert.Equal(409, error.StatusCode);
        Assert.Equal(3, handler.Calls.Count);
        Assert.Equal(new[] { "user-1", "user-2", "user-3" }, handler.Calls.Select(call => call.User));
        Assert.All(handler.Calls, call => Assert.Equal("Bearer service", call.Bearer));
        Assert.Contains("subject=a%26b", handler.Calls[0].Url);
        Assert.Contains("/id%2Fone/resolve", handler.Calls[2].Url);
        Assert.Contains("same-command", handler.Calls[2].Body);
    }
    [Fact]
    public async Task MissingCurrentUserNeverSendsServiceOnlyRequest()
    {
        var handler = new Handler(); using var http = new HttpClient(handler);
        var client = new HostyDecisionClient(http, new() { AppId = "source", CoreOrigin = "https://core.test", ServiceToken = "service" }, _ => Task.FromResult(""));
        await Assert.ThrowsAsync<InvalidOperationException>(() => client.ListAsync());
        Assert.Empty(handler.Calls);
    }
    private sealed class Handler : HttpMessageHandler
    {
        public bool Conflict { get; set; }
        public List<(string Url, string? Bearer, string User, string Body)> Calls { get; } = [];
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Calls.Add((request.RequestUri!.AbsoluteUri, request.Headers.Authorization?.ToString(), request.Headers.GetValues("X-Hosty-User-Token").Single(),
                request.Content is null ? "" : await request.Content.ReadAsStringAsync(ct)));
            return new(Conflict ? HttpStatusCode.Conflict : HttpStatusCode.OK) { Content = new StringContent(Conflict
                ? "{\"error\":{\"code\":\"decision_conflict\",\"message\":\"Refresh\"}}"
                : "{\"items\":[],\"pendingCount\":0,\"cursor\":null}", Encoding.UTF8, "application/json") };
        }
    }
}
