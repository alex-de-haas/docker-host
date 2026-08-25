using System.Net;
using System.Text;
using System.Text.Json;
using HostySdk.App;
using Xunit;

namespace HostySdk.App.Tests;

// Scoped access tokens (docs/features/scoped-access-tokens/feature.md): the credential an external
// client presents straight to this app, validated by asking Core on every call.
public sealed class HostyScopedTokenClientTests
{
    private sealed class RecordingHandler(HttpStatusCode status, object? body) : HttpMessageHandler
    {
        public List<(string Path, string? Authorization, string? Body)> Requests { get; } = [];

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Requests.Add((
                request.RequestUri!.AbsolutePath,
                request.Headers.Authorization?.ToString(),
                request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken)));

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

    private static HostyScopedTokenClient Client(HttpMessageHandler handler, HostyAppOptions? options = null)
        => new(new StubFactory(handler), options ?? Options());

    [Fact]
    public async Task IntrospectAsync_AsksForItsOwnAppAndCarriesTheToolForTheAuditLine()
    {
        var handler = new RecordingHandler(
            HttpStatusCode.OK,
            new { active = true, sub = "user_1", role = "host.admin", scopes = new[] { "mcp:read" } });

        var result = await Client(handler).IntrospectAsync("hostyat_value", "list_people");

        Assert.True(result.Active);
        Assert.Equal("user_1", result.Sub);
        Assert.Equal("host.admin", result.Role);
        Assert.True(result.HasScope(HostyScopedTokenClient.McpReadScope));
        Assert.False(result.HasScope("mcp:write"));

        var request = Assert.Single(handler.Requests);
        Assert.Equal("/api/internal/apps/com.example.app/token/introspect", request.Path);
        // The service token authenticates the app; the credential under test travels in the body and
        // is never this request's own bearer.
        Assert.Equal("Bearer hosty_app_service.1.a.b", request.Authorization);
        Assert.Contains("\"tool\":\"list_people\"", request.Body);
    }

    [Fact]
    public async Task IntrospectAsync_AsksEveryTime_BecauseRevocationMustNotWaitForACache()
    {
        var handler = new RecordingHandler(
            HttpStatusCode.OK,
            new { active = true, sub = "user_1", role = "host.admin", scopes = new[] { "mcp:read" } });
        var client = Client(handler);

        await client.IntrospectAsync("hostyat_value", "list_people");
        await client.IntrospectAsync("hostyat_value", "list_people");

        // The secrets client caches on purpose; this one must not, and the difference is the whole
        // reason this credential can live in a client's config file.
        Assert.Equal(2, handler.Requests.Count);
    }

    [Fact]
    public async Task IntrospectAsync_TreatsAnInactiveAnswerAsAnAnswer_AndAnUnreachableCoreAsAFailure()
    {
        // The pair a caller turns into two different HTTP statuses: 401 for the first, 503 for the
        // second. Collapsing them would tell a legitimate client its credential is bad whenever Core
        // happens to be restarting.
        var inactive = await Client(new RecordingHandler(
            HttpStatusCode.OK,
            new { active = false, sub = (string?)null, role = (string?)null, scopes = Array.Empty<string>() }))
            .IntrospectAsync("hostyat_value");
        Assert.False(inactive.Active);
        Assert.Null(inactive.Sub);

        var failure = await Assert.ThrowsAsync<HostyScopedTokenException>(
            () => Client(new ThrowingHandler(new HttpRequestException("refused"))).IntrospectAsync("hostyat_value"));
        Assert.Equal(HostyScopedTokenErrorCodes.Unavailable, failure.Code);
    }

    [Fact]
    public async Task IntrospectAsync_FailsClosedOnAnAnswerThatCarriesNoSubject()
    {
        var result = await Client(new RecordingHandler(HttpStatusCode.OK, new { active = true }))
            .IntrospectAsync("hostyat_value");

        // An answer that cannot be read is not a grant. `active: true` with nobody to act as is the
        // shape a wire-format change would produce, and it must not authorize anything.
        Assert.False(result.Active);
    }

    [Fact]
    public async Task IntrospectAsync_RefusesWithoutAServiceToken_AndNeverCallsCoreForAnEmptyCredential()
    {
        var handler = new RecordingHandler(HttpStatusCode.OK, new { active = true, sub = "user_1" });

        var missing = await Assert.ThrowsAsync<HostyScopedTokenException>(
            () => Client(handler, Options(serviceToken: null)).IntrospectAsync("hostyat_value"));
        Assert.Equal(HostyScopedTokenErrorCodes.ServiceTokenMissing, missing.Code);

        var empty = await Client(handler).IntrospectAsync("   ");
        Assert.False(empty.Active);
        Assert.Empty(handler.Requests);
    }
}
