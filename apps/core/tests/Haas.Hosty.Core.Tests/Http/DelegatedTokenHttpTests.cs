using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

// The Shell→system-app delegated-token exchange over real HTTP: a signed-in caller trades a Core
// session for a short-TTL signed token scoped to one app, and the same access policy that guards
// every identity flow guards issuance (docs/features/ai-gateway/plan.md, phase 1).
public sealed class DelegatedTokenHttpTests
{
    [Fact]
    public async Task IssuesATokenTheReceivingAppCanValidateLocally()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var apps = harness.Services.GetRequiredService<AppRegistryStore>();
        const string appId = "hosty.ai-gateway";
        await apps.UpsertAppAsync(CreateApp(appId, system: true));
        var admin = await SeedSessionAsync(harness, "host.admin");
        using var client = harness.CreateClient();

        using var response = await SendAsync(client, HttpMethod.Post, $"/api/apps/{appId}/delegated-token", admin);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var payload = await ReadJsonAsync(response);
        var token = payload.GetProperty("token").GetString()!;
        Assert.StartsWith("hosty_delegated.1.", token, StringComparison.Ordinal);
        Assert.Equal(appId, payload.GetProperty("appId").GetString());
        Assert.Equal(300, payload.GetProperty("expiresInSeconds").GetInt32());

        // What the app-side SDK does with the injected public key, expressed through the Core-side
        // twin validator: the signature holds, and the claims carry the actor and audience.
        var claims = harness.Services.GetRequiredService<DelegatedTokenService>().ValidateToken(token, appId);
        Assert.NotNull(claims);
        Assert.Equal("user_1", claims.Sub);
        Assert.Equal("host.admin", claims.Role);
    }

    [Fact]
    public async Task RequiresASession()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var apps = harness.Services.GetRequiredService<AppRegistryStore>();
        await apps.UpsertAppAsync(CreateApp("hosty.ai-gateway", system: true));
        using var client = harness.CreateClient();

        // A browser-shaped anonymous POST fails the CSRF gate first (403, platform convention for
        // requireCsrf endpoints); a CSRF-exempt bearer with an invalid session is the clean 401.
        using var anonymous = await client.PostAsync("/api/apps/hosty.ai-gateway/delegated-token", null);
        Assert.Equal(HttpStatusCode.Forbidden, anonymous.StatusCode);

        using var badBearer = await SendAsync(client, HttpMethod.Post, "/api/apps/hosty.ai-gateway/delegated-token", "not-a-session");
        Assert.Equal(HttpStatusCode.Unauthorized, badBearer.StatusCode);
    }

    [Fact]
    public async Task DeniesANonAdminOnASystemApp()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var apps = harness.Services.GetRequiredService<AppRegistryStore>();
        await apps.UpsertAppAsync(CreateApp("hosty.ai-gateway", system: true));
        var member = await SeedSessionAsync(harness, "host.member");
        using var client = harness.CreateClient();

        using var response = await SendAsync(client, HttpMethod.Post, "/api/apps/hosty.ai-gateway/delegated-token", member);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal("system_app_admin_required", (await ReadJsonAsync(response)).GetProperty("code").GetString());
    }

    [Fact]
    public async Task DeniesAnUnassignedUserOnAnOrdinaryApp()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var apps = harness.Services.GetRequiredService<AppRegistryStore>();
        await apps.UpsertAppAsync(CreateApp("com.example.notes", system: false));
        var member = await SeedSessionAsync(harness, "host.member");
        using var client = harness.CreateClient();

        using var response = await SendAsync(client, HttpMethod.Post, "/api/apps/com.example.notes/delegated-token", member);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal("app_access_denied", (await ReadJsonAsync(response)).GetProperty("code").GetString());
    }

    [Fact]
    public async Task DeniesAnUnknownApp()
    {
        await using var harness = await CoreHttpHarness.StartAsync();
        var admin = await SeedSessionAsync(harness, "host.admin");
        using var client = harness.CreateClient();

        using var response = await SendAsync(client, HttpMethod.Post, "/api/apps/com.example.ghost/delegated-token", admin);

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal("app_not_found", (await ReadJsonAsync(response)).GetProperty("code").GetString());
    }

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

    private static async Task<string> SeedSessionAsync(CoreHttpHarness harness, string role, string userId = "user_1")
    {
        var users = harness.Services.GetRequiredService<UserDirectoryStore>();
        var now = harness.Services.GetRequiredService<IClock>().UtcNow;
        var user = new HostUserRecord(userId, $"{userId}@example.test", userId, role, false, now, now);
        var session = new AuthSessionRecord($"session_{userId}", userId, now, now.AddHours(1), null, now);
        await users.WriteAsync(new UserDirectoryState(1, [user], [], [], [session]));
        return session.Id;
    }

    private static AppRecord CreateApp(string id, bool system)
        => new(
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
            RuntimeState: "stopped",
            LastOperation: null,
            LastError: null,
            Capabilities: ["open"],
            Settings: new Dictionary<string, AppSettingValue>(),
            StorageMappings: [],
            Dependencies: [],
            Endpoints: [],
            InstalledAt: DateTimeOffset.UtcNow,
            UpdatedAt: DateTimeOffset.UtcNow);
}
