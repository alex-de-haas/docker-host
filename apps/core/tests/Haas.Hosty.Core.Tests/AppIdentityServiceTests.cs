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
    public async Task RevalidateAsync_RejectsTokenAfterAssignmentChanges()
    {
        var fixture = await IdentityFixture.CreateAsync();
        await fixture.WriteUsersAsync([CreateUser("user_1")], [new AppAssignmentRecord("com.example.notes", "user_1", fixture.Clock.UtcNow)]);
        var token = await fixture.Service.CreateLaunchTokenAsync("com.example.notes", "user_1");
        await fixture.WriteUsersAsync(
            [CreateUser("user_1"), CreateUser("user_2")],
            [new AppAssignmentRecord("com.example.notes", "user_2", fixture.Clock.UtcNow)]);

        var error = await Assert.ThrowsAsync<AppIdentityException>(() => fixture.Service.RevalidateAsync(token.AccessToken));

        Assert.Equal("app_access_denied", error.Code);
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
        private IdentityFixture(UserDirectoryStore users, AppIdentityService service, FakeClock clock)
        {
            Users = users;
            Service = service;
            Clock = clock;
        }

        public UserDirectoryStore Users { get; }

        public AppIdentityService Service { get; }

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
            return new IdentityFixture(users, service, clock);
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
                SelectedChannel: null,
                SelectedRuntime: "dev",
                OperationStatus: "installed",
                RuntimeState: "running",
                LastOperation: null,
                LastError: null,
                Capabilities: ["open"],
                Settings: new Dictionary<string, AppSettingValue>(),
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
