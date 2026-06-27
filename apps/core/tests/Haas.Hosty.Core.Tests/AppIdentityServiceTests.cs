using Haas.Hosty.Core;

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
    public async Task ExchangeCodeAsync_IssuesTwentyFourHourIdentityToken()
    {
        var fixture = await IdentityFixture.CreateAsync();
        await fixture.WriteUsersAsync([CreateUser("user_1")], [new AppAssignmentRecord("com.example.notes", "user_1", fixture.Clock.UtcNow)]);
        var authorization = await fixture.Service.CreateAuthorizationCodeAsync("com.example.notes", "user_1", "https://notes.example/callback");
        var issuedAt = fixture.Clock.UtcNow;

        var token = await fixture.Service.ExchangeCodeAsync(authorization.Code);

        Assert.Equal((int)TimeSpan.FromHours(24).TotalSeconds, token.ExpiresInSeconds);
        Assert.Equal(issuedAt.AddHours(24), token.ExpiresAt);
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
    public async Task CreateLaunchTokenAsync_ConcurrentFirstUseSharesSigningKey()
    {
        var fixture = await IdentityFixture.CreateAsync();
        await fixture.WriteUsersAsync([CreateUser("user_1")], [new AppAssignmentRecord("com.example.notes", "user_1", fixture.Clock.UtcNow)]);

        var tokens = await Task.WhenAll(Enumerable.Range(0, 16)
            .Select(_ => fixture.Service.CreateLaunchTokenAsync("com.example.notes", "user_1")));

        foreach (var token in tokens)
        {
            var session = await fixture.Service.RevalidateAsync(token.AccessToken, "com.example.notes");
            Assert.True(session.Active);
            Assert.Equal("user_1", session.UserId);
        }

        var keyPath = Path.Combine(fixture.Paths.AuthRoot, "app-identity-signing.key");
        Assert.Equal(32, Convert.FromBase64String((await File.ReadAllTextAsync(keyPath)).Trim()).Length);
    }

    [Theory]
    [InlineData("")]
    [InlineData("   \n")]
    [InlineData("not-valid-base64!!")]
    public async Task CreateLaunchTokenAsync_SelfHealsPoisonedSigningKeyFile(string poisonedContents)
    {
        var fixture = await IdentityFixture.CreateAsync();
        await fixture.WriteUsersAsync([CreateUser("user_1")], [new AppAssignmentRecord("com.example.notes", "user_1", fixture.Clock.UtcNow)]);
        var keyPath = Path.Combine(fixture.Paths.AuthRoot, "app-identity-signing.key");
        Directory.CreateDirectory(fixture.Paths.AuthRoot);
        await File.WriteAllTextAsync(keyPath, poisonedContents);

        var token = await fixture.Service.CreateLaunchTokenAsync("com.example.notes", "user_1");
        var session = await fixture.Service.RevalidateAsync(token.AccessToken, "com.example.notes");

        Assert.True(session.Active);
        Assert.Equal("user_1", session.UserId);
        Assert.Equal(32, Convert.FromBase64String((await File.ReadAllTextAsync(keyPath)).Trim()).Length);
    }

    private static HostUserRecord CreateUser(string id, bool disabled = false)
        => new(
            Id: id,
            Email: $"{id}@example.test",
            DisplayName: id,
            Role: "host.user",
            Disabled: disabled,
            CreatedAt: DateTimeOffset.UtcNow,
            UpdatedAt: DateTimeOffset.UtcNow);

    private sealed class IdentityFixture
    {
        private IdentityFixture(UserDirectoryStore users, AppIdentityService service, CoreDataPaths paths, FakeClock clock)
        {
            Users = users;
            Service = service;
            Paths = paths;
            Clock = clock;
        }

        public UserDirectoryStore Users { get; }

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
            var clock = new FakeClock(DateTimeOffset.UtcNow);
            var service = new AppIdentityService(users, codes, apps, paths, clock);
            await users.WriteAsync(new UserDirectoryState(1, [], [], [], []));
            await apps.UpsertAppAsync(CreateApp());
            return new IdentityFixture(users, service, paths, clock);
        }

        public async Task WriteUsersAsync(IReadOnlyList<HostUserRecord> users, IReadOnlyList<AppAssignmentRecord> assignments)
            => await Users.WriteAsync(new UserDirectoryState(1, users, [], assignments, []));

        private static AppRecord CreateApp()
            => new(
                Id: "com.example.notes",
                DisplayName: "Notes",
                Description: null,
                Version: "1.0.0",
                Kind: "runtime",
                System: false,
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
                Endpoints: [new AppEndpointContract("app.http", "https", "https://notes.example", Public: true)],
                InstalledAt: DateTimeOffset.UtcNow,
                UpdatedAt: DateTimeOffset.UtcNow);
    }

    private sealed class FakeClock(DateTimeOffset now) : IClock
    {
        public DateTimeOffset UtcNow { get; set; } = now;
    }
}
