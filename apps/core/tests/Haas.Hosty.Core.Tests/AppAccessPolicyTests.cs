using Haas.Hosty.Core;

namespace Haas.Hosty.Core.Tests;

public sealed class AppAccessPolicyTests
{
    [Fact]
    public void Admin_SeesEveryApp_IncludingSystemApps()
    {
        var state = StateWith();

        Assert.True(AppAccessPolicy.CanAccessApp(state, Admin(), "com.example.notes", system: false));
        Assert.True(AppAccessPolicy.CanAccessApp(state, Admin(), "hosty.shell", system: true));
    }

    [Fact]
    public void User_SeesOnlyAppsAssignedToThem()
    {
        var state = StateWith(("com.example.notes", "user_1"));

        Assert.True(AppAccessPolicy.CanAccessApp(state, User("user_1"), "com.example.notes", system: false));
        Assert.False(AppAccessPolicy.CanAccessApp(state, User("user_2"), "com.example.notes", system: false));
    }

    [Fact]
    public void User_IsDeniedAnAppNobodyIsAssignedTo()
    {
        // An unassigned app is visible to nobody but admins — never to everybody.
        Assert.False(AppAccessPolicy.CanAccessApp(StateWith(), User("user_1"), "com.example.notes", system: false));
    }

    [Fact]
    public void User_IsDeniedASystemAppEvenWhenAssigned()
    {
        var state = StateWith(("hosty.shell", "user_1"));

        Assert.False(AppAccessPolicy.CanAccessApp(state, User("user_1"), "hosty.shell", system: true));
    }

    [Fact]
    public void User_IsDeniedWhenTheDocumentPredatesAssignments()
    {
        // A persisted document written before the field existed, or hand-edited, leaves it null.
        var state = new UserDirectoryState(SchemaVersion: 1, Users: [], Invitations: [], Assignments: null!, Sessions: []);

        Assert.False(AppAccessPolicy.CanAccessApp(state, User("user_1"), "com.example.notes", system: false));
        Assert.True(AppAccessPolicy.CanAccessApp(state, Admin(), "com.example.notes", system: false));
    }

    [Fact]
    public void Assignment_IsMatchedOnBothAppAndUser()
    {
        // A row naming the right user but a different app must not grant access, and vice versa.
        var state = StateWith(("com.example.other", "user_1"), ("com.example.notes", "user_2"));

        Assert.False(AppAccessPolicy.CanAccessApp(state, User("user_1"), "com.example.notes", system: false));
    }

    private static UserDirectoryState StateWith(params (string AppId, string UserId)[] assignments)
        => new(
            SchemaVersion: 1,
            Users: [],
            Invitations: [],
            Assignments: [.. assignments.Select(pair => new AppAssignmentRecord(pair.AppId, pair.UserId, DateTimeOffset.UnixEpoch))],
            Sessions: []);

    private static HostUserRecord Admin() => CreateUser("user_admin", "host.admin");

    private static HostUserRecord User(string id) => CreateUser(id, "host.user");

    private static HostUserRecord CreateUser(string id, string role) => new(
        Id: id,
        Email: $"{id}@example.com",
        DisplayName: id,
        Role: role,
        Disabled: false,
        CreatedAt: DateTimeOffset.UnixEpoch,
        UpdatedAt: DateTimeOffset.UnixEpoch);
}
