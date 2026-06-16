using Haas.Hosty.Core;
using Microsoft.AspNetCore.Http;

namespace Haas.Hosty.Core.Tests;

public sealed class NotificationConsumerEndpointsTests
{
    [Fact]
    public async Task ListForSessionAsync_WithoutSession_Returns401()
    {
        var fixture = await Fixture.CreateAsync();

        var result = await NotificationEndpoints.ListForSessionAsync(
            Request(session: false), fixture.Users, fixture.Clock, fixture.Notifications, CancellationToken.None);

        Assert.Equal(StatusCodes.Status401Unauthorized, StatusOf(result));
    }

    [Fact]
    public async Task ListForSessionAsync_WithSession_ReturnsUserInbox()
    {
        var fixture = await Fixture.CreateAsync();
        await fixture.Notifications.PublishAsync(new CoreScope(), "user_1", NotificationService.AudienceUser, "info", "A", null, null, null);
        await fixture.Notifications.PublishAsync(new CoreScope(), "user_1", NotificationService.AudienceUser, "info", "B", null, null, null);

        var result = await NotificationEndpoints.ListForSessionAsync(
            Request(), fixture.Users, fixture.Clock, fixture.Notifications, CancellationToken.None);

        var body = ValueOf<NotificationsResponse>(result);
        Assert.Equal(2, body.Notifications.Count);
        Assert.Equal(2, body.UnreadCount);
    }

    [Fact]
    public async Task ListForSessionAsync_UnreadFilterAndLimitApply()
    {
        var fixture = await Fixture.CreateAsync();
        await fixture.Notifications.PublishAsync(new CoreScope(), "user_1", NotificationService.AudienceUser, "info", "A", null, null, null);
        await fixture.Notifications.PublishAsync(new CoreScope(), "user_1", NotificationService.AudienceUser, "info", "B", null, null, null);

        var request = Request();
        request.QueryString = new QueryString("?unread=true&limit=1");
        var result = await NotificationEndpoints.ListForSessionAsync(
            request, fixture.Users, fixture.Clock, fixture.Notifications, CancellationToken.None);

        var body = ValueOf<NotificationsResponse>(result);
        Assert.Single(body.Notifications);   // limit=1
        Assert.Equal(2, body.UnreadCount);    // count is over all unread, not the page
        Assert.Equal(2, body.Pagination.Total);
    }

    [Fact]
    public async Task MarkReadForSessionAsync_WithoutCsrf_Returns403()
    {
        var fixture = await Fixture.CreateAsync();

        var result = await NotificationEndpoints.MarkReadForSessionAsync(
            Request(csrf: false), input: null, fixture.Users, fixture.Clock, fixture.Notifications, CancellationToken.None);

        Assert.Equal(StatusCodes.Status403Forbidden, StatusOf(result));
    }

    [Fact]
    public async Task MarkReadForSessionAsync_WithCsrf_MarksAllAndReportsUnread()
    {
        var fixture = await Fixture.CreateAsync();
        await fixture.Notifications.PublishAsync(new CoreScope(), "user_1", NotificationService.AudienceUser, "info", "A", null, null, null);
        await fixture.Notifications.PublishAsync(new CoreScope(), "user_1", NotificationService.AudienceUser, "info", "B", null, null, null);

        var result = await NotificationEndpoints.MarkReadForSessionAsync(
            Request(csrf: true), new NotificationMarkReadRequest(null), fixture.Users, fixture.Clock, fixture.Notifications, CancellationToken.None);

        var body = ValueOf<NotificationMarkReadResponse>(result);
        Assert.Equal(2, body.Updated);
        Assert.Equal(0, body.UnreadCount);
    }

    [Fact]
    public async Task StreamForSessionAsync_WithoutSession_Returns401()
    {
        var fixture = await Fixture.CreateAsync();
        var context = new DefaultHttpContext();

        var result = await NotificationEndpoints.StreamForSessionAsync(
            context.Request, context.Response, fixture.Users, fixture.Clock, new NotificationBroadcaster(), CancellationToken.None);

        Assert.Equal(StatusCodes.Status401Unauthorized, StatusOf(result));
    }

    private static HttpRequest Request(bool session = true, bool csrf = false)
    {
        var context = new DefaultHttpContext();
        var cookies = new List<string>();
        if (session)
        {
            cookies.Add($"{CoreSessionAuthorization.SessionCookieName}=session_1");
        }

        if (csrf)
        {
            cookies.Add($"{CoreSessionAuthorization.CsrfCookieName}=csrf_1");
            context.Request.Headers[CoreSessionAuthorization.CsrfHeaderName] = "csrf_1";
        }

        if (cookies.Count > 0)
        {
            context.Request.Headers.Cookie = string.Join("; ", cookies);
        }

        return context.Request;
    }

    private static int StatusOf(IResult result)
        => (result as IStatusCodeHttpResult)?.StatusCode ?? StatusCodes.Status200OK;

    private static T ValueOf<T>(IResult result)
    {
        Assert.Equal(StatusCodes.Status200OK, StatusOf(result));
        var value = (result as IValueHttpResult)?.Value;
        Assert.NotNull(value);
        return Assert.IsType<T>(value);
    }

    private sealed class Fixture
    {
        private Fixture(UserDirectoryStore users, NotificationService notifications, FakeClock clock)
        {
            Users = users;
            Notifications = notifications;
            Clock = clock;
        }

        public UserDirectoryStore Users { get; }

        public NotificationService Notifications { get; }

        public FakeClock Clock { get; }

        public static async Task<Fixture> CreateAsync()
        {
            var root = Path.Combine(Path.GetTempPath(), $"hosty-core-notification-consumer-tests-{Guid.NewGuid():N}");
            var paths = new CoreDataPaths(
                DataRoot: root,
                CoreRoot: Path.Combine(root, "core"),
                AppsRoot: Path.Combine(root, "apps"),
                BackupsRoot: Path.Combine(root, "backups"),
                SourcesRoot: Path.Combine(root, "sources"),
                AuthRoot: Path.Combine(root, "core", "auth"),
                AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));

            var clock = new FakeClock(DateTimeOffset.Parse("2026-06-05T10:00:00Z"));
            var users = new UserDirectoryStore(paths);
            var user = new HostUserRecord("user_1", "user@example.test", "User", "host.user", false, clock.UtcNow, clock.UtcNow);
            var session = new AuthSessionRecord("session_1", "user_1", clock.UtcNow, clock.UtcNow.AddHours(1), null);
            await users.WriteAsync(new UserDirectoryState(1, [user], [], [], [session]));

            var notifications = new NotificationService(new NotificationStore(paths), users, new NotificationBroadcaster(), clock);
            return new Fixture(users, notifications, clock);
        }
    }

    private sealed class FakeClock(DateTimeOffset now) : IClock
    {
        public DateTimeOffset UtcNow { get; set; } = now;
    }
}
