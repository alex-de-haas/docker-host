using System.Net;
using System.Text;
using HostySdk.App;
using Xunit;

namespace HostySdk.App.Tests;

public sealed class HostyBackgroundClientTests
{
    [Fact]
    public async Task CoalescesIssuanceAndDoesNotReplayFailedMutations()
    {
        var handler = new Handler();
        using var http = new HttpClient(handler);
        var client = new HostyBackgroundClient(http, new() { AppId = "worker", CoreOrigin = "http://core.test", ServiceToken = "service" }, "grant", "scope");
        var tokens = await Task.WhenAll(Enumerable.Range(0, 12).Select(_ => client.TokenAsync()));
        Assert.All(tokens, token => Assert.Equal("scoped", token));
        Assert.Equal(1, handler.Issuances);
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/apps/target/update");
        using var response = await client.SendCoreAsync(request);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        Assert.Equal(1, handler.Operations);
        using var foreign = new HttpRequestMessage(HttpMethod.Post, "http://other.test/api/apps/target/update");
        await Assert.ThrowsAsync<ArgumentException>(() => client.SendCoreAsync(foreign));
        Assert.Equal(1, handler.Operations);
    }

    [Fact]
    public async Task RefreshesCredentialBeforeItsDeadline()
    {
        var handler = new Handler { LifetimeSeconds = 5 };
        using var http = new HttpClient(handler);
        var client = new HostyBackgroundClient(http, new() { AppId = "worker", CoreOrigin = "http://core.test", ServiceToken = "service" }, "grant", "scope");
        await client.TokenAsync();
        await client.TokenAsync();
        Assert.Equal(2, handler.Issuances);
    }

    private sealed class Handler : HttpMessageHandler
    {
        public int Issuances;
        public int Operations;
        public int LifetimeSeconds = 300;
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Assert.Equal("core.test", request.RequestUri!.Host);
            Assert.Equal("Bearer service", request.Headers.Authorization!.ToString());
            if (request.RequestUri.AbsolutePath.EndsWith("/background/token", StringComparison.Ordinal))
            {
                Interlocked.Increment(ref Issuances);
                Assert.Equal("{\"grantId\":\"grant\",\"scopeId\":\"scope\"}", await request.Content!.ReadAsStringAsync(cancellationToken));
                await Task.Yield();
                return new(HttpStatusCode.OK) { Content = new StringContent($$"""{"accessToken":"scoped","expiresAt":"{{DateTimeOffset.UtcNow.AddSeconds(LifetimeSeconds):O}}"}""", Encoding.UTF8, "application/json") };
            }
            Interlocked.Increment(ref Operations);
            Assert.Equal("scoped", Assert.Single(request.Headers.GetValues("X-Hosty-App-Identity")));
            return new(HttpStatusCode.ServiceUnavailable);
        }
    }
}
