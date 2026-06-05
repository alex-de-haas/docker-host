using Haas.Hosty.Core;
using Microsoft.AspNetCore.Http;

namespace Haas.Hosty.Core.Tests;

public sealed class AuthEndpointsTests
{
    [Fact]
    public async Task CreateSessionAsync_SetsSecureCookieWhenRequested()
    {
        var fixture = await AuthEndpointFixture.CreateAsync();
        var context = new DefaultHttpContext();

        var result = await AuthEndpoints.CreateSessionAsync(
            "user_1",
            secureCookie: true,
            context.Response,
            fixture.Users,
            fixture.Clock,
            CancellationToken.None);
        var cookie = context.Response.Headers.SetCookie.ToString();

        Assert.True(result.Succeeded);
        Assert.Contains("secure", cookie, StringComparison.OrdinalIgnoreCase);
    }

    private sealed class AuthEndpointFixture
    {
        private AuthEndpointFixture(UserDirectoryStore users, FakeClock clock)
        {
            Users = users;
            Clock = clock;
        }

        public UserDirectoryStore Users { get; }

        public FakeClock Clock { get; }

        public static async Task<AuthEndpointFixture> CreateAsync()
        {
            var root = Path.Combine(Path.GetTempPath(), $"hosty-core-auth-endpoints-tests-{Guid.NewGuid():N}");
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
            var clock = new FakeClock(DateTimeOffset.Parse("2026-06-05T10:00:00Z"));
            var user = new HostUserRecord(
                Id: "user_1",
                Email: "user@example.test",
                DisplayName: "User",
                Role: "host.user",
                Disabled: false,
                CreatedAt: clock.UtcNow,
                UpdatedAt: clock.UtcNow);
            await users.WriteAsync(new UserDirectoryState(1, [user], [], [], []));
            return new AuthEndpointFixture(users, clock);
        }
    }

    private sealed class FakeClock(DateTimeOffset now) : IClock
    {
        public DateTimeOffset UtcNow { get; set; } = now;
    }
}
