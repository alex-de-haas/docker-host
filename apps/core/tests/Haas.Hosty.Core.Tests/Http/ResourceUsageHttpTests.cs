using System.Net;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class ResourceUsageHttpTests
{
    [Theory]
    [InlineData(null, HttpStatusCode.Unauthorized)]
    [InlineData("host.user", HttpStatusCode.Forbidden)]
    [InlineData("host.admin", HttpStatusCode.OK)]
    public async Task ResourceHistoryIsAdminOnly(string? role, HttpStatusCode expected)
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        using var client = harness.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/core/resources");
        if (role is not null)
        {
            var now = harness.Services.GetRequiredService<IClock>().UtcNow;
            var user = new HostUserRecord("user_1", "user@example.test", "User", role, false, now, now);
            var session = new AuthSessionRecord("sess_1", user.Id, now, now.AddHours(1), null, now);
            await harness.Services.GetRequiredService<UserDirectoryStore>().WriteAsync(new UserDirectoryState(1, [user], [], [], [session]));
            request.Headers.Add("Cookie", $"{CoreSessionAuthorization.SessionCookieName}={session.Id}");
            harness.Services.GetRequiredService<RuntimeResourceSampler>().Record(new(now, [new("app", "web", "localCommand", now, 25, 1024)]));
        }
        using var response = await client.SendAsync(request);
        Assert.Equal(expected, response.StatusCode);
        if (expected == HttpStatusCode.OK)
        {
            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
            Assert.NotEmpty(json.RootElement.GetProperty("runId").GetString()!);
            Assert.Equal(25, json.RootElement.GetProperty("history")[0].GetProperty("services")[0].GetProperty("cpuPercent").GetDouble());
        }
    }
}
