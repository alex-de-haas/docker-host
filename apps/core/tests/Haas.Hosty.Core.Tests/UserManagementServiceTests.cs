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
            AssignedModuleIds: ["com.example.notes"]), actor);
        var state = await fixture.Users.ReadAsync();
        var invitation = Assert.Single(state.Invitations);

        Assert.StartsWith("dhstp_", result.Token, StringComparison.Ordinal);
        Assert.StartsWith("http://127.0.0.1:3001/setup/invite?setupToken=", result.SetupUrl, StringComparison.Ordinal);
        Assert.NotEqual(result.Token, invitation.TokenHash);
        Assert.NotEmpty(invitation.TokenHash!);
        Assert.Equal(["com.example.notes"], invitation.AssignedAppIds);
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
            AssignedModuleIds: ["com.example.notes"]), actor);
        var state = await fixture.Users.ReadAsync();

        Assert.Contains(state.Assignments, assignment => assignment.AppId == "com.example.notes" && assignment.UserId == user.Id);
        Assert.DoesNotContain(state.Assignments, assignment => assignment.AppId == "com.example.old" && assignment.UserId == user.Id);
        Assert.Contains(state.Assignments, assignment => assignment.AppId == "com.example.other" && assignment.UserId == other.Id);
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
            var config = new HostyCoreRuntimeConfig(
                DataRoot: root,
                RunDirectory: Path.Combine(root, "core", "run"),
                ControlDiscoveryPath: Path.Combine(root, "core", "run", "control.json"),
                ListenUrl: "http://127.0.0.1:3001",
                CorePublicOrigin: "http://127.0.0.1:3001",
                ShellPublicOrigin: "http://127.0.0.1:3000",
                RuntimePublicHost: "localhost",
                ShellManifestPath: null,
                ShellBootstrapEnabled: false,
                ShellAutostart: false);
            var service = new UserManagementService(users, apps, audit, config, clock);
            await users.WriteAsync(new UserDirectoryState(1, [], [], [], []));
            return new UserManagementFixture(users, service, clock);
        }
    }

    private sealed class FakeClock(DateTimeOffset now) : IClock
    {
        public DateTimeOffset UtcNow { get; set; } = now;
    }
}
