namespace Haas.Hosty.Core;

// Workspace authority is narrower than the administrator's browser role. It belongs to one
// directly reviewed Core credential and is re-established for every call, including source reads.
internal sealed class ExternalWorkspaceMcpAuthorization(UserDirectoryStore users, OAuthStore oauth,
    IClock clock, CoreSettingsService settings)
{
    public async Task<ExternalWorkspaceMcpCaller> RequireAsync(HttpContext? http, CancellationToken ct)
    {
        var bearer = http is null ? null : CoreSessionAuthorization.ReadBearerToken(http.Request);
        var credential = ScopedCredentials.Resolve(await users.ReadAsync(ct), bearer, clock.UtcNow,
            settings.AuthLifetimes, AccessTokenScopes.CoreAudience);
        if (credential is null || !AppAccessPolicy.IsAdmin(credential.User) ||
            !AccessTokenScopes.Grants(credential.Record.Scopes, AccessTokenScopes.McpRead) ||
            !AccessTokenScopes.Grants(credential.Record.Scopes, AccessTokenScopes.McpWorkspaces))
            throw Denied();

        if (credential.Record.Kind == AccessTokenKinds.OAuth && credential.Record.GrantId is { } grantId)
        {
            var state = await oauth.ReadAsync(ct);
            var grant = state.Grants.FirstOrDefault(candidate => candidate.Id == grantId);
            var client = grant is null ? null : state.Clients.FirstOrDefault(candidate =>
                candidate.ClientId == grant.ClientId && candidate.DeletedAt is null);
            if (grant is null || client is null || !OAuthStore.IsGrantLive(grant, clock.UtcNow) ||
                grant.UserId != credential.User.Id || grant.Audience != AccessTokenScopes.CoreAudience ||
                !AccessTokenScopes.Grants(grant.Scopes, AccessTokenScopes.McpRead) ||
                !AccessTokenScopes.Grants(grant.Scopes, AccessTokenScopes.McpWorkspaces) ||
                credential.Record.Scopes!.Except(grant.Scopes, StringComparer.Ordinal).Any())
                throw Denied();
            // Access-token rotation deliberately leaves this principal unchanged. A new grant,
            // even to the same OAuth client and user, gets a separate principal.
            return new(credential.User.Id, "oauth:" + grant.Id, NormalizeLabel(client.Name));
        }

        if (credential.Record.Kind != AccessTokenKinds.Manual || credential.Record.GrantId is not null)
            throw Denied();
        // The bearer value must never appear in a workspace owner, audit trail or tool result.
        return new(credential.User.Id, "manual:" + DevelopmentWorkspaceService.Hash(credential.Record.Id),
            NormalizeLabel(credential.Record.Label));
    }

    internal static AppIdentityException Denied() => new("workspace_authority_required",
        "A directly reviewed Core OAuth or manual credential with mcp:read and mcp:workspaces is required. " +
        "Browser, read-only, delegated and app credentials cannot manage external workspaces.");

    internal static string NormalizeLabel(string? value)
    {
        var label = (value ?? "External agent").Trim();
        if (label.Length == 0 || label.Length > 80 || label.Any(char.IsControl))
            throw new AppLifecycleException("workspace_label_invalid", "Use a nonempty display label of at most 80 characters without control characters.");
        return label;
    }
}

internal sealed record ExternalWorkspaceMcpCaller(string UserId, string PrincipalId, string Label)
{
    public bool Owns(WorkspaceOwner owner)
        => owner.UserId == UserId && owner.External?.PrincipalId == PrincipalId;

    public WorkspaceOwner Owner(string taskId, string? label = null)
        => WorkspaceOwner.ForExternal(UserId, PrincipalId, taskId,
            label is null ? Label : ExternalWorkspaceMcpAuthorization.NormalizeLabel(label));
}
