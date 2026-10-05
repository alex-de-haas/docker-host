using System.Net;
using System.Text;
using System.Text.Json;

namespace Haas.Hosty.Core.Tests;

public sealed class McpCatalogReaderTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Discovery_OnlyInitializesAndLists_WithBoundedPagination(bool endless)
    {
        var calls = new List<string>();
        using var client = new HttpClient(new Handler(async request => {
            Assert.Equal("https://app.test/mcp", request.RequestUri!.AbsoluteUri);
            Assert.Equal("Bearer discovery-secret", request.Headers.Authorization!.ToString());
            if (request.Method == HttpMethod.Delete) return new(HttpStatusCode.OK);
            var json = JsonDocument.Parse(await request.Content!.ReadAsStringAsync()).RootElement;
            var method = json.GetProperty("method").GetString()!;
            calls.Add(method);
            Assert.Contains(method, new[] { "initialize", "notifications/initialized", "tools/list" });
            if (method == "notifications/initialized") return new(HttpStatusCode.Accepted);
            var id = json.GetProperty("id").GetRawText();
            var result = method == "initialize"
                ? "{\"protocolVersion\":\"2025-06-18\",\"capabilities\":{\"tools\":{}},\"serverInfo\":{\"name\":\"fixture\",\"version\":\"1\"}}"
                : "{\"tools\":[{\"name\":\"read_items\",\"inputSchema\":{\"type\":\"object\"}}]" + (endless ? ",\"nextCursor\":\"next\"}" : "}");
            return new(HttpStatusCode.OK) { Content = new StringContent("{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"result\":" + result + "}", Encoding.UTF8, "application/json") };
        }));
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        if (endless)
            await Assert.ThrowsAsync<InvalidOperationException>(() => AssistantMcpDiscovery.ReadCatalogAsync(new("https://app.test/mcp"), "discovery-secret", client, timeout.Token));
        else
        {
            var result = await AssistantMcpDiscovery.ReadCatalogAsync(new("https://app.test/mcp"), "discovery-secret", client, timeout.Token);
            Assert.Equal("read_items", Assert.Single(result.Tools).Name);
            Assert.DoesNotContain("discovery-secret", CoreJson.Text(result));
        }
        Assert.Equal(endless ? 20 : 1, calls.Count(method => method == "tools/list"));
        Assert.DoesNotContain("tools/call", calls);
    }
    private sealed class Handler(Func<HttpRequestMessage, Task<HttpResponseMessage>> respond) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) => respond(request);
    }
}
