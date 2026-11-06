namespace Haas.Hosty.Core;

internal sealed record CorePublicationQuery(string? WorkspaceId = null);
internal sealed record CorePublicationGet(string WorktreeId);
internal sealed record CorePublicationMutation(string WorktreeId, PublicationCommand Input);
internal sealed record CoreRemoteQuery(string WorktreeId, string AppId);
internal sealed record CoreRemoteMutation(string WorktreeId, LocalRemoteCommand Input);

internal sealed class CorePublicationAdapter(CoreCapabilityAuthorization authorization, DevelopmentWorkspaceService workspaces,
    PublicationService publications)
{
    internal static bool RemoteWrite(string operation) => operation is "configure" or "push" or "publish" or "link" or "ready" or "resolve-review" or "merge" or "corrective" or "push-base";
    internal async Task<ExternalWorkspaceMcpCaller> Caller(HttpRequest request, string operation, CancellationToken ct)
    {
        var scopes = new List<string> { AccessTokenScopes.McpRead, AccessTokenScopes.McpWorkspaces };
        var permissions = new List<string> { CoreAppPermissions.Sources };
        if (operation != "commit") scopes.Add(AccessTokenScopes.McpPublicationRead);
        if (RemoteWrite(operation)) { scopes.Add(AccessTokenScopes.McpPublicationWrite); permissions.Add(CoreAppPermissions.PublicationWrite); }
        var caller = await authorization.RequireAsync(request, scopes, permissions, ct);
        return new(caller.User.Id, caller.PrincipalId, caller.App?.DisplayName ?? "Core publication client", caller.App, caller.Authority);
    }
    internal async Task<PublicationConnections> Connections(HttpRequest request, CancellationToken ct) =>
        await publications.ConnectionsAsync((await Caller(request, "connections", ct)).Owner("publication-directory"), ct);
    internal async Task<PublicationList> List(HttpRequest request, CorePublicationQuery input, CancellationToken ct)
    {
        var caller = await Caller(request, "list", ct);
        var result = await publications.ListAsync(caller.Owner("publication-directory"), ct, canonical: true);
        await Caller(request, "list", ct);
        if (input.WorkspaceId is null) return result;
        var trees = (await workspaces.ListAsync(null, true, ct)).Workspaces.Where(w => w.WorkspaceId == input.WorkspaceId).Select(w => w.Id).ToHashSet();
        return new(result.Publications.Where(p => trees.Contains(p.WorkspaceId)).ToArray());
    }
    internal async Task<PublicationRecord> Get(HttpRequest request, string worktreeId, CancellationToken ct)
    {
        var result = await publications.ObserveAsync(worktreeId, await CoreSourceApi.Actor(await Caller(request, "get", ct), worktreeId, workspaces, ct), ct, canonical: true);
        await Caller(request, "get", ct);
        return result;
    }
    internal async Task<PublicationRecord> Command(HttpRequest request, string kind, CorePublicationMutation input, CancellationToken ct)
    {
        var caller = await Caller(request, kind, ct);
        if (kind is not ("resolve-review" or "commit" or "configure" or "push" or "publish" or "link" or "ready" or "merge" or "complete" or "corrective"))
            throw new PublicationException("request_invalid", "Select a supported publication operation.");
        return await publications.CommandAsync(input.WorktreeId, await CoreSourceApi.Actor(caller, input.WorktreeId, workspaces, ct), kind, input.Input, ct, canonical: true, validateCaller: async token => { await Caller(request, kind, token); });
    }
    internal async Task<LocalRemoteStatus> RemoteStatus(HttpRequest request, CoreRemoteQuery input, CancellationToken ct) =>
        await workspaces.RemoteStatusAsync(input.WorktreeId, await CoreSourceApi.Actor(await Caller(request, "remote-status", ct), input.WorktreeId, workspaces, ct), input.AppId, ct);
    internal async Task<LocalRemoteStatus> RemoteCommand(HttpRequest request, string kind, CoreRemoteMutation input, CancellationToken ct)
    {
        var caller = await Caller(request, kind, ct);
        if (kind is not ("connect" or "fetch" or "push-base")) throw new PublicationException("request_invalid", "Select a supported remote operation.");
        return await workspaces.RemoteCommandAsync(input.WorktreeId, await CoreSourceApi.Actor(caller, input.WorktreeId, workspaces, ct), kind, input.Input, ct, validateCaller: async token => { await Caller(request, kind, token); });
    }
}
