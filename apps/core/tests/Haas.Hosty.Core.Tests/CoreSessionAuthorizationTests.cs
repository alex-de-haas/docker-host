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

    [Fact]
    public async Task RequireSessionAsync_AuthenticatesABearerPresentedSession()
    {
        var fixture = await AuthorizationFixture.CreateAsync(role: "host.user");
        var request = CreateRequest(includeSession: false, includeCsrf: false, bearer: "session_1").Request;

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
    public async Task RequireAdminSessionAsync_DoesNotRequireCsrfForABearerPresentedSession()
    {
        var fixture = await AuthorizationFixture.CreateAsync(role: "host.admin");
        var request = CreateRequest(includeSession: false, includeCsrf: false, bearer: "session_1").Request;

        var result = await CoreSessionAuthorization.RequireAdminSessionAsync(
            request,
            fixture.Users,
            fixture.Clock,
            () => Task.FromResult<IResult>(Results.Ok()),
            requireCsrf: true);

        Assert.Equal(StatusCodes.Status200OK, Inspect(result).StatusCode);
    }

    // The rule the bearer path stands on. A browser request already carries the session cookie, so if
    // adding an Authorization header could move it onto the CSRF-exempt path, any cross-site POST could
    // exempt itself and the double-submit check would be worth nothing. The cookie always wins.
    [Fact]
    public async Task RequireAdminSessionAsync_CookieRequestCannotEscapeCsrfByAlsoSendingBearer()
    {
        var fixture = await AuthorizationFixture.CreateAsync(role: "host.admin");
        var request = CreateRequest(includeSession: true, includeCsrf: false, bearer: "session_1").Request;

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

    // A request with no credential at all is answered exactly as before the bearer path existed. Only a
    // caller that actually presents a bearer session is exempt.
    [Fact]
    public async Task RequireAdminSessionAsync_StillRequiresCsrfWhenNoCredentialIsPresented()
    {
        var fixture = await AuthorizationFixture.CreateAsync(role: "host.admin");
        var request = CreateRequest(includeSession: false, includeCsrf: false).Request;

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
    public async Task RequireSessionAsync_RejectsAnUnknownBearerLikeAnUnknownCookie()
    {
        var fixture = await AuthorizationFixture.CreateAsync(role: "host.user");

        var viaBearer = Inspect(await CoreSessionAuthorization.RequireSessionAsync(
            CreateRequest(includeSession: false, includeCsrf: false, bearer: "not_a_session").Request,
            fixture.Users,
            fixture.Clock,
            user => Task.FromResult<IResult>(Results.Ok())));

        var viaCookie = Inspect(await CoreSessionAuthorization.RequireSessionAsync(
            CreateRequest(includeSession: true, includeCsrf: false, sessionId: "not_a_session").Request,
            fixture.Users,
            fixture.Clock,
            user => Task.FromResult<IResult>(Results.Ok())));

        Assert.Equal(StatusCodes.Status401Unauthorized, viaBearer.StatusCode);
        Assert.Contains("session_invalid", viaBearer.Body);
        Assert.Equal(viaCookie.StatusCode, viaBearer.StatusCode);
        Assert.Equal(viaCookie.Body, viaBearer.Body);
    }

    [Fact]
    public async Task RequireSessionAsync_RejectsARevokedSessionPresentedAsBearer()
    {
        var fixture = await AuthorizationFixture.CreateAsync(role: "host.user");
        await fixture.Users.UpdateAsync(state => state with
        {
            Sessions = [.. state.Sessions.Select(session => session with { RevokedAt = fixture.Clock.UtcNow })],
        });

        var result = await CoreSessionAuthorization.RequireSessionAsync(
            CreateRequest(includeSession: false, includeCsrf: false, bearer: "session_1").Request,
            fixture.Users,
            fixture.Clock,
            user => Task.FromResult<IResult>(Results.Ok()));

        var response = Inspect(result);

        Assert.Equal(StatusCodes.Status401Unauthorized, response.StatusCode);
        Assert.Contains("session_revoked", response.Body);
    }

    [Fact]
    public async Task RequireSessionAsync_TellsRevocationApartFromExpiry()
    {
        // One message covering "missing, expired, or revoked" reads as an expiry to whoever meets
        // it, so a revocation looks like a credential that aged out and the operator waits for a
        // refresh that will never help. Each cause answers its own code and its own sentence; every
        // one of them is still a 401, which is what clients actually branch on
        // (docs/features/auth-session-lifecycle/feature.md).
        var revoked = await RefuseAsync(session => session with { RevokedAt = session.CreatedAt });
        Assert.Equal(StatusCodes.Status401Unauthorized, revoked.StatusCode);
        Assert.Contains("session_revoked", revoked.Body);
        Assert.Contains("Core session has been revoked", revoked.Body);

        // Past its absolute cap, and past its idle window: both are expiry, and they are told apart
        // by their sentence rather than by their code, because the fix differs only in degree.
        var capped = await RefuseAsync(session => session with { ExpiresAt = session.CreatedAt.AddMinutes(-1) });
        Assert.Equal(StatusCodes.Status401Unauthorized, capped.StatusCode);
        Assert.Contains("session_expired", capped.Body);
        Assert.Contains("maximum lifetime", capped.Body);

        var idled = await RefuseAsync(session => session with
        {
            ExpiresAt = session.CreatedAt.AddDays(30),
            LastSeenAt = session.CreatedAt.AddDays(-8),
        });
        Assert.Equal(StatusCodes.Status401Unauthorized, idled.StatusCode);
        Assert.Contains("session_expired", idled.Body);
        Assert.Contains("idle too long", idled.Body);

        // Long-abandoned credentials are past *both* windows, which is the ordinary case rather than
        // an edge one — a browser session idles out on day 7 and hits its cap on day 30. The sentence
        // names the deadline that elapsed first, so the same record reads as idle or as capped
        // depending on which one actually killed it, not on which condition is tested first.
        var bothIdleFirst = await RefuseAsync(session => session with
        {
            ExpiresAt = session.CreatedAt.AddHours(-1),
            LastSeenAt = session.CreatedAt.AddDays(-8),
        });
        Assert.Contains("idle too long", bothIdleFirst.Body);

        var bothCapFirst = await RefuseAsync(session => session with
        {
            ExpiresAt = session.CreatedAt.AddDays(-10),
            LastSeenAt = session.CreatedAt.AddDays(-8),
        });
        Assert.Contains("maximum lifetime", bothCapFirst.Body);

        // A revoked credential that has also aged out reports the revocation: it is the deliberate
        // act, and the one an operator is trying to confirm landed. (Pinned from #453.)
        var both = await RefuseAsync(session => session with
        {
            RevokedAt = session.CreatedAt,
            ExpiresAt = session.CreatedAt.AddHours(-1),
        });
        Assert.Contains("session_revoked", both.Body);

        // An id no record answers to names nothing — it may never have existed, and the user it
        // belonged to may since have been deleted — so it keeps the code it always had.
        var unknown = await RefuseAsync(session => session, bearer: "not_a_session");
        Assert.Equal(StatusCodes.Status401Unauthorized, unknown.StatusCode);
        Assert.Contains("session_invalid", unknown.Body);
    }

    [Fact]
    public async Task RequireSessionAsync_NamesBothWaysACredentialCanBePresented()
    {
        // A bearer client that sent nothing was told a cookie was missing — a browser mechanism it
        // was never going to use. Both forms resolve here, so both are named.
        var response = Inspect(await CoreSessionAuthorization.RequireSessionAsync(
            CreateRequest(includeSession: false, includeCsrf: false).Request,
            (await AuthorizationFixture.CreateAsync(role: "host.user")).Users,
            new FakeClock(DateTimeOffset.Parse("2026-06-02T12:00:00Z")),
            user => Task.FromResult<IResult>(Results.Ok())));

        Assert.Equal(StatusCodes.Status401Unauthorized, response.StatusCode);
        Assert.Contains("session_missing", response.Body);
        Assert.Contains(CoreSessionAuthorization.SessionCookieName, response.Body);
        Assert.Contains("Authorization: Bearer", response.Body);
    }

    [Fact]
    public async Task RequireSessionAsync_CallsARevokedAccessTokenWhatItIs()
    {
        // The case that prompted the split (docs/features/mcp-oauth/feature.md): a revoked OAuth
        // access token reaches this path — ScopedCredentials refuses a dead record and falls
        // through — and its holder never had a Core session at all, so a message about one sent the
        // operator looking in the wrong place.
        var response = await RefuseAsync(session => session with
        {
            RevokedAt = session.CreatedAt,
            Kind = AccessTokenKinds.OAuth,
            Audience = AccessTokenScopes.CoreAudience,
            Scopes = [AccessTokenScopes.McpRead],
        });

        Assert.Equal(StatusCodes.Status401Unauthorized, response.StatusCode);
        Assert.Contains("session_revoked", response.Body);
        Assert.Contains("This access token has been revoked", response.Body);
    }

    [Fact]
    public void ReadSessionCredential_ReportsHowTheSessionArrived()
    {
        var cookie = CoreSessionAuthorization.ReadSessionCredential(
            CreateRequest(includeSession: true, includeCsrf: false).Request);
        var bearer = CoreSessionAuthorization.ReadSessionCredential(
            CreateRequest(includeSession: false, includeCsrf: false, bearer: "session_1").Request);
        var both = CoreSessionAuthorization.ReadSessionCredential(
            CreateRequest(includeSession: true, includeCsrf: false, bearer: "other").Request);
        var neither = CoreSessionAuthorization.ReadSessionCredential(
            CreateRequest(includeSession: false, includeCsrf: false).Request);

        Assert.Equal(SessionCredentialSource.Cookie, cookie.Source);
        Assert.Equal(SessionCredentialSource.Bearer, bearer.Source);
        Assert.Equal(SessionCredentialSource.None, neither.Source);
        Assert.Null(neither.Value);

        // Precedence, stated once and directly: the cookie is the credential, and the header is ignored.
        Assert.Equal(SessionCredentialSource.Cookie, both.Source);
        Assert.Equal("session_1", both.Value);
    }

    // Presents one dead credential as a bearer and returns the refusal. The mutation shapes the
    // record; the clock never moves, so what each case asserts is the reason it wrote, not a timing.
    private static async Task<(int StatusCode, string Body)> RefuseAsync(
        Func<AuthSessionRecord, AuthSessionRecord> shape,
        string bearer = "session_1")
    {
        var fixture = await AuthorizationFixture.CreateAsync(role: "host.user");
        await fixture.Users.UpdateAsync(state => state with
        {
            Sessions = [.. state.Sessions.Select(shape)],
        });

        return Inspect(await CoreSessionAuthorization.RequireSessionAsync(
            CreateRequest(includeSession: false, includeCsrf: false, bearer: bearer).Request,
            fixture.Users,
            fixture.Clock,
            user => Task.FromResult<IResult>(Results.Ok())));
    }

    private static DefaultHttpContext CreateRequest(
        bool includeSession,
        bool includeCsrf,
        string? bearer = null,
        string sessionId = "session_1")
    {
        var context = new DefaultHttpContext();
        var cookies = new List<string>();
        if (includeSession)
        {
            cookies.Add($"{CoreSessionAuthorization.SessionCookieName}={sessionId}");
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

        if (bearer is not null)
        {
            context.Request.Headers.Authorization = $"Bearer {bearer}";
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
