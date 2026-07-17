using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class UserManagementServiceTests
{
    [Fact]
    public async Task CreateInvitationAsync_ReturnsCoreOwnedSetupUrlAndStoresOnlyTokenHash()
    {
        var fixture = await UserManagementFixture.CreateAsync();
        var actor = CreateUser("admin_1", "host.admin");
        await fixture.Users.WriteAsync(new UserDirectoryState(1, [actor], [], [], []));

        var result = await fixture.Service.CreateInvitationAsync(new UserInvitationCreateRequest(
            Email: "user@example.test",
            DisplayName: "User",
            Role: "host.user",
            AssignedAppIds: ["com.example.notes"]), actor);
        var state = await fixture.Users.ReadAsync();
        var invitation = Assert.Single(state.Invitations);

        Assert.StartsWith("dhstp_", result.Token, StringComparison.Ordinal);
        Assert.StartsWith("http://127.0.0.1:3001/setup/invite?setupToken=", result.SetupUrl, StringComparison.Ordinal);
        Assert.NotEqual(result.Token, invitation.TokenHash);
        Assert.NotEmpty(invitation.TokenHash!);
        Assert.Equal(["com.example.notes"], invitation.AssignedAppIds);
    }

    [Fact]
    public async Task AcceptInvitationAsync_CreatesUserAssignmentsAndPasswordCredential()
    {
        var fixture = await UserManagementFixture.CreateAsync();
        var actor = CreateUser("admin_1", "host.admin");
        await fixture.Users.WriteAsync(new UserDirectoryState(1, [actor], [], [], []));
        var invitation = await fixture.Service.CreateInvitationAsync(new UserInvitationCreateRequest(
            Email: "user@example.test",
            DisplayName: "Invited User",
            Role: "host.user",
            AssignedAppIds: ["com.example.notes"]), actor);

        var user = await fixture.Service.AcceptInvitationAsync(new UserInvitationAcceptRequest(
            SetupToken: invitation.Token,
            DisplayName: "Accepted User",
            Password: "correct horse battery staple"));
        var state = await fixture.Users.ReadAsync();
        var stored = Assert.Single(state.Users, candidate => candidate.Id == user.Id);
        var credential = Assert.Single(state.PasswordCredentials ?? []);

        Assert.Equal("user@example.test", stored.Email);
        Assert.Equal("Accepted User", stored.DisplayName);
        Assert.Equal("host.user", stored.Role);
        Assert.Contains(state.Assignments, assignment => assignment.UserId == user.Id && assignment.AppId == "com.example.notes");
        Assert.Equal(user.Id, credential.UserId);
        Assert.NotEqual("correct horse battery staple", credential.Hash);
        Assert.Equal("used", Assert.Single(state.Invitations).Status);
    }

    [Fact]
    public async Task AcceptInvitationAsync_RequiresPassword()
    {
        var fixture = await UserManagementFixture.CreateAsync();
        var actor = CreateUser("admin_1", "host.admin");
        await fixture.Users.WriteAsync(new UserDirectoryState(1, [actor], [], [], []));
        var invitation = await fixture.Service.CreateInvitationAsync(new UserInvitationCreateRequest(
            Email: "user@example.test",
            Role: "host.user"), actor);

        var error = await Assert.ThrowsAsync<LocalPasswordAuthException>(() =>
            fixture.Service.AcceptInvitationAsync(new UserInvitationAcceptRequest(
                SetupToken: invitation.Token)));

        Assert.Equal("password_invalid", error.Code);
    }

    [Fact]
    public async Task DisableUserAsync_PreventsSelfDisable()
    {
        var fixture = await UserManagementFixture.CreateAsync();
        var actor = CreateUser("admin_1", "host.admin");
        await fixture.Users.WriteAsync(new UserDirectoryState(1, [actor], [], [], []));

        var error = await Assert.ThrowsAsync<UserManagementException>(() =>
            fixture.Service.DisableUserAsync(actor.Id, actor));

        Assert.Equal("self_disable_forbidden", error.Code);
    }

    [Fact]
    public async Task UpdateUserAsync_PreventsDemotingLastAdmin()
    {
        var fixture = await UserManagementFixture.CreateAsync();
        var actor = CreateUser("admin_1", "host.admin");
        await fixture.Users.WriteAsync(new UserDirectoryState(1, [actor], [], [], []));

        var error = await Assert.ThrowsAsync<UserManagementException>(() =>
            fixture.Service.UpdateUserAsync(actor.Id, new HostUserUpdateRequest(Role: "host.user"), actor));

        Assert.Equal("last_admin", error.Code);
    }

    [Fact]
    public async Task UpdateUserAsync_PreventsSelfDemoteWhenAnotherAdminExists()
    {
        var fixture = await UserManagementFixture.CreateAsync();
        var actor = CreateUser("admin_1", "host.admin");
        var otherAdmin = CreateUser("admin_2", "host.admin");
        await fixture.Users.WriteAsync(new UserDirectoryState(1, [actor, otherAdmin], [], [], []));

        var error = await Assert.ThrowsAsync<UserManagementException>(() =>
            fixture.Service.UpdateUserAsync(actor.Id, new HostUserUpdateRequest(Role: "host.user"), actor));

        Assert.Equal("self_role_change_forbidden", error.Code);
    }

    [Fact]
    public async Task ReplaceAssignmentsAsync_ReplacesOnlyTargetUserAssignments()
    {
        var fixture = await UserManagementFixture.CreateAsync();
        var actor = CreateUser("admin_1", "host.admin");
        var user = CreateUser("user_1", "host.user");
        var other = CreateUser("user_2", "host.user");
        await fixture.Users.WriteAsync(new UserDirectoryState(
            1,
            [actor, user, other],
            [],
            [
                new AppAssignmentRecord("com.example.old", user.Id, fixture.Clock.UtcNow),
                new AppAssignmentRecord("com.example.other", other.Id, fixture.Clock.UtcNow),
            ],
            []));

        _ = await fixture.Service.ReplaceAssignmentsAsync(user.Id, new HostUserAssignmentsRequest(
            AssignedAppIds: ["com.example.notes"]), actor);
        var state = await fixture.Users.ReadAsync();

        Assert.Contains(state.Assignments, assignment => assignment.AppId == "com.example.notes" && assignment.UserId == user.Id);
        Assert.DoesNotContain(state.Assignments, assignment => assignment.AppId == "com.example.old" && assignment.UserId == user.Id);
        Assert.Contains(state.Assignments, assignment => assignment.AppId == "com.example.other" && assignment.UserId == other.Id);
    }

    [Fact]
    public async Task PurgeUserAsync_RemovesDisabledRecordAndCredentialAndSessions()
    {
        var fixture = await UserManagementFixture.CreateAsync();
        var actor = CreateUser("admin_1", "host.admin");
        await fixture.Users.WriteAsync(new UserDirectoryState(1, [actor], [], [], []));
        var invitation = await fixture.Service.CreateInvitationAsync(new UserInvitationCreateRequest(
            Email: "user@example.test",
            Role: "host.user",
            AssignedAppIds: ["com.example.notes"]), actor);
        var user = await fixture.Service.AcceptInvitationAsync(new UserInvitationAcceptRequest(
            SetupToken: invitation.Token,
            Password: "correct horse battery staple"));
        await fixture.Service.DisableUserAsync(user.Id, actor);

        var result = await fixture.Service.PurgeUserAsync(user.Id, actor);
        var state = await fixture.Users.ReadAsync();

        Assert.True(result.Purged);
        Assert.DoesNotContain(state.Users, candidate => candidate.Id == user.Id);
        Assert.DoesNotContain(state.PasswordCredentials ?? [], credential => credential.UserId == user.Id);
        Assert.DoesNotContain(state.Sessions, session => session.UserId == user.Id);
        Assert.DoesNotContain(state.Assignments, assignment => assignment.UserId == user.Id);
    }

    [Fact]
    public async Task PurgeUserAsync_RejectsActiveUser()
    {
        var fixture = await UserManagementFixture.CreateAsync();
        var actor = CreateUser("admin_1", "host.admin");
        var user = CreateUser("user_1", "host.user");
        await fixture.Users.WriteAsync(new UserDirectoryState(1, [actor, user], [], [], []));

        var error = await Assert.ThrowsAsync<UserManagementException>(() =>
            fixture.Service.PurgeUserAsync(user.Id, actor));
        var state = await fixture.Users.ReadAsync();

        Assert.Equal("user_not_disabled", error.Code);
        Assert.Contains(state.Users, candidate => candidate.Id == user.Id);
    }

    [Fact]
    public async Task PurgeUserAsync_MissingUser_Throws()
    {
        var fixture = await UserManagementFixture.CreateAsync();
        var actor = CreateUser("admin_1", "host.admin");
        await fixture.Users.WriteAsync(new UserDirectoryState(1, [actor], [], [], []));

        var error = await Assert.ThrowsAsync<UserManagementException>(() =>
            fixture.Service.PurgeUserAsync("user_missing", actor));

        Assert.Equal("user_not_found", error.Code);
    }

    [Fact]
    public async Task PurgeUserAsync_FreesEmailForReinvite()
    {
        var fixture = await UserManagementFixture.CreateAsync();
        var actor = CreateUser("admin_1", "host.admin");
        var user = CreateUser("user_1", "host.user") with { Email = "reuse@example.test", Disabled = true };
        await fixture.Users.WriteAsync(new UserDirectoryState(1, [actor, user], [], [], []));

        // Same email is blocked while the disabled record exists...
        var blocked = await Assert.ThrowsAsync<UserManagementException>(() =>
            fixture.Service.CreateInvitationAsync(new UserInvitationCreateRequest(Email: "reuse@example.test", Role: "host.user"), actor));
        Assert.Equal("email_exists", blocked.Code);

        // ...and available again once the record is purged.
        await fixture.Service.PurgeUserAsync(user.Id, actor);
        var invitation = await fixture.Service.CreateInvitationAsync(new UserInvitationCreateRequest(Email: "reuse@example.test", Role: "host.user"), actor);
        Assert.StartsWith("dhstp_", invitation.Token, StringComparison.Ordinal);
    }

    [Fact]
    public async Task PurgeExpiredDisabledUsersAsync_RemovesOnlyAgedDisabledUsers()
    {
        var fixture = await UserManagementFixture.CreateAsync();
        var now = fixture.Clock.UtcNow;
        var admin = CreateUser("admin_1", "host.admin");
        var active = CreateUser("user_active", "host.user");
        var recentlyDisabled = CreateUser("user_recent", "host.user") with { Disabled = true, UpdatedAt = now.AddDays(-3) };
        var longDisabled = CreateUser("user_old", "host.user") with { Disabled = true, UpdatedAt = now.AddDays(-30) };
        await fixture.Users.WriteAsync(new UserDirectoryState(
            1, [admin, active, recentlyDisabled, longDisabled], [], [], []));

        var purged = await fixture.Service.PurgeExpiredDisabledUsersAsync(TimeSpan.FromDays(10));
        var state = await fixture.Users.ReadAsync();

        Assert.Equal(["user_old"], purged);
        Assert.DoesNotContain(state.Users, candidate => candidate.Id == "user_old");
        Assert.Contains(state.Users, candidate => candidate.Id == "user_recent");
        Assert.Contains(state.Users, candidate => candidate.Id == "user_active");
        Assert.Contains(state.Users, candidate => candidate.Id == "admin_1");
    }

    [Fact]
    public async Task PurgeExpiredDisabledUsersAsync_NonPositiveRetentionRemovesNothing()
    {
        var fixture = await UserManagementFixture.CreateAsync();
        var admin = CreateUser("admin_1", "host.admin");
        var longDisabled = CreateUser("user_old", "host.user") with { Disabled = true, UpdatedAt = fixture.Clock.UtcNow.AddDays(-100) };
        await fixture.Users.WriteAsync(new UserDirectoryState(1, [admin, longDisabled], [], [], []));

        var purged = await fixture.Service.PurgeExpiredDisabledUsersAsync(TimeSpan.Zero);

        Assert.Empty(purged);
        Assert.Contains((await fixture.Users.ReadAsync()).Users, candidate => candidate.Id == "user_old");
    }

    private static HostUserRecord CreateUser(string id, string role)
        => new(
            Id: id,
            Email: $"{id}@example.test",
            DisplayName: id,
            Role: role,
            Disabled: false,
            CreatedAt: DateTimeOffset.UtcNow,
            UpdatedAt: DateTimeOffset.UtcNow);

    private sealed class UserManagementFixture
    {
        private UserManagementFixture(UserDirectoryStore users, UserManagementService service, FakeClock clock)
        {
            Users = users;
            Service = service;
            Clock = clock;
        }

        public UserDirectoryStore Users { get; }

        public UserManagementService Service { get; }

        public FakeClock Clock { get; }

        public static async Task<UserManagementFixture> CreateAsync()
        {
            var root = Path.Combine(Path.GetTempPath(), $"hosty-core-users-tests-{Guid.NewGuid():N}");
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
            var apps = new AppRegistryStore(paths);
            var audit = new AuditStore(paths);
            var clock = new FakeClock(DateTimeOffset.Parse("2026-06-03T10:00:00Z"));
            var passwords = new LocalPasswordAuthService(users, audit, clock);
            var config = new HostyCoreRuntimeConfig(
                DataRoot: root,
                RunDirectory: Path.Combine(root, "core", "run"),
                ControlDiscoveryPath: Path.Combine(root, "core", "run", "control.json"),
                CorePort: 3001,
                ListenUrl: "http://127.0.0.1:3001",
                CorePublicOrigin: "http://127.0.0.1:3001",
                RuntimePublicHost: "localhost",
                ShellSourceOverridePath: null,
                ShellAutostart: false);
            var service = new UserManagementService(users, apps, audit, passwords, config, clock);
            await users.WriteAsync(new UserDirectoryState(1, [], [], [], []));
            return new UserManagementFixture(users, service, clock);
        }
    }

    private sealed class FakeClock(DateTimeOffset now) : IClock
    {
        public DateTimeOffset UtcNow { get; set; } = now;
    }
}
