using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

// The control-channel delegated-token route: the credential `hosty mcp` presents to an app's MCP
// endpoint (docs/features/hosty-mcp-connector/plan.md).
//
// Every refusal is asserted beside the acceptance it must be distinguishable from. A route that
// refused everything would satisfy each negative on its own and be completely broken — a failure mode
// this repository has hit more than once.
public sealed class ControlDelegatedTokenHttpTests
{
    private const string ControlSecretHeader = "X-Hosty-Control-Secret";

    [Fact]
    public async Task IssuesATokenForTheNamedUserThatTheAppCanValidate()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        await SeedAppAsync(harness, "com.example.notes", system: false);
        await SeedUsersAsync(harness);
        using var client = harness.CreateClient();

        using var response = await PostAsync(harness, client, "com.example.notes", "admin@example.test");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var payload = await ReadJsonAsync(response);
        var token = payload.GetProperty("token").GetString()!;
        Assert.Equal("com.example.notes", payload.GetProperty("appId").GetString());

        // The audience claim is what stops this token working on another app, so it is checked
        // positively rather than inferred from the response body echoing the id back.
        var claims = harness.Services.GetRequiredService<DelegatedTokenService>()
            .ValidateToken(token, "com.example.notes");
        Assert.NotNull(claims);
        Assert.Equal("user_admin", claims.Sub);
        Assert.Equal("host.admin", claims.Role);
        Assert.Null(harness.Services.GetRequiredService<DelegatedTokenService>()
            .ValidateToken(token, "com.example.other"));
    }

    [Fact]
    public async Task RequiresTheControlSecret()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        await SeedAppAsync(harness, "com.example.notes", system: false);
        await SeedUsersAsync(harness);
        using var client = harness.CreateClient();

        using var request = new HttpRequestMessage(
            HttpMethod.Post, "/control/v1/apps/com.example.notes/delegated-token")
        {
            Content = JsonContent.Create(new { user = "admin@example.test" }),
        };
        using var missing = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.Unauthorized, missing.StatusCode);

        using var wrong = new HttpRequestMessage(
            HttpMethod.Post, "/control/v1/apps/com.example.notes/delegated-token")
        {
            Content = JsonContent.Create(new { user = "admin@example.test" }),
        };
        wrong.Headers.Add(ControlSecretHeader, new string('0', 64));
        using var wrongResponse = await client.SendAsync(wrong);
        Assert.Equal(HttpStatusCode.Unauthorized, wrongResponse.StatusCode);

        // The pair: the same call with the real secret succeeds, so the two refusals above are the
        // gate working rather than the route being broken.
        using var allowed = await PostAsync(harness, client, "com.example.notes", "admin@example.test");
        Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);
    }

    [Fact]
    public async Task AppliesTheSameAccessPolicyAsTheSessionPath()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        await SeedAppAsync(harness, "com.example.notes", system: false);
        await SeedUsersAsync(harness);
        using var client = harness.CreateClient();

        // A member with no assignment may not reach an ordinary app...
        using var denied = await PostAsync(harness, client, "com.example.notes", "member@example.test");
        Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
        Assert.Equal("app_access_denied", (await ReadJsonAsync(denied)).GetProperty("code").GetString());

        // ...while an admin does. Holding the control secret is therefore not by itself authority to
        // act as any user toward any app — which is the property that makes this route safe to add.
        using var allowed = await PostAsync(harness, client, "com.example.notes", "admin@example.test");
        Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);
    }

    [Fact]
    public async Task DeniesANonAdminOnASystemApp()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        await SeedAppAsync(harness, "hosty.ai-gateway", system: true);
        await SeedUsersAsync(harness);
        using var client = harness.CreateClient();

        using var denied = await PostAsync(harness, client, "hosty.ai-gateway", "member@example.test");
        Assert.Equal(HttpStatusCode.Forbidden, denied.StatusCode);
        Assert.Equal("system_app_admin_required", (await ReadJsonAsync(denied)).GetProperty("code").GetString());

        using var allowed = await PostAsync(harness, client, "hosty.ai-gateway", "admin@example.test");
        Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);
    }

    [Fact]
    public async Task SeparatesAnUnknownUserFromAnUnknownApp()
    {
        // Different causes must stay different answers: the connector reports one as a misconfigured
        // --user and the other as an app that is gone, and conflating them would send an operator
        // looking in the wrong place.
        await using var harness = await CoreHttpHarness.StartAsync();
        await SeedAppAsync(harness, "com.example.notes", system: false);
        await SeedUsersAsync(harness);
        using var client = harness.CreateClient();

        using var unknownUser = await PostAsync(harness, client, "com.example.notes", "nobody@example.test");
        Assert.Equal(HttpStatusCode.NotFound, unknownUser.StatusCode);
        Assert.Equal("user_not_found", (await ReadJsonAsync(unknownUser)).GetProperty("code").GetString());

        using var unknownApp = await PostAsync(harness, client, "com.example.ghost", "admin@example.test");
        Assert.Equal("app_not_found", (await ReadJsonAsync(unknownApp)).GetProperty("code").GetString());
    }

    [Fact]
    public async Task AuditsBothTheIssueAndTheRefusal()
    {
        // This is a path to a data-plane credential; if it is ever abused, the absence of a trail is
        // what would make it unexplainable. The refusal is the more interesting half.
        await using var harness = await CoreHttpHarness.StartAsync();
        await SeedAppAsync(harness, "com.example.notes", system: false);
        await SeedUsersAsync(harness);
        using var client = harness.CreateClient();

        using (await PostAsync(harness, client, "com.example.notes", "admin@example.test"))
        {
        }

        using (await PostAsync(harness, client, "com.example.notes", "member@example.test"))
        {
        }

        var records = await harness.Services.GetRequiredService<AuditStore>().ReadRecentAsync(50, default);
        var mine = records.Where(record => record.Action == "auth.delegated-token.control").ToArray();
        Assert.Equal(2, mine.Length);
        Assert.Contains(mine, record => record.Outcome == "succeeded" && record.ActorUserId == "user_admin");
        Assert.Contains(mine, record => record.Outcome == "app_access_denied");
        Assert.All(mine, record => Assert.Equal("com.example.notes", record.ResourceId));
    }

    private static Task<HttpResponseMessage> PostAsync(
        CoreHttpHarness harness,
        HttpClient client,
        string appId,
        string user)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, $"/control/v1/apps/{appId}/delegated-token")
        {
            Content = JsonContent.Create(new { user }),
        };
        request.Headers.Add(
            ControlSecretHeader,
            harness.Services.GetRequiredService<ControlSecret>().Value);
        return client.SendAsync(request);
    }

    private static async Task<JsonElement> ReadJsonAsync(HttpResponseMessage response)
        => JsonDocument.Parse(await response.Content.ReadAsStringAsync()).RootElement.Clone();

    private static async Task SeedUsersAsync(CoreHttpHarness harness)
    {
        var users = harness.Services.GetRequiredService<UserDirectoryStore>();
        var now = harness.Services.GetRequiredService<IClock>().UtcNow;
        await users.WriteAsync(new UserDirectoryState(
            1,
            [
                new HostUserRecord("user_admin", "admin@example.test", "Admin", "host.admin", false, now, now),
                new HostUserRecord("user_member", "member@example.test", "Member", "host.member", false, now, now),
            ],
            [],
            [],
            []));
    }

    private static async Task SeedAppAsync(CoreHttpHarness harness, string id, bool system)
        => await harness.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(new AppRecord(
            Id: id,
            DisplayName: "App",
            Description: null,
            Version: "1.0.0",
            Kind: "runtime",
            System: system,
            Source: "installed",
            ManifestPath: $"apps/{id}/manifest.json",
            ManifestUrl: null,
            SelectedRuntime: "docker",
            OperationStatus: "installed",
            RuntimeState: "running",
            LastOperation: null,
            LastError: null,
            Capabilities: ["open"],
            Settings: new Dictionary<string, AppSettingValue>(),
            StorageMappings: [],
            Dependencies: [],
            Endpoints: [],
            InstalledAt: DateTimeOffset.UtcNow,
            UpdatedAt: DateTimeOffset.UtcNow));
}
