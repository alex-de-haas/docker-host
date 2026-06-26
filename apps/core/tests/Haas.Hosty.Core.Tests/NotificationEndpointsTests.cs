using Haas.Hosty.Core;
using Microsoft.AspNetCore.Http;

namespace Haas.Hosty.Core.Tests;

public sealed class NotificationEndpointsTests
{
    [Theory]
    [InlineData(null, "notification_title_required")]
    [InlineData("   ", "notification_title_required")]
    public void ValidateAppRequest_RejectsMissingTitle(string? title, string expectedCode)
    {
        var (command, code, _) = NotificationEndpoints.ValidateAppRequest(
            new AppNotificationCreateRequest("broadcast", null, null, title, null, null, null));

        Assert.Null(command);
        Assert.Equal(expectedCode, code);
    }

    [Fact]
    public void ValidateAppRequest_RejectsTooLongTitle()
    {
        var (command, code, status) = NotificationEndpoints.ValidateAppRequest(
            new AppNotificationCreateRequest("broadcast", null, null, new string('x', 121), null, null, null));

        Assert.Null(command);
        Assert.Equal("notification_title_too_long", code);
        Assert.Equal(StatusCodes.Status400BadRequest, status);
    }

    [Fact]
    public void ValidateAppRequest_RejectsHostAdminAudience()
    {
        var (command, code, status) = NotificationEndpoints.ValidateAppRequest(
            new AppNotificationCreateRequest("broadcast", "host-admin", null, "Title", null, null, null));

        Assert.Null(command);
        Assert.Equal("notification_audience_forbidden", code);
        Assert.Equal(StatusCodes.Status403Forbidden, status);
    }

    [Fact]
    public void ValidateAppRequest_RejectsUnknownLevel()
    {
        var (command, code, _) = NotificationEndpoints.ValidateAppRequest(
            new AppNotificationCreateRequest("broadcast", null, "critical", "Title", null, null, null));

        Assert.Null(command);
        Assert.Equal("notification_level_invalid", code);
    }

    [Fact]
    public void ValidateAppRequest_RejectsMissingTarget()
    {
        var (command, code, _) = NotificationEndpoints.ValidateAppRequest(
            new AppNotificationCreateRequest(null, null, null, "Title", null, null, null));

        Assert.Null(command);
        Assert.Equal("notification_target_required", code);
    }

    [Fact]
    public void ValidateAppRequest_NormalizesAndAcceptsValidInput()
    {
        var (command, code, _) = NotificationEndpoints.ValidateAppRequest(
            new AppNotificationCreateRequest("  user_alice  ", "USER", "  WARNING ", "  Hi  ", "   ", "  /x ", "  k  "));

        Assert.Null(code);
        Assert.NotNull(command);
        Assert.Equal("user_alice", command!.Target);
        Assert.Equal("warning", command.Level);
        Assert.Equal("Hi", command.Title);
        Assert.Null(command.Body); // whitespace-only body collapses to null
        Assert.Equal("/x", command.Link);
        Assert.Equal("k", command.DedupeKey);
    }

    [Fact]
    public async Task PublishFromAppAsync_MissingToken_Returns401()
    {
        var fixture = await Fixture.CreateAsync();

        var result = await fixture.Publish(token: null,
            new AppNotificationCreateRequest("broadcast", null, null, "Hi", null, null, null));

        Assert.Equal(StatusCodes.Status401Unauthorized, StatusOf(result));
    }

    [Fact]
    public async Task PublishFromAppAsync_ValidTokenUnknownApp_Returns404()
    {
        var fixture = await Fixture.CreateAsync();
        var token = fixture.ServiceTokens.CreateToken("com.example.missing");

        var result = await fixture.Publish(token,
            new AppNotificationCreateRequest("broadcast", null, null, "Hi", null, null, null),
            appId: "com.example.missing");

        Assert.Equal(StatusCodes.Status404NotFound, StatusOf(result));
    }

    [Fact]
    public async Task PublishFromAppAsync_HappyPath_Returns201AndWritesAudit()
    {
        var fixture = await Fixture.CreateAsync();
        var token = fixture.ServiceTokens.CreateToken("com.example.app");

        var result = await fixture.Publish(token,
            new AppNotificationCreateRequest("broadcast", null, "info", "Hi", "Body", null, null));

        Assert.Equal(StatusCodes.Status201Created, StatusOf(result));
        Assert.True(File.Exists(fixture.AuditLogPath));
        Assert.Contains("notification.publish", await File.ReadAllTextAsync(fixture.AuditLogPath));
    }

    [Fact]
    public async Task PublishFromAppAsync_DuplicateDedupeKey_Returns200Deduplicated()
    {
        var fixture = await Fixture.CreateAsync();
        var token = fixture.ServiceTokens.CreateToken("com.example.app");
        var request = new AppNotificationCreateRequest("user_alice", null, null, "Hi", null, null, "k1");

        var first = await fixture.Publish(token, request);
        var second = await fixture.Publish(token, request);

        Assert.Equal(StatusCodes.Status201Created, StatusOf(first));
        Assert.Equal(StatusCodes.Status200OK, StatusOf(second));
    }

    private static int StatusOf(IResult result)
        => (result as IStatusCodeHttpResult)?.StatusCode ?? StatusCodes.Status200OK;

    private sealed class Fixture
    {
        private Fixture(AppServiceTokenService serviceTokens, AppRegistryStore apps, NotificationService notifications, AuditStore audit, string auditLogPath, FakeClock clock)
        {
            ServiceTokens = serviceTokens;
            _apps = apps;
            _notifications = notifications;
            _audit = audit;
            AuditLogPath = auditLogPath;
            _clock = clock;
        }

        private readonly AppRegistryStore _apps;
        private readonly NotificationService _notifications;
        private readonly AuditStore _audit;
        private readonly FakeClock _clock;

        public AppServiceTokenService ServiceTokens { get; }

        public string AuditLogPath { get; }

        public Task<IResult> Publish(string? token, AppNotificationCreateRequest input, string appId = "com.example.app")
        {
            var context = new DefaultHttpContext();
            if (token is not null)
            {
                context.Request.Headers.Authorization = $"Bearer {token}";
            }

            return NotificationEndpoints.PublishFromAppAsync(
                appId, context.Request, input, ServiceTokens, _apps, _notifications, _audit, _clock, CancellationToken.None);
        }

        public static async Task<Fixture> CreateAsync()
        {
            var root = Path.Combine(Path.GetTempPath(), $"hosty-core-notification-endpoint-tests-{Guid.NewGuid():N}");
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
            var alice = new HostUserRecord("user_alice", "alice@example.test", "Alice", "host.user", false, clock.UtcNow, clock.UtcNow);
            await users.WriteAsync(new UserDirectoryState(
                1, [alice], [], [new AppAssignmentRecord("com.example.app", "user_alice", clock.UtcNow)], []));

            var apps = new AppRegistryStore(paths);
            await apps.UpsertAppAsync(CreateApp("com.example.app"));

            var notifications = new NotificationService(new NotificationStore(paths), users, new NotificationBroadcaster(), clock);
            var serviceTokens = new AppServiceTokenService(new ControlSecret("test-secret"));
            return new Fixture(serviceTokens, apps, notifications, new AuditStore(paths), paths.AuditLogPath, clock);
        }

        private static AppRecord CreateApp(string id)
            => new(
                Id: id,
                DisplayName: "App",
                Description: null,
                Version: "1.0.0",
                Kind: "runtime",
                System: false,
                Source: "installed",
                ManifestPath: null,
                ManifestUrl: null,
                SelectedRuntime: "docker",
                OperationStatus: "installed",
                RuntimeState: "stopped",
                LastOperation: null,
                LastError: null,
                Capabilities: [],
                Settings: new Dictionary<string, AppSettingValue>(),
                StorageMappings: [],
                Dependencies: [],
                Endpoints: [],
                InstalledAt: DateTimeOffset.UtcNow,
                UpdatedAt: DateTimeOffset.UtcNow);
    }

    private sealed class FakeClock(DateTimeOffset now) : IClock
    {
        public DateTimeOffset UtcNow { get; set; } = now;
    }
}
