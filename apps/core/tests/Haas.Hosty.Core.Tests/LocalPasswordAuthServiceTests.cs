using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class LocalPasswordAuthServiceTests
{
    [Fact]
    public async Task AuthenticateAsync_AllowsValidPassword()
    {
        var fixture = await LocalPasswordFixture.CreateAsync();
        var user = CreateUser("user_1") with { Email = "user@example.test" };
        var credentials = fixture.Passwords.UpsertCredential(
            null,
            user.Id,
            "correct horse battery staple",
            fixture.Clock.UtcNow);
        await fixture.Users.WriteAsync(new UserDirectoryState(1, [user], [], [], [], credentials));

        var authenticated = await fixture.Passwords.AuthenticateAsync(
            new LocalPasswordLoginRequest("USER@example.test", "correct horse battery staple"),
            "127.0.0.1");

        Assert.Equal(user.Id, authenticated.Id);
    }

    [Fact]
    public async Task AuthenticateAsync_RejectsWrongPasswordWithGenericError()
    {
        var fixture = await LocalPasswordFixture.CreateAsync();
        var user = CreateUser("user_1") with { Email = "user@example.test" };
        var credentials = fixture.Passwords.UpsertCredential(
            null,
            user.Id,
            "correct horse battery staple",
            fixture.Clock.UtcNow);
        await fixture.Users.WriteAsync(new UserDirectoryState(1, [user], [], [], [], credentials));

        var error = await Assert.ThrowsAsync<LocalPasswordAuthException>(() =>
            fixture.Passwords.AuthenticateAsync(
                new LocalPasswordLoginRequest("user@example.test", "wrong password"),
                "127.0.0.1"));

        Assert.Equal("login_invalid", error.Code);
    }

    [Fact]
    public async Task AuthenticateAsync_RejectsDisabledUsersWithGenericError()
    {
        var fixture = await LocalPasswordFixture.CreateAsync();
        var user = CreateUser("user_1") with
        {
            Email = "user@example.test",
            Disabled = true,
        };
        var credentials = fixture.Passwords.UpsertCredential(
            null,
            user.Id,
            "correct horse battery staple",
            fixture.Clock.UtcNow);
        await fixture.Users.WriteAsync(new UserDirectoryState(1, [user], [], [], [], credentials));

        var error = await Assert.ThrowsAsync<LocalPasswordAuthException>(() =>
            fixture.Passwords.AuthenticateAsync(
                new LocalPasswordLoginRequest("user@example.test", "correct horse battery staple"),
                "127.0.0.1"));

        Assert.Equal("login_invalid", error.Code);
    }

    [Fact]
    public async Task AuthenticateAsync_ThrottlesRepeatedFailures()
    {
        var fixture = await LocalPasswordFixture.CreateAsync();
        await fixture.Users.WriteAsync(new UserDirectoryState(1, [], [], [], []));

        for (var attempt = 0; attempt < 10; attempt += 1)
        {
            var error = await Assert.ThrowsAsync<LocalPasswordAuthException>(() =>
                fixture.Passwords.AuthenticateAsync(
                    new LocalPasswordLoginRequest("missing@example.test", "wrong password"),
                    "127.0.0.1"));
            Assert.Equal("login_invalid", error.Code);
        }

        var throttled = await Assert.ThrowsAsync<LocalPasswordAuthException>(() =>
            fixture.Passwords.AuthenticateAsync(
                new LocalPasswordLoginRequest("missing@example.test", "wrong password"),
                "127.0.0.1"));

        Assert.Equal("login_throttled", throttled.Code);
    }

    private static HostUserRecord CreateUser(string id)
        => new(
            Id: id,
            Email: $"{id}@example.test",
            DisplayName: id,
            Role: "host.user",
            Disabled: false,
            CreatedAt: DateTimeOffset.UtcNow,
            UpdatedAt: DateTimeOffset.UtcNow);

    private sealed class LocalPasswordFixture
    {
        private LocalPasswordFixture(UserDirectoryStore users, LocalPasswordAuthService passwords, FakeClock clock)
        {
            Users = users;
            Passwords = passwords;
            Clock = clock;
        }

        public UserDirectoryStore Users { get; }

        public LocalPasswordAuthService Passwords { get; }

        public FakeClock Clock { get; }

        public static async Task<LocalPasswordFixture> CreateAsync()
        {
            var root = Path.Combine(Path.GetTempPath(), $"hosty-core-local-password-tests-{Guid.NewGuid():N}");
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
            var audit = new AuditStore(paths);
            var clock = new FakeClock(DateTimeOffset.Parse("2026-06-05T10:00:00Z"));
            var passwords = new LocalPasswordAuthService(users, audit, clock);
            await users.WriteAsync(new UserDirectoryState(1, [], [], [], []));
            return new LocalPasswordFixture(users, passwords, clock);
        }
    }

    private sealed class FakeClock(DateTimeOffset now) : IClock
    {
        public DateTimeOffset UtcNow { get; set; } = now;
    }
}
