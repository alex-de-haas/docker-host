using System.Net;
using System.Text;
using System.Text.Json;
using HostySdk.App;
using Xunit;

namespace HostySdk.App.Tests;

public sealed class HostyTranslationClientTests
{
    private static readonly HostyProvider Provider = new("harness", "Claude", "translation", "claude", 1, ["markdown"], "http://harness.test/api/translation/v1/claude", true);
    private static readonly HostyTranslationRequest Input = new("# Example\n\n- [ ] D1. Read.", "ru", Format: "markdown");

    [Fact]
    public async Task TranslateAsync_MarkdownSelection_SendsOnlyScopedAuthorityToExactKey()
    {
        var handler = new Handler();
        using var http = new HttpClient(handler);
        var result = await Client(http).TranslateAsync(Provider, Input);
        Assert.Equal("# Пример", result.Text);
        Assert.Equal(2, handler.Calls.Count);
        Assert.Equal("/api/internal/apps/consumer/providers/translation/token", handler.Calls[0].Uri.AbsolutePath);
        Assert.Equal("Bearer service", handler.Calls[0].Authorization);
        Assert.Equal("claude", JsonDocument.Parse(handler.Calls[0].Body).RootElement.GetProperty("key").GetString());
        Assert.Equal("http://harness.test/api/translation/v1/claude/translations", handler.Calls[1].Uri.AbsoluteUri);
        Assert.Equal("Bearer scoped", handler.Calls[1].Authorization);
        Assert.Equal("markdown", JsonDocument.Parse(handler.Calls[1].Body).RootElement.GetProperty("format").GetString());
    }

    [Theory]
    [InlineData("denied", "app_permission_required", 1)]
    [InlineData("version", "provider_incompatible", 1)]
    [InlineData("response", "provider_response_invalid", 2)]
    public async Task TranslateAsync_InvalidAuthorityOrResponse_FailsWithoutFallback(string failure, string code, int calls)
    {
        var handler = new Handler { Failure = failure };
        using var http = new HttpClient(handler);
        var error = await Assert.ThrowsAsync<HostyProviderException>(() => Client(http).TranslateAsync(Provider, Input));
        Assert.Equal(code, error.Code);
        Assert.Equal(calls, handler.Calls.Count);
    }

    [Fact]
    public async Task TranslateAsync_ConsumerCancellation_StopsProviderRequest()
    {
        using var cancellation = new CancellationTokenSource();
        var handler = new Handler { Cancel = cancellation };
        using var http = new HttpClient(handler);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => Client(http).TranslateAsync(Provider, Input, cancellation.Token));
        Assert.Equal(2, handler.Calls.Count);
    }

    private static HostyProviderClient Client(HttpClient http) => new(http, new() { AppId = "consumer", CoreOrigin = "http://core.test", ServiceToken = "service" });
    private sealed class Handler : HttpMessageHandler
    {
        public string? Failure { get; init; }
        public CancellationTokenSource? Cancel { get; init; }
        public List<(Uri Uri, string? Authorization, string Body)> Calls { get; } = [];
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            Calls.Add((request.RequestUri!, request.Headers.Authorization?.ToString(), await request.Content!.ReadAsStringAsync(cancellationToken)));
            if (Calls.Count == 2 && Cancel is not null) { Cancel.Cancel(); cancellationToken.ThrowIfCancellationRequested(); }
            var json = Failure == "denied" ? """{"code":"app_permission_required","message":"Denied"}""" : Calls.Count == 1
                ? JsonSerializer.Serialize(new { token = "scoped", provider = new { appId = "harness", kind = "translation", key = "claude", version = Failure == "version" ? 2 : 1, url = Provider.Url } })
                : JsonSerializer.Serialize(new { text = "# Пример", targetLanguage = Failure == "response" ? "en" : "ru", sourceLanguage = "auto" });
            return new HttpResponseMessage(Failure == "denied" ? HttpStatusCode.Forbidden : HttpStatusCode.OK) { Content = new StringContent(json, Encoding.UTF8, "application/json") };
        }
    }
}
