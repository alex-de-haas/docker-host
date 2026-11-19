using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using HostySdk.App;
using Xunit;

namespace HostySdk.App.Tests;

public sealed class HostyAgentExecutionClientTests
{
    [Fact]
    public async Task PreparedMutationRetriesKeepExactBytesAndOnlyScopedTokenReachesProvider()
    {
        var provider = new HostyProviderRef("independent.agent", "opaque-installation", "native");
        var sessionId = Guid.NewGuid().ToString();
        var prepared = HostyAgentExecutionClient.PrepareSession(sessionId, new(new(new("configured", "1"),
            Instructions: [new("test", "private prompt")])));
        var calls = new List<string>(); var authorizations = new List<HostyAgentAuthorizationRequest>();
        using var handler = new Handler(async request => {
            Assert.Equal("agent.test", request.RequestUri!.Host);
            Assert.Equal("Bearer exact-operation", request.Headers.Authorization!.ToString());
            Assert.False(request.Headers.Contains("X-Hosty-User-Token"));
            calls.Add(await request.Content!.ReadAsStringAsync());
            return new(HttpStatusCode.OK) { Content = new StringContent("{}", Encoding.UTF8, "application/json") };
        });
        using var http = new HttpClient(handler);
        var client = new HostyAgentExecutionClient(http, provider, (request, _) => {
            authorizations.Add(request);
            return Task.FromResult(new HostyAgentAuthorization(provider, "http://agent.test/api/agent/v1", "exact-operation", DateTimeOffset.UtcNow.AddMinutes(1), "admission", DateTimeOffset.UtcNow.AddHours(1)));
        });
        await client.SendAsync(prepared); await client.SendAsync(prepared);
        Assert.Equal(2, calls.Count); Assert.Equal(prepared.Body, calls[0]); Assert.Equal(calls[0], calls[1]);
        Assert.All(authorizations, metadata => {
            Assert.Equal(Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(prepared.Body))).ToLowerInvariant(), metadata.BodyHash);
            Assert.DoesNotContain("private prompt", JsonSerializer.Serialize(metadata));
        });
        await Assert.ThrowsAsync<ArgumentException>(() => client.SendAsync(prepared with { Body = "{}" }));
        Assert.Equal(2, calls.Count);
    }

    [Fact]
    public async Task ChangedInstallationIsRejectedBeforeProviderContact()
    {
        var provider = new HostyProviderRef("agent", "installation", "default");
        using var http = new HttpClient(new Handler(_ => throw new InvalidOperationException("Must not contact changed provider")));
        var client = new HostyAgentExecutionClient(http, provider, (_, _) => Task.FromResult(new HostyAgentAuthorization(
            provider with { InstallationId = "replaced" }, "http://agent.test", "token", DateTimeOffset.UtcNow.AddMinutes(1), "admission", DateTimeOffset.UtcNow.AddHours(1))));
        var error = await Assert.ThrowsAsync<HostyProviderException>(() => client.GetAsync("capabilities", "/capabilities"));
        Assert.Equal("provider_changed", error.Code);
    }

    [Fact]
    public async Task SseUsesAfterCursorAndRejectsAnotherRunsEvent()
    {
        var provider = new HostyProviderRef("agent", "installation", "default"); var runId = Guid.NewGuid().ToString();
        using var http = new HttpClient(new Handler(request => {
            Assert.EndsWith("?after=cursor", request.RequestUri!.AbsoluteUri);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(
                "event: agent\nid: next\ndata: {\"schemaVersion\":\"agent-event.1\",\"runId\":\"other\",\"generation\":\"generation\",\"sequence\":\"1\",\"revision\":\"1\",\"occurredAt\":\"2026-11-12T00:00:00Z\",\"type\":\"warning\",\"source\":{},\"data\":{}}\n\n", Encoding.UTF8, "text/event-stream") });
        }));
        var client = new HostyAgentExecutionClient(http, provider, (_, _) => Task.FromResult(new HostyAgentAuthorization(provider,
            "http://agent.test", "token", DateTimeOffset.UtcNow.AddMinutes(1), "admission", DateTimeOffset.UtcNow.AddHours(1))));
        var error = await Assert.ThrowsAsync<HostyProviderException>(async () => { await foreach (var _ in client.EventsAsync(runId, "cursor")) { } });
        Assert.Equal("provider_response_invalid", error.Code);
    }

    [Theory]
    [InlineData("read", "observed")]
    [InlineData("start", "observed")]
    [InlineData("sse", "observed")]
    [InlineData("read", "cleared")]
    [InlineData("start", "cleared")]
    [InlineData("sse", "cleared")]
    [InlineData("read", "omitted")]
    [InlineData("start", "omitted")]
    [InlineData("sse", "omitted")]
    public async Task TypedSnapshotResponses_PreserveOptionalLatestContext(string operation, string observation)
    {
        var provider = new HostyProviderRef("independent.agent", "installation", "default");
        var runId = Guid.NewGuid().ToString(); var sessionId = Guid.NewGuid().ToString();
        var snapshot = new Dictionary<string, object?> {
            ["ref"] = new { provider, id = runId }, ["sessionId"] = sessionId, ["generation"] = "generation",
            ["revision"] = "3", ["state"] = "succeeded", ["phase"] = "terminal", ["stopConfirmed"] = true,
            ["freshness"] = "current", ["observedAt"] = "2026-11-13T00:00:00Z", ["configurationRevision"] = "1",
            ["lastSequence"] = "9007199254740993", ["cursor"] = "cursor", ["pending"] = Array.Empty<object>(),
            ["effects"] = new { certainty = "known", unresolvedCallIds = Array.Empty<string>() }
        };
        if (observation != "omitted") snapshot["latestContext"] = new {
            sequence = "9007199254740993",
            usage = observation == "cleared" ? null : new {
                usedTokens = 32, maxTokens = 128, estimated = true, observedAt = "2026-11-13T00:00:00Z",
                mcp = new { tools = new[] { new { name = "read", tokens = 7, isLoaded = true } } },
                sources = new { skills = new[] { new { id = "selected-skill", tokens = 5 } } }
            }
        };
        var json = JsonSerializer.Serialize(snapshot, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        using var http = new HttpClient(new Handler(request => {
            Assert.Equal(operation == "start" ? HttpMethod.Put : HttpMethod.Get, request.Method);
            Assert.Equal(operation == "start" ? $"/sessions/{sessionId}/runs/{runId}" :
                operation == "sse" ? $"/runs/{runId}/events" : $"/runs/{runId}", request.RequestUri!.AbsolutePath);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = operation == "sse"
                ? new StringContent($"event: snapshot\nid: cursor\ndata: {json}\n\n", Encoding.UTF8, "text/event-stream")
                : new StringContent(json, Encoding.UTF8, "application/json") });
        }));
        var client = new HostyAgentExecutionClient(http, provider, (_, _) => Task.FromResult(new HostyAgentAuthorization(
            provider, "http://agent.test", "exact-operation", DateTimeOffset.UtcNow.AddMinutes(1), "admission", DateTimeOffset.UtcNow.AddHours(1))));
        HostyAgentExecutionSnapshot actual;
        if (operation == "start") actual = await client.SendRunAsync(HostyAgentExecutionClient.PrepareRun(sessionId, runId,
            new("1", "1", "new", new("prompt"))));
        else if (operation == "sse") {
            var frames = new List<HostyAgentExecutionFrame>();
            await foreach (var frame in client.EventsAsync(runId)) frames.Add(frame);
            actual = Assert.Single(frames).Snapshot!;
        }
        else actual = await client.RunAsync(runId);

        Assert.Equal(runId, actual.Ref.Id);
        if (observation == "omitted") Assert.Null(actual.LatestContext);
        else {
            Assert.True(actual.LatestContext.HasValue);
            using var expected = JsonDocument.Parse(json);
            Assert.Equal(expected.RootElement.GetProperty("latestContext").GetRawText(), actual.LatestContext.Value.GetRawText());
            Assert.Equal("9007199254740993", actual.LatestContext.Value.GetProperty("sequence").GetString());
            Assert.Equal(observation == "cleared" ? JsonValueKind.Null : JsonValueKind.Object,
                actual.LatestContext.Value.GetProperty("usage").ValueKind);
        }
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task InstallationHistoryUsesOnlyTheReadCredentialAndValidatesRunIdentity(bool matching)
    {
        var provider = new HostyProviderRef("another.provider", "installation", "agent");
        var run = Guid.NewGuid().ToString();
        var generation = Guid.NewGuid().ToString();
        var observation = new {
            sessionId = "session-1", runId = run, generation, userId = "user", principalId = "principal",
            item = new { kind = "event", cursor = "run-position", @event = new {
                schemaVersion = "agent-event.1", runId = matching ? run : "another-run", generation,
                sequence = "1", revision = "1", occurredAt = DateTimeOffset.UtcNow, type = "message.completed",
                source = new { agentId = "main" }, data = new { messageId = "reply", text = "Hello" }
            } }
        };
        using var http = new HttpClient(new Handler(request => {
            Assert.Equal("/agent/v1/history/events?after=last", request.RequestUri!.PathAndQuery);
            Assert.Equal("Bearer read-history", request.Headers.Authorization!.ToString());
            Assert.False(request.Headers.Contains("X-Hosty-User-Token"));
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) {
                Content = new StringContent($"event: observation\nid: shared-position\ndata: {JsonSerializer.Serialize(observation)}\n\n", Encoding.UTF8, "text/event-stream")
            });
        }));
        var client = new HostyAgentExecutionClient(http, provider, (_, _) => throw new InvalidOperationException("Unexpected user authorization"));
        var binding = new HostyAgentHistoryBinding("read-history", DateTimeOffset.UtcNow.AddHours(1), "http://provider.test/agent/v1");
        var results = new List<HostyAgentHistoryObservation>();
        async Task Collect() { await foreach (var item in client.HistoryAsync(binding, "last")) results.Add(item); }
        if (!matching) { await Assert.ThrowsAsync<HostyProviderException>(Collect); return; }
        await Collect();
        Assert.Equal("shared-position", Assert.Single(results).Cursor);
        Assert.Equal("run-position", results[0].Item.Cursor);
    }

    [Fact]
    public async Task InstallationHistoryRejectsRunUpdatesWithoutSnapshot()
    {
        var provider = new HostyProviderRef("another.provider", "installation", "agent");
        var generation = Guid.NewGuid().ToString();
        var value = new { sessionId = "s", runId = "r", generation, userId = "u", principalId = "p",
            item = new { kind = "event", cursor = "run-position", @event = new
            {
                schemaVersion = "agent-event.1", runId = "r", generation, sequence = "1", revision = "2",
                occurredAt = DateTimeOffset.UtcNow, type = "run.updated", source = new { agentId = "root" }, data = new { }
            } }
        };
        using var http = new HttpClient(new Handler(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
        {
            Content = new StringContent($"event: observation\nid: installation-position\ndata: {JsonSerializer.Serialize(value)}\n\n",
                Encoding.UTF8, "text/event-stream")
        })));
        var client = new HostyAgentExecutionClient(http, provider, (_, _) => throw new InvalidOperationException());
        var binding = new HostyAgentHistoryBinding("history", DateTimeOffset.UtcNow.AddHours(1), "http://provider.test/agent/v1");
        await using var reader = client.HistoryAsync(binding).GetAsyncEnumerator();
        await Assert.ThrowsAsync<HostyProviderException>(() => reader.MoveNextAsync().AsTask());
    }

    [Theory]
    [InlineData("watermark", null, true)]
    [InlineData("changed", null, false)]
    [InlineData("watermark", "previous", false)]
    public async Task InstallationHistoryPagingKeepsItsBoundary(string boundary, string? nextCursor, bool valid)
    {
        var provider = new HostyProviderRef("another.provider", "installation", "agent");
        using var http = new HttpClient(new Handler(request =>
        {
            Assert.Equal("/agent/v1/history/events?after=previous&through=watermark&limit=2", request.RequestUri!.PathAndQuery);
            Assert.Equal("application/json", Assert.Single(request.Headers.Accept).MediaType);
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(JsonSerializer.Serialize(new { through = boundary, observations = Array.Empty<object>(), nextCursor }),
                    Encoding.UTF8, "application/json")
            });
        }));
        var client = new HostyAgentExecutionClient(http, provider, (_, _) => throw new InvalidOperationException("Unexpected user authorization"));
        var binding = new HostyAgentHistoryBinding("history", DateTimeOffset.UtcNow.AddHours(1), "http://provider.test/agent/v1");
        if (valid)
        {
            var page = await client.HistoryPageAsync(binding, "previous", "watermark", 2);
            Assert.Empty(page.Observations);
            Assert.Equal("watermark", page.Through);
        }
        else
        {
            await Assert.ThrowsAsync<HostyProviderException>(() => client.HistoryPageAsync(binding, "previous", "watermark", 2));
        }
    }

    private sealed class Handler(Func<HttpRequestMessage, Task<HttpResponseMessage>> callback) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) => callback(request);
    }
}
