namespace Haas.Hosty.Core;

internal sealed record WorkspaceParticipantUser(string Id, string Name);
internal sealed record WorkspaceMemberView(string UserId, string Name, string Role, string[] WorktreeIds, bool Revoked);
internal sealed record WorkspaceSessionView(string AppId, string UserId, string SessionId, string Title,
    bool Attached, bool CanOpen, string? ViewerPath, string Status, DateTimeOffset? ActivityAt, bool CurrentInstallation, DateTimeOffset ChangedAt);
internal sealed record WorkspaceParticipationView(string Id, long Revision, string Role,
    WorkspaceMemberView[] Members, WorkspaceSessionView[] Sessions, WorkspaceParticipantUser[] EligibleUsers, string ViewerUserId);
internal sealed record WorkspaceAssociationView(WorkspaceParticipationView? Workspace);

internal static class WorkspaceParticipationEndpoints
{
    public static void Map(WebApplication app)
    {
        const string inspection = "/api/internal/apps/{appId}/workspace-inspection/{workspaceId}/participants";
        const string association = "/api/internal/apps/{appId}/sessions/{sessionId}/workspace-association";
        app.MapGet(inspection, async (string appId, string workspaceId, HttpRequest request,
            WorkspaceInspectionAuthorization auth, DevelopmentWorkspaceService workspaces, UserDirectoryStore users, AppRegistryStore apps, CancellationToken ct) =>
            await Handle(async () =>
            {
                var actor = await auth.RequireAsync(request, appId, ct);
                return await Project(await workspaces.ParticipationAsync(workspaceId, actor, ct), actor, appId, users, apps, ct);
            }, request));
        app.MapPost(inspection + "/{kind}", async (string appId, string workspaceId, string kind, WorkspaceMemberCommand input,
            HttpRequest request, WorkspaceInspectionAuthorization auth, DevelopmentWorkspaceService workspaces,
            UserDirectoryStore users, AppRegistryStore apps, CancellationToken ct) => await Handle(async () =>
            {
                var actor = await auth.RequireAsync(request, appId, ct, manage: true);
                var target = (await users.ReadAsync(ct)).Users.FirstOrDefault(u => u.Id == input.UserId);
                if (kind == "grant" && (target is null || target.Disabled || !AppAccessPolicy.IsAdmin(target)))
                    throw DevelopmentWorkspaceService.Error("member_ineligible", "Sharing requires an existing enabled administrator.");
                return await Project(await workspaces.ChangeMemberAsync(workspaceId, actor, kind, input, ct), actor, appId, users, apps, ct);
            }, request));
        app.MapGet(association, async (string appId, string sessionId, HttpRequest request, WorkspaceAuthorization auth,
            DevelopmentWorkspaceService workspaces, UserDirectoryStore users, AppRegistryStore apps, CancellationToken ct) => await Handle(async () =>
            {
                var actor = await auth.RequireAsync(request, appId, sessionId, ct);
                var participation = await workspaces.SessionParticipationAsync(actor, ct);
                if (participation is null)
                {
                    var legacy = (await workspaces.ListAsync(actor, true, ct)).Workspaces.FirstOrDefault();
                    if (legacy is not null) participation = await workspaces.ParticipationAsync(legacy.WorkspaceId, actor.UserId, ct);
                }
                return new WorkspaceAssociationView(participation is null ? null : await Project(await workspaces.ParticipationAsync(participation.Id, actor.UserId, ct), actor.UserId, appId, users, apps, ct));
            }, request));
        app.MapPost(association + "/{workspaceId}/{kind}", async (string appId, string sessionId, string workspaceId,
            string kind, WorkspaceSessionCommand input, HttpRequest request, WorkspaceAuthorization auth,
            DevelopmentWorkspaceService workspaces, UserDirectoryStore users, AppRegistryStore apps, CancellationToken ct) => await Handle(async () =>
            {
                var actor = await auth.RequireAsync(request, appId, sessionId, ct);
                await workspaces.ChangeSessionAsync(workspaceId, actor, kind, input, ct);
                // A retained receipt must not restore an association changed by a later request.
                var current = await workspaces.SessionParticipationAsync(actor, ct);
                if (current is null)
                    return new WorkspaceAssociationView(null);
                return new WorkspaceAssociationView(await Project(await workspaces.ParticipationAsync(current.Id, actor.UserId, ct), actor.UserId, appId, users, apps, ct));
            }, request));
    }

    internal static async Task<WorkspaceParticipationView> Project(WorkspaceParticipation value, string actor, string appId,
        UserDirectoryStore? users, AppRegistryStore apps, CancellationToken ct)
    {
        var directory = users is null ? [] : (await users.ReadAsync(ct)).Users;
        var installation = (await apps.GetAppAsync(appId, ct))?.InstalledAt;
        var role = "operator";
        string Name(string userId) => directory.FirstOrDefault(u => u.Id == userId)?.DisplayName ?? "Workspace participant";
        return new(value.Id, value.Revision, role,
            value.Members.Select(m => new WorkspaceMemberView(m.UserId, Name(m.UserId), m.Role, m.WorktreeIds, m.RevokedAt is not null)).ToArray(),
            // External allocation evidence is retained internally, not exposed as a hosted chat or activity.
            value.Sessions.Where(s => !s.Session.IsExternal).Select(s => new WorkspaceSessionView(s.Session.AppId, s.Session.UserId, s.Session.SessionId, s.Title,
                s.DetachedAt is null, s.Session.UserId == actor && s.Session.AppId == appId && s.Session.Installation == installation,
                s.Session.UserId == actor && s.Session.AppId == appId && s.Session.Installation == installation ? s.ViewerPath : null,
                s.Status is not ("idle" or "failed") && (s.ActivityAt is null || DateTimeOffset.UtcNow - s.ActivityAt > TimeSpan.FromSeconds(45)) ? "unknown" : s.Status, s.ActivityAt, s.Session.AppId == appId && s.Session.Installation == installation, s.ChangedAt ?? s.AttachedAt)).ToArray(),
            role == "owner" ? directory.Where(u => !u.Disabled && AppAccessPolicy.IsAdmin(u))
                .Select(u => new WorkspaceParticipantUser(u.Id, u.DisplayName ?? u.Email ?? "Administrator")).ToArray() : [], actor);
    }

    private static async Task<IResult> Handle<T>(Func<Task<T>> action, HttpRequest request)
    {
        request.HttpContext.Response.Headers.CacheControl = "no-store";
        try { return CoreJson.Json(await action()); }
        catch (AppIdentityException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), AuthEndpoints.MapIdentityErrorStatus(ex.Code)); }
        catch (AppLifecycleException ex) { return CoreJson.Json(new ErrorResponse(ex.Code, ex.Message), ex.Code == "workspace_forbidden" ? 403 : ex.Code == "workspace_not_found" ? 404 : 409); }
    }
}
