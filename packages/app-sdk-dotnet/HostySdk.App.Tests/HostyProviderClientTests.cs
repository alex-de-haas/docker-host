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
