namespace Haas.Hosty.Core;

// Conversations share the assistant app's browser-established activity. A session ID identifies
// work; it never creates or extends permission, app activity or the authorizing Core sign-in.
internal sealed class AssistantSessionAuthority(AppRegistryStore apps, AppIdentityService identity,
    AppSessionGrantStore grants)
{
    internal static void ValidateSessionId(string id)
    {
        if (id.Length is < 1 or > 128 || id.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not '-' and not '_'))
            throw new AppIdentityException("assistant_session_invalid", "A valid assistant session ID is required.");
    }

    internal async Task<AppSessionValidationResult> RequireAsync(string appId, string sessionId, string grantHash, CancellationToken ct)
    {
        ValidateSessionId(sessionId);
        var actor = await identity.RequireActivityHashAsync(grantHash, appId, ct);
        var app = await apps.GetAppAsync(appId, ct);
        if (app is null || !AgentMcpDirectory.IsAssistant(app))
            throw new AppIdentityException("mcp_assistant_required", "A confirmed assistant is required.");
        var grant = await grants.TryResolveAsync(grantHash, ct);
        if (grant is null || grant.CreatedAt < app.InstalledAt)
            throw new AppIdentityException("token_invalid", "Sign in again after reinstalling the assistant.");
        return actor;
    }
}
