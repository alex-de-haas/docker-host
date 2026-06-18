using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class AppDirectoryEndpointsTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.UnixEpoch;

    private static HostUserRecord User(string id, string role, bool disabled = false, string? email = null)
        => new(id, email ?? $"{id}@example.test", id, role, disabled, Now, Now);

    [Fact]
    public void BuildDirectoryUsers_IncludesExplicitlyAssignedUsers()
    {
        var state = new UserDirectoryState(
            1,
            [User("user_alice", "host.user"), User("user_bob", "host.user")],
            [],
            [new AppAssignmentRecord("com.example.app", "user_alice", Now)],
            []);

        var result = AppDirectoryEndpoints.BuildDirectoryUsers(state, "com.example.app");

        Assert.Equal(["user_alice"], result.Select(user => user.Id));
    }

    [Fact]
    public void BuildDirectoryUsers_IncludesAdminsWithoutExplicitAssignment()
    {
        // Admins are never stored as explicit assignments, yet they have implicit access to every
        // app — so they must still appear in the directory. Regression for the false revocation of
        // an admin's app-owned credentials (e.g. media-server Jellyfin PIN).
        var state = new UserDirectoryState(
            1,
            [User("user_admin", "host.admin")],
            [],
            [],
            []);

        var result = AppDirectoryEndpoints.BuildDirectoryUsers(state, "com.example.app");

        Assert.Equal(["user_admin"], result.Select(user => user.Id));
    }

    [Fact]
    public void BuildDirectoryUsers_IncludesAdminAlongsideAssignedUsers()
    {
        var state = new UserDirectoryState(
            1,
            [User("user_admin", "host.admin"), User("user_alice", "host.user")],
            [],
            [new AppAssignmentRecord("com.example.app", "user_alice", Now)],
            []);

        var result = AppDirectoryEndpoints.BuildDirectoryUsers(state, "com.example.app");

        Assert.Equal(["user_admin", "user_alice"], result.Select(user => user.Id).OrderBy(id => id));
    }

    [Fact]
    public void BuildDirectoryUsers_ExcludesDisabledUsers_EvenAdmins()
    {
        var state = new UserDirectoryState(
            1,
            [
                User("user_admin", "host.admin", disabled: true),
                User("user_alice", "host.user", disabled: true),
            ],
            [],
            [new AppAssignmentRecord("com.example.app", "user_alice", Now)],
            []);

        var result = AppDirectoryEndpoints.BuildDirectoryUsers(state, "com.example.app");

        Assert.Empty(result);
    }

    [Fact]
    public void BuildDirectoryUsers_ExcludesUsersAssignedToOtherApps()
    {
        var state = new UserDirectoryState(
            1,
            [User("user_alice", "host.user")],
            [],
            [new AppAssignmentRecord("com.example.other", "user_alice", Now)],
            []);

        var result = AppDirectoryEndpoints.BuildDirectoryUsers(state, "com.example.app");

        Assert.Empty(result);
    }
}
