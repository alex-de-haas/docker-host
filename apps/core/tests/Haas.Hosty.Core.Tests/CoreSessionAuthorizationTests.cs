using Haas.Hosty.Core;
using Microsoft.AspNetCore.Http;

namespace Haas.Hosty.Core.Tests;

public sealed class CoreSessionAuthorizationTests
{
    [Fact]
    public async Task RequireAdminSessionAsync_AllowsAdminWithValidCsrf()
    {
        var fixture = await AuthorizationFixture.CreateAsync(role: "host.admin");
        var request = CreateRequest(includeSession: true, includeCsrf: true).Request;

        var result = await CoreSessionAuthorization.RequireAdminSessionAsync(
            request,
            fixture.Users,
            fixture.Clock,
            () => Task.FromResult<IResult>(Results.Ok()),
            requireCsrf: true);

        var response = Inspect(result);

        Assert.Equal(StatusCodes.Status200OK, response.StatusCode);
    }

    [Fact]
    public async Task RequireAdminSessionAsync_RejectsNonAdminSessions()
    {
        var fixture = await AuthorizationFixture.CreateAsync(role: "host.user");
        var request = CreateRequest(includeSession: true, includeCsrf: true).Request;

        var result = await CoreSessionAuthorization.RequireAdminSessionAsync(
            request,
            fixture.Users,
            fixture.Clock,
            () => Task.FromResult<IResult>(Results.Ok()),
            requireCsrf: true);

        var response = Inspect(result);

        Assert.Equal(StatusCodes.Status403Forbidden, response.StatusCode);
        Assert.Contains("admin_required", response.Body);
    }

    [Fact]
    public async Task RequireSessionAsync_AllowsNonAdminSessions()
    {
        var fixture = await AuthorizationFixture.CreateAsync(role: "host.user");
        var request = CreateRequest(includeSession: true, includeCsrf: false).Request;

        var result = await CoreSessionAuthorization.RequireSessionAsync(
            request,
            fixture.Users,
            fixture.Clock,
            user => Task.FromResult<IResult>(Results.Json(new { user.Id })));

        var response = Inspect(result);

        Assert.Equal(StatusCodes.Status200OK, response.StatusCode);
        Assert.Contains("user_1", response.Body);
    }

    [Fact]
    public async Task RequireAdminSessionAsync_RejectsMissingCsrfForMutations()
    {
        var fixture = await AuthorizationFixture.CreateAsync(role: "host.admin");
        var request = CreateRequest(includeSession: true, includeCsrf: false).Request;

        var result = await CoreSessionAuthorization.RequireAdminSessionAsync(
            request,
            fixture.Users,
            fixture.Clock,
            () => Task.FromResult<IResult>(Results.Ok()),
            requireCsrf: true);

        var response = Inspect(result);

        Assert.Equal(StatusCodes.Status403Forbidden, response.StatusCode);
        Assert.Contains("csrf_invalid", response.Body);
    }

    [Fact]
    public async Task ResolveNavigationSessionAsync_ReturnsUserForValidSession()
    {
        var fixture = await AuthorizationFixture.CreateAsync(role: "host.user");
        var request = CreateRequest(includeSession: true, includeCsrf: false).Request;

        var result = await CoreSessionAuthorization.ResolveNavigationSessionAsync(request, fixture.Users, fixture.Clock);

        Assert.NotNull(result.User);
        Assert.Equal("user_1", result.User!.Id);
        Assert.Null(result.Denied);
    }

    [Fact]
    public async Task ResolveNavigationSessionAsync_SignalsMissingSessionForRecovery()
    {
        var fixture = await AuthorizationFixture.CreateAsync(role: "host.user");
        var request = CreateRequest(includeSession: false, includeCsrf: false).Request;

        var result = await CoreSessionAuthorization.ResolveNavigationSessionAsync(request, fixture.Users, fixture.Clock);

        // Both null → the caller redirects to /login rather than returning a terminal response.
        Assert.Null(result.User);
        Assert.Null(result.Denied);
    }

    [Fact]
    public async Task ResolveNavigationSessionAsync_ReturnsTerminalDenialForDisabledUser()
    {
        var fixture = await AuthorizationFixture.CreateAsync(role: "host.user", disabled: true);
        var request = CreateRequest(includeSession: true, includeCsrf: false).Request;

        var result = await CoreSessionAuthorization.ResolveNavigationSessionAsync(request, fixture.Users, fixture.Clock);

        // A signed-in but disabled account is terminal: return the 403 as-is, never bounce to /login.
        Assert.Null(result.User);
        Assert.NotNull(result.Denied);
        var response = Inspect(result.Denied!);
        Assert.Equal(StatusCodes.Status403Forbidden, response.StatusCode);
        Assert.Contains("user_disabled", response.Body);
    }

    private static DefaultHttpContext CreateRequest(bool includeSession, bool includeCsrf)
    {
        var context = new DefaultHttpContext();
        var cookies = new List<string>();
        if (includeSession)
        {
            cookies.Add($"{CoreSessionAuthorization.SessionCookieName}=session_1");
        }

        if (includeCsrf)
        {
            cookies.Add($"{CoreSessionAuthorization.CsrfCookieName}=csrf_1");
            context.Request.Headers[CoreSessionAuthorization.CsrfHeaderName] = "csrf_1";
        }

        if (cookies.Count > 0)
        {
            context.Request.Headers.Cookie = string.Join("; ", cookies);
        }

        return context;
    }

    private static (int StatusCode, string Body) Inspect(IResult result)
    {
        var statusCode = result is IStatusCodeHttpResult statusResult
            ? statusResult.StatusCode ?? StatusCodes.Status200OK
            : StatusCodes.Status200OK;
        var body = result is IValueHttpResult valueResult && valueResult.Value is not null
            ? valueResult.Value.ToString() ?? ""
            : "";
        return (statusCode, body);
    }

    private sealed class AuthorizationFixture(UserDirectoryStore users, FakeClock clock)
    {
        public UserDirectoryStore Users { get; } = users;

        public FakeClock Clock { get; } = clock;

        public static async Task<AuthorizationFixture> CreateAsync(string role, bool disabled = false)
        {
            var root = Path.Combine(Path.GetTempPath(), $"hosty-core-authz-tests-{Guid.NewGuid():N}");
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
            var clock = new FakeClock(DateTimeOffset.Parse("2026-06-02T12:00:00Z"));
            var user = new HostUserRecord(
                Id: "user_1",
                Email: "user@example.test",
                DisplayName: "User",
                Role: role,
                Disabled: disabled,
                CreatedAt: clock.UtcNow,
                UpdatedAt: clock.UtcNow);
            var session = new AuthSessionRecord(
                Id: "session_1",
                UserId: user.Id,
                CreatedAt: clock.UtcNow,
                ExpiresAt: clock.UtcNow.AddHours(1),
                RevokedAt: null);
            await users.WriteAsync(new UserDirectoryState(1, [user], [], [], [session]));
            return new AuthorizationFixture(users, clock);
        }
    }

    private sealed class FakeClock(DateTimeOffset now) : IClock
    {
        public DateTimeOffset UtcNow { get; set; } = now;
    }
}
