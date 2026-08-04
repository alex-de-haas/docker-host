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
            AuthLifetimes.Defaults,
            CancellationToken.None);
        var cookie = context.Response.Headers.SetCookie.ToString();

        Assert.True(result.Succeeded);
        Assert.Contains("secure", cookie, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task CreateSessionAsync_PrunesIdleExpiredSessionsOnWrite()
    {
        var fixture = await AuthEndpointFixture.CreateAsync();
        var lifetimes = AuthLifetimes.Defaults;
        var now = fixture.Clock.UtcNow;
        // An idle-expired session: within its absolute cap but long past the idle window.
        var idleExpired = new AuthSessionRecord(
            "old_session",
            "user_1",
            now.Add(-lifetimes.CoreSessionAbsolute).AddDays(1),
            now.Add(lifetimes.CoreSessionAbsolute),
            RevokedAt: null,
            LastSeenAt: now.Subtract(lifetimes.CoreSessionIdle).AddDays(-1));
        var state = await fixture.Users.ReadAsync();
        await fixture.Users.WriteAsync(state with { Sessions = [idleExpired] });

        await AuthEndpoints.CreateSessionAsync("user_1", secureCookie: false, new DefaultHttpContext().Response, fixture.Users, fixture.Clock, lifetimes, CancellationToken.None);

        var sessions = (await fixture.Users.ReadAsync()).Sessions;
        Assert.DoesNotContain(sessions, session => session.Id == "old_session");
        Assert.Single(sessions);
    }

    [Fact]
    public async Task CreateSessionAsync_UsesConfiguredAbsoluteLifetimeAndSlidesIdle()
    {
        var fixture = await AuthEndpointFixture.CreateAsync();
        var context = new DefaultHttpContext();
        var lifetimes = AuthLifetimes.Defaults;

        await AuthEndpoints.CreateSessionAsync("user_1", secureCookie: false, context.Response, fixture.Users, fixture.Clock, lifetimes, CancellationToken.None);

        var state = await fixture.Users.ReadAsync();
        var session = Assert.Single(state.Sessions);
        Assert.Equal(fixture.Clock.UtcNow.Add(lifetimes.CoreSessionAbsolute), session.ExpiresAt);
        Assert.Equal(fixture.Clock.UtcNow, session.LastSeenAt);
        Assert.True(CoreSessionAuthorization.IsSessionLive(session, fixture.Clock.UtcNow, lifetimes.CoreSessionIdle));
        // Idle window enforced independent of the absolute cap.
        Assert.False(CoreSessionAuthorization.IsSessionLive(session, fixture.Clock.UtcNow.Add(lifetimes.CoreSessionIdle).AddSeconds(1), lifetimes.CoreSessionIdle));
    }

    [Theory]
    [InlineData("invalid_code", StatusCodes.Status401Unauthorized)]
    [InlineData("code_expired", StatusCodes.Status401Unauthorized)]
    [InlineData("code_consumed", StatusCodes.Status401Unauthorized)]
    [InlineData("token_invalid", StatusCodes.Status401Unauthorized)]
    [InlineData("token_expired", StatusCodes.Status401Unauthorized)]
    [InlineData("token_revoked", StatusCodes.Status401Unauthorized)]
    [InlineData("user_not_found", StatusCodes.Status403Forbidden)]
    [InlineData("user_disabled", StatusCodes.Status403Forbidden)]
    [InlineData("app_access_denied", StatusCodes.Status403Forbidden)]
    [InlineData("system_app_admin_required", StatusCodes.Status403Forbidden)]
    [InlineData("token_app_mismatch", StatusCodes.Status403Forbidden)]
    [InlineData("redirect_uri_denied", StatusCodes.Status403Forbidden)]
    [InlineData("app_not_found", StatusCodes.Status403Forbidden)]
    [InlineData("redirect_uri_invalid", StatusCodes.Status400BadRequest)]
    [InlineData("signing_key_unavailable", StatusCodes.Status500InternalServerError)]
    [InlineData("something_unmapped", StatusCodes.Status403Forbidden)]
    public void MapIdentityErrorStatus_MapsCodesByCause(string code, int expectedStatus)
        => Assert.Equal(expectedStatus, AuthEndpoints.MapIdentityErrorStatus(code));

    [Theory]
    [InlineData("/api/apps/com.haas.demo-app/open")]
    [InlineData("/api/apps/com.haas.demo-app/open?redirectUri=https%3A%2F%2Fapp.example%2F")]
    [InlineData("/api/apps/hosty.telemetry/open?redirectUri=https%3A%2F%2Ft.example%2Fx%3Fa%3D1")]
    public void IsAllowedLoginReturnTo_AcceptsAppOpenContinuations(string returnTo)
        => Assert.True(AuthEndpoints.IsAllowedLoginReturnTo(returnTo));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("https://evil.example/api/apps/x/open")]
    [InlineData("//evil.example/api/apps/x/open")]
    [InlineData("/\\evil.example/api/apps/x/open")]
    [InlineData("/api/apps/x/open\r\nSet-Cookie: a=b")]
    [InlineData("/marketplace")]
    [InlineData("/api/apps/x/launch-code")]
    [InlineData("/api/core/status")]
    public void IsAllowedLoginReturnTo_RejectsEverythingElse(string? returnTo)
        => Assert.False(AuthEndpoints.IsAllowedLoginReturnTo(returnTo));

    // A Shell page is the other continuation /login honours, and it is resolved against the Shell origin
    // rather than Core's. Without it a browser sent to sign in comes back at Shell's bare origin, having
    // lost the page it was heading for — the device approval screen, in the case that made this matter.
    [Theory]
    [InlineData("/settings?tab=tokens")]
    [InlineData("/installed-apps")]
    public void ResolveLoginRedirect_KeepsAShellPageAcrossTheSignIn(string returnTo)
        => Assert.Equal(
            $"https://shell.example{returnTo}",
            AuthEndpoints.ResolveLoginRedirect(returnTo, "https://shell.example/"));

    [Fact]
    public void ResolveLoginRedirect_PrefersACoreContinuationAndFallsBackToTheOrigin()
    {
        // A Core app-open continuation stays on Core, and is checked first: it is the one shape that
        // must not be appended to the Shell origin.
        Assert.Equal(
            "/api/apps/demo/open",
            AuthEndpoints.ResolveLoginRedirect("/api/apps/demo/open", "https://shell.example"));

        // Nothing usable, and a host with no Shell at all: the caller has to be told there is nowhere
        // to send the browser rather than handed an invented address.
        Assert.Equal("https://shell.example", AuthEndpoints.ResolveLoginRedirect("https://evil.example", "https://shell.example"));
        Assert.Null(AuthEndpoints.ResolveLoginRedirect("/settings?tab=tokens", null));
    }

    // The Shell shape passes exactly the same hardening as the Core one: it is a path appended to an
    // origin, so anything that could escape that origin or forge a header must be refused here too.
    [Theory]
    [InlineData("https://evil.example/settings")]
    [InlineData("//evil.example/settings")]
    [InlineData("/\\evil.example/settings")]
    [InlineData("/settings\r\nSet-Cookie: a=b")]
    [InlineData("settings")]
    [InlineData("")]
    [InlineData(null)]
    public void IsAllowedShellReturnTo_RejectsAnythingThatCouldLeaveTheShellOrigin(string? returnTo)
        => Assert.False(AuthEndpoints.IsAllowedShellReturnTo(returnTo));

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
