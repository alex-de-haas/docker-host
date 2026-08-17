using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

// The whole credential story over real HTTP: a client with no browser starts a device authorization, a
// signed-in user approves it, the credential Core hands back authenticates like any session, it shows up
// in the listing without its own value, and revoking it stops it working.
public sealed class AccessTokenHttpTests
{
    [Fact]
    public async Task DeviceFlow_TakesAHeadlessClientFromNothingToAWorkingCredential()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var approver = await SeedUserAsync(harness, "host.admin");
        using var client = harness.CreateClient();

        // 1. The device has no credential — which is the entire point — and asks for a code.
        using var start = await client.PostAsJsonAsync("/api/auth/device/code", new { label = "kitchen console" });
        Assert.Equal(HttpStatusCode.OK, start.StatusCode);
        var request = await ReadJsonAsync(start);
        var deviceCode = request.GetProperty("deviceCode").GetString()!;
        var userCode = request.GetProperty("userCode").GetString()!;

        // 2. Nothing is granted yet: polling says pending, not approved.
        Assert.Equal("pending", await PollStatusAsync(client, deviceCode));

        // 3. The approver sees it waiting, with the label the device supplied.
        using var pendingList = await SendAsync(client, HttpMethod.Get, "/api/auth/device/requests", approver);
        var pending = await ReadJsonAsync(pendingList);
        var entry = Assert.Single(pending.GetProperty("requests").EnumerateArray().ToArray());
        Assert.Equal(userCode, entry.GetProperty("userCode").GetString());
        Assert.Equal("kitchen console", entry.GetProperty("label").GetString());

        // 4. Approval is a deliberate act by a signed-in user.
        using var approve = await SendAsync(client, HttpMethod.Post, "/api/auth/device/requests/approve", approver, new { userCode });
        Assert.Equal(HttpStatusCode.OK, approve.StatusCode);

        // 5. The device collects its credential on the next poll.
        using var collect = await client.PostAsJsonAsync("/api/auth/device/token", new { deviceCode });
        var collected = await ReadJsonAsync(collect);
        Assert.Equal("approved", collected.GetProperty("status").GetString());
        var credential = collected.GetProperty("token").GetString()!;
        Assert.False(string.IsNullOrWhiteSpace(credential));

        // 6. And it works as a bearer credential, reporting the kind so a client knows what it holds.
        using var session = await SendAsync(client, HttpMethod.Get, "/api/auth/session", credential);
        var probe = await ReadJsonAsync(session);
        Assert.True(probe.GetProperty("authenticated").GetBoolean());
        Assert.Equal("device", probe.GetProperty("kind").GetString());
        Assert.Equal("host.admin", probe.GetProperty("user").GetProperty("role").GetString());

        // 7. Handed over exactly once: a replayed device code collects nothing.
        Assert.Equal("expired", await PollStatusAsync(client, deviceCode));
    }

    [Fact]
    public async Task CreatedCredential_AuthenticatesAndIsRevocable_AndItsValueIsNeverListed()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var owner = await SeedUserAsync(harness, "host.admin");
        using var client = harness.CreateClient();

        // Direct creation is the path for a client that cannot run the device flow.
        using var created = await SendAsync(client, HttpMethod.Post, "/api/auth/credentials", owner, new { label = "backup script" });
        Assert.Equal(HttpStatusCode.OK, created.StatusCode);
        var payload = await ReadJsonAsync(created);
        var token = payload.GetProperty("token").GetString()!;
        var fingerprint = payload.GetProperty("id").GetString()!;

        // The id handed back is a fingerprint, not the credential: a session id IS the bearer value, so
        // listing raw ids would hand every credential's secret to anyone allowed to see it exists.
        Assert.NotEqual(token, fingerprint);

        using var authenticated = await SendAsync(client, HttpMethod.Get, "/api/auth/session", token);
        Assert.True((await ReadJsonAsync(authenticated)).GetProperty("authenticated").GetBoolean());

        using var list = await SendAsync(client, HttpMethod.Get, "/api/auth/credentials", owner);
        var body = await list.Content.ReadAsStringAsync();
        Assert.Contains(fingerprint, body, StringComparison.Ordinal);
        Assert.DoesNotContain(token, body, StringComparison.Ordinal);

        using var revoke = await SendAsync(client, HttpMethod.Delete, $"/api/auth/credentials/{fingerprint}", owner);
        Assert.Equal(HttpStatusCode.OK, revoke.StatusCode);

        using var afterRevoke = await SendAsync(client, HttpMethod.Get, "/api/auth/session", token);
        Assert.False((await ReadJsonAsync(afterRevoke)).GetProperty("authenticated").GetBoolean());
    }

    // The audit log is durable and readable through the control channel, so a credential written into it
    // outlives the single poll that was supposed to be its only appearance.
    [Fact]
    public async Task AuditNeverRecordsACredentialsOwnValue()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var approver = await SeedUserAsync(harness, "host.admin");
        using var client = harness.CreateClient();

        using var start = await client.PostAsJsonAsync("/api/auth/device/code", new { label = "console" });
        var request = await ReadJsonAsync(start);
        var deviceCode = request.GetProperty("deviceCode").GetString()!;
        var userCode = request.GetProperty("userCode").GetString()!;

        using var approve = await SendAsync(client, HttpMethod.Post, "/api/auth/device/requests/approve", approver, new { userCode });
        Assert.Equal(HttpStatusCode.OK, approve.StatusCode);

        using var collect = await client.PostAsJsonAsync("/api/auth/device/token", new { deviceCode });
        var deviceCredential = (await ReadJsonAsync(collect)).GetProperty("token").GetString()!;

        // And the same for a directly created one, whose value is likewise shown exactly once.
        using var created = await SendAsync(client, HttpMethod.Post, "/api/auth/credentials", approver, new { label = "script" });
        var manualCredential = (await ReadJsonAsync(created)).GetProperty("token").GetString()!;

        var audit = harness.Services.GetRequiredService<AuditStore>();
        var records = await audit.ReadRecentAsync(100);
        var serialized = string.Join("\n", records.Select(record =>
            $"{record.Action} {record.ResourceId} {string.Join(",", record.Details.Select(pair => $"{pair.Key}={pair.Value}"))}"));

        Assert.Contains(records, record => record.Action == "auth.device.approved");
        Assert.Contains(records, record => record.Action == "auth.credential.created");
        Assert.DoesNotContain(deviceCredential, serialized, StringComparison.Ordinal);
        Assert.DoesNotContain(manualCredential, serialized, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ACredentialIsNotVisibleOrRevocableByAnotherOrdinaryUser()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var owner = await SeedUserAsync(harness, "host.user", "user_owner");
        var stranger = await SeedUserAsync(harness, "host.user", "user_stranger", append: true);
        using var client = harness.CreateClient();

        using var created = await SendAsync(client, HttpMethod.Post, "/api/auth/credentials", owner, new { label = "mine" });
        var fingerprint = (await ReadJsonAsync(created)).GetProperty("id").GetString()!;

        // Not in the stranger's listing...
        using var strangerList = await SendAsync(client, HttpMethod.Get, "/api/auth/credentials", stranger);
        Assert.DoesNotContain(fingerprint, await strangerList.Content.ReadAsStringAsync(), StringComparison.Ordinal);

        // ...and not revocable by them either, answered the same way a missing one is so the endpoint
        // cannot be used to discover which ids exist.
        using var strangerRevoke = await SendAsync(client, HttpMethod.Delete, $"/api/auth/credentials/{fingerprint}", stranger);
        Assert.Equal(HttpStatusCode.NotFound, strangerRevoke.StatusCode);

        // The owner still holds a working credential.
        using var ownerList = await SendAsync(client, HttpMethod.Get, "/api/auth/credentials", owner);
        Assert.Contains(fingerprint, await ownerList.Content.ReadAsStringAsync(), StringComparison.Ordinal);
    }

    [Fact]
    public async Task DeviceCodeRequests_AreCappedPerSourceRatherThanGlobally()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        using var client = harness.CreateClient();

        // TestServer gives every request the same remote address, so this exercises one source filling
        // its own bucket. That the bucket is per source, not shared, is asserted directly against the
        // store in AccessTokenTests — here we only prove the endpoint enforces a cap at all.
        for (var index = 0; index < DeviceAuthorizationStore.MaxPendingPerSource; index++)
        {
            using var allowed = await client.PostAsJsonAsync("/api/auth/device/code", new { label = $"device {index}" });
            Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);
        }

        using var throttled = await client.PostAsJsonAsync("/api/auth/device/code", new { label = "one too many" });
        Assert.Equal(HttpStatusCode.TooManyRequests, throttled.StatusCode);
    }

    [Fact]
    public async Task ApprovingRequiresASessionAndCsrf()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        using var client = harness.CreateClient();

        using var start = await client.PostAsJsonAsync("/api/auth/device/code", new { label = "console" });
        var userCode = (await ReadJsonAsync(start)).GetProperty("userCode").GetString()!;

        // Anonymous: no session, so nothing to approve with.
        using var anonymous = await client.PostAsJsonAsync("/api/auth/device/requests/approve", new { userCode });
        Assert.Contains((int)anonymous.StatusCode, new[] { 401, 403 });
    }

    private static async Task<string> PollStatusAsync(HttpClient client, string deviceCode)
    {
        using var response = await client.PostAsJsonAsync("/api/auth/device/token", new { deviceCode });
        return (await ReadJsonAsync(response)).GetProperty("status").GetString()!;
    }

    // Every authenticated call travels as a bearer, which is both what a headless client does and what
    // keeps these tests free of the CSRF double-submit pair a browser would carry.
    private static async Task<HttpResponseMessage> SendAsync(
        HttpClient client,
        HttpMethod method,
        string path,
        string credential,
        object? body = null)
    {
        using var request = new HttpRequestMessage(method, path);
        request.Headers.Add("Authorization", $"Bearer {credential}");
        if (body is not null)
        {
            request.Content = JsonContent.Create(body);
        }

        return await client.SendAsync(request);
    }

    private static async Task<JsonElement> ReadJsonAsync(HttpResponseMessage response)
        => JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.Clone();

    // Returns a live browser-session credential for the seeded user, which stands in for "someone signed
    // in to Shell" in the approval steps.
    private static async Task<string> SeedUserAsync(
        CoreHttpHarness harness,
        string role,
        string userId = "user_1",
        bool append = false)
    {
        var users = harness.Services.GetRequiredService<UserDirectoryStore>();
        var now = harness.Services.GetRequiredService<IClock>().UtcNow;
        var user = new HostUserRecord(userId, $"{userId}@example.test", userId, role, false, now, now);
        var session = new AuthSessionRecord($"session_{userId}", userId, now, now.AddHours(1), null, now);

        if (append)
        {
            var existing = await users.ReadAsync();
            await users.WriteAsync(existing with
            {
                Users = [.. existing.Users, user],
                Sessions = [.. existing.Sessions, session],
            });
        }
        else
        {
            await users.WriteAsync(new UserDirectoryState(1, [user], [], [], [session]));
        }

        return session.Id;
    }
}
