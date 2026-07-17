using Haas.Hosty.Core;
using Microsoft.Extensions.Logging.Abstractions;

namespace Haas.Hosty.Core.Tests;

public sealed class AppIdentityServiceTests
{
    [Fact]
    public async Task ExchangeCodeAsync_RejectsExpiredCode()
    {
        var fixture = await IdentityFixture.CreateAsync();
        await fixture.WriteUsersAsync([CreateUser("user_1")], [new AppAssignmentRecord("com.example.notes", "user_1", fixture.Clock.UtcNow)]);
        var authorization = await fixture.Service.CreateAuthorizationCodeAsync("com.example.notes", "user_1", "https://notes.example/callback");
        fixture.Clock.UtcNow = authorization.ExpiresAt.AddSeconds(1);

        var error = await Assert.ThrowsAsync<AppIdentityException>(() => fixture.Service.ExchangeCodeAsync(authorization.Code));

        Assert.Equal("code_expired", error.Code);
    }

    [Fact]
    public async Task ExchangeCodeAsync_ConsumesCodeOnce()
    {
        var fixture = await IdentityFixture.CreateAsync();
        await fixture.WriteUsersAsync([CreateUser("user_1")], [new AppAssignmentRecord("com.example.notes", "user_1", fixture.Clock.UtcNow)]);
        var authorization = await fixture.Service.CreateAuthorizationCodeAsync("com.example.notes", "user_1", "https://notes.example/callback");

        var token = await fixture.Service.ExchangeCodeAsync(authorization.Code);
        var error = await Assert.ThrowsAsync<AppIdentityException>(() => fixture.Service.ExchangeCodeAsync(authorization.Code));

        Assert.Equal("Bearer", token.TokenType);
        Assert.Equal("code_consumed", error.Code);
    }

    [Fact]
    public async Task ExchangeCodeAsync_ParallelExchangesConsumeCodeExactlyOnce()
    {
        var fixture = await IdentityFixture.CreateAsync();
        await fixture.WriteUsersAsync([CreateUser("user_1")], [new AppAssignmentRecord("com.example.notes", "user_1", fixture.Clock.UtcNow)]);
        var authorization = await fixture.Service.CreateAuthorizationCodeAsync("com.example.notes", "user_1", "https://notes.example/callback");

        var results = await Task.WhenAll(Enumerable.Range(0, 8).Select(async attempt =>
        {
            try
            {
                await fixture.Service.ExchangeCodeAsync(authorization.Code);
                return (Succeeded: true, Code: (string?)null);
            }
            catch (AppIdentityException ex)
            {
                return (Succeeded: false, Code: (string?)ex.Code);
            }
        }));

        Assert.Equal(1, results.Count(result => result.Succeeded));
        Assert.All(results.Where(result => !result.Succeeded), result => Assert.Equal("code_consumed", result.Code));
    }

    [Fact]
    public async Task ExchangeCodeAsync_PrunesEarlierConsumedCodesOnLaterExchanges()
    {
        var fixture = await IdentityFixture.CreateAsync();
        await fixture.WriteUsersAsync([CreateUser("user_1")], [new AppAssignmentRecord("com.example.notes", "user_1", fixture.Clock.UtcNow)]);
        var first = await fixture.Service.CreateAuthorizationCodeAsync("com.example.notes", "user_1", "https://notes.example/callback");
        var second = await fixture.Service.CreateAuthorizationCodeAsync("com.example.notes", "user_1", "https://notes.example/callback");
        _ = await fixture.Service.ExchangeCodeAsync(first.Code);
        _ = await fixture.Service.ExchangeCodeAsync(second.Code);

        var replay = await Assert.ThrowsAsync<AppIdentityException>(() => fixture.Service.ExchangeCodeAsync(first.Code));

        Assert.Equal("invalid_code", replay.Code);
    }

    [Fact]
    public async Task ExchangeCodeAsync_IssuesGrantWithAbsoluteLifetime()
    {
        var fixture = await IdentityFixture.CreateAsync();
        await fixture.WriteUsersAsync([CreateUser("user_1")], [new AppAssignmentRecord("com.example.notes", "user_1", fixture.Clock.UtcNow)]);
        var authorization = await fixture.Service.CreateAuthorizationCodeAsync("com.example.notes", "user_1", "https://notes.example/callback");
        var issuedAt = fixture.Clock.UtcNow;

        var token = await fixture.Service.ExchangeCodeAsync(authorization.Code);

        // Regular (non-system) app: the default absolute grant lifetime, and an opaque hostyg_ value —
        // never a signed JWT.
        Assert.Equal((int)AuthLifetimes.Defaults.AppGrantAbsolute.TotalSeconds, token.ExpiresInSeconds);
        Assert.Equal(issuedAt.Add(AuthLifetimes.Defaults.AppGrantAbsolute), token.ExpiresAt);
        Assert.StartsWith("hostyg_", token.AccessToken, StringComparison.Ordinal);
        Assert.DoesNotContain('.', token.AccessToken);
    }

    [Fact]
    public async Task RevalidateAsync_RejectsUnknownToken()
    {
        var fixture = await IdentityFixture.CreateAsync();
        await fixture.WriteUsersAsync([CreateUser("user_1")], [new AppAssignmentRecord("com.example.notes", "user_1", fixture.Clock.UtcNow)]);

        var error = await Assert.ThrowsAsync<AppIdentityException>(() =>
            fixture.Service.RevalidateAsync("hostyg_not-a-real-token", "com.example.notes"));

        Assert.Equal("token_invalid", error.Code);
    }

    [Fact]
    public async Task RevalidateAsync_RejectsGrantPastAbsoluteLifetime()
    {
        var fixture = await IdentityFixture.CreateAsync();
        await fixture.WriteUsersAsync([CreateUser("user_1")], [new AppAssignmentRecord("com.example.notes", "user_1", fixture.Clock.UtcNow)]);
        var token = await fixture.Service.CreateLaunchTokenAsync("com.example.notes", "user_1");
        fixture.Clock.UtcNow = token.ExpiresAt.AddSeconds(1);

        var error = await Assert.ThrowsAsync<AppIdentityException>(() =>
            fixture.Service.RevalidateAsync(token.AccessToken, "com.example.notes"));

        Assert.Equal("token_expired", error.Code);
    }

    [Fact]
    public async Task RevalidateAsync_RejectsIdleExpiredGrant()
    {
        var fixture = await IdentityFixture.CreateAsync();
        await fixture.WriteUsersAsync([CreateUser("user_1")], [new AppAssignmentRecord("com.example.notes", "user_1", fixture.Clock.UtcNow)]);
        var token = await fixture.Service.ExchangeCodeAsync(
            (await fixture.Service.CreateAuthorizationCodeAsync("com.example.notes", "user_1", "https://notes.example/callback")).Code);

        // Advance past the idle window but before the absolute cap.
        fixture.Clock.UtcNow = fixture.Clock.UtcNow.Add(AuthLifetimes.Defaults.AppGrantIdle).AddSeconds(1);

        var error = await Assert.ThrowsAsync<AppIdentityException>(() =>
            fixture.Service.RevalidateAsync(token.AccessToken, "com.example.notes"));

        Assert.Equal("token_expired", error.Code);
    }

    [Fact]
    public async Task RevalidateAsync_RejectsRevokedGrantAfterLogoutCascade()
    {
        var fixture = await IdentityFixture.CreateAsync();
        await fixture.WriteUsersAsync([CreateUser("user_1")], [new AppAssignmentRecord("com.example.notes", "user_1", fixture.Clock.UtcNow)]);
        // Issue via a code stamped with an authorizing session, then cascade-revoke that session's grants.
        var authorization = await fixture.Service.CreateAuthorizationCodeAsync(
            "com.example.notes", "user_1", "https://notes.example/callback", authorizingSessionId: "session_1");
        var token = await fixture.Service.ExchangeCodeAsync(authorization.Code);
        Assert.True((await fixture.Service.RevalidateAsync(token.AccessToken, "com.example.notes")).Active);

        await fixture.Grants.RevokeByAuthorizingSessionAsync("session_1", fixture.Clock.UtcNow);

        var error = await Assert.ThrowsAsync<AppIdentityException>(() =>
            fixture.Service.RevalidateAsync(token.AccessToken, "com.example.notes"));

        Assert.Equal("token_revoked", error.Code);
    }

    [Fact]
    public async Task RevalidateAsync_SlidesIdleWindowOnUse()
    {
        var fixture = await IdentityFixture.CreateAsync();
        await fixture.WriteUsersAsync([CreateUser("user_1")], [new AppAssignmentRecord("com.example.notes", "user_1", fixture.Clock.UtcNow)]);
        // A code-issued grant gets the regular app idle/absolute windows (a CLI grant is short and fixed).
        var token = await fixture.Service.ExchangeCodeAsync(
            (await fixture.Service.CreateAuthorizationCodeAsync("com.example.notes", "user_1", "https://notes.example/callback")).Code);

        // Use it just before the idle deadline; the idle window should slide forward from the new use.
        fixture.Clock.UtcNow = fixture.Clock.UtcNow.Add(AuthLifetimes.Defaults.AppGrantIdle).AddHours(-1);
        Assert.True((await fixture.Service.RevalidateAsync(token.AccessToken, "com.example.notes")).Active);

        // Advance almost a full idle window past that use — still valid because it slid.
        fixture.Clock.UtcNow = fixture.Clock.UtcNow.Add(AuthLifetimes.Defaults.AppGrantIdle).AddHours(-1);
        Assert.True((await fixture.Service.RevalidateAsync(token.AccessToken, "com.example.notes")).Active);
    }

    [Fact]
    public async Task CreateAuthorizationCodeAsync_RejectsDisabledUsers()
    {
        var fixture = await IdentityFixture.CreateAsync();
        await fixture.WriteUsersAsync([CreateUser("user_1", disabled: true)], []);

        var error = await Assert.ThrowsAsync<AppIdentityException>(() =>
            fixture.Service.CreateAuthorizationCodeAsync("com.example.notes", "user_1", "https://notes.example/callback"));

        Assert.Equal("user_disabled", error.Code);
    }

    [Fact]
    public async Task CreateAuthorizationCodeAsync_RejectsInvalidRedirectUris()
    {
        var fixture = await IdentityFixture.CreateAsync();
        await fixture.WriteUsersAsync([CreateUser("user_1")], []);

        var error = await Assert.ThrowsAsync<AppIdentityException>(() =>
            fixture.Service.CreateAuthorizationCodeAsync("com.example.notes", "user_1", "javascript:alert(1)"));

        Assert.Equal("redirect_uri_invalid", error.Code);
    }

    [Fact]
    public async Task CreateAuthorizationCodeAsync_AllowsEndpointPublicOriginRedirectUris()
    {
        var fixture = await IdentityFixture.CreateAsync();
        await fixture.WriteUsersAsync([CreateUser("user_1")], [new AppAssignmentRecord("com.example.notes", "user_1", fixture.Clock.UtcNow)]);

        var authorization = await fixture.Service.CreateAuthorizationCodeAsync(
            "com.example.notes",
            "user_1",
            "https://notes-public.example/settings");

        Assert.StartsWith("https://notes-public.example/settings?code=", authorization.RedirectUri, StringComparison.Ordinal);
    }

    [Fact]
    public async Task CreateAuthorizationCodeAsync_RejectsUnknownPublicOriginRedirectUris()
    {
        var fixture = await IdentityFixture.CreateAsync();
        await fixture.WriteUsersAsync([CreateUser("user_1")], [new AppAssignmentRecord("com.example.notes", "user_1", fixture.Clock.UtcNow)]);

        var error = await Assert.ThrowsAsync<AppIdentityException>(() =>
            fixture.Service.CreateAuthorizationCodeAsync("com.example.notes", "user_1", "https://attacker.example/settings"));

        Assert.Equal("redirect_uri_denied", error.Code);
    }

    [Fact]
    public async Task CreateAuthorizationCodeAsync_RejectsSystemAppsForNonAdminUsers()
    {
        var fixture = await IdentityFixture.CreateAsync();
        await fixture.UpsertSystemAppAsync();
        await fixture.WriteUsersAsync([CreateUser("user_1")], []);

        var error = await Assert.ThrowsAsync<AppIdentityException>(() =>
            fixture.Service.CreateAuthorizationCodeAsync("hosty.sysapp", "user_1", "https://sysapp.example/callback"));

        Assert.Equal("system_app_admin_required", error.Code);
    }

    [Fact]
    public async Task CreateAuthorizationCodeAsync_AllowsSystemAppsForAdmins()
    {
        var fixture = await IdentityFixture.CreateAsync();
        await fixture.UpsertSystemAppAsync();
        await fixture.WriteUsersAsync([CreateUser("admin_1", role: "host.admin")], []);

        var authorization = await fixture.Service.CreateAuthorizationCodeAsync(
            "hosty.sysapp",
            "admin_1",
            "https://sysapp.example/callback");

        Assert.StartsWith("https://sysapp.example/callback?code=", authorization.RedirectUri, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ExchangeCodeAsync_RejectsSystemAppCodeAfterRoleDowngrade()
    {
        var fixture = await IdentityFixture.CreateAsync();
        await fixture.UpsertSystemAppAsync();
        await fixture.WriteUsersAsync([CreateUser("admin_1", role: "host.admin")], []);
        var authorization = await fixture.Service.CreateAuthorizationCodeAsync(
            "hosty.sysapp",
            "admin_1",
            "https://sysapp.example/callback");
        await fixture.WriteUsersAsync([CreateUser("admin_1")], []);

        var error = await Assert.ThrowsAsync<AppIdentityException>(() => fixture.Service.ExchangeCodeAsync(authorization.Code));

        Assert.Equal("system_app_admin_required", error.Code);
    }

    [Fact]
    public async Task RevalidateAsync_RejectsSystemAppTokenAfterRoleDowngrade()
    {
        var fixture = await IdentityFixture.CreateAsync();
        await fixture.UpsertSystemAppAsync();
        await fixture.WriteUsersAsync([CreateUser("admin_1", role: "host.admin")], []);
        var token = await fixture.Service.CreateLaunchTokenAsync("hosty.sysapp", "admin_1");
        await fixture.WriteUsersAsync([CreateUser("admin_1")], []);

        var error = await Assert.ThrowsAsync<AppIdentityException>(() => fixture.Service.RevalidateAsync(token.AccessToken, "hosty.sysapp"));

        Assert.Equal("system_app_admin_required", error.Code);
    }

    [Fact]
    public async Task RevalidateAsync_RejectsTokenAfterAssignmentChanges()
    {
        var fixture = await IdentityFixture.CreateAsync();
        await fixture.WriteUsersAsync([CreateUser("user_1")], [new AppAssignmentRecord("com.example.notes", "user_1", fixture.Clock.UtcNow)]);
        var token = await fixture.Service.CreateLaunchTokenAsync("com.example.notes", "user_1");
        await fixture.WriteUsersAsync(
            [CreateUser("user_1"), CreateUser("user_2")],
            [new AppAssignmentRecord("com.example.notes", "user_2", fixture.Clock.UtcNow)]);

        var error = await Assert.ThrowsAsync<AppIdentityException>(() => fixture.Service.RevalidateAsync(token.AccessToken, "com.example.notes"));

        Assert.Equal("app_access_denied", error.Code);
    }

    // An app nobody has been assigned to is not "unrestricted" — it is granted to nobody. Regression:
    // the rule used to skip the check when the app had no assignment rows, so every non-admin could
    // launch every never-assigned app.
    [Fact]
    public async Task CreateLaunchTokenAsync_RejectsAppWithNoAssignments()
    {
        var fixture = await IdentityFixture.CreateAsync();
        await fixture.WriteUsersAsync([CreateUser("user_1")], []);

        var error = await Assert.ThrowsAsync<AppIdentityException>(
            () => fixture.Service.CreateLaunchTokenAsync("com.example.notes", "user_1"));

        Assert.Equal("app_access_denied", error.Code);
    }

    [Fact]
    public async Task CreateLaunchTokenAsync_AllowsAdminOnAppWithNoAssignments()
    {
        var fixture = await IdentityFixture.CreateAsync();
        await fixture.WriteUsersAsync([CreateUser("admin_1", role: "host.admin")], []);

        var token = await fixture.Service.CreateLaunchTokenAsync("com.example.notes", "admin_1");

        var session = await fixture.Service.RevalidateAsync(token.AccessToken, "com.example.notes");
        Assert.True(session.Active);
    }

    [Fact]
    public async Task RevalidateAsync_RejectsTokensIssuedForAnotherApp()
    {
        var fixture = await IdentityFixture.CreateAsync();
        await fixture.WriteUsersAsync([CreateUser("user_1")], [new AppAssignmentRecord("com.example.notes", "user_1", fixture.Clock.UtcNow)]);
        var token = await fixture.Service.CreateLaunchTokenAsync("com.example.notes", "user_1");

        var error = await Assert.ThrowsAsync<AppIdentityException>(() => fixture.Service.RevalidateAsync(token.AccessToken, "com.example.other"));

        Assert.Equal("token_app_mismatch", error.Code);
    }

    [Fact]
    public async Task CreateLaunchTokenAsync_ConcurrentIssuanceEachRevalidateIndependently()
    {
        var fixture = await IdentityFixture.CreateAsync();
        await fixture.WriteUsersAsync([CreateUser("user_1")], [new AppAssignmentRecord("com.example.notes", "user_1", fixture.Clock.UtcNow)]);

        var tokens = await Task.WhenAll(Enumerable.Range(0, 16)
            .Select(_ => fixture.Service.CreateLaunchTokenAsync("com.example.notes", "user_1")));

        // Each concurrently-issued grant is a distinct opaque token that revalidates on its own.
        Assert.Equal(16, tokens.Select(token => token.AccessToken).Distinct(StringComparer.Ordinal).Count());
        foreach (var token in tokens)
        {
            var session = await fixture.Service.RevalidateAsync(token.AccessToken, "com.example.notes");
            Assert.True(session.Active);
            Assert.Equal("user_1", session.UserId);
        }
    }

    [Fact]
    public async Task GrantStore_PersistsOnlyTokenHashNeverRawToken()
    {
        var fixture = await IdentityFixture.CreateAsync();
        await fixture.WriteUsersAsync([CreateUser("user_1")], [new AppAssignmentRecord("com.example.notes", "user_1", fixture.Clock.UtcNow)]);
        var token = await fixture.Service.CreateLaunchTokenAsync("com.example.notes", "user_1");

        var raw = await File.ReadAllTextAsync(Path.Combine(fixture.Paths.AuthRoot, "app-grants.json"));

        Assert.DoesNotContain(token.AccessToken, raw, StringComparison.Ordinal);
    }

    private static HostUserRecord CreateUser(string id, bool disabled = false, string role = "host.user")
        => new(
            Id: id,
            Email: $"{id}@example.test",
            DisplayName: id,
            Role: role,
            Disabled: disabled,
            CreatedAt: DateTimeOffset.UtcNow,
            UpdatedAt: DateTimeOffset.UtcNow);

    private sealed class IdentityFixture
    {
        private IdentityFixture(UserDirectoryStore users, AppRegistryStore apps, AppSessionGrantStore grants, AppIdentityService service, CoreDataPaths paths, FakeClock clock)
        {
            Users = users;
            Apps = apps;
            Grants = grants;
            Service = service;
            Paths = paths;
            Clock = clock;
        }

        public UserDirectoryStore Users { get; }

        public AppRegistryStore Apps { get; }

        public AppSessionGrantStore Grants { get; }

        public AppIdentityService Service { get; }

        public CoreDataPaths Paths { get; }

        public FakeClock Clock { get; }

        public static async Task<IdentityFixture> CreateAsync()
        {
            var root = Path.Combine(Path.GetTempPath(), $"hosty-core-identity-tests-{Guid.NewGuid():N}");
            Directory.CreateDirectory(root);
            var paths = new CoreDataPaths(
                DataRoot: root,
                CoreRoot: Path.Combine(root, "core"),
                AppsRoot: Path.Combine(root, "apps"),
                BackupsRoot: Path.Combine(root, "backups"),
                SourcesRoot: Path.Combine(root, "sources"),
                AuthRoot: Path.Combine(root, "core", "auth"),
                AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));
            var users = new UserDirectoryStore(paths);
            var apps = new AppRegistryStore(paths);
            var codes = new AppAuthCodeStore(paths);
            var grants = new AppSessionGrantStore(paths);
            var clock = new FakeClock(DateTimeOffset.UtcNow);
            var settings = new CoreSettingsService(new CoreSettingsStore(paths, NullLogger<CoreSettingsStore>.Instance));
            var service = new AppIdentityService(users, codes, apps, grants, settings, clock);
            await users.WriteAsync(new UserDirectoryState(1, [], [], [], []));
            await apps.UpsertAppAsync(CreateApp());
            return new IdentityFixture(users, apps, grants, service, paths, clock);
        }

        public async Task WriteUsersAsync(IReadOnlyList<HostUserRecord> users, IReadOnlyList<AppAssignmentRecord> assignments)
            => await Users.WriteAsync(new UserDirectoryState(1, users, [], assignments, []));

        public async Task UpsertSystemAppAsync()
            => await Apps.UpsertAppAsync(CreateApp(id: "hosty.sysapp", system: true, origin: "https://sysapp.example"));

        private static AppRecord CreateApp(
            string id = "com.example.notes",
            bool system = false,
            string origin = "https://notes.example")
            => new(
                Id: id,
                DisplayName: "Notes",
                Description: null,
                Version: "1.0.0",
                Kind: "runtime",
                System: system,
                Source: "manifest",
                ManifestPath: "/tmp/notes/manifest.json",
                ManifestUrl: null,
                SelectedRuntime: "dev",
                OperationStatus: "installed",
                RuntimeState: "running",
                LastOperation: null,
                LastError: null,
                Capabilities: ["open"],
                Settings: new Dictionary<string, AppSettingValue>
                {
                    ["HOSTY_PUBLIC_ORIGIN_APP_HTTP"] = new("HOSTY_PUBLIC_ORIGIN_APP_HTTP", "url", "https://notes-public.example", Secret: false),
                },
                StorageMappings: [],
                Dependencies: [],
                Endpoints: [new AppEndpointContract("app.http", "https", origin, Public: true)],
                InstalledAt: DateTimeOffset.UtcNow,
                UpdatedAt: DateTimeOffset.UtcNow);
    }

    private sealed class FakeClock(DateTimeOffset now) : IClock
    {
        public DateTimeOffset UtcNow { get; set; } = now;
    }
}
