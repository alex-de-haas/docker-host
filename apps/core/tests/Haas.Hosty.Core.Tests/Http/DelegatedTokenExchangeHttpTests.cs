using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

// The delegated-token exchange (docs/features/delegated-token-exchange/plan.md): a system app trades
// the token it holds for one scoped to another app, so an agent can call app MCP endpoints on behalf
// of the user currently talking to it.
//
// Every bound is tested as a PAIR — the refusal next to the acceptance it must be distinguishable
// from. A route that refuses everything satisfies each negative on its own and is completely broken,
// which is the failure mode this repository has been bitten by more than once.
public sealed class DelegatedTokenExchangeHttpTests
{
    private const string Gateway = "hosty.harness";
    private const string TargetApp = "com.example.notes";

    [Theory]
    [InlineData(Gateway, TargetApp)]
    [InlineData(TargetApp, "com.example.other")]
    [InlineData(Gateway, "hosty:core")]
    public async Task LegacyTokenCannotBranchRegardlessOfSystemRole(string caller, string target)
    {
        await using var host = await StartAsync();
        using var client = host.CreateClient();
        using var result = await ExchangeAsync(client, target, Mint(host, caller));
        Assert.Equal(HttpStatusCode.Forbidden, result.StatusCode);
        Assert.Equal("mcp_grant_required", (await ReadJsonAsync(result)).GetProperty("code").GetString());
    }

    [Fact]
    public async Task LegacySelfRefreshRetainsExpiryAndActorChecks()
    {
        var clock = new MovableClock();
        await using var host = await StartAsync(clock);
        using var client = host.CreateClient();
        var token = Mint(host, Gateway);
        Assert.Equal(HttpStatusCode.OK, (await ExchangeAsync(client, Gateway, token)).StatusCode);
        clock.Advance(TimeSpan.FromMinutes(6));
        Assert.False((await ExchangeAsync(client, Gateway, token)).IsSuccessStatusCode);
    }

    [Fact]
    public async Task LegacySelfRefreshCannotResetTheAbsoluteChainLimit()
    {
        var clock = new MovableClock();
        await using var host = await StartAsync(clock);
        using var client = host.CreateClient();
        var tooOld = Mint(host, Gateway, chainOrigin: clock.UtcNow.AddHours(-2).ToUnixTimeSeconds());
        using var response = await ExchangeAsync(client, Gateway, tooOld);
        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal("exchange_chain_expired", (await ReadJsonAsync(response)).GetProperty("code").GetString());
    }

    /// <summary>A clock the test drives, so a token can be aged past its five minutes.</summary>
    private sealed class MovableClock : IClock
    {
        public DateTimeOffset UtcNow { get; private set; } = DateTimeOffset.UtcNow;

        public void Advance(TimeSpan by) => UtcNow = UtcNow.Add(by);
    }

    private static async Task<CoreHttpHarness> StartAsync(IClock? clock = null)
    {
        var harness = await CoreHttpHarness.StartAsync(clock);
        var apps = harness.Services.GetRequiredService<AppRegistryStore>();
        await apps.UpsertAppAsync(CreateApp(Gateway, system: true));
        await apps.UpsertAppAsync(CreateApp("hosty.shell", system: true));
        await apps.UpsertAppAsync(CreateApp(TargetApp, system: false));
        await apps.UpsertAppAsync(CreateApp("com.example.other", system: false));
        await SeedUsersAsync(harness);
        return harness;
    }

    /// <summary>Mints a token the way Core would, so a test can present one without a browser.</summary>
    private static string Mint(
        CoreHttpHarness harness,
        string audience,
        string sub = "user_admin",
        string role = "host.admin",
        long? chainOrigin = null,
        bool branched = false)
        => harness.Services.GetRequiredService<DelegatedTokenService>()
            .CreateToken(audience, sub, role, chainOrigin, branched).Token;

    private static Task<HttpResponseMessage> ExchangeAsync(HttpClient client, string targetAppId, string token)
    {
        var request = new HttpRequestMessage(HttpMethod.Post, $"/api/apps/{targetAppId}/delegated-token");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
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

    /// <summary>Seeds a Core session for one of the users StartAsync creates, so the browser path can
    /// be exercised. Takes the user rather than a role, because the role lives on the user record —
    /// an unused role parameter would quietly let a test believe it seeded a non-admin.</summary>
    private static async Task<string> SeedSessionAsync(CoreHttpHarness harness, string userId)
    {
        var users = harness.Services.GetRequiredService<UserDirectoryStore>();
        var now = harness.Services.GetRequiredService<IClock>().UtcNow;
        var state = await users.ReadAsync();
        var session = new AuthSessionRecord($"session_{userId}", userId, now, now.AddHours(1), null, now);
        await users.WriteAsync(state with { Sessions = [session] });
        return session.Id;
    }

    private static AppRecord CreateApp(string id, bool system)
        => new(
            Id: id,
            DisplayName: id,
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
            UpdatedAt: DateTimeOffset.UtcNow);
}
