using System.Net.Http.Json;
using System.Text.RegularExpressions;

namespace Haas.Hosty.Core.Tests.Http;

// Explicitly called by tests whose setup/action is a user-confirmed mutation. Never installed as
// a global handler: permission, anonymous and unreviewed-call tests still use ordinary SendAsync.
internal static class CoreReviewFixture
{
    internal static Task<HttpResponseMessage> PutAsync(HttpClient client, string path, object body) =>
        SendAsync(client, new(HttpMethod.Put, path) { Content = JsonContent.Create(body) });
    internal static Task<HttpResponseMessage> PostAsync(HttpClient client, string path, object body) =>
        SendAsync(client, new(HttpMethod.Post, path) { Content = JsonContent.Create(body) });
    internal static Task<HttpResponseMessage> AsUserAsync(HttpClient client, HttpMethod method, string path, string browserSession, object? body = null)
    {
        var request = new HttpRequestMessage(method, path);
        request.Headers.Add("Cookie", $"hosty_session={browserSession}; hosty_csrf=review-proof");
        request.Headers.Add("X-Hosty-CSRF", "review-proof");
        if (body is not null) request.Content = JsonContent.Create(body);
        return SendAsync(client, request);
    }
    internal static async Task<HttpResponseMessage> SendAsync(HttpClient client, HttpRequestMessage request)
    {
        var bytes = request.Content is null ? null : await request.Content.ReadAsByteArrayAsync();
        var response = await client.SendAsync(request);
        if ((int)response.StatusCode != 428) return response;
        var review = (await response.Content.ReadFromJsonAsync<SettingsChangeView>())!;
        var cookies = request.Headers.TryGetValues("Cookie", out var values) ? values : client.DefaultRequestHeaders.GetValues("Cookie");
        var origin = request.RequestUri!.GetLeftPart(UriPartial.Authority);
        using var page = new HttpRequestMessage(HttpMethod.Get, new Uri(new Uri(origin), "/settings/confirm/" + review.Id));
        page.Headers.Add("Cookie", cookies);
        var html = await (await client.SendAsync(page)).Content.ReadAsStringAsync();
        var nonce = Regex.Match(html, "name=nonce value=\"([^\"]+)\"").Groups[1].Value;
        Assert.True(nonce.Length > 0, $"Confirmation page did not contain a decision form: {html}");
        using var decision = new HttpRequestMessage(HttpMethod.Post, page.RequestUri) {
            Content = new FormUrlEncodedContent(new Dictionary<string, string> { ["nonce"] = nonce, ["decision"] = "approve" }) };
        decision.Headers.Add("Cookie", cookies); decision.Headers.Add("Origin", origin);
        (await client.SendAsync(decision)).EnsureSuccessStatusCode();
        var replay = new HttpRequestMessage(request.Method, request.RequestUri);
        foreach (var header in request.Headers) replay.Headers.TryAddWithoutValidation(header.Key, header.Value);
        replay.Headers.Add(ProtectedSettingsChanges.Header, review.Id);
        if (bytes is not null) { replay.Content = new ByteArrayContent(bytes); foreach (var header in request.Content!.Headers) replay.Content.Headers.TryAddWithoutValidation(header.Key, header.Value); }
        response.Dispose();
        return await client.SendAsync(replay);
    }
}
