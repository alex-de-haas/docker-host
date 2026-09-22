using System.Net;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class SourceWorktreeHttpTests
{
    [Theory]
    [InlineData("diff", "{\"path\":\"file.txt\"}")]
    [InlineData("discard/plan", "{\"paths\":[\"file.txt\"]}")]
    [InlineData("discard", "{\"reviewId\":\"review\"}")]
    public async Task SourcePostsRequireCsrfEvenForAdministrators(string route, string body)
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        await SignInAsync(harness, "host.admin");
        using var client = harness.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/apps/test/source/{route}");
        request.Headers.Add("Cookie", "hosty_session=source-session");
        request.Content = new StringContent(body, System.Text.Encoding.UTF8, "application/json");

        using var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Contains("csrf_invalid", await response.Content.ReadAsStringAsync());
        Assert.True(response.Headers.CacheControl?.NoStore);
    }

    [Theory]
    [InlineData("status")]
    [InlineData("summary")]
    public async Task NonAdministratorCannotInspectSource(string route)
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        await SignInAsync(harness, "host.user");
        using var client = harness.CreateClient();
        client.DefaultRequestHeaders.Add("Cookie", "hosty_session=source-session");

        using var response = await client.GetAsync($"/api/apps/test/source/{route}");

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Contains("admin_required", await response.Content.ReadAsStringAsync());
    }

    [Fact]
    public async Task SummaryRequiresControlSecret()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        using var client = harness.CreateClient();
        using var response = await client.GetAsync("/control/v1/apps/test/source/summary");
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.True(response.Headers.CacheControl?.NoStore);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ImageDiffRequiresAdministratorEvenWithValidCsrf(bool signedIn)
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        if (signedIn) await SignInAsync(harness, "host.user");
        using var client = harness.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/apps/test/source/diff");
        request.Headers.Add("Cookie", (signedIn ? "hosty_session=source-session; " : "") + "hosty_csrf=test-csrf");
        request.Headers.Add("X-Hosty-CSRF", "test-csrf");
        request.Content = new StringContent("{\"path\":\"image.png\"}", System.Text.Encoding.UTF8, "application/json");
        using var response = await client.SendAsync(request);
        Assert.Equal(signedIn ? HttpStatusCode.Forbidden : HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.True(response.Headers.CacheControl?.NoStore);
    }

    [Fact]
    public async Task ImageDiffControlRouteRequiresControlSecret()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        using var client = harness.CreateClient();
        using var response = await client.PostAsync("/control/v1/apps/test/source/diff",
            new StringContent("{\"path\":\"image.png\"}", System.Text.Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Theory]
    [InlineData(null, false)]
    [InlineData("host.user", false)]
    [InlineData(null, true)]
    [InlineData("host.user", true)]
    public async Task CoreInspectionRequiresAdministrator(string? role, bool diff)
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        if (role is not null) await SignInAsync(harness, role);
        using var client = harness.CreateClient();
        using var request = new HttpRequestMessage(diff ? HttpMethod.Post : HttpMethod.Get,
            diff ? "/api/core/source/diff" : "/api/core/source/status");
        request.Headers.Add("Cookie", (role is null ? "" : "hosty_session=source-session; ") + "hosty_csrf=test-csrf");
        request.Headers.Add("X-Hosty-CSRF", "test-csrf");
        if (diff) request.Content = new StringContent("{\"path\":\"file.txt\"}", System.Text.Encoding.UTF8, "application/json");
        using var response = await client.SendAsync(request);
        Assert.Equal(role is null ? HttpStatusCode.Unauthorized : HttpStatusCode.Forbidden, response.StatusCode);
        Assert.True(response.Headers.CacheControl?.NoStore);
    }

    [Fact]
    public async Task CoreDiffRequiresCsrfAndStatusUsesTheSharedContract()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        await SignInAsync(harness, "host.admin");
        using var client = harness.CreateClient();
        client.DefaultRequestHeaders.Add("Cookie", "hosty_session=source-session");
        using var rejected = await client.PostAsync("/api/core/source/diff",
            new StringContent("{\"path\":\"file.txt\"}", System.Text.Encoding.UTF8, "application/json"));
        Assert.Equal(HttpStatusCode.Forbidden, rejected.StatusCode);
        Assert.Contains("csrf_invalid", await rejected.Content.ReadAsStringAsync());
        using var status = await client.GetAsync("/api/core/source/status");
        Assert.Equal(HttpStatusCode.OK, status.StatusCode);
        Assert.True(status.Headers.CacheControl?.NoStore);
        using var json = System.Text.Json.JsonDocument.Parse(await status.Content.ReadAsStringAsync());
        Assert.Equal("hosty-core", json.RootElement.GetProperty("appId").GetString());
        Assert.Equal(System.Text.Json.JsonValueKind.Array, json.RootElement.GetProperty("files").ValueKind);
    }

    private static async Task SignInAsync(CoreHttpHarness harness, string role)
    {
        var now = harness.Services.GetRequiredService<IClock>().UtcNow;
        var user = new HostUserRecord("source-user", "source@example.test", "Source User", role, false, now, now);
        var session = new AuthSessionRecord("source-session", user.Id, now, now.AddHours(1), null, now);
        await harness.Services.GetRequiredService<UserDirectoryStore>()
            .WriteAsync(new UserDirectoryState(1, [user], [], [], [session]));
    }
}
