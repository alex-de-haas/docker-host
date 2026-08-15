using System.Net;
using System.Net.Http.Headers;
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
    private const string Gateway = "hosty.ai-gateway";
    private const string TargetApp = "com.example.notes";

    [Fact]
    public async Task SystemCallerExchangesForAnotherApp_WhileANonSystemCallerCannot()
    {
        await using var harness = await StartAsync();
        using var client = harness.CreateClient();

        // The pair: identical requests, differing only in whether the caller is a system app.
        var systemToken = Mint(harness, Gateway);
        using var allowed = await ExchangeAsync(client, TargetApp, systemToken);
        Assert.Equal(HttpStatusCode.OK, allowed.StatusCode);
        var issued = await ReadJsonAsync(allowed);
        Assert.Equal(TargetApp, issued.GetProperty("appId").GetString());

        var domainToken = Mint(harness, TargetApp);
        using var refused = await ExchangeAsync(client, "com.example.other", domainToken);
        Assert.Equal(HttpStatusCode.Forbidden, refused.StatusCode);
        Assert.Equal("exchange_forbidden", (await ReadJsonAsync(refused)).GetProperty("code").GetString());
    }

    [Fact]
    public async Task ABranchedTokenRefreshesItself_ButCannotReachAThirdApp()
    {
        // The heart of the design: branching once is the point, branching twice would let reach spread
        // app to app, and refusing both would leave a caller unable to keep its own credential alive.
        //
        // The branch target here is a SYSTEM app on purpose. The system-only caller rule and the
        // refresh rule only ever meet when the branched token's audience is itself a system app —
        // a branched token for a domain app cannot be presented at all, because its audience is not
        // allowed to exchange. That is not a gap: a caller keeps app credentials fresh by re-branching
        // from its own token, never by refreshing the branched one.
        await using var harness = await StartAsync();
        using var client = harness.CreateClient();

        using var branchResponse = await ExchangeAsync(client, "hosty.shell", Mint(harness, Gateway));
        Assert.Equal(HttpStatusCode.OK, branchResponse.StatusCode);
        var branched = (await ReadJsonAsync(branchResponse)).GetProperty("token").GetString()!;

        // Same audience: a refresh, allowed.
        using var refreshed = await ExchangeAsync(client, "hosty.shell", branched);
        Assert.Equal(HttpStatusCode.OK, refreshed.StatusCode);

        // Different audience: a second branch, refused — the laundering this rule exists to stop.
        using var hop = await ExchangeAsync(client, TargetApp, branched);
        Assert.Equal(HttpStatusCode.Forbidden, hop.StatusCode);
        Assert.Equal("exchange_chain_forbidden", (await ReadJsonAsync(hop)).GetProperty("code").GetString());
    }

    [Fact]
    public async Task ATokenBranchedToADomainAppCannotExchangeAtAll()
    {
        // The practical shape of the rule: the gateway's demo-app token is a dead end by construction,
        // because its audience is not a system app. Fresh app credentials come from re-branching.
        await using var harness = await StartAsync();
        using var client = harness.CreateClient();

        using var branchResponse = await ExchangeAsync(client, TargetApp, Mint(harness, Gateway));
        var branched = (await ReadJsonAsync(branchResponse)).GetProperty("token").GetString()!;

        using var refresh = await ExchangeAsync(client, TargetApp, branched);
        Assert.Equal(HttpStatusCode.Forbidden, refresh.StatusCode);
        Assert.Equal("exchange_forbidden", (await ReadJsonAsync(refresh)).GetProperty("code").GetString());
    }

    [Fact]
    public async Task SelfRefreshKeepsTheRightToBranch()
    {
        // A caller renewing its OWN credential has not branched, so it must still be able to reach an
        // app afterwards. Getting this wrong would leave the gateway unable to serve MCP providers
        // after its first refresh — the case that made an unqualified no-chaining rule unworkable.
        await using var harness = await StartAsync();
        using var client = harness.CreateClient();

        using var selfRefresh = await ExchangeAsync(client, Gateway, Mint(harness, Gateway));
        Assert.Equal(HttpStatusCode.OK, selfRefresh.StatusCode);
        var renewed = (await ReadJsonAsync(selfRefresh)).GetProperty("token").GetString()!;

        using var branch = await ExchangeAsync(client, TargetApp, renewed);
        Assert.Equal(HttpStatusCode.OK, branch.StatusCode);
    }

    [Fact]
    public async Task TheChainExpiresAnHourAfterTheHumanInteraction()
    {
        await using var harness = await StartAsync();
        using var client = harness.CreateClient();
        var now = DateTimeOffset.UtcNow;

        // A chain that started moments ago still works…
        using var stillValid = await ExchangeAsync(
            client, TargetApp, Mint(harness, Gateway, chainOrigin: now.AddMinutes(-59).ToUnixTimeSeconds()));
        Assert.Equal(HttpStatusCode.OK, stillValid.StatusCode);

        // …and the refusal past the hour is about the CHAIN, not the token's own five minutes: the
        // token below is freshly minted and unexpired, only its origin is old.
        using var expired = await ExchangeAsync(
            client, TargetApp, Mint(harness, Gateway, chainOrigin: now.AddHours(-2).ToUnixTimeSeconds()));
        Assert.Equal(HttpStatusCode.Forbidden, expired.StatusCode);
        Assert.Equal("exchange_chain_expired", (await ReadJsonAsync(expired)).GetProperty("code").GetString());
    }

    [Fact]
    public async Task RejectsAForgedOrExpiredTokenWithoutFallingBackToTheSessionPath()
    {
        await using var harness = await StartAsync();
        using var client = harness.CreateClient();

        // A tampered payload fails the signature check, so it is not readable as claims and falls
        // through to the session path — which refuses it because it is not a session id either.
        var token = Mint(harness, Gateway);
        var parts = token.Split('.');
        var forged = $"{parts[0]}.{parts[1]}.{parts[2]}.{new string('A', parts[3].Length)}";
        using var forgedResponse = await ExchangeAsync(client, TargetApp, forged);
        Assert.Equal(HttpStatusCode.Unauthorized, forgedResponse.StatusCode);

    }

    [Fact]
    public async Task RejectsATokenThatHasExpired()
    {
        var clock = new MovableClock();
        await using var harness = await StartAsync(clock);
        using var client = harness.CreateClient();

        var token = Mint(harness, Gateway);
        using var beforeExpiry = await ExchangeAsync(client, TargetApp, token);
        Assert.Equal(HttpStatusCode.OK, beforeExpiry.StatusCode);

        clock.Advance(TimeSpan.FromMinutes(10));
        using var afterExpiry = await ExchangeAsync(client, TargetApp, token);
        Assert.Equal(HttpStatusCode.Unauthorized, afterExpiry.StatusCode);
    }

    [Fact]
    public async Task RefusesAUserWhoCannotReachTheTarget_WhileAPermittedUserSucceeds()
    {
        // The access policy is the real gate, and it runs on the exchange exactly as on the session
        // path. Without the succeeding half this test would pass against a route that refuses all.
        await using var harness = await StartAsync();
        using var client = harness.CreateClient();

        using var admin = await ExchangeAsync(client, "hosty.shell", Mint(harness, Gateway, sub: "user_admin", role: "host.admin"));
        Assert.Equal(HttpStatusCode.OK, admin.StatusCode);

        // hosty.shell is a system app, so a non-admin is refused by the system-app-admin rule.
        using var member = await ExchangeAsync(client, "hosty.shell", Mint(harness, Gateway, sub: "user_member", role: "host.member"));
        Assert.Equal(HttpStatusCode.Forbidden, member.StatusCode);
        Assert.Equal("system_app_admin_required", (await ReadJsonAsync(member)).GetProperty("code").GetString());
    }

    [Fact]
    public async Task RefusesATargetThatIsNotInstalled()
    {
        await using var harness = await StartAsync();
        using var client = harness.CreateClient();

        using var response = await ExchangeAsync(client, "com.example.ghost", Mint(harness, Gateway));

        Assert.Equal(HttpStatusCode.Forbidden, response.StatusCode);
        Assert.Equal("app_not_found", (await ReadJsonAsync(response)).GetProperty("code").GetString());
    }

    [Fact]
    public async Task TheSessionPathStillWorksAndIsStillTheUnbranchedOrigin()
    {
        // The exchange is additive: the browser path must be untouched, and a token it mints must
        // still be branchable — otherwise Shell's tokens would be dead ends.
        await using var harness = await StartAsync();
        using var client = harness.CreateClient();
        var session = await SeedSessionAsync(harness, "host.admin");

        using var request = new HttpRequestMessage(HttpMethod.Post, $"/api/apps/{Gateway}/delegated-token");
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", session);
        using var response = await client.SendAsync(request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var token = (await ReadJsonAsync(response)).GetProperty("token").GetString()!;
        using var branch = await ExchangeAsync(client, TargetApp, token);
        Assert.Equal(HttpStatusCode.OK, branch.StatusCode);
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

    private static async Task<string> SeedSessionAsync(CoreHttpHarness harness, string role)
    {
        var users = harness.Services.GetRequiredService<UserDirectoryStore>();
        var now = harness.Services.GetRequiredService<IClock>().UtcNow;
        var state = await users.ReadAsync();
        var session = new AuthSessionRecord("session_admin", "user_admin", now, now.AddHours(1), null, now);
        await users.WriteAsync(state with { Sessions = [session] });
        _ = role;
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
