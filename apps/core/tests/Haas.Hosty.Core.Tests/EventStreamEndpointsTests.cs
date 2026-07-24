using Haas.Hosty.Core;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;

namespace Haas.Hosty.Core.Tests;

public sealed class EventStreamEndpointsTests
{
    [Fact]
    public async Task StreamForSessionAsync_WithoutSession_Returns401()
    {
        var fixture = await Fixture.CreateAsync();
        var context = new DefaultHttpContext();

        var result = await EventStreamEndpoints.StreamForSessionAsync(
            context.Request, context.Response, fixture.Users, fixture.Clock, new CoreEventHub(), CancellationToken.None);

        Assert.Equal(StatusCodes.Status401Unauthorized, StatusOf(result));
    }

    [Fact]
    public async Task StreamForSessionAsync_WritesInitialCommentAndIdleHeartbeat()
    {
        var fixture = await Fixture.CreateAsync();
        var context = RequestContext("session_user");

        // Nothing is ever published, so the stream stays idle — the keep-alive must still fire.
        using var cts = new CancellationTokenSource();
        var stream = EventStreamEndpoints.StreamForSessionAsync(
            context.Request, context.Response, fixture.Users, fixture.Clock, new CoreEventHub(),
            cts.Token, heartbeat: TimeSpan.FromMilliseconds(30));

        await Task.Delay(200);
        cts.Cancel();
        await stream;

        var text = BodyOf(context);
        // Real body bytes forward the response start immediately (the Cloudflare 524 fix)...
        Assert.StartsWith(": connected\n\n", text, StringComparison.Ordinal);
        // ...and an idle stream keeps emitting comments so the proxy never reaps it.
        Assert.Contains(": ping\n\n", text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task StreamForSessionAsync_EndsWhenApplicationStops()
    {
        // An SSE response never completes on its own, and Kestrel's graceful stop waits for
        // in-flight requests — the stream must end itself when Core begins shutting down, or one
        // open tab holds shutdown for the whole host budget and starves the runtime-app stop sweep
        // behind it.
        var fixture = await Fixture.CreateAsync();
        var context = RequestContext("session_user");

        using var stopping = new CancellationTokenSource();
        var stream = EventStreamEndpoints.StreamForSessionAsync(
            context.Request, context.Response, fixture.Users, fixture.Clock, new CoreEventHub(),
            CancellationToken.None, heartbeat: TimeSpan.FromMilliseconds(30), applicationStopping: stopping.Token);

        await Task.Delay(100);
        Assert.False(stream.IsCompleted); // The client never disconnects; only shutdown may end it.

        stopping.Cancel();
        await stream.WaitAsync(TimeSpan.FromSeconds(5));
    }

    [Fact]
    public async Task StreamForSessionAsync_WritesDomainEventsForAdminSessions()
    {
        var fixture = await Fixture.CreateAsync();
        var context = RequestContext("session_admin");
        var events = new CoreEventHub();

        using var cts = new CancellationTokenSource();
        var stream = EventStreamEndpoints.StreamForSessionAsync(
            context.Request, context.Response, fixture.Users, fixture.Clock, events,
            cts.Token, heartbeat: TimeSpan.FromSeconds(5));

        await WaitForBodyAsync(context, ": connected");
        events.PublishAppEvent(CoreEventHub.AppChanged, "com.haas.demo-app");
        await WaitForBodyAsync(context, CoreEventHub.AppChanged);

        cts.Cancel();
        await stream;

        var text = BodyOf(context);
        // Named events: the client picks what it listens for, and new names stay additive.
        Assert.Contains($"event: {CoreEventHub.AppChanged}\ndata: ", text, StringComparison.Ordinal);
        Assert.Contains("com.haas.demo-app", text, StringComparison.Ordinal);
    }

    [Fact]
    public async Task StreamForSessionAsync_WithholdsDomainEventsFromNonAdminSessions()
    {
        // The admin gate lives in the fan-out, not just in the UI: a non-admin session shares the
        // endpoint (it still wants its notifications) but must never learn about apps host-wide.
        var fixture = await Fixture.CreateAsync();
        var context = RequestContext("session_user");
        var events = new CoreEventHub();

        using var cts = new CancellationTokenSource();
        var stream = EventStreamEndpoints.StreamForSessionAsync(
            context.Request, context.Response, fixture.Users, fixture.Clock, events,
            cts.Token, heartbeat: TimeSpan.FromMilliseconds(30));

        await WaitForBodyAsync(context, ": connected");
        events.PublishAppEvent(CoreEventHub.AppChanged, "com.haas.secret-app");
        await Task.Delay(150);

        cts.Cancel();
        await stream;

        var text = BodyOf(context);
        Assert.DoesNotContain("com.haas.secret-app", text, StringComparison.Ordinal);
        Assert.DoesNotContain($"event: {CoreEventHub.AppChanged}", text, StringComparison.Ordinal);
    }

    private static DefaultHttpContext RequestContext(string sessionId)
    {
        var context = new DefaultHttpContext();
        context.Request.Headers.Cookie = $"{CoreSessionAuthorization.SessionCookieName}={sessionId}";
        context.Response.Body = new MemoryStream();
        return context;
    }

    private static string BodyOf(DefaultHttpContext context)
        => System.Text.Encoding.UTF8.GetString(((MemoryStream)context.Response.Body).ToArray());

    private static async Task WaitForBodyAsync(DefaultHttpContext context, string expected)
    {
        for (var i = 0; i < 100; i++)
        {
            if (BodyOf(context).Contains(expected, StringComparison.Ordinal))
            {
                return;
            }

            await Task.Delay(20);
        }

        Assert.Fail($"Stream never wrote '{expected}'. Body: {BodyOf(context)}");
    }

    private static int StatusOf(IResult result)
        => (result as IStatusCodeHttpResult)?.StatusCode ?? StatusCodes.Status200OK;

    private sealed class Fixture
    {
        private Fixture(UserDirectoryStore users, FakeClock clock)
        {
            Users = users;
            Clock = clock;
        }

        public UserDirectoryStore Users { get; }

        public FakeClock Clock { get; }

        public static async Task<Fixture> CreateAsync()
        {
            var root = Path.Combine(Path.GetTempPath(), $"hosty-core-event-stream-tests-{Guid.NewGuid():N}");
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
            await users.WriteAsync(new UserDirectoryState(
                1,
                [
                    new HostUserRecord("user_1", "user@example.test", "User", "host.user", false, clock.UtcNow, clock.UtcNow),
                    new HostUserRecord("admin_1", "admin@example.test", "Admin", "host.admin", false, clock.UtcNow, clock.UtcNow),
                ],
                [],
                [],
                [
                    new AuthSessionRecord("session_user", "user_1", clock.UtcNow, clock.UtcNow.AddHours(1), null),
                    new AuthSessionRecord("session_admin", "admin_1", clock.UtcNow, clock.UtcNow.AddHours(1), null),
                ]));

            return new Fixture(users, clock);
        }
    }

    private sealed class FakeClock(DateTimeOffset now) : IClock
    {
        public DateTimeOffset UtcNow { get; set; } = now;
    }
}
