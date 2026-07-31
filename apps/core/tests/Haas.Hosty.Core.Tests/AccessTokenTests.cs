using System.Text.Json;
using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class AccessTokenTests
{
    [Fact]
    public void IdleFor_GivesAccessTokensTheirOwnWindowAndLeavesBrowserSessionsAlone()
    {
        var lifetimes = AuthLifetimes.Defaults;

        Assert.Equal(lifetimes.CoreSessionIdle, lifetimes.IdleFor(null));
        Assert.Equal(lifetimes.AccessTokenIdle, lifetimes.IdleFor(AccessTokenKinds.Device));
        Assert.Equal(lifetimes.AccessTokenIdle, lifetimes.IdleFor(AccessTokenKinds.Manual));
        // An unknown kind from a future record must not silently inherit the long window.
        Assert.Equal(lifetimes.CoreSessionIdle, lifetimes.IdleFor("something-else"));
    }

    [Fact]
    public async Task IssueAsync_HasNoAbsoluteCapAndStaysLiveFarPastTheSessionWindow()
    {
        var fixture = await AccessTokenFixture.CreateAsync();
        var lifetimes = AuthLifetimes.Defaults;

        var credential = await AccessTokenEndpoints.IssueAsync(
            "user_1", AccessTokenKinds.Device, "kitchen console", fixture.Users, fixture.Clock, lifetimes, CancellationToken.None);

        // Well past the 30-day absolute cap a browser session carries, but inside the idle window.
        var later = fixture.Clock.UtcNow.AddDays(60);
        Assert.True(CoreSessionAuthorization.IsSessionLive(credential, later, lifetimes.IdleFor(credential.Kind)));

        // And dead once the idle window itself elapses, because nothing else ends it.
        var muchLater = fixture.Clock.UtcNow.Add(lifetimes.AccessTokenIdle).AddDays(1);
        Assert.False(CoreSessionAuthorization.IsSessionLive(credential, muchLater, lifetimes.IdleFor(credential.Kind)));
    }

    [Fact]
    public async Task PruneSessions_KeepsALiveAccessTokenWhileDroppingAnIdleExpiredBrowserSession()
    {
        var fixture = await AccessTokenFixture.CreateAsync();
        var lifetimes = AuthLifetimes.Defaults;
        var now = fixture.Clock.UtcNow;

        var token = await AccessTokenEndpoints.IssueAsync(
            "user_1", AccessTokenKinds.Device, "console", fixture.Users, fixture.Clock, lifetimes, CancellationToken.None);
        var staleBrowserSession = new AuthSessionRecord(
            "browser_1", "user_1", now.AddDays(-20), now.AddDays(10), RevokedAt: null, LastSeenAt: now.AddDays(-20));

        // A browser login prunes the list it writes. It must judge each record by its own kind, or the
        // access token — 20 days idle, well past a browser session's window — disappears with it.
        var kept = AuthEndpoints
            .PruneSessions([token, staleBrowserSession], now.AddDays(20), lifetimes)
            .ToArray();

        Assert.Contains(kept, session => session.Id == token.Id);
        Assert.DoesNotContain(kept, session => session.Id == "browser_1");
    }

    [Fact]
    public async Task ExistingStateLoadsUnchangedAndKeepsBehavingAsABrowserSession()
    {
        var fixture = await AccessTokenFixture.CreateAsync();
        // A record exactly as written before access tokens shipped: no kind, no label.
        var legacy = """
            {"schemaVersion":1,"users":[{"id":"user_1","email":"user@example.test","displayName":"User","role":"host.admin","disabled":false,"createdAt":"2026-06-05T10:00:00+00:00","updatedAt":"2026-06-05T10:00:00+00:00"}],"invitations":[],"assignments":[],"sessions":[{"id":"legacy_session","userId":"user_1","createdAt":"2026-06-05T10:00:00+00:00","expiresAt":"2026-07-05T10:00:00+00:00","revokedAt":null}]}
            """;
        await File.WriteAllTextAsync(fixture.StatePath, legacy);

        var state = await fixture.Users.ReadAsync();
        var session = Assert.Single(state.Sessions);

        Assert.Null(session.Kind);
        Assert.Null(session.Label);
        Assert.False(AccessTokenKinds.IsAccessToken(session.Kind));
        Assert.Equal(AuthLifetimes.Defaults.CoreSessionIdle, AuthLifetimes.Defaults.IdleFor(session.Kind));
    }

    [Fact]
    public void FingerprintSessionId_IsStableAndNeverTheCredentialItself()
    {
        const string id = "3f2a" + "b1c9d8e7f60514233445566778899aabbccddeeff00112233445566778899aa";

        var first = CoreSessionAuthorization.FingerprintSessionId(id);
        var second = CoreSessionAuthorization.FingerprintSessionId(id);

        Assert.Equal(first, second);
        Assert.NotEqual(id, first);
        Assert.DoesNotContain(first, id, StringComparison.Ordinal);
    }

    [Fact]
    public void Create_CapsPendingRequestsPerSourceWithoutBlockingOtherSources()
    {
        var clock = new FakeClock(DateTimeOffset.Parse("2026-06-05T10:00:00Z"));
        var devices = new DeviceAuthorizationStore(clock);

        for (var index = 0; index < DeviceAuthorizationStore.MaxPendingPerSource; index++)
        {
            Assert.NotNull(devices.Create($"device {index}", "10.0.0.1").Request);
        }

        // The noisy source is now capped...
        var throttled = devices.Create("one too many", "10.0.0.1");
        Assert.Null(throttled.Request);
        Assert.True(throttled.TooManyPending);

        // ...and a different source is completely unaffected, which is the whole reason the cap is not
        // global: one caller must not be able to block every legitimate enrollment.
        Assert.NotNull(devices.Create("someone else", "10.0.0.2").Request);
    }

    [Fact]
    public void Poll_ReportsExpiredOnceTheRequestLifetimeElapses()
    {
        var clock = new FakeClock(DateTimeOffset.Parse("2026-06-05T10:00:00Z"));
        var devices = new DeviceAuthorizationStore(clock);
        var request = devices.Create("console", "10.0.0.1").Request!;

        Assert.Equal(DeviceAuthorizationStatus.Pending, devices.Poll(request.DeviceCode).Status);

        clock.UtcNow = clock.UtcNow.Add(DeviceAuthorizationStore.RequestLifetime).AddSeconds(1);

        Assert.Equal(DeviceAuthorizationStatus.Expired, devices.Poll(request.DeviceCode).Status);
        Assert.Null(devices.FindByUserCode(request.UserCode));
    }

    [Fact]
    public void Approve_HandsTheCredentialOverExactlyOnce()
    {
        var clock = new FakeClock(DateTimeOffset.Parse("2026-06-05T10:00:00Z"));
        var devices = new DeviceAuthorizationStore(clock);
        var request = devices.Create("console", "10.0.0.1").Request!;

        Assert.True(devices.TryApprove(request.DeviceCode, "session_1", "user_1"));

        var collected = devices.Poll(request.DeviceCode);
        Assert.Equal(DeviceAuthorizationStatus.Approved, collected.Status);
        Assert.Equal("session_1", collected.SessionId);

        // A replayed device code cannot collect the credential a second time.
        Assert.Equal(DeviceAuthorizationStatus.Expired, devices.Poll(request.DeviceCode).Status);
    }

    [Fact]
    public void Approve_LosesToWhoeverAnsweredFirst()
    {
        var clock = new FakeClock(DateTimeOffset.Parse("2026-06-05T10:00:00Z"));
        var devices = new DeviceAuthorizationStore(clock);
        var request = devices.Create("console", "10.0.0.1").Request!;

        Assert.True(devices.TryApprove(request.DeviceCode, "session_1", "user_1"));

        // Two approvers racing the same code must produce one credential, not two.
        Assert.False(devices.TryApprove(request.DeviceCode, "session_2", "user_2"));
        Assert.False(devices.TryDeny(request.DeviceCode));
    }

    [Fact]
    public void FindByUserCode_AcceptsWhatAnOperatorActuallyTypes()
    {
        var clock = new FakeClock(DateTimeOffset.Parse("2026-06-05T10:00:00Z"));
        var devices = new DeviceAuthorizationStore(clock);
        var request = devices.Create("console", "10.0.0.1").Request!;

        Assert.NotNull(devices.FindByUserCode(request.UserCode.ToLowerInvariant()));
        Assert.NotNull(devices.FindByUserCode($"  {AccessTokenEndpoints.FormatUserCode(request.UserCode)}  "));
        Assert.Null(devices.FindByUserCode("NOTACODE"));
    }

    [Fact]
    public void NormalizeLabel_BoundsUntrustedDisplayText()
    {
        Assert.Null(DeviceAuthorizationStore.NormalizeLabel(null));
        Assert.Null(DeviceAuthorizationStore.NormalizeLabel("   "));
        Assert.Equal("kitchen console", DeviceAuthorizationStore.NormalizeLabel("  kitchen console  "));
        // A device supplies its own label, so control characters must not reach an approval screen.
        Assert.Equal("consoleX", DeviceAuthorizationStore.NormalizeLabel("console\r\nX"));
        Assert.Equal(64, DeviceAuthorizationStore.NormalizeLabel(new string('a', 200))!.Length);
    }

    [Fact]
    public void CloseSession_EndsTheStreamThatCredentialHoldsOpenAndLeavesOthersRunning()
    {
        var hub = new CoreEventHub();
        using var revoked = hub.Subscribe("user_1", isAdmin: true, sessionId: "credential_1");
        using var survivor = hub.Subscribe("user_1", isAdmin: true, sessionId: "credential_2");

        hub.CloseSession("credential_1");

        // A completed channel is how the SSE loop already ends: WaitToReadAsync returns false.
        Assert.True(revoked.Reader.Completion.IsCompleted);
        Assert.False(survivor.Reader.Completion.IsCompleted);
    }

    private sealed class AccessTokenFixture
    {
        private AccessTokenFixture(UserDirectoryStore users, FakeClock clock, string statePath)
        {
            Users = users;
            Clock = clock;
            StatePath = statePath;
        }

        public UserDirectoryStore Users { get; }

        public FakeClock Clock { get; }

        public string StatePath { get; }

        public static async Task<AccessTokenFixture> CreateAsync()
        {
            var root = Path.Combine(Path.GetTempPath(), $"hosty-core-access-token-tests-{Guid.NewGuid():N}");
            Directory.CreateDirectory(root);
            var paths = new CoreDataPaths(
                DataRoot: root,
                CoreRoot: Path.Combine(root, "core"),
                AppsRoot: Path.Combine(root, "apps"),
                BackupsRoot: Path.Combine(root, "backups"),
                SourcesRoot: Path.Combine(root, "sources"),
                AuthRoot: Path.Combine(root, "core", "auth"),
                AuditLogPath: Path.Combine(root, "core", "audit", "audit.ndjson"));
            Directory.CreateDirectory(paths.AuthRoot);
            var users = new UserDirectoryStore(paths);
            var clock = new FakeClock(DateTimeOffset.Parse("2026-06-05T10:00:00Z"));
            var user = new HostUserRecord(
                Id: "user_1",
                Email: "user@example.test",
                DisplayName: "User",
                Role: "host.admin",
                Disabled: false,
                CreatedAt: clock.UtcNow,
                UpdatedAt: clock.UtcNow);
            await users.WriteAsync(new UserDirectoryState(1, [user], [], [], []));
            return new AccessTokenFixture(users, clock, Path.Combine(paths.AuthRoot, "state.json"));
        }
    }

    private sealed class FakeClock(DateTimeOffset now) : IClock
    {
        public DateTimeOffset UtcNow { get; set; } = now;
    }
}
