namespace Haas.Hosty.Core;

// Who may see a given app. Assignments are a per-user allowlist: a non-admin sees an app only when a
// row names them. An app nobody is assigned to is visible to nobody (except admins), never to
// everybody — the admin picker grants access by checking a box, so an unchecked app must stay out of
// reach. System apps are admin-only.
//
// This lives on its own rather than inside the apps-list endpoint because every route that exposes
// per-app data has to answer the same question, and a copy that drifts is an authorization hole. It
// was one: the asset endpoint served any app's files to any authenticated session while the listing
// beside it filtered by assignment.
internal static class AppAccessPolicy
{
    public static bool IsAdmin(HostUserRecord user)
        => string.Equals(user.Role, "host.admin", StringComparison.Ordinal);

    public static bool CanAccessApp(UserDirectoryState state, HostUserRecord user, string appId, bool system)
        => IsAdmin(user) || (!system && IsAssigned(state, user, appId));

    // The `?? []` guards a persisted document that predates the field or was hand-edited: the store
    // only substitutes a default state for a missing file, so a present-but-partial one leaves this null.
    private static bool IsAssigned(UserDirectoryState state, HostUserRecord user, string appId)
        => (state.Assignments ?? []).Any(assignment =>
            string.Equals(assignment.AppId, appId, StringComparison.Ordinal) &&
            string.Equals(assignment.UserId, user.Id, StringComparison.Ordinal));
}
