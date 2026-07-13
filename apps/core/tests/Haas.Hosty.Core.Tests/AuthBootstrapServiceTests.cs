using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class AuthBootstrapServiceTests
{
    [Fact]
    public async Task CreateSetupTokenAsync_StoresOnlyTokenHash()
    {
        var fixture = await AuthBootstrapFixture.CreateAsync();

        var result = await fixture.Service.CreateSetupTokenAsync();
        var state = await fixture.Tokens.ReadAsync();
        var token = Assert.Single(state.Tokens);

        Assert.StartsWith("dhstp_", result.Token, StringComparison.Ordinal);
        Assert.StartsWith("http://127.0.0.1:3001/setup?setupToken=", result.SetupUrl, StringComparison.Ordinal);
        Assert.Null(result.RecoveryUrl);
        Assert.NotEqual(result.Token, token.TokenHash);
        Assert.NotEmpty(token.TokenHash);
        Assert.Equal("setup", token.Kind);
        Assert.Equal("pending", token.Status);
    }

    [Fact]
    public async Task CreateSetupTokenAsync_RejectsEnabledAdmin()
    {
        var fixture = await AuthBootstrapFixture.CreateAsync();
        await fixture.Users.WriteAsync(new UserDirectoryState(1, [CreateUser("admin_1", "host.admin")], [], [], []));

        var error = await Assert.ThrowsAsync<AuthBootstrapException>(() => fixture.Service.CreateSetupTokenAsync());

        Assert.Equal("setup_unavailable", error.Code);
    }

    [Fact]
    public async Task BootstrapAsync_ConsumesSetupTokenAndCreatesFirstAdmin()
    {
        var fixture = await AuthBootstrapFixture.CreateAsync();
        var token = await fixture.Service.CreateSetupTokenAsync();

        var user = await fixture.Service.BootstrapAsync(new AuthBootstrapRequest(
            SetupToken: token.Token,
            Email: "Admin@Example.Test",
            DisplayName: "Admin",
            Password: "correct horse battery staple"));
        var userState = await fixture.Users.ReadAsync();
        var tokenState = await fixture.Tokens.ReadAsync();
        var credential = Assert.Single(userState.PasswordCredentials ?? []);

        Assert.Equal("host.admin", user.Role);
        Assert.False(user.Disabled);
        Assert.Equal("admin@example.test", user.Email);
        Assert.Contains(userState.Users, candidate => candidate.Id == user.Id);
        Assert.Equal("used", Assert.Single(tokenState.Tokens).Status);
        Assert.Equal(user.Id, credential.UserId);
        Assert.Equal(LocalPasswordAuthService.Algorithm, credential.Algorithm);
        Assert.NotEqual("correct horse battery staple", credential.Hash);
        Assert.NotEmpty(credential.Salt);
    }

    [Fact]
    public async Task BootstrapAsync_RequiresPassword()
    {
        var fixture = await AuthBootstrapFixture.CreateAsync();
        var token = await fixture.Service.CreateSetupTokenAsync();

        var error = await Assert.ThrowsAsync<LocalPasswordAuthException>(() =>
            fixture.Service.BootstrapAsync(new AuthBootstrapRequest(
                SetupToken: token.Token,
                Email: "admin@example.test")));

        Assert.Equal("password_invalid", error.Code);
    }

    [Fact]
    public async Task BootstrapAsync_RejectsUsedSetupToken()
    {
        var fixture = await AuthBootstrapFixture.CreateAsync();
        var token = await fixture.Service.CreateSetupTokenAsync();
        _ = await fixture.Service.BootstrapAsync(new AuthBootstrapRequest(
            SetupToken: token.Token,
            Email: "admin@example.test",
            Password: "correct horse battery staple"));

        var error = await Assert.ThrowsAsync<AuthBootstrapException>(() =>
            fixture.Service.BootstrapAsync(new AuthBootstrapRequest(
                SetupToken: token.Token,
                Email: "another@example.test")));

        Assert.Equal("setup_token_invalid", error.Code);
    }

    [Fact]
    public async Task CreateRecoveryTokenAsync_RequiresExistingUsers()
    {
        var fixture = await AuthBootstrapFixture.CreateAsync();

        var error = await Assert.ThrowsAsync<AuthBootstrapException>(() => fixture.Service.CreateRecoveryTokenAsync());

        Assert.Equal("recovery_unavailable", error.Code);
    }

    [Fact]
    public async Task RecoverAsync_RestoresExistingUserAsAdminAndRevokesSessions()
    {
        var fixture = await AuthBootstrapFixture.CreateAsync();
        var user = CreateUser("user_1", "host.user") with
        {
            Email = "user@example.test",
            Disabled = true,
        };
        var session = new AuthSessionRecord(
            Id: "session_1",
            UserId: user.Id,
            CreatedAt: fixture.Clock.UtcNow,
            ExpiresAt: fixture.Clock.UtcNow.AddHours(1),
            RevokedAt: null);
        await fixture.Users.WriteAsync(new UserDirectoryState(1, [user], [], [], [session]));
        var token = await fixture.Service.CreateRecoveryTokenAsync();

        var recovered = await fixture.Service.RecoverAsync(new AuthRecoveryRequest(
            RecoveryToken: token.Token,
            Email: "USER@example.test",
            DisplayName: "Recovered Admin",
            Password: "replacement horse battery staple"));
        var state = await fixture.Users.ReadAsync();
        var stored = Assert.Single(state.Users);
        var storedSession = Assert.Single(state.Sessions);
        var credential = Assert.Single(state.PasswordCredentials ?? []);

        Assert.Equal(user.Id, recovered.Id);
        Assert.Equal("host.admin", stored.Role);
        Assert.False(stored.Disabled);
        Assert.Equal("Recovered Admin", stored.DisplayName);
        Assert.NotNull(storedSession.RevokedAt);
        Assert.Equal(user.Id, credential.UserId);
        Assert.NotEqual("replacement horse battery staple", credential.Hash);
    }

    private static HostUserRecord CreateUser(string id, string role)
        => new(
            Id: id,
            Email: $"{id}@example.test",
            DisplayName: id,
            Role: role,
            Disabled: false,
            CreatedAt: DateTimeOffset.UtcNow,
            UpdatedAt: DateTimeOffset.UtcNow);

    private sealed class AuthBootstrapFixture
    {
        private AuthBootstrapFixture(
            UserDirectoryStore users,
            AuthBootstrapTokenStore tokens,
            AuthBootstrapService service,
            FakeClock clock)
        {
            Users = users;
            Tokens = tokens;
            Service = service;
            Clock = clock;
        }

        public UserDirectoryStore Users { get; }

        public AuthBootstrapTokenStore Tokens { get; }

        public AuthBootstrapService Service { get; }

        public FakeClock Clock { get; }

        public static async Task<AuthBootstrapFixture> CreateAsync()
        {
            var root = Path.Combine(Path.GetTempPath(), $"hosty-core-auth-bootstrap-tests-{Guid.NewGuid():N}");
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
            var tokens = new AuthBootstrapTokenStore(paths);
            var audit = new AuditStore(paths);
            var clock = new FakeClock(DateTimeOffset.Parse("2026-06-04T10:00:00Z"));
            var config = new HostyCoreRuntimeConfig(
                DataRoot: root,
                RunDirectory: Path.Combine(root, "core", "run"),
                ControlDiscoveryPath: Path.Combine(root, "core", "run", "control.json"),
                CorePort: 3001,
                ShellPort: 3000,
                ListenUrl: "http://127.0.0.1:3001",
                CorePublicOrigin: "http://127.0.0.1:3001",
                ShellPublicOrigin: "http://127.0.0.1:3000",
                RuntimePublicHost: "localhost",
                ShellSourceOverridePath: null,
                ShellAutostart: false);
            var passwords = new LocalPasswordAuthService(users, audit, clock);
            var service = new AuthBootstrapService(users, tokens, audit, passwords, config, clock);
            await users.WriteAsync(new UserDirectoryState(1, [], [], [], []));
            return new AuthBootstrapFixture(users, tokens, service, clock);
        }
    }

    private sealed class FakeClock(DateTimeOffset now) : IClock
    {
        public DateTimeOffset UtcNow { get; set; } = now;
    }
}
