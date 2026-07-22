using System.Net;
using System.Text;
using System.Text.Json;
using HostySdk.App;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace HostySdk.App.Tests;

public sealed class HostySecretsClientTests
{
    // Replays queued responses in order and records what was sent, so a test can assert both the
    // request shape and how many round-trips the cache actually saved.
    private sealed class RecordingHandler(params (HttpStatusCode Status, object? Body)[] responses) : HttpMessageHandler
    {
        private int index;

        public List<(HttpMethod Method, string Path, string? Authorization, string? Body)> Requests { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add((
                request.Method,
                request.RequestUri!.AbsolutePath,
                request.Headers.Authorization?.ToString(),
                request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken)));

            var (status, body) = responses[Math.Min(index++, responses.Length - 1)];
            var response = new HttpResponseMessage(status);
            if (body is not null)
            {
                response.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
            }

            return response;
        }
    }

    private sealed class ThrowingHandler(Exception error) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
            => Task.FromException<HttpResponseMessage>(error);
    }

    private sealed class StubFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler) { BaseAddress = new Uri("http://core.test") };
    }

    private static HostyAppOptions Options(string? serviceToken = "hosty_app_service.1.a.b")
        => new() { AppId = "com.example.app", CoreOrigin = "http://core.test", ServiceToken = serviceToken };

    private static HostySecretsClient Client(HttpMessageHandler handler, HostyAppOptions? options = null)
        => new(new StubFactory(handler), options ?? Options(), NullLogger<HostySecretsClient>.Instance);

    [Fact]
    public async Task GetAsync_SendsTheServiceTokenToThePerKeyRoute_AndReturnsTheValue()
    {
        var handler = new RecordingHandler((HttpStatusCode.OK, new { value = "token-payload" }));

        var value = await Client(handler).GetAsync("trakt.connection.1.tokens");

        Assert.Equal("token-payload", value);
        var request = Assert.Single(handler.Requests);
        Assert.Equal(HttpMethod.Get, request.Method);
        Assert.Equal("/api/internal/apps/com.example.app/secrets/trakt.connection.1.tokens", request.Path);
        Assert.Equal("Bearer hosty_app_service.1.a.b", request.Authorization);
    }

    // A missing secret is the documented reconnect-required state, not a failure.
    [Fact]
    public async Task GetAsync_ReturnsNullOnNotFound_WithoutThrowing()
    {
        var handler = new RecordingHandler((HttpStatusCode.NotFound, new { code = "app_secret_not_found" }));

        Assert.Null(await Client(handler).GetAsync("absent"));
    }

    [Fact]
    public async Task GetAsync_ServesRepeatReadsFromTheCache_IncludingAMiss()
    {
        var handler = new RecordingHandler(
            (HttpStatusCode.OK, new { value = "cached" }),
            (HttpStatusCode.NotFound, new { code = "app_secret_not_found" }));
        var client = Client(handler);

        Assert.Equal("cached", await client.GetAsync("present"));
        Assert.Equal("cached", await client.GetAsync("present"));
        Assert.Null(await client.GetAsync("absent"));
        Assert.Null(await client.GetAsync("absent"));

        Assert.Equal(2, handler.Requests.Count);
    }

    [Fact]
    public async Task GetAsync_WithRefresh_BypassesTheCache()
    {
        var handler = new RecordingHandler(
            (HttpStatusCode.OK, new { value = "first" }),
            (HttpStatusCode.OK, new { value = "second" }));
        var client = Client(handler);

        Assert.Equal("first", await client.GetAsync("key"));
        Assert.Equal("second", await client.GetAsync("key", refresh: true));
        Assert.Equal("second", await client.GetAsync("key"));

        Assert.Equal(2, handler.Requests.Count);
    }

    [Fact]
    public async Task SetAsync_PutsTheValue_AndServesLaterReadsWithoutARoundTrip()
    {
        var handler = new RecordingHandler((HttpStatusCode.NoContent, null));
        var client = Client(handler);

        await client.SetAsync("key", "written");

        Assert.Equal("written", await client.GetAsync("key"));
        var request = Assert.Single(handler.Requests);
        Assert.Equal(HttpMethod.Put, request.Method);
        Assert.Equal("/api/internal/apps/com.example.app/secrets/key", request.Path);
        Assert.Contains("\"value\":\"written\"", request.Body);
    }

    [Fact]
    public async Task DeleteAsync_RemovesTheValue_AndLaterReadsReportItMissingFromTheCache()
    {
        var handler = new RecordingHandler((HttpStatusCode.NoContent, null));
        var client = Client(handler);
        await client.SetAsync("key", "written");

        await client.DeleteAsync("key");

        Assert.Null(await client.GetAsync("key"));
        Assert.Equal(2, handler.Requests.Count);
        Assert.Equal(HttpMethod.Delete, handler.Requests[1].Method);
    }

    [Fact]
    public async Task ListKeysAsync_AlwaysReadsLive_AndTargetsTheCollectionRoute()
    {
        var handler = new RecordingHandler((HttpStatusCode.OK, new { keys = new[] { "a.key", "b.key" } }));
        var client = Client(handler);

        Assert.Equal(["a.key", "b.key"], await client.ListKeysAsync());
        await client.ListKeysAsync();

        Assert.Equal(2, handler.Requests.Count);
        Assert.Equal("/api/internal/apps/com.example.app/secrets", handler.Requests[0].Path);
    }

    [Fact]
    public async Task WithoutAServiceToken_EveryOperationFailsWithoutCallingCore()
    {
        var handler = new RecordingHandler((HttpStatusCode.OK, new { value = "unused" }));
        var client = Client(handler, Options(serviceToken: null));

        await Assert.ThrowsAsync<HostySecretsException>(() => client.GetAsync("key"));
        await Assert.ThrowsAsync<HostySecretsException>(() => client.SetAsync("key", "value"));
        await Assert.ThrowsAsync<HostySecretsException>(() => client.ListKeysAsync());

        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task ARejectedWriteThrows_AndDoesNotPoisonTheCache()
    {
        var handler = new RecordingHandler(
            (HttpStatusCode.BadRequest, new { code = "app_secret_value_invalid" }),
            (HttpStatusCode.NotFound, new { code = "app_secret_not_found" }));
        var client = Client(handler);

        var error = await Assert.ThrowsAsync<HostySecretsException>(() => client.SetAsync("key", "too-big"));
        Assert.Contains("app_secret_value_invalid", error.Message);

        // The failed write must not be cached as if it had landed.
        Assert.Null(await client.GetAsync("key"));
        Assert.Equal(2, handler.Requests.Count);
    }

    [Fact]
    public async Task A404OnAMutationIsAnError_UnlikeAMissingSecretOnRead()
    {
        // Core only 404s a PUT/DELETE when the app itself is unknown (e.g. removed).
        var handler = new RecordingHandler((HttpStatusCode.NotFound, new { code = "app_not_found" }));
        var client = Client(handler);

        await Assert.ThrowsAsync<HostySecretsException>(() => client.SetAsync("key", "value"));
        await Assert.ThrowsAsync<HostySecretsException>(() => client.DeleteAsync("key"));
    }

    [Fact]
    public async Task ATransportFailureSurfacesAsHostySecretsException()
    {
        var client = Client(new ThrowingHandler(new HttpRequestException("connection refused")));

        var error = await Assert.ThrowsAsync<HostySecretsException>(() => client.GetAsync("key"));
        Assert.IsType<HttpRequestException>(error.InnerException);
    }

    [Fact]
    public async Task ATimeoutSurfacesAsHostySecretsException_NotACancellation()
    {
        // HttpClient timeouts arrive as TaskCanceledException with no caller cancellation.
        var client = Client(new ThrowingHandler(new TaskCanceledException("timed out")));

        var error = await Assert.ThrowsAsync<HostySecretsException>(() => client.GetAsync("key"));
        Assert.Contains("timed out", error.Message);
    }

    [Fact]
    public async Task CallerCancellationPropagates()
    {
        using var cancellation = new CancellationTokenSource();
        await cancellation.CancelAsync();
        var client = Client(new ThrowingHandler(new TaskCanceledException("cancelled")));

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => client.GetAsync("key", cancellationToken: cancellation.Token));
    }

    [Fact]
    public async Task KeysAndAppIdsAreUrlEscaped()
    {
        var handler = new RecordingHandler((HttpStatusCode.OK, new { value = "v" }));
        var options = new HostyAppOptions
        {
            AppId = "com.example.app",
            CoreOrigin = "http://core.test",
            ServiceToken = "hosty_app_service.1.a.b",
        };

        await Client(handler, options).GetAsync("weird key/with-slash");

        Assert.Equal(
            "/api/internal/apps/com.example.app/secrets/weird%20key%2Fwith-slash",
            Assert.Single(handler.Requests).Path);
    }
}
