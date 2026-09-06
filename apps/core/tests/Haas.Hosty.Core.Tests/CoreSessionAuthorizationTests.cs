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
        Assert.Contains("session_invalid", response.Body);
    }

    // The distinction the message exists to draw. Both credentials are dead, both answer 401
    // `session_invalid`, and an operator watching a client fail has to be able to tell which happened —
    // a revocation they just performed from a lifetime that simply ran out.
    [Fact]
    public async Task RequireSessionAsync_NamesRevocationAndExpiryApart()
    {
        var revoked = await RefuseAsync(session => session with { RevokedAt = session.CreatedAt });
        var expired = await RefuseAsync(session => session with { ExpiresAt = session.CreatedAt.AddMinutes(-1) });

        Assert.Equal(StatusCodes.Status401Unauthorized, revoked.StatusCode);
        Assert.Equal(StatusCodes.Status401Unauthorized, expired.StatusCode);

        // One code for both: callers branch on the status class, and both causes recover the same way.
        Assert.Contains("session_invalid", revoked.Body);
        Assert.Contains("session_invalid", expired.Body);

        Assert.Contains("was revoked", revoked.Body);
        Assert.DoesNotContain("was revoked", expired.Body);
        Assert.Contains("has expired", expired.Body);
        Assert.DoesNotContain("has expired", revoked.Body);
    }

    // A revoked credential that is also past its absolute cap reports the revocation: the deliberate act
    // is the one the operator is trying to confirm landed.
    [Fact]
    public async Task RequireSessionAsync_ReportsRevocationOverAConcurrentExpiry()
    {
        var response = await RefuseAsync(session => session with
        {
            RevokedAt = session.CreatedAt,
            ExpiresAt = session.CreatedAt.AddMinutes(-1),
        });

        Assert.Contains("was revoked", response.Body);
    }

    // The third condition IsSessionLive folds in, and the one that is not an expiry at all: the absolute
    // cap still holds, but nothing used the credential inside its sliding window.
    [Fact]
    public async Task RequireSessionAsync_NamesTheIdleWindowSeparately()
    {
        var fixture = await AuthorizationFixture.CreateAsync(role: "host.user");
        fixture.Clock.UtcNow = fixture.Clock.UtcNow
            .Add(AuthLifetimes.Defaults.CoreSessionIdle)
            .AddDays(1);

        var response = await RefuseAsync(
            session => session with { ExpiresAt = fixture.Clock.UtcNow.AddDays(1) },
            fixture);

        Assert.Contains("idle window", response.Body);
        Assert.DoesNotContain("has expired", response.Body);
    }

    // The window named is the one whose *deadline* came first, not whichever has passed by the time the
    // call arrives. Both usually have — an untouched browser session idles out on day 7 and hits its
    // absolute cap on day 30, so a request on day 31 is past both — and reporting whichever condition
    // was tested first would call every long-abandoned session an absolute expiry.
    [Fact]
    public async Task RequireSessionAsync_ReportsTheDeadlineThatCameFirstNotWhicheverHasPassed()
    {
        var idled = await AuthorizationFixture.CreateAsync(role: "host.user");
        var idledAt = idled.Clock.UtcNow;
        idled.Clock.UtcNow = idledAt.Add(AuthLifetimes.Defaults.CoreSessionAbsolute).AddDays(1);
        var bothElapsed = await RefuseAsync(
            session => session with { ExpiresAt = idledAt.Add(AuthLifetimes.Defaults.CoreSessionAbsolute) },
            idled);

        // Day 7 beat day 30, though the request landed on day 31 with both long past.
        Assert.Contains("idle window", bothElapsed.Body);
        Assert.DoesNotContain("has expired", bothElapsed.Body);

        // The other direction, and the shape that actually reaches this path: an OAuth access token
        // caps out after an hour while its idle window runs for months, so the cap is what killed it.
        var capped = await AuthorizationFixture.CreateAsync(role: "host.user");
        var issuedAt = capped.Clock.UtcNow;
        capped.Clock.UtcNow = issuedAt.AddDays(2);
        var absolute = await RefuseAsync(
            session => session with { Kind = AccessTokenKinds.OAuth, ExpiresAt = issuedAt.AddHours(1) },
            capped);

        Assert.Contains("access token has expired", absolute.Body);
        Assert.DoesNotContain("idle window", absolute.Body);
    }

    // An access token is not a "session" to whoever holds one, and the credential that most often dies
    // here is an OAuth-issued token whose grant was revoked on the tokens page.
    [Fact]
    public async Task RequireSessionAsync_CallsARevokedAccessTokenByItsOwnName()
    {
        var response = await RefuseAsync(session => session with
        {
            Kind = AccessTokenKinds.OAuth,
            RevokedAt = session.CreatedAt,
        });

        Assert.Contains("access token was revoked", response.Body);
    }

    // A caller that presented nothing at all is a different refusal from a dead credential, and the
    // sentence has to work for the client that was never going to send a cookie in the first place.
    [Fact]
    public async Task RequireSessionAsync_NamesBothFormsWhenNoCredentialIsPresented()
    {
        var fixture = await AuthorizationFixture.CreateAsync(role: "host.user");

        var response = Inspect(await CoreSessionAuthorization.RequireSessionAsync(
            CreateRequest(includeSession: false, includeCsrf: false).Request,
            fixture.Users,
            fixture.Clock,
            user => Task.FromResult<IResult>(Results.Ok())));

        Assert.Equal(StatusCodes.Status401Unauthorized, response.StatusCode);
        Assert.Contains("session_missing", response.Body);
        Assert.Contains(CoreSessionAuthorization.SessionCookieName, response.Body);
        Assert.Contains("Bearer", response.Body);
    }

    // A credential whose record is gone — pruned, or never issued at all — is the one case the vague
    // sentence is still honest about, and it must stay byte-identical for a cookie and a bearer alike.
    [Fact]
    public async Task RequireSessionAsync_KeepsTheVagueAnswerWhenNoRecordSurvives()
    {
        var fixture = await AuthorizationFixture.CreateAsync(role: "host.user");

        var response = Inspect(await CoreSessionAuthorization.RequireSessionAsync(
            CreateRequest(includeSession: false, includeCsrf: false, bearer: "not_a_session").Request,
            fixture.Users,
            fixture.Clock,
            user => Task.FromResult<IResult>(Results.Ok())));

        Assert.Equal(StatusCodes.Status401Unauthorized, response.StatusCode);
        Assert.Contains("Core session is missing, expired, or revoked.", response.Body);
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

    // Rewrites the fixture's one session and presents it as a bearer, which is the shape an external
    // client uses and the one the live run refused.
    private static async Task<(int StatusCode, string Body)> RefuseAsync(
        Func<AuthSessionRecord, AuthSessionRecord> mutate,
        AuthorizationFixture? existing = null)
    {
        var fixture = existing ?? await AuthorizationFixture.CreateAsync(role: "host.user");
        await fixture.Users.UpdateAsync(state => state with
        {
            // Only the record under test, so these stay correct if the fixture ever grows a second one.
            Sessions =
            [
                .. state.Sessions.Select(session =>
                    string.Equals(session.Id, "session_1", StringComparison.Ordinal) ? mutate(session) : session),
            ],
        });

        return Inspect(await CoreSessionAuthorization.RequireSessionAsync(
            CreateRequest(includeSession: false, includeCsrf: false, bearer: "session_1").Request,
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
