using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;

namespace Haas.Hosty.Core.Tests.Http;

public sealed class ContinuousAccessHttpTests
{
    private sealed class Clock : IClock { public DateTimeOffset UtcNow { get; set; } = DateTimeOffset.UtcNow; }

    [Fact]
    public async Task BackendMaintenanceCannotKeepBrowserParentAlive()
    {
        var clock = new Clock();
        await using var host = await CoreHttpHarness.StartAsync(clock);
        using var app = await AppManagementHttpTests.CreateAppClient(host, "console", [CoreAppPermissions.ReadApps]);
        var identity = host.Services.GetRequiredService<AppIdentityService>();
        var token = app.DefaultRequestHeaders.GetValues(AppManagementAuthorization.IdentityHeader).Single();
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        var parent = (await users.ReadAsync()).Sessions.Single();
        for (var hour = 0; hour < 7; hour++)
        {
            clock.UtcNow = clock.UtcNow.AddHours(1);
            Assert.NotNull((await identity.RequireActivityAsync(token, "console", default)).Continuity);
        }
        Assert.Equal(parent.LastSeenAt, (await users.ReadAsync()).Sessions.Single().LastSeenAt);
        clock.UtcNow = parent.ExpiresAt;
        Assert.Equal("token_expired", (await Assert.ThrowsAsync<AppIdentityException>(() => identity.RevalidateAsync(token, "console"))).Code);
    }

    [Theory]
    [InlineData("none", 403)]
    [InlineData("wrong-session", 401)]
    [InlineData("service", 403)]
    [InlineData("valid", 200)]
    public async Task ParentTouchRequiresMatchingCoreCookieAndProof(string proof, int expected)
    {
        var clock = new Clock();
        await using var host = await CoreHttpHarness.StartAsync(clock);
        using var app = await AppManagementHttpTests.CreateAppClient(host, "console", []);
        var identity = host.Services.GetRequiredService<AppIdentityService>();
        var token = app.DefaultRequestHeaders.GetValues(AppManagementAuthorization.IdentityHeader).Single();
        var info = (await identity.RevalidateAsync(token, "console")).Continuity!;
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        var before = (await users.ReadAsync()).Sessions.Single();
        var appRecord = (await host.Services.GetRequiredService<AppRegistryStore>().GetAppAsync("console"))!;
        const string origin = "http://app.test";
        await host.Services.GetRequiredService<AppRegistryStore>().UpsertAppAsync(appRecord with { Endpoints = [new("http", "http", origin, true)] });
        clock.UtcNow = clock.UtcNow.AddMinutes(20);
        using var browser = host.CreateClient(); browser.BaseAddress = new("http://localhost:7070");
        browser.DefaultRequestHeaders.Add("Origin", "http://localhost:7070");
        if (proof != "none")
        {
            browser.DefaultRequestHeaders.Add("Cookie", $"hosty_session={(proof == "wrong-session" ? "other" : before.Id)}; hosty_csrf=proof");
            browser.DefaultRequestHeaders.Add("X-Hosty-CSRF", "proof");
        }
        if (proof == "service") browser.DefaultRequestHeaders.Authorization = app.DefaultRequestHeaders.Authorization;
        var response = await browser.PostAsJsonAsync("/api/auth/apps/continuity/maintain", new { grantId = info.GrantId, origin });
        Assert.Equal(expected, (int)response.StatusCode);
        Assert.Equal(proof == "valid" ? clock.UtcNow : before.LastSeenAt, (await users.ReadAsync()).Sessions.Single().LastSeenAt);
        Assert.Equal(before.ExpiresAt, (await users.ReadAsync()).Sessions.Single().ExpiresAt);
    }

    [Theory]
    [InlineData(180, true)]
    [InlineData(30, true)]
    [InlineData(1.5, true)]
    [InlineData(180, false)]
    [InlineData(30, false)]
    [InlineData(1.5, false)]
    public async Task ShortIdlePolicyAdvertisesAndMaintainsBeforeEitherDeadline(double seconds, bool shortParent)
    {
        var clock = new Clock();
        await using var host = await CoreHttpHarness.StartAsync(clock);
        using var app = await AppManagementHttpTests.CreateAppClient(host, "console", []);
        await host.Services.GetRequiredService<CoreSettingsService>().UpdateAsync(new Dictionary<string, string?>
        {
            ["HOSTY_AUTH_CORE_SESSION_IDLE_HOURS"] = CoreSettingsService.FormatHours((shortParent ? seconds : 600) / 3600),
            ["HOSTY_AUTH_APP_GRANT_IDLE_HOURS"] = CoreSettingsService.FormatHours((shortParent ? 600 : seconds) / 3600),
        });
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        await apps.UpsertAppAsync((await apps.GetAppAsync("console"))! with { Endpoints = [new("http", "http", "http://app.test", true)] });
        var identity = host.Services.GetRequiredService<AppIdentityService>();
        var token = app.DefaultRequestHeaders.GetValues(AppManagementAuthorization.IdentityHeader).Single();
        var info = (await identity.RevalidateAsync(token, "console")).Continuity!;
        Assert.Equal(seconds / 3, info.CheckAfterSeconds, 6);
        using var browser = host.CreateClient(); browser.BaseAddress = new("http://localhost:7070");
        browser.DefaultRequestHeaders.Add("Cookie", "hosty_session=operator; hosty_csrf=proof");
        browser.DefaultRequestHeaders.Add("Origin", "http://localhost:7070");
        browser.DefaultRequestHeaders.Add("X-Hosty-CSRF", "proof");
        var started = clock.UtcNow;
        for (var check = 0; check < 16; check++)
        {
            using var response = await browser.PostAsJsonAsync("/api/auth/apps/continuity/maintain",
                new { grantId = info.GrantId, origin = "http://app.test" });
            Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
            Assert.NotNull((await identity.RevalidateAsync(token, "console")).Continuity);
            clock.UtcNow += TimeSpan.FromSeconds(info.CheckAfterSeconds * 1.1); // Maximum positive SDK jitter.
        }
        Assert.True(clock.UtcNow - started > TimeSpan.FromSeconds(seconds * 5));
        Assert.NotNull((await identity.RevalidateAsync(token, "console")).Continuity);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task MigrationRemovesElapsedActivityOnlyForLiveIdentity(bool expiredIdentity)
    {
        var clock = new Clock();
        await using var host = await CoreHttpHarness.StartAsync(clock);
        using var app = await AppManagementHttpTests.CreateAppClient(host, "console", []);
        var grants = host.Services.GetRequiredService<AppSessionGrantStore>();
        var current = (await grants.ReadAsync()).Grants.Single();
        var legacy = current with { Id = "legacy", TokenHash = "legacy-hash", AuthorityVersion = 0, Installation = null,
            ActiveUntil = clock.UtcNow.AddMinutes(-1), AbsoluteExpiresAt = expiredIdentity ? clock.UtcNow : clock.UtcNow.AddHours(2) };
        await grants.AppendAsync(legacy, clock.UtcNow);
        var identity = host.Services.GetRequiredService<AppIdentityService>();
        if (expiredIdentity) await Assert.ThrowsAsync<AppIdentityException>(() => identity.RevalidateHashAsync("legacy-hash", "console", default));
        else
        {
            var actor = await identity.RequireActivityHashAsync("legacy-hash", "console", default);
            Assert.False(actor.ActivityRequired); Assert.Null(actor.ActiveUntil); Assert.NotNull(actor.Continuity);
            var persisted = await new AppSessionGrantStore(host.Services.GetRequiredService<CoreDataPaths>()).TryResolveAsync("legacy-hash");
            Assert.Equal(1, persisted!.AuthorityVersion);
        }
    }

    [Fact]
    public async Task BackgroundScopeSurvivesLogoutButCannotBecomeInteractiveOrExceedTargetAndAction()
    {
        var clock = new Clock();
        await using var host = await CoreHttpHarness.StartAsync(clock);
        using var app = await AppManagementHttpTests.CreateAppClient(host, "console", [CoreAppPermissions.ReadApps]);
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var target = (await apps.GetAppAsync("console"))!;
        var manifest = Path.Combine(host.Services.GetRequiredService<CoreDataPaths>().DataRoot, "fixture.json");
        await File.WriteAllTextAsync(manifest, """
            {"schemaVersion":"app.0.1","id":"console","name":"Console","version":"1.0.0",
            "runtimeProfiles":[{"key":"dev","type":"localCommand","development":true}],"defaultRuntime":"dev",
            "services":[{"key":"app","runtimes":{"dev":{"type":"localCommand","command":"true","workingDirectory":"."}}}]}
            """);
        await apps.UpsertAppAsync(target with { ManifestPath = manifest });
        var grants = host.Services.GetRequiredService<BackgroundGrantService>();
        var grant = await grants.CreateAsync("actor", new("console", "Check this app", [new("health", "core", "console", ["health"])]), default);
        var issued = await grants.IssueAsync("console", new(grant.Id, "health"), default);
        var identity = host.Services.GetRequiredService<AppIdentityService>();
        await Assert.ThrowsAsync<AppIdentityException>(() => identity.RevalidateAsync(issued.AccessToken, "console"));
        await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(s => s with { Sessions = s.Sessions.Select(x => x with { RevokedAt = clock.UtcNow }).ToArray() });
        app.DefaultRequestHeaders.Remove(AppManagementAuthorization.IdentityHeader);
        app.DefaultRequestHeaders.Add(AppManagementAuthorization.IdentityHeader, issued.AccessToken);
        var health = await app.GetAsync("/api/apps/console/health");
        Assert.True(health.IsSuccessStatusCode, await health.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.Forbidden, (await app.GetAsync("/api/apps")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await app.GetAsync("/api/apps/other/health")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await app.PostAsJsonAsync("/api/apps/console/stop", new { })).StatusCode);
        await grants.RevokeAsync("actor", grant.Id, default);
        Assert.Equal(HttpStatusCode.Forbidden, (await app.GetAsync("/api/apps/console/health")).StatusCode);
        await Assert.ThrowsAsync<AppIdentityException>(() => grants.IssueAsync("console", new(grant.Id, "health"), default));
    }

    [Theory]
    [InlineData("permission")]
    [InlineData("owner")]
    [InlineData("installation")]
    [InlineData("revision")]
    public async Task BackgroundDispatchChecksCurrentAuthority(string change)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var app = await AppManagementHttpTests.CreateAppClient(host, "console", [CoreAppPermissions.ReadApps]);
        var grants = host.Services.GetRequiredService<BackgroundGrantService>();
        var grant = await grants.CreateAsync("actor", new("console", "Check health", [new("health", "core", "console", ["health"])]), default);
        var issued = await grants.IssueAsync("console", new(grant.Id, "health"), default);
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var original = (await apps.GetAppAsync("console"))!;
        if (change == "permission") await apps.UpsertAppAsync(original with { GrantedCorePermissions = [] });
        if (change == "installation") await apps.UpsertAppAsync(original with { InstalledAt = original.InstalledAt.AddSeconds(1) });
        if (change is "owner" or "revision") await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(s => s with
        { Users = s.Users.Select(u => change == "owner" ? u with { Disabled = true } : u with { AuthRevision = "changed" }).ToArray() });
        await Assert.ThrowsAsync<AppIdentityException>(() => host.Services.GetRequiredService<AppIdentityService>()
            .RequireOperationHashAsync(AppIdentityService.HashToken(issued.AccessToken), "console", _ => true, default));
    }
    [Fact]
    public async Task BackgroundMcpIntrospectionRequiresExactToolAndLiveGrant()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var app = await AppManagementHttpTests.CreateAppClient(host, "assistant", [CoreAppPermissions.ReadApps]);
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var caller = (await apps.GetAppAsync("assistant"))!;
        caller = caller with { ConfirmedRoles = ["assistant"], Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>>
            { ["assistant"] = [new("default", null, "/assistant")] } };
        var target = AssistantMcpAccessHttpTests.Record("target", caller.InstalledAt) with
            { Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["mcp"] = [new("default", null, "/mcp")] } };
        await apps.UpsertAppAsync(caller); await apps.UpsertAppAsync(target);
        await host.Services.GetRequiredService<AgentPolicyStore>().ChangeAsync(target.Id, new(target.InstalledAt, true,
            new Dictionary<string, string>(), new Dictionary<string, AssistantTargetGrant> { [caller.Id] = new(caller.InstalledAt, "link") }));
        var background = host.Services.GetRequiredService<BackgroundGrantService>();
        var grant = await background.CreateAsync("actor", new(caller.Id, "Read exact tool", [new("read", "mcp", target.Id, ["read_document"])]), default);
        var source = await background.IssueAsync(caller.Id, new(grant.Id, "read"), default);
        var services = host.Services.GetRequiredService<AppServiceTokenService>();
        var child = await host.Services.GetRequiredService<AssistantMcpAccess>().IssueAsync(caller.Id, target.Id,
            services.CreateToken(caller.Id), source.AccessToken, default);
        using var client = host.CreateClient();
        client.DefaultRequestHeaders.Authorization = new("Bearer", services.CreateToken(target.Id));
        async Task<JsonElement> Inspect(string? tool)
        {
            using var response = await client.PostAsJsonAsync($"/api/internal/apps/{target.Id}/token/introspect", new { token = child.Token, purpose = "mcp", tool });
            response.EnsureSuccessStatusCode(); return await response.Content.ReadFromJsonAsync<JsonElement>();
        }
        await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(s => s with { Sessions = [] });
        Assert.True((await Inspect("read_document")).GetProperty("active").GetBoolean());
        Assert.False((await Inspect("write_document")).GetProperty("active").GetBoolean());
        Assert.False((await Inspect("read_document\n")).GetProperty("active").GetBoolean());
        var catalog = await Inspect(null);
        Assert.True(catalog.GetProperty("active").GetBoolean());
        Assert.DoesNotContain("mcp:invoke", catalog.GetProperty("scopes").EnumerateArray().Select(x => x.GetString()));
        await background.RevokeAsync("actor", grant.Id, default);
        Assert.False((await Inspect("read_document")).GetProperty("active").GetBoolean());
    }

    [Fact]
    public async Task BackgroundProviderChildrenRemainBoundToScopeAndRevocation()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var app = await AppManagementHttpTests.CreateAppClient(host, "consumer", [CoreAppPermissions.SpeechProviders]);
        var apps = host.Services.GetRequiredService<AppRegistryStore>();
        var caller = (await apps.GetAppAsync("consumer"))!;
        var target = AssistantMcpAccessHttpTests.Record("speech", caller.InstalledAt) with {
            ConfirmedRoles = ["speech-to-text"], Endpoints = [new("http", "http", "http://speech.test", true)],
            Interfaces = new Dictionary<string, IReadOnlyList<AppInterfaceContract>> { ["speech-to-text"] = [new("selected", "http", "/speech", 1)] } };
        await apps.UpsertAppAsync(target);
        var background = host.Services.GetRequiredService<BackgroundGrantService>();
        var grant = await background.CreateAsync("actor", new(caller.Id, "Transcribe", [new("speech", "provider", target.Id, [], "speech-to-text", "selected")]), default);
        var source = await background.IssueAsync(caller.Id, new(grant.Id, "speech"), default);
        var provider = host.Services.GetRequiredService<ProviderAccessService>();
        var child = await provider.IssueAsync(caller, "speech-to-text", new(target.Id, "selected"), source.AccessToken, default);
        await host.Services.GetRequiredService<UserDirectoryStore>().UpdateAsync(s => s with { Sessions = [] });
        Assert.NotNull(await provider.ValidateAsync(target, new(child.Token, "speech-to-text", "selected"), default));
        await Assert.ThrowsAsync<AppIdentityException>(() => provider.IssueAsync(caller, "speech-to-text", new(target.Id, "other"), source.AccessToken, default));
        await background.RevokeAsync("actor", grant.Id, default);
        await Assert.ThrowsAsync<AppIdentityException>(() => provider.ValidateAsync(target, new(child.Token, "speech-to-text", "selected"), default));
    }

    [Fact]
    public async Task BackgroundCreationRequiresCoreBrowserProofAndRevokeAllEndsEverySource()
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var app = await AppManagementHttpTests.CreateAppClient(host, "console", [CoreAppPermissions.ReadApps]);
        var input = new { appId = "console", label = "Read health", scopes = new[] { new { id = "health", kind = "core", targetAppId = "console", actions = new[] { "health" } } } };
        Assert.Equal(HttpStatusCode.Forbidden, (await app.PostAsJsonAsync("/api/auth/background-grants", input)).StatusCode);
        var parent = (await host.Services.GetRequiredService<UserDirectoryStore>().ReadAsync()).Sessions.Single();
        using var browser = host.CreateClient(); browser.BaseAddress = new("http://localhost:7070");
        browser.DefaultRequestHeaders.Add("Cookie", $"hosty_session={parent.Id}; hosty_csrf=proof");
        browser.DefaultRequestHeaders.Add("Origin", "http://localhost:7070");
        Assert.Equal(HttpStatusCode.Forbidden, (await browser.PostAsJsonAsync("/api/auth/background-grants", input)).StatusCode);
        browser.DefaultRequestHeaders.Add("X-Hosty-CSRF", "proof");
        using var created = await browser.PostAsJsonAsync("/api/auth/background-grants", input);
        created.EnsureSuccessStatusCode();
        var id = (await created.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("id").GetString()!;
        var source = await host.Services.GetRequiredService<BackgroundGrantService>().IssueAsync("console", new(id, "health"), default);
        var original = app.DefaultRequestHeaders.GetValues(AppManagementAuthorization.IdentityHeader).Single();
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        await users.UpdateAsync(state => state with
        {
            Users = [.. state.Users, state.Users.Single() with { Id = "other", Email = "other@example.test" }],
            Sessions = [.. state.Sessions, parent with { Id = "device", Kind = AccessTokenKinds.Device },
                parent with { Id = "manual", Kind = AccessTokenKinds.Manual },
                parent with { Id = "oauth", Kind = AccessTokenKinds.OAuth }, parent with { Id = "other-session", UserId = "other" }],
        });
        var events = host.Services.GetRequiredService<CoreEventHub>();
        using var primaryStream = events.Subscribe(parent.UserId, true, parent.Id);
        using var deviceStream = events.Subscribe(parent.UserId, true, "device");
        using var manualStream = events.Subscribe(parent.UserId, true, "manual");
        using var oauthStream = events.Subscribe(parent.UserId, true, "oauth");
        using var otherStream = events.Subscribe("other", true, "other-session");
        (await browser.PostAsJsonAsync("/api/auth/background-grants/revoke-all-authorizations", new { })).EnsureSuccessStatusCode();
        var identity = host.Services.GetRequiredService<AppIdentityService>();
        await Assert.ThrowsAsync<AppIdentityException>(() => identity.RevalidateAsync(original, "console"));
        await Assert.ThrowsAsync<AppIdentityException>(() => identity.RequireOperationHashAsync(AppIdentityService.HashToken(source.AccessToken), "console", _ => true, default));
        var sessions = (await users.ReadAsync()).Sessions;
        Assert.All(sessions.Where(s => s.UserId == parent.UserId), session => Assert.NotNull(session.RevokedAt));
        Assert.Null(sessions.Single(s => s.Id == "other-session").RevokedAt);
        events.PublishAppEvent(CoreEventHub.AppChanged, "console");
        foreach (var stream in new[] { primaryStream, deviceStream, manualStream, oauthStream })
        {
            Assert.True(stream.Reader.Completion.IsCompleted);
            Assert.False(stream.Reader.TryRead(out _));
        }
        Assert.False(otherStream.Reader.Completion.IsCompleted);
        Assert.True(otherStream.Reader.TryRead(out _));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("original-revision")]
    public async Task BrowserCreationCannotAdoptRevisionFromConcurrentRevokeAll(string? revision)
    {
        await using var host = await CoreHttpHarness.StartAsync();
        using var app = await AppManagementHttpTests.CreateAppClient(host, "console", [CoreAppPermissions.ReadApps]);
        var users = host.Services.GetRequiredService<UserDirectoryStore>();
        await users.UpdateAsync(state => state with { Users = state.Users.Select(u => u with { AuthRevision = revision }).ToArray() });
        var actor = (await users.ReadAsync()).Users.Single(); // Snapshot returned by BrowserActorAsync before revoke-all.
        using var browser = host.CreateClient(); browser.BaseAddress = new("http://localhost:7070");
        browser.DefaultRequestHeaders.Add("Cookie", "hosty_session=operator; hosty_csrf=proof");
        browser.DefaultRequestHeaders.Add("Origin", "http://localhost:7070");
        browser.DefaultRequestHeaders.Add("X-Hosty-CSRF", "proof");
        using var revoked = await browser.PostAsJsonAsync("/api/auth/background-grants/revoke-all-authorizations", new { });
        revoked.EnsureSuccessStatusCode();
        var grants = host.Services.GetRequiredService<BackgroundGrantService>();
        var request = new BackgroundGrantRequest("console", "Read health", [new("health", "core", "console", ["health"])]);
        await Assert.ThrowsAsync<AppIdentityException>(() => grants.CreateAsync(actor, request, default));
        Assert.Empty((await grants.ReadAsync(default))!.Grants);
        // A separately authorized local control operation can deliberately create new authority afterward.
        var fresh = await grants.CreateAsync(actor.Id, request, default);
        Assert.NotEqual(actor.AuthRevision, fresh.AuthRevision);
        Assert.NotNull(await grants.IssueAsync("console", new(fresh.Id, "health"), default));
    }

    [Fact]
    public async Task OptionalBackgroundExpiryClampsRequestCredentialAndCannotRevive()
    {
        var clock = new Clock();
        await using var host = await CoreHttpHarness.StartAsync(clock);
        using var app = await AppManagementHttpTests.CreateAppClient(host, "console", [CoreAppPermissions.ReadApps]);
        var grants = host.Services.GetRequiredService<BackgroundGrantService>();
        var deadline = clock.UtcNow.AddMinutes(1);
        var grant = await grants.CreateAsync("actor", new("console", "One minute", [new("health", "core", "console", ["health"])], deadline), default);
        Assert.Equal(deadline, (await grants.IssueAsync("console", new(grant.Id, "health"), default)).ExpiresAt);
        clock.UtcNow = deadline;
        await Assert.ThrowsAsync<AppIdentityException>(() => grants.IssueAsync("console", new(grant.Id, "health"), default));
    }

}
