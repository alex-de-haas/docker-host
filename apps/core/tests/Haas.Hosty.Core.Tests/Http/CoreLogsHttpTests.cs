using System.Net;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Haas.Hosty.Core.Tests.Http;

// The Core logs dialog's read path, over real HTTP: an admin sees what the pipeline buffered, the ring
// and level filters actually filter, and a non-admin session cannot read it at all — request paths run
// through these records, and in Development so do secret key names.
public sealed class CoreLogsHttpTests
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    [Fact]
    public async Task AnAdminReadsCoresOwnRecords()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var session = await SignInAsync(harness, "host.admin");
        Log(harness, "Haas.Hosty.Core.RuntimeAppSupervisorService", LogLevel.Information, "Adopted a container");

        var payload = await ReadLogsAsync(harness, session, "/api/core/logs");

        Assert.NotEmpty(payload.RunId);
        Assert.Equal("hosty", payload.Ring);
        Assert.Contains(payload.Records, record => record.Message == "Adopted a container");
    }

    [Fact]
    public async Task TheRequestTrailLivesInItsOwnRing()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var session = await SignInAsync(harness, "host.admin");
        Log(harness, "Microsoft.AspNetCore.Hosting.Diagnostics", LogLevel.Information, "Request finished");

        var hosty = await ReadLogsAsync(harness, session, "/api/core/logs?ring=hosty");
        var framework = await ReadLogsAsync(harness, session, "/api/core/logs?ring=framework");

        Assert.DoesNotContain(hosty.Records, record => record.Message == "Request finished");
        Assert.Contains(framework.Records, record => record.Message == "Request finished");
    }

    [Fact]
    public async Task TheLevelFloorFiltersTheRecords()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var session = await SignInAsync(harness, "host.admin");
        Log(harness, "Haas.Hosty.Core.Test", LogLevel.Information, "routine");
        Log(harness, "Haas.Hosty.Core.Test", LogLevel.Error, "broken");

        var payload = await ReadLogsAsync(harness, session, "/api/core/logs?level=warning");

        Assert.Contains(payload.Records, record => record.Message == "broken");
        Assert.DoesNotContain(payload.Records, record => record.Message == "routine");
    }

    [Theory]
    [InlineData("/api/core/logs?ring=everything", "core_logs_invalid_ring")]
    [InlineData("/api/core/logs?level=loud", "core_logs_invalid_level")]
    public async Task AMalformedFilterIsRefusedWithItsOwnCode(string path, string expectedCode)
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var session = await SignInAsync(harness, "host.admin");

        using var client = harness.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        request.Headers.Add("Cookie", $"{CoreSessionAuthorization.SessionCookieName}={session}");
        using var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        var body = await response.Content.ReadAsStringAsync();
        Assert.Contains(expectedCode, body, StringComparison.Ordinal);
    }

    // Core's log carries request paths, and in Development the *names* of app secrets. A signed-in
    // non-admin is still not an operator of this host.
    [Fact]
    public async Task ANonAdminSessionIsRefused()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var session = await SignInAsync(harness, "host.user");

        using var client = harness.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, "/api/core/logs");
        request.Headers.Add("Cookie", $"{CoreSessionAuthorization.SessionCookieName}={session}");
        using var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
    }

    private static void Log(CoreHttpHarness harness, string category, LogLevel level, string message)
        => harness.Services.GetRequiredService<ILoggerFactory>().CreateLogger(category).Log(level, "{Message}", message);

    private static async Task<string> SignInAsync(CoreHttpHarness harness, string role)
    {
        var users = harness.Services.GetRequiredService<UserDirectoryStore>();
        var now = harness.Services.GetRequiredService<IClock>().UtcNow;
        var user = new HostUserRecord("user_1", "user@example.test", "User", role, false, now, now);
        var session = new AuthSessionRecord("sess_1", user.Id, now, now.AddHours(1), null, now);
        await users.WriteAsync(new UserDirectoryState(1, [user], [], [], [session]));
        return session.Id;
    }

    private static async Task<LogsPayload> ReadLogsAsync(CoreHttpHarness harness, string session, string path)
    {
        using var client = harness.CreateClient();
        using var request = new HttpRequestMessage(HttpMethod.Get, path);
        request.Headers.Add("Cookie", $"{CoreSessionAuthorization.SessionCookieName}={session}");
        using var response = await client.SendAsync(request);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return JsonSerializer.Deserialize<LogsPayload>(await response.Content.ReadAsStringAsync(), Json)
            ?? throw new InvalidOperationException("Core returned no logs payload.");
    }

    private sealed record LogsPayload(string RunId, string Ring, IReadOnlyList<LogRecordPayload> Records);

    private sealed record LogRecordPayload(long Sequence, string Level, string Category, string Message, int Count);
}
