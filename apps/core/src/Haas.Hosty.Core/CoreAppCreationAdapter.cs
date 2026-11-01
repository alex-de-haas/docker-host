namespace Haas.Hosty.Core;

internal sealed record CanonicalAppCreation(string TaskId, string LeaseId, AppCreationRequest Input, string? NavigationPath = null);
internal sealed record CanonicalAppCreationStatus(string TaskId, string RequestId);
internal sealed record CanonicalLocalApp(string WorktreeId, string AppId);
internal sealed record CanonicalLocalHandoff(string AppId, LocalAppHandoffRequest Input);

internal sealed class CoreAppCreationAdapter(CoreCapabilityAuthorization authorization, CoreLifecycleService lifecycle,
    DevelopmentWorkspaceService workspaces)
{
    private async Task<(CoreCapabilityCaller Caller, ExternalWorkspaceMcpCaller Source)> Caller(HttpRequest request, CancellationToken ct, bool create = false, bool use = false)
    {
        var scopes = new List<string> { AccessTokenScopes.McpRead, AccessTokenScopes.McpWorkspaces };
        var permissions = new List<string> { CoreAppPermissions.Sources };
        if (create) { scopes.Add(AccessTokenScopes.McpAppCreate); permissions.Add(CoreAppPermissions.Install); }
        if (use) { scopes.Add(AccessTokenScopes.McpLifecycle); permissions.Add(CoreAppPermissions.AppLifecycle); }
        var caller = await authorization.RequireAsync(request, scopes, permissions, ct);
        return (caller, new(caller.User.Id, caller.PrincipalId, caller.App?.DisplayName ?? "Core app creator", caller.App, caller.Authority));
    }
    internal async Task<AppCreationCapabilities> Capabilities(HttpRequest request, CancellationToken ct) =>
        new((await Caller(request, ct)).Caller.User.GitIdentity);
    internal async Task<AppDevelopmentGuide> Guide(HttpRequest request, string? topic, CancellationToken ct)
    {
        await Caller(request, ct); return AppDevelopmentGuideReader.Read(topic);
    }
    internal async Task<AppCreationResult> Status(HttpRequest request, CanonicalAppCreationStatus input, CancellationToken ct) =>
        new(await lifecycle.ReadCreationAsync((await Caller(request, ct)).Source.Owner(input.TaskId), input.RequestId, ct));
    internal async Task<AppCreationResult> Create(HttpRequest request, CanonicalAppCreation input, CancellationToken ct)
    {
        var (caller, source) = await Caller(request, ct, create: true);
        if (string.IsNullOrWhiteSpace(input.TaskId) || input.TaskId.Length > 200 || input.TaskId.Any(char.IsControl) || input.TaskId != input.TaskId.Trim()
            || !Guid.TryParse(input.LeaseId, out _) || input.Input is null)
            throw new AppLifecycleException("creation_context_invalid", "Supply a bounded task context, activity lease UUID and creation input.");
        if (input.NavigationPath is { } path && (caller.App is null || path.Length > 2048 || !path.StartsWith('/') || path.StartsWith("//") || path.Contains('\\') || path.Any(char.IsControl)))
            throw new AppLifecycleException("creation_navigation_invalid", "Optional navigation is a relative path supplied by the calling application.");
        var owner = source.Owner(input.TaskId);
        var created = await lifecycle.CreateLocalAppAsync(owner, input.Input, caller.User.GitIdentity, ct);
        await Caller(request, ct, create: true);
        var name = ("Create " + input.Input.Name)[..Math.Min(120, 7 + input.Input.Name.Length)].TrimEnd();
        var tree = await workspaces.PrepareAsync(owner, new(input.Input.RequestId, input.TaskId, input.Input.AppId,
            input.NavigationPath, "main", input.LeaseId, Name: name), ct);
        return created with { Workspace = await workspaces.SessionProjectionAsync(tree, owner, ct) };
    }
    internal async Task<LocalAppHandoffStatus> LocalStatus(HttpRequest request, CanonicalLocalApp input, CancellationToken ct) =>
        await lifecycle.ReadLocalAppAsync(await CoreSourceApi.Actor((await Caller(request, ct)).Source, input.WorktreeId, workspaces, ct), input.AppId, input.WorktreeId, workspaces, ct);
    internal async Task<LocalAppHandoffStatus> Handoff(HttpRequest request, string kind, CanonicalLocalHandoff input, CancellationToken ct)
    {
        var (_, source) = await Caller(request, ct, use: kind == "use");
        if (kind is not ("accept" or "use")) throw new AppLifecycleException("local_request_invalid", "Choose accept or use.");
        return await lifecycle.HandoffLocalAppAsync(await CoreSourceApi.Actor(source, input.Input.WorkspaceId, workspaces, ct), input.AppId, kind, input.Input, workspaces, ct);
    }
}
