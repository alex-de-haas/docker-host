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

    [Fact]
    public async Task NonAdministratorCannotInspectSource()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        await SignInAsync(harness, "host.user");
        using var client = harness.CreateClient();
        client.DefaultRequestHeaders.Add("Cookie", "hosty_session=source-session");

        using var response = await client.GetAsync("/api/apps/test/source/status");

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Contains("admin_required", await response.Content.ReadAsStringAsync());
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
